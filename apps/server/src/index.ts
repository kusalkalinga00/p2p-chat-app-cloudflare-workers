import type { IceConfigResponse, IceServer } from "@p2p-chat/types";
import { World } from "./world";

export { World };

/**
 * TURN configuration, all optional. Providers are tried in this order:
 *
 * 1. Cloudflare TURN — `TURN_KEY_ID` + `TURN_KEY_API_TOKEN` secrets. Mints
 *    short-lived credentials. Billed per GB, needs billing enabled.
 * 2. Metered Open Relay — `METERED_API_KEY` + `METERED_APP` secrets. 20 GB/month
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
  ALLOWED_ORIGINS?: string;
  TURN_KEY_ID?: string;
  TURN_KEY_API_TOKEN?: string;
  TURN_TTL_SECONDS?: string;
  METERED_API_KEY?: string;
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

  let response: Response;
  try {
    response = await fetch(
      `https://${env.METERED_APP}.metered.live/api/v1/turn/credentials?apiKey=${env.METERED_API_KEY}`,
    );
  } catch (err) {
    console.error("[turn] metered credential request failed:", err);
    return null;
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    console.error(
      `[turn] metered credential fetch failed: ${response.status} ${detail.slice(0, 200)}`,
    );
    return null;
  }

  const payload = (await response.json()) as IceServer[] | IceConfigResponse;
  // Their docs return the array directly; tolerate a wrapped body too.
  const iceServers = Array.isArray(payload) ? payload : payload.iceServers;

  if (!Array.isArray(iceServers) || iceServers.length === 0) return null;

  const ttl = Math.min(
    Number(env.TURN_TTL_SECONDS) || METERED_MAX_CACHE_SECONDS,
    METERED_MAX_CACHE_SECONDS,
  );

  credentialCache = {
    expiresAt: Date.now() + Math.max(ttl - 60, 30) * 1000,
    body: { iceServers, ttl },
  };

  return credentialCache.body;
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

async function buildIceResponse(env: Env): Promise<IceConfigResponse> {
  if (env.TURN_KEY_ID && env.TURN_KEY_API_TOKEN) {
    const minted = await mintCloudflareCredentials(env);
    // Fall through rather than breaking connections when minting fails.
    if (minted) return minted;
  }

  if (env.METERED_API_KEY && env.METERED_APP) {
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
      const body = await buildIceResponse(env);

      return Response.json(body, {
        headers: {
          ...cors,
          "Cache-Control": env.TURN_KEY_ID || env.METERED_API_KEY
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
