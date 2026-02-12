import { DurableObject } from "cloudflare:workers";
import { Env } from ".";

export class ChatRoom extends DurableObject<Env> {
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

    // Accept the WebSocket and store reference
    this.ctx.acceptWebSocket(server);

    // Store metadata on the socket for hibernation support
    server.serializeAttachment({ id });

    // Notify this client they're connected
    server.send(JSON.stringify({ type: "connected", id }));

    // Broadcast to all OTHER websockets in this DO that someone joined
    this.broadcast({ type: "peer-joined", id }, id);

    return new Response(null, { status: 101, webSocket: client });
  }

  // Helper: Send to all except sender
  broadcast(message: object, excludeId?: string) {
    const msg = JSON.stringify(message);
    const websockets = this.ctx.getWebSockets();

    for (const ws of websockets) {
      const meta = ws.deserializeAttachment();
      if (meta.id !== excludeId && ws.readyState === WebSocket.OPEN) {
        ws.send(msg);
      }
    }
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    this.broadcast({ data: message }, undefined);
  }

  async webSocketClose(ws: WebSocket) {
    const attachment = ws.deserializeAttachment();
    this.broadcast({ type: "peer-left", id: attachment.id }, attachment.id);
  }
}
