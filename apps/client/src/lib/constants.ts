export const STUN_SERVERS: RTCConfiguration = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ],
};

export const INVITATION_TIMEOUT_MS = 15_000;

/**
 * Worker origin. `http(s)://` is fine — `new WebSocket()` upgrades it to
 * `ws(s)://` — and it keeps dev and prod pointing at the same shape of URL.
 */
export const WORLD_WSS_URL: string =
  import.meta.env.VITE_WORLD_WSS_URL ?? "http://localhost:8787";
