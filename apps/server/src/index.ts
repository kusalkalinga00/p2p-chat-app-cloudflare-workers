import type { IceConfigResponse, IceServer } from "@p2p-chat/types";
import { World } from "./world";

export { World };
export { IceRateLimiter } from "./rate-limiter";

/**
 * TURN configuration, all optional. Providers are tried in this order:
 *
 * 1. Cloudflare TURN — `TURN_KEY_ID` + `TURN_KEY_API_TOKEN` secrets. Mints
 *    short-lived credentials. Billed per GB, needs billing enabled.
 * 2. Metered Open Relay — `METERED_SECRET_KEY` + `METERED_APP` secrets. Free
 *    free, no card. Credentials come from their REST API per request.
 * 3. Static — `TURN_URLS`, `TURN_USERNAME`, `TURN_PASSWORD` vars, e.g. a local
 *    coturn instance.
 * 4. None — clients fall back to public STUN, which works on permissive
 *    networks but not through symmetric NAT.
 *
 * Every provider key is a long-term secret that can mint unlimited credentials,
 * so keys stay server-side and never reach the browser.
 */
export interface Env {
  WORLD: DurableObjectNamespace<World>;
  RATE_LIMITER: DurableObjectNamespace;
  ALLOWED_ORIGINS?: string;
  /** Max /ice requests per client IP per window. Default 30. */
  ICE_RATE_LIMIT?: string;
  /** Rate-limit window in seconds. Default 3600. */
  ICE_RATE_WINDOW_SECONDS?: string;
  TURN_KEY_ID?: string;
  TURN_KEY_API_TOKEN?: string;
  TURN_TTL_SECONDS?: string;
  METERED_SECRET_KEY?: string;
  METERED_APP?: string;
  TURN_URLS?: string;
  TURN_USERNAME?: string;
  TURN_PASSWORD?: string;
}

const DEFAULT_ALLOWED_ORIGINS = [
  "http://localhost:5173",
  "http://localhost:5180",
  "https://p2p-chat-app-cloudflare-workers.pages.dev",
];

/** Public STUN used when no TURN is configured. */
const FALLBACK_ICE_SERVERS: IceServer[] = [
  { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
];

const CLOUDFLARE_TURN_ENDPOINT = "https://rtc.live.cloudflare.com/v1/turn/keys";

/** Free tier; credentials are short-lived, so cache them for an hour at most. */
const METERED_MAX_CACHE_SECONDS = 3_600;

const DEFAULT_TURN_TTL_SECONDS = 86_400;

/**
 * Per-isolate cache of minted credentials. TURN credentials stay valid until
 * their TTL and this Worker is the only caller of the mint endpoint, so caching
 * avoids minting a fresh credential for every client load.
 */
let credentialCache: { expiresAt: number; body: IceConfigResponse } | null = null;

function allowedOrigins(env: Env): string[] {
  const configured = env.ALLOWED_ORIGINS?.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  return configured?.length ? configured : DEFAULT_ALLOWED_ORIGINS;
}

function corsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get("Origin");
  const allowed = allowedOrigins(env);
  const allowOrigin = origin && allowed.includes(origin) ? origin : allowed[0];

  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    // The allowlist varies per request, so caches must key on Origin.
    Vary: "Origin",
  };
}

/** Mint short-lived credentials from Cloudflare's TURN service. */
async function mintCloudflareCredentials(
  env: Env,
): Promise<IceConfigResponse | null> {
  const cached = credentialCache;
  if (cached && cached.expiresAt > Date.now()) return cached.body;

  const ttl = Number(env.TURN_TTL_SECONDS) || DEFAULT_TURN_TTL_SECONDS;

  let response: Response;
  try {
    response = await fetch(
      `${CLOUDFLARE_TURN_ENDPOINT}/${env.TURN_KEY_ID}/credentials/generate-ice-servers`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ttl }),
      },
    );
  } catch (err) {
    // A network failure must degrade to STUN, not fail the whole request.
    console.error("[turn] credential mint request failed:", err);
    return null;
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    console.error(
      `[turn] credential mint failed: ${response.status} ${detail.slice(0, 200)}`,
    );
    return null;
  }

  const body = (await response.json()) as IceConfigResponse;
  if (!Array.isArray(body.iceServers)) return null;

  credentialCache = {
    // Renew a minute early so a client never receives a dead credential.
    expiresAt: Date.now() + Math.max(ttl - 60, 30) * 1000,
    body: { ...body, ttl },
  };

  return credentialCache.body;
}

/**
 * Metered Open Relay: 20 GB/month free, no payment method. Their endpoint
 * returns the `iceServers` array for the caller's nearest region.
 */
