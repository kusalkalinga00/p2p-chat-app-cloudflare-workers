import { DurableObject } from "cloudflare:workers";
import { Env } from ".";

interface User {
  id: string;
  x: number;
  y: number;
  z: number;
  color: string;
  available: boolean;
  ws: WebSocket;
}

export class ChatRoom extends DurableObject<Env> {
  private users: Map<string, User> = new Map();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

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
    server.serializeAttachment({ id });

    // Send current world state (all existing users) to new connection
    const currentUsers = Array.from(this.users.values()).map((u) => ({
      id: u.id,
      x: u.x,
      y: u.y,
      z: u.z,
      color: u.color,
      available: u.available,
    }));

    server.send(
      JSON.stringify({
        type: "world-state",
        users: currentUsers,
      }),
    );

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    const data = JSON.parse(message as string);
    const attachment = ws.deserializeAttachment() as { id: string };

    switch (data.type) {
      case "spawn":
        // Register user with their 3D position and appearance
        this.users.set(attachment.id, {
          id: attachment.id,
          x: data.x,
          y: data.y,
          z: data.z,
          color: data.color,
          available: data.available,
          ws,
        });

        // Broadcast to all other users that someone joined
        this.broadcast(
          {
            type: "user-joined",
            user: {
              id: attachment.id,
              x: data.x,
              y: data.y,
              z: data.z,
              color: data.color,
              available: data.available,
            },
          },
          attachment.id,
        );
        break;

      case "chat-request":
        // Forward chat request to specific target user
        const target = this.users.get(data.target);
        if (target) {
          target.ws.send(
            JSON.stringify({
              type: "chat-request",
              from: attachment.id,
            }),
          );
        }
        break;

      case "chat-response":
        // Forward accept/decline response back to the requester
        const requester = this.users.get(data.target);
        if (requester) {
          requester.ws.send(
            JSON.stringify({
              type: "chat-response",
              from: attachment.id,
              accept: data.accept,
              roomId: data.roomId,
            }),
          );
        }
        break;

      default:
        // Broadcast other messages to everyone
        this.broadcast({ ...data, from: attachment.id });
    }
  }

  async webSocketClose(ws: WebSocket) {
    const attachment = ws.deserializeAttachment() as { id: string };

    // Remove user from world
    this.users.delete(attachment.id);

    // Notify remaining users
    this.broadcast({
      type: "user-left",
      id: attachment.id,
    });
  }

  broadcast(message: object, excludeId?: string) {
    const msg = JSON.stringify(message);
    const websockets = this.ctx.getWebSockets();

    for (const ws of websockets) {
      const meta = ws.deserializeAttachment() as { id: string };
      if (meta.id !== excludeId && ws.readyState === WebSocket.OPEN) {
        ws.send(msg);
      }
    }
  }
}
