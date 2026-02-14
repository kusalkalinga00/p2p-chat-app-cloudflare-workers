import { DurableObject } from "cloudflare:workers";
import { Env } from ".";

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
  available: boolean;
  /** false until the client sends "spawn" */
  spawned: boolean;
}

export class World extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  // ── Helpers ──────────────────────────────────────────────────────

  /** Return all spawned users' data (read from WebSocket attachments). */
  private getSpawnedUsers(): { meta: WsAttachment; ws: WebSocket }[] {
    return this.ctx
      .getWebSockets()
      .map((ws) => ({
        meta: ws.deserializeAttachment() as WsAttachment,
        ws,
      }))
      .filter((entry) => entry.meta.spawned);
  }

  /** Find a specific user's WebSocket by their ID. */
  private findSocket(userId: string): WebSocket | undefined {
    for (const ws of this.ctx.getWebSockets()) {
      const meta = ws.deserializeAttachment() as WsAttachment;
      if (meta.id === userId && meta.spawned) return ws;
    }
    return undefined;
  }

  // ── WebSocket lifecycle ──────────────────────────────────────────

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const id = url.searchParams.get("id");

    if (!id) {
      return new Response("Missing ID", { status: 400 });
    }

    const upgrade = request.headers.get("Upgrade");
    if (upgrade !== "websocket") {
      return new Response("Expected WebSocket", { status: 400 });
    }

    const [client, server] = Object.values(new WebSocketPair());

    this.ctx.acceptWebSocket(server);

    // Store initial attachment – spawned: false until the client sends "spawn"
    server.serializeAttachment({
      id,
      x: 0,
      y: 0,
      z: 0,
      color: "",
      available: false,
      spawned: false,
    } satisfies WsAttachment);

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    const data = JSON.parse(message as string);
    const attachment = ws.deserializeAttachment() as WsAttachment;

    switch (data.type) {
      case "spawn": {
        // 1. Send current world-state (all already-spawned users) to
        //    this newly connected user so they see everyone.
        const currentUsers = this.getSpawnedUsers()
          .filter((u) => u.meta.id !== attachment.id)
          .map((u) => ({
            id: u.meta.id,
            x: u.meta.x,
            y: u.meta.y,
            z: u.meta.z,
            color: u.meta.color,
            available: u.meta.available,
          }));

        ws.send(
          JSON.stringify({
            type: "world-state",
            users: currentUsers,
          }),
        );

        // 2. Persist this user's data in the WebSocket attachment
        //    (survives hibernation).
        const updated: WsAttachment = {
          id: attachment.id,
          x: data.x,
          y: data.y,
          z: data.z,
          color: data.color,
          available: data.available,
          spawned: true,
        };
        ws.serializeAttachment(updated);

        // 3. Broadcast to everyone else that a new user joined.
        this.broadcast(
          {
            type: "user-joined",
            user: {
              id: updated.id,
              x: updated.x,
              y: updated.y,
              z: updated.z,
              color: updated.color,
              available: updated.available,
            },
          },
          updated.id,
        );
        break;
      }

      case "set-available": {
        // Update this user's availability in their attachment and
        // broadcast the change so all clients update their UI.
        const updatedAvail: WsAttachment = {
          ...attachment,
          available: data.available,
        };
        ws.serializeAttachment(updatedAvail);

        this.broadcast(
          {
            type: "availability-changed",
            id: attachment.id,
            available: data.available,
          },
          attachment.id,
        );
        break;
      }

      case "chat-request": {
        // Only forward if the target is available
        const target = this.findSocket(data.target);
        if (target) {
          const targetMeta = target.deserializeAttachment() as WsAttachment;
          if (!targetMeta.available) {
            // Target is busy — send an immediate decline back to sender
            ws.send(
              JSON.stringify({
                type: "chat-response",
                from: data.target,
                accept: false,
                roomId: "",
              }),
            );
            break;
          }
          target.send(
            JSON.stringify({
              type: "chat-request",
              from: attachment.id,
            }),
          );
        }
        break;
      }

      case "chat-response": {
        const requester = this.findSocket(data.target);
        if (requester) {
          requester.send(
            JSON.stringify({
              type: "chat-response",
              from: attachment.id,
              accept: data.accept,
              roomId: data.roomId,
            }),
          );
        }
        break;
      }

      // ── WebRTC signaling relay ────────────────────────────────────
      // These messages are forwarded 1-to-1 between two users who
      // have agreed to chat.  The World DO acts as a thin relay so
      // we don't need a separate signaling server.

      case "rtc-offer":
      case "rtc-answer":
      case "rtc-ice-candidate": {
        const peer = this.findSocket(data.target);
        if (peer) {
          peer.send(
            JSON.stringify({
              type: data.type,
              from: attachment.id,
              payload: data.payload,
            }),
          );
        }
        break;
      }

      default:
        this.broadcast({ ...data, from: attachment.id });
    }
  }

  async webSocketClose(ws: WebSocket) {
    const attachment = ws.deserializeAttachment() as WsAttachment;

    // Notify remaining users
    this.broadcast({
      type: "user-left",
      id: attachment.id,
    });
  }

  private broadcast(message: object, excludeId?: string) {
    const msg = JSON.stringify(message);

    for (const { meta, ws } of this.getSpawnedUsers()) {
      if (meta.id !== excludeId && ws.readyState === WebSocket.OPEN) {
        ws.send(msg);
      }
    }
  }
}
