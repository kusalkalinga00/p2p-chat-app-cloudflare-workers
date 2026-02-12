import { DurableObjectState } from "@cloudflare/workers-types";

export class ChatRoom {
  constructor(private state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    return new Response("DO is working");
  }
}
