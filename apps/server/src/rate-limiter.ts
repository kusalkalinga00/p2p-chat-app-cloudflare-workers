import { DurableObject } from "cloudflare:workers";

/**
 * Sliding-window rate limiter, one instance per client IP.
 *
 * A Durable Object is the right home for this: a module-level counter in the
 * Worker would live inside a single isolate, so an attacker hitting different
 * colos would get a fresh budget in each one. One DO per IP serialises the
 * counting globally.
 *
 * State is in memory rather than storage. A DO can be evicted between requests,
 * which resets a window early — acceptable for abuse prevention (it can only
 * make the limiter more permissive, never lock anyone out), and it keeps the
 * hot path free of storage writes.
 */
export class IceRateLimiter extends DurableObject {
  private hits: number[] = [];

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const limit = Number(url.searchParams.get("limit")) || 30;
    const windowMs = (Number(url.searchParams.get("window")) || 3600) * 1000;
    const now = Date.now();

    // Drop timestamps that fell out of the window.
    this.hits = this.hits.filter((at) => now - at < windowMs);

    if (this.hits.length >= limit) {
      const oldest = this.hits[0];
      const retryAfter = Math.max(
        1,
        Math.ceil((windowMs - (now - oldest)) / 1000),
      );

      return Response.json(
        { allowed: false, retryAfter },
        { status: 429, headers: { "Retry-After": String(retryAfter) } },
      );
    }

    this.hits.push(now);
    return Response.json({ allowed: true, remaining: limit - this.hits.length });
  }
}
