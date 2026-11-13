/**
 * Shared wire protocol and view models for the island world.
 *
 * Imported by both the Worker (Durable Object) and the browser client, so
 * this file must stay free of DOM-only types (`RTCSessionDescriptionInit`
 * etc. do not exist in the Workers runtime) and of runtime dependencies.
 */

// ---------------------------------------------------------------------------
// World models
// ---------------------------------------------------------------------------

/** A user present in the world, as broadcast by the Durable Object. */
export interface User {
  id: string;
  x: number;
  y: number;
  z: number;
  color: string;
  /** False while the user is in a private chat (cannot receive invites). */
  available: boolean;
}

/** SDP payload, structurally compatible with `RTCSessionDescriptionInit`. */
export interface SessionDescription {
  type: "offer" | "answer";
  sdp: string;
}

/** ICE server entry, structurally compatible with `RTCIceServer`. */
export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

/** Body of `GET /ice` — the ICE configuration the client should use. */
export interface IceConfigResponse {
  iceServers: IceServer[];
  /** Seconds until short-lived credentials expire. */
  ttl?: number;
}

/**
 * E2EE public key, exchanged over the signalling relay.
 *
 * These keys are *not* trusted — the whole point is that the relay could
 * substitute them. They are only useful once both sides derive the same
 * short authentication string and the two people compare it out loud.
 */
export interface E2eeKeyPayload {
  /** base64 SPKI of an ephemeral ECDH P-256 public key. */
  publicKey: string;
  /**
   * Derivation protocol version. A mismatch is rejected before any keys are
   * used, because two versions would derive different chains and fail only
   * when the first message is decrypted.
   */
  version: number;
}

/** Proof that both ends derived the same shared secret. */
export interface E2eeConfirmPayload {
  /** base64 HMAC-SHA256 over the key-exchange transcript. */
  tag: string;
}

/** ICE payload, structurally compatible with `RTCIceCandidateInit`. */
export interface IceCandidate {
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
}

// ---------------------------------------------------------------------------
// Client → server
// ---------------------------------------------------------------------------

export type ClientMessage =
  | {
      type: "spawn";
      x: number;
      y: number;
      z: number;
      color: string;
      available: boolean;
    }
  | { type: "set-available"; available: boolean }
  | { type: "chat-request"; target: string }
  | { type: "chat-response"; target: string; accept: boolean; roomId: string }
  /** Withdraw an invitation that is still pending (cancel or timeout). */
  | { type: "chat-cancel"; target: string }
  /** Sent when the local user closes the private chat. */
  | { type: "chat-leave" }
  | { type: "rtc-offer"; target: string; payload: SessionDescription }
  | { type: "rtc-answer"; target: string; payload: SessionDescription }
  | { type: "rtc-ice-candidate"; target: string; payload: IceCandidate }
  | { type: "e2ee-key"; target: string; payload: E2eeKeyPayload }
  /** Key-confirmation tag: proves both sides derived the same secret. */
  | { type: "e2ee-confirm"; target: string; payload: E2eeConfirmPayload };

// ---------------------------------------------------------------------------
// Server → client
// ---------------------------------------------------------------------------

export type ServerErrorCode =
  /** The target is already in a chat. */
  | "busy"
  /** The target left the world. */
  | "not-found"
  /** Message failed validation. */
  | "bad-message"
  /** Message exceeded the size limit. */
  | "too-large"
  /** Signaling attempted with someone you are not paired with. */
  | "not-paired"
  /** You are already in a chat. */
  | "already-paired";

export type ServerMessage =
  | { type: "world-state"; users: User[] }
  | { type: "user-joined"; user: User }
  | { type: "user-left"; id: string }
  | { type: "availability-changed"; id: string; available: boolean }
  | { type: "chat-request"; from: string }
  | { type: "chat-response"; from: string; accept: boolean; roomId: string }
  /** The invitation we were shown has been withdrawn by the sender. */
  | { type: "chat-cancelled"; from: string }
  | { type: "rtc-offer"; from: string; payload: SessionDescription }
  | { type: "rtc-answer"; from: string; payload: SessionDescription }
  | { type: "rtc-ice-candidate"; from: string; payload: IceCandidate }
  | { type: "e2ee-key"; from: string; payload: E2eeKeyPayload }
  | { type: "e2ee-confirm"; from: string; payload: E2eeConfirmPayload }
  /** The peer you were chatting with disconnected. */
  | { type: "peer-left"; id: string }
  | { type: "error"; code: ServerErrorCode; message: string };

// ---------------------------------------------------------------------------
// Client-only view models
// ---------------------------------------------------------------------------

export type RtcStatus = "connecting" | "connected" | "disconnected" | "failed";

export interface ChatMessage {
  id: string;
  from: "me" | "peer";
  text: string;
  timestamp: number;
}

export type View = "world" | "chat";

export type OutgoingStatus = "idle" | "waiting" | "timeout" | "declined";
