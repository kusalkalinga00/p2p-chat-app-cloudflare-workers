import { DurableObject } from "cloudflare:workers";
import type {
  ClientMessage,
  ServerErrorCode,
  ServerMessage,
  User,
} from "@p2p-chat/types";
import type { Env } from ".";

/**
 * Data persisted in each WebSocket's attachment.
 * Attachments survive hibernation, unlike in-memory JS state.
 */
interface WsAttachment {
  id: string;
  x: number;
  y: number;
  z: number;
  color: string;
  /** False while in a private chat — nobody may invite this user. */
  available: boolean;
  /** False until the client sends "spawn". */
  spawned: boolean;
  /** The user this socket is currently in a private chat with. */
  peerId: string | null;
  /** The user awaiting our reply to a chat invitation. */
  invitedBy: string | null;
  /** Timestamp of the last accepted invitation, for invite rate limiting. */
  lastInviteAt: number;
}

/** SDP blobs are the biggest legitimate message; 64 KB is generous. */
const MAX_MESSAGE_CHARS = 64 * 1024;

/** Minimum gap between two invitations sent by the same socket. */
const INVITE_COOLDOWN_MS = 1_500;

/** WebSocket close code used when a connection is replaced by a reconnect. */
const CLOSE_REPLACED = 4001;

const EMPTY_ATTACHMENT = (id: string): WsAttachment => ({
  id,
  x: 0,
  y: 0,
  z: 0,
  color: "",
  available: false,
  spawned: false,
  peerId: null,
  invitedBy: null,
  lastInviteAt: 0,
});

