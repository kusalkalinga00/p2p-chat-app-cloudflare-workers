export const INVITATION_TIMEOUT_MS = 15_000;

/**
 * Worker **origin**, normalised from whatever `VITE_WORLD_WSS_URL` holds.
 *
 * The value is configured inconsistently in practice: `ws://`, `wss://`,
 * `http://`, sometimes with a path like `/world` appended. WebSocket tolerates
 * all of it, but `fetch()` rejects `ws://`/`wss://` outright, and a path suffix
 * turns `/ice` into `/world/ice`, which routes to the Durable Object instead of
 * the Worker. Reducing to an origin makes both callers correct.
 */
function toOrigin(raw: string): string {
  const httpish = raw.replace(/^ws(s?):\/\//i, "http$1://");
  try {
    return new URL(httpish).origin;
  } catch {
    console.warn(`[config] VITE_WORLD_WSS_URL is not a URL: ${raw}`);
    return "http://localhost:8787";
  }
}

export const WORLD_ORIGIN: string = toOrigin(
  import.meta.env.VITE_WORLD_WSS_URL ?? "http://localhost:8787",
);