async function mintMeteredCredentials(
  env: Env,
): Promise<IceConfigResponse | null> {
  const cached = credentialCache;
  if (cached && cached.expiresAt > Date.now()) return cached.body;

  const app = env.METERED_APP;
  const secretKey = env.METERED_SECRET_KEY;
  if (!app || !secretKey) return null;

  // Accept either "island-chat" or the full "island-chat.metered.live".
  const host = app.replace(/\.metered\.live$/, "");

  const ttl = Math.min(
    Number(env.TURN_TTL_SECONDS) || METERED_MAX_CACHE_SECONDS,
    METERED_MAX_CACHE_SECONDS,
  );

  try {
    // Step 1: create a credential. This returns a per-credential `apiKey`,
    // which is what the ICE server lookup takes — the secret key is not it.
    const create = await fetch(
      `https://${host}.metered.live/api/v1/turn/credential?secretKey=${secretKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expiryInSeconds: ttl, label: "island-chat" }),
      },
    );

    if (!create.ok) {
      const detail = await create.text().catch(() => "");
      console.error(
        `[turn] metered credential create failed: ${create.status} ${detail.slice(0, 200)}`,
      );
      return null;
    }

    const created = (await create.json()) as { apiKey?: string };
    if (!created.apiKey) {
      console.error("[turn] metered credential create returned no apiKey");
      return null;
    }

    // Step 2: resolve the ICE servers for that credential.
    const lookup = await fetch(
      `https://${host}.metered.live/api/v1/turn/credentials?apiKey=${created.apiKey}`,
    );

    if (!lookup.ok) {
      const detail = await lookup.text().catch(() => "");
      console.error(
        `[turn] metered ice lookup failed: ${lookup.status} ${detail.slice(0, 200)}`,
      );
      return null;
    }

    const payload = (await lookup.json()) as IceServer[] | IceConfigResponse;
    // Their docs return the array directly; tolerate a wrapped body too.
    const iceServers = Array.isArray(payload) ? payload : payload.iceServers;

    if (!Array.isArray(iceServers) || iceServers.length === 0) return null;

    credentialCache = {
      expiresAt: Date.now() + Math.max(ttl - 60, 30) * 1000,
      body: { iceServers, ttl },
    };

    return credentialCache.body;
  } catch (err) {
    // A network failure must degrade to STUN, not fail the whole request.
    console.error("[turn] metered credential request failed:", err);
    return null;
  }
}

/** Static credentials, e.g. a local coturn using long-term auth. */
function staticCredentials(env: Env): IceConfigResponse | null {
  if (!env.TURN_URLS || !env.TURN_USERNAME || !env.TURN_PASSWORD) return null;

  return {
    iceServers: [
      {
        urls: env.TURN_URLS.split(",").map((url) => url.trim()),
        username: env.TURN_USERNAME,
        credential: env.TURN_PASSWORD,
      },
    ],
  };
}

/** True when /ice will call a provider (and therefore cost something). */
function hasTurnProvider(env: Env): boolean {
  return Boolean(
    (env.TURN_KEY_ID && env.TURN_KEY_API_TOKEN) ||
      (env.METERED_SECRET_KEY && env.METERED_APP) ||
      (env.TURN_URLS && env.TURN_USERNAME && env.TURN_PASSWORD),
  );
}

/**
 * Only callers we recognise get credentials. Browsers always send `Origin` on a
 * cross-origin fetch; a bare `curl` does not. This is friction for casual abuse
 * rather than authentication — the header is spoofable by anyone determined —
 * which is why the IP rate limit sits behind it.
 */
function isTrustedOrigin(request: Request, env: Env): boolean {
  const origin = request.headers.get("Origin");
  if (!origin) return false;
  return allowedOrigins(env).includes(origin);
}

/**
 * Ask the per-IP limiter whether this request may mint credentials.
 * Returns null when allowed, or a 429 response when not.
 */
async function checkIceRateLimit(
  request: Request,
  env: Env,
): Promise<Response | null> {
  const limit = Number(env.ICE_RATE_LIMIT) || 30;
  const windowSeconds = Number(env.ICE_RATE_WINDOW_SECONDS) || 3600;

  // Cloudflare sets this at the edge; it cannot be spoofed by the client.
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const id = env.RATE_LIMITER.idFromName(`ice:${ip}`);
  const limiter = env.RATE_LIMITER.get(id);

  const result = await limiter.fetch(
    `https://limiter/?limit=${limit}&window=${windowSeconds}`,
  );

  if (result.status !== 429) return null;

  const retryAfter = result.headers.get("Retry-After") ?? "60";
  return Response.json(
    { error: "Rate limit exceeded", retryAfter: Number(retryAfter) },
    {
      status: 429,
      headers: { "Retry-After": retryAfter, "Access-Control-Allow-Origin": "*" },
    },
  );
}

async function buildIceResponse(env: Env): Promise<IceConfigResponse> {
  if (env.TURN_KEY_ID && env.TURN_KEY_API_TOKEN) {
    const minted = await mintCloudflareCredentials(env);
    // Fall through rather than breaking connections when minting fails.
    if (minted) return minted;
  }

  if (env.METERED_SECRET_KEY && env.METERED_APP) {
    const metered = await mintMeteredCredentials(env);
    if (metered) return metered;
  }

  const staticConfig = staticCredentials(env);
  if (staticConfig) return staticConfig;

  return { iceServers: FALLBACK_ICE_SERVERS };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors });
    }

    // ICE server configuration for the browser. Credentials are minted here so
    // the TURN key never ships in the client bundle.
    if (url.pathname === "/ice") {
      if (!isTrustedOrigin(request, env)) {
        return Response.json(
          { error: "Origin not allowed" },
          { status: 403, headers: { Vary: "Origin" } },
        );
      }

      // Only spend the DO request when a provider is configured: with no TURN
      // the response is static STUN and there is nothing to protect.
      if (hasTurnProvider(env)) {
        const limited = await checkIceRateLimit(request, env);
        if (limited) return limited;
      }

      const body = await buildIceResponse(env);

      return Response.json(body, {
        headers: {
          ...cors,
          "Cache-Control": env.TURN_KEY_ID || env.METERED_SECRET_KEY
            ? "private, max-age=60"
            : "public, max-age=300",
        },
      });
    }

    if (url.pathname === "/health") {
      return Response.json({ ok: true }, { headers: cors });
    }

    // Route to Durable Object
    if (url.pathname.startsWith("/world/")) {
      const worldName = url.pathname.split("/")[2];
      const id = env.WORLD.idFromName(worldName);
      const world = env.WORLD.get(id);
      return world.fetch(request);
    }

    return new Response("Not Found", { status: 404, headers: cors });
  },
} satisfies ExportedHandler<Env>;
