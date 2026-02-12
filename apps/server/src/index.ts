import { ChatRoom } from "./room";

export { ChatRoom };

export default {
  async fetch(request: Request): Promise<Response> {
    return new Response("Server is running", { status: 200 });
  },
};