export class World extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  // ── Helpers ──────────────────────────────────────────────────────

  private attachmentOf(ws: WebSocket): WsAttachment {
    return (ws.deserializeAttachment() as WsAttachment | null) ?? EMPTY_ATTACHMENT("");
  }

  private save(ws: WebSocket, meta: WsAttachment): void {
    ws.serializeAttachment(meta);
  }

  /** All spawned users, read from WebSocket attachments. */
  private getSpawnedUsers(): { meta: WsAttachment; ws: WebSocket }[] {
    return this.ctx
      .getWebSockets()
      .map((ws) => ({ meta: this.attachmentOf(ws), ws }))
      .filter((entry) => entry.meta.spawned);
  }

  /** Find a user's WebSocket by ID. */
  private findSocket(userId: string): WebSocket | undefined {
    return this.getSpawnedUsers().find((u) => u.meta.id === userId)?.ws;
  }

  private static toPublicUser(meta: WsAttachment): User {
    return {
      id: meta.id,
      x: meta.x,
      y: meta.y,
      z: meta.z,
      color: meta.color,
      available: meta.available,
    };
  }

  private send(ws: WebSocket, message: ServerMessage): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(message));
  }

  private sendError(ws: WebSocket, code: ServerErrorCode, message: string): void {
    this.send(ws, { type: "error", code, message });
  }

  private broadcast(message: ServerMessage, excludeId?: string): void {
    const msg = JSON.stringify(message);

    for (const { meta, ws } of this.getSpawnedUsers()) {
      if (meta.id !== excludeId && ws.readyState === WebSocket.OPEN) {
        ws.send(msg);
      }
    }
  }

  /**
   * Clear the pairing between two users and tell the peer, if they are
   * still around. Used on leave, disconnect, and reconnect-eviction.
   */
  private releasePair(meta: WsAttachment, notifyPeer: boolean): void {
    if (!meta.peerId) return;
    const peerId = meta.peerId;

    const peerWs = this.findSocket(peerId);
    if (peerWs) {
      const peerMeta = this.attachmentOf(peerWs);
      this.save(peerWs, { ...peerMeta, peerId: null, available: true });
      if (notifyPeer) this.send(peerWs, { type: "peer-left", id: meta.id });
      this.broadcast({
        type: "availability-changed",
        id: peerId,
        available: true,
      });
    }
  }

  // ── WebSocket lifecycle ──────────────────────────────────────────

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const id = url.searchParams.get("id");

    if (!id || id.length > 64) {
      return new Response("Missing or invalid ID", { status: 400 });
    }

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 400 });
    }

    const [client, server] = Object.values(new WebSocketPair());

    this.ctx.acceptWebSocket(server);
    this.save(server, EMPTY_ATTACHMENT(id));

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    // The protocol is JSON text; binary frames are never valid.
    if (typeof message !== "string") {
      this.sendError(ws, "bad-message", "Binary frames are not supported");
      return;
    }

    if (message.length > MAX_MESSAGE_CHARS) {
      ws.close(1009, "Message too large");
      return;
    }

    let data: ClientMessage;
    try {
      data = JSON.parse(message) as ClientMessage;
    } catch {
      this.sendError(ws, "bad-message", "Malformed JSON");
      return;
    }

    if (!data || typeof data !== "object" || typeof data.type !== "string") {
      this.sendError(ws, "bad-message", "Missing message type");
      return;
    }

    const meta = this.attachmentOf(ws);

    switch (data.type) {
      case "spawn": {
        if (
          !Number.isFinite(data.x) ||
          !Number.isFinite(data.y) ||
          !Number.isFinite(data.z) ||
          typeof data.color !== "string" ||
          data.color.length > 32
        ) {
          this.sendError(ws, "bad-message", "Invalid spawn payload");
          return;
        }

        // Persist first: the old socket's close handler checks for a
        // replacement socket before announcing a departure, so saving
        // now avoids a user-left/user-joined flicker on reconnect.
        const updated: WsAttachment = {
          ...meta,
          x: data.x,
          y: data.y,
          z: data.z,
          color: data.color,
          available: data.available,
          spawned: true,
          peerId: null,
          invitedBy: null,
        };
        this.save(ws, updated);

        // A reconnect can race the old socket's close. Evict any other
        // socket claiming this ID, otherwise the world ends up with a
        // ghost avatar and messages routed to a dead socket.
        for (const other of this.ctx.getWebSockets()) {
          if (other === ws) continue;
          const otherMeta = this.attachmentOf(other);
          if (otherMeta.id === meta.id) {
            this.releasePair(otherMeta, true);
            other.close(CLOSE_REPLACED, "Replaced by a newer connection");
          }
        }

        // 1. Tell the newcomer who is already here.
        this.send(ws, {
          type: "world-state",
          users: this.getSpawnedUsers()
            .filter((u) => u.meta.id !== updated.id)
            .map((u) => World.toPublicUser(u.meta)),
        });

        // 2. Tell everyone else.
        this.broadcast(
          { type: "user-joined", user: World.toPublicUser(updated) },
          updated.id,
        );
        break;
      }

      case "set-available": {
        // Someone in a chat cannot opt back into invitations.
        if (meta.peerId) {
          this.sendError(ws, "already-paired", "Leave the chat first");
          return;
        }
        const updated: WsAttachment = {
          ...meta,
          available: Boolean(data.available),
        };
        this.save(ws, updated);
        this.broadcast(
          {
            type: "availability-changed",
            id: updated.id,
            available: updated.available,
          },
          updated.id,
        );
        break;
      }

      case "chat-request": {
        if (!meta.spawned) {
          this.sendError(ws, "bad-message", "Spawn first");
          return;
        }
        if (meta.peerId) {
          this.sendError(ws, "already-paired", "You are already in a chat");
          return;
        }
        if (typeof data.target !== "string" || data.target === meta.id) {
          this.sendError(ws, "bad-message", "Invalid invitation target");
          return;
        }

        const now = Date.now();
        if (now - meta.lastInviteAt < INVITE_COOLDOWN_MS) {
          this.sendError(ws, "busy", "Slow down");
          return;
        }

        const target = this.findSocket(data.target);
        const targetMeta = target ? this.attachmentOf(target) : null;

        // Unreachable or busy: answer immediately so the sender does not
        // sit through the full invitation timeout.
        if (!target || !targetMeta || !targetMeta.available || targetMeta.peerId) {
          this.send(ws, {
            type: "chat-response",
            from: data.target,
            accept: false,
            roomId: "",
          });
          return;
        }

        this.save(ws, { ...meta, lastInviteAt: now });
        this.save(target, { ...targetMeta, invitedBy: meta.id });
        this.send(target, { type: "chat-request", from: meta.id });
        break;
      }

      case "chat-response": {
        // Only the invited user may answer, and only the user who
        // invited them.
        if (meta.invitedBy !== data.target) {
          this.sendError(ws, "not-paired", "No pending invitation from that user");
          return;
        }

        this.save(ws, { ...meta, invitedBy: null });

        const requester = this.findSocket(data.target);
        const requesterMeta = requester ? this.attachmentOf(requester) : null;

        if (!data.accept) {
          if (requester) {
            this.send(requester, {
              type: "chat-response",
              from: meta.id,
              accept: false,
              roomId: "",
            });
          }
          break;
        }

        // Both sides must still be free — either may have been claimed
        // by someone else while the invitation was in flight.
        if (
          !requester ||
          !requesterMeta ||
          meta.peerId ||
          requesterMeta.peerId
        ) {
          this.send(ws, {
            type: "chat-response",
            from: data.target,
            accept: false,
            roomId: "",
          });
          if (requester) {
            this.send(requester, {
              type: "chat-response",
              from: meta.id,
              accept: false,
              roomId: "",
            });
          }
          break;
        }

        const roomId =
          typeof data.roomId === "string" && data.roomId.length <= 128
            ? data.roomId
            : "";

        // Pair both attachments: this is what authorizes signaling relay.
        this.save(ws, { ...meta, invitedBy: null, peerId: data.target, available: false });
        this.save(requester, {
          ...requesterMeta,
          peerId: meta.id,
          available: false,
        });

        this.broadcast({ type: "availability-changed", id: meta.id, available: false });
        this.broadcast({
          type: "availability-changed",
          id: data.target,
          available: false,
        });

        this.send(requester, {
          type: "chat-response",
          from: meta.id,
          accept: true,
          roomId,
        });
        break;
      }

      case "chat-cancel": {
        const target = this.findSocket(data.target);
        if (!target) return;

        const targetMeta = this.attachmentOf(target);
        // Only the user who sent the invitation may withdraw it.
        if (targetMeta.invitedBy !== meta.id) return;

        this.save(target, { ...targetMeta, invitedBy: null });
        this.send(target, { type: "chat-cancelled", from: meta.id });
        break;
      }

      case "chat-leave": {
        this.releasePair(meta, true);
        this.save(ws, { ...meta, peerId: null, invitedBy: null, available: true });
        this.broadcast({ type: "availability-changed", id: meta.id, available: true });
        break;
      }

      // ── WebRTC signaling relay ────────────────────────────────────
      // Forwarded only between two users who have an accepted pairing.
      // Without this check any client could push an offer at anyone.

      case "rtc-offer":
      case "rtc-answer":
      case "rtc-ice-candidate":
      // The E2EE public keys travel the same gated path. The relay handles
      // them as opaque data: it cannot forge a key it cannot decrypt the
      // traffic of, and any substitution shows up in the safety string the
      // two clients compare.
      case "e2ee-key": {
        if (!meta.peerId || meta.peerId !== data.target) {
          this.sendError(ws, "not-paired", "Not in a chat with that user");
          return;
        }

        if (!data.payload || typeof data.payload !== "object") {
          this.sendError(ws, "bad-message", "Missing signaling payload");
          return;
        }

        const peer = this.findSocket(data.target);
        if (!peer) {
          this.sendError(ws, "not-found", "Peer is no longer connected");
          return;
        }

        switch (data.type) {
          case "rtc-offer":
            this.send(peer, {
              type: "rtc-offer",
              from: meta.id,
              payload: data.payload,
            });
            break;
          case "rtc-answer":
            this.send(peer, {
              type: "rtc-answer",
              from: meta.id,
              payload: data.payload,
            });
            break;
          case "rtc-ice-candidate":
            this.send(peer, {
              type: "rtc-ice-candidate",
              from: meta.id,
              payload: data.payload,
            });
            break;
          case "e2ee-key":
            this.send(peer, {
              type: "e2ee-key",
              from: meta.id,
              payload: data.payload,
            });
            break;
        }
        break;
      }

      default: {
        // Previously this fell through to a world-wide broadcast, which
        // turned the Durable Object into an open fan-out relay.
        this.sendError(ws, "bad-message", "Unknown message type");
      }
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const meta = this.attachmentOf(ws);

    // A socket replaced by a reconnect: the new socket for this ID owns
    // the presence, so only tear down the chat pairing.
    const replacement = this.getSpawnedUsers().some(
      (u) => u.meta.id === meta.id && u.ws !== ws,
    );

    this.releasePair(meta, true);

    if (!replacement) {
      this.broadcast({ type: "user-left", id: meta.id });
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws);
  }
}
