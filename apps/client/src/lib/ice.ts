import type { IceConfigResponse, IceServer } from "@p2p-chat/types";
import { WORLD_ORIGIN } from "./constants";

/**
 * ICE configuration is fetched from the Worker rather than bundled, because
 * TURN credentials are minted server-side and expire: shipping them in the
 * bundle would hand every visitor a working credential for our relay.
 */

/** Used when the Worker is unreachable or has no TURN configured. */
const FALLBACK_ICE_SERVERS: IceServer[] = [
  { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
];

const DEFAULT_TTL_SECONDS = 300;
const FALLBACK_TTL_SECONDS = 30;

/**
 * Privacy switch: with a TURN server available, use *only* relay candidates.
 *
 * A direct P2P connection tells the peer your address: the ICE candidates we
 * send include host and server-reflexive addresses, so the person on the
 * other end can read your public IP (and, outside mDNS, your LAN address).
 * Routing through TURN hides both behind the relay, at the cost of bandwidth.
 *
 * Set `VITE_ICE_POLICY=all` to allow direct connections. If no TURN server is
 * configured there is no relay to force, so direct is used and the exposure is
 * logged rather than silently pretended away.
 */
const PREFER_RELAY =
  (import.meta.env.VITE_ICE_POLICY ?? "relay").toLowerCase() !== "all";

let warnedNoRelay = false;

function hasTurnServer(iceServers: IceServer[]): boolean {
  return iceServers.some((server) => {
    const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
    return urls.some((url) => /^turns?:/i.test(url));
  });
}

let cache: { expiresAt: number; config: RTCConfiguration } | null = null;
/** Deduplicates concurrent callers, e.g. both peers opening a chat at once. */
let inFlight: Promise<RTCConfiguration> | null = null;

function toConfiguration(iceServers: IceServer[], ttlSeconds: number) {
  const relayOnly = PREFER_RELAY && hasTurnServer(iceServers);

  if (!relayOnly && PREFER_RELAY && !warnedNoRelay) {
    warnedNoRelay = true;
    console.warn(
      "[ice] no TURN relay configured: peers will see each other's IP address",
    );
  }

  const config: RTCConfiguration = relayOnly
    ? { iceServers, iceTransportPolicy: "relay" }
    : { iceServers };

  const lifetime = Math.max(ttlSeconds - 60, FALLBACK_TTL_SECONDS);

  return {
    config,
    expiresAt: Date.now() + lifetime * 1000,
  };
}

/**
 * Resolve the ICE configuration to use. Never throws: a failed lookup results
 * in public STUN, which still connects peers on permissive networks.
 */
export async function getIceConfig(): Promise<RTCConfiguration> {
  if (cache && cache.expiresAt > Date.now()) return cache.config;
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const response = await fetch(`${WORLD_ORIGIN}/ice`, {
        headers: { Accept: "application/json" },
      });

      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const body = (await response.json()) as IceConfigResponse;
      const iceServers = Array.isArray(body.iceServers) && body.iceServers.length
        ? body.iceServers
        : FALLBACK_ICE_SERVERS;

      const ttl = typeof body.ttl === "number" ? body.ttl : DEFAULT_TTL_SECONDS;
      const { config, expiresAt } = toConfiguration(iceServers, ttl);
      cache = { expiresAt, config };

      return config;
    } catch (err) {
      console.warn("[ice] using public STUN, could not load TURN:", err);

      const { config, expiresAt } = toConfiguration(
        FALLBACK_ICE_SERVERS,
        FALLBACK_TTL_SECONDS,
      );
      cache = { expiresAt, config };

      return config;
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

/** Warm the cache so the first chat does not wait on a round trip. */
export function prefetchIceConfig(): void {
  void getIceConfig();
}
