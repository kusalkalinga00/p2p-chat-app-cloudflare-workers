import { World } from "./world";

export { World };

export interface Env {
  WORLD: DurableObjectNamespace<World>;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // CORS for dev
    const allowedOrigins = [
      "http://localhost:5173",
      "https://p2p-chat-app-cloudflare-workers.pages.dev",
    ];

    const origin = request.headers.get("Origin");

    const allowOrigin = allowedOrigins.includes(origin!)
      ? origin
      : "https://p2p-chat-app-cloudflare-workers.pages.dev";

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": allowOrigin!,
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    // Route to Durable Object
    if (url.pathname.startsWith("/world/")) {
      const worldName = url.pathname.split("/")[2];
      const id = env.WORLD.idFromName(worldName);
      const world = env.WORLD.get(id);
      return world.fetch(request);
    }

    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
