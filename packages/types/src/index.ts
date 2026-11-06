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
  | { type: "rtc-ice-candidate"; target: string; payload: IceCandidate };

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
