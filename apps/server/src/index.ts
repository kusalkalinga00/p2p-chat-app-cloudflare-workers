import { ChatRoom } from "./room";

export { ChatRoom };

export interface Env {
  CHAT_ROOMS: DurableObjectNamespace<ChatRoom>;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // CORS for dev
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    // Route to Durable Object
    if (url.pathname.startsWith("/room/")) {
      const roomName = url.pathname.split("/")[2];
      const id = env.CHAT_ROOMS.idFromName(roomName);
      const room = env.CHAT_ROOMS.get(id);
      return room.fetch(request);
    }

    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
