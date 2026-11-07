# P2P Chat (3D World + WebRTC)

![World Preview](readme_assets/world.png)

A monorepo for a peer-to-peer chat application with:

- React + Vite + React Three Fiber frontend (3D island world)
- Cloudflare Workers + Durable Objects signaling backend
- WebRTC DataChannel for direct browser-to-browser messaging

## Architecture

### High-level flow

1. Client connects to the `World` Durable Object over WebSocket.
2. DO manages world presence (`spawn`, `user-joined`, `user-left`, availability).
3. User invites another user to chat (`chat-request` / `chat-response`).
4. DO relays WebRTC signaling messages (`rtc-offer`, `rtc-answer`, `rtc-ice-candidate`).
5. Peers establish direct WebRTC DataChannel and exchange messages P2P.

### Key design notes

- Presence state is stored in WebSocket attachments (hibernation-safe DO pattern),
  so the Durable Object can hibernate between messages without losing the world.
- Accepting an invitation **pairs** both sockets inside the DO. Signaling
  (`rtc-offer` / `rtc-answer` / `rtc-ice-candidate`) is relayed only between two
  users the DO has actually paired — it is not an open relay.
- Users in an active chat are marked unavailable, so invitations sent to them are
  declined immediately instead of making the sender wait out the timeout.
- WebSocket stays open while in a private chat to avoid reconnect race conditions.
- Re-spawning an existing user ID closes the older socket with code `4001`, so a
  reconnect cannot leave a ghost avatar behind.
- The wire protocol lives in `packages/types` as a discriminated union shared by
  the Worker and the client — one definition, checked at both ends.

## Repository layout

```text
apps/
	client/   # React + R3F + Tailwind UI
	server/   # Cloudflare Worker + Durable Object signaling
packages/
	types/    # Shared wire protocol + view models (imported as source)
```

## Tech stack

- Frontend: React 19, Vite 7, TypeScript, Tailwind CSS, Three.js, @react-three/fiber, @react-three/drei
- Backend: Cloudflare Workers, Durable Objects, Wrangler
- Realtime: WebSocket signaling + WebRTC DataChannel
- Package manager: pnpm workspaces

## Prerequisites

- Node.js 20+
- pnpm 10+
- Cloudflare account (for deployment)
- Wrangler CLI (installed via workspace dependencies)

## Environment configuration

Create `apps/client/.env.local`:

```bash
VITE_WORLD_WSS_URL=ws://localhost:8787
```

For deployed environments, use your public Worker URL (placeholder example):

```bash
VITE_WORLD_WSS_URL=https://<your-worker-domain>
```

Do not commit secrets or private endpoints.

## Local development

From repository root:

```bash
pnpm install
pnpm dev
```

This runs client and server in parallel using workspace scripts.

### Default local ports

- Client: `http://localhost:5173`
- Worker dev server: `http://localhost:8787`

## Scripts

### Root

- `pnpm check` — what CI runs: shared types, worker types, client lint, build
- `pnpm dev` — run all apps in dev mode
- `pnpm build` — build client and run server type checks
- `pnpm deploy` — deploy server (Cloudflare Worker)
- `pnpm clean` — remove workspace dependencies/lockfile

### Client (`apps/client`)

- `pnpm --filter client dev`
- `pnpm --filter client build`
- `pnpm --filter client preview`
- `pnpm --filter client lint`

### Server (`apps/server`)

- `pnpm --filter server dev`
- `pnpm --filter server deploy`
- `pnpm --filter server types`

## Durable Object configuration

Server DO binding is configured in `apps/server/wrangler.toml`:

- Binding name: `WORLD`
- DO class: `World`
- Migration tag present for SQLite-backed DO class registration

If you change DO class names or bindings, update migrations and redeploy.

## Messaging protocol summary

Every message is a discriminated union member of `ClientMessage` or
`ServerMessage` in `packages/types/src/index.ts`.

### Presence / world

- `spawn` → `world-state`
- `user-joined`
- `user-left`
- `set-available` → `availability-changed`

### Invitation flow

- `chat-request` → `chat-request` (delivered to the target)
- `chat-response` (`accept: true | false`)
- `chat-cancel` → `chat-cancelled` (withdraw a pending invitation)
- `chat-leave` → `peer-left` (release the pairing)

### WebRTC signaling relay

- `rtc-offer`
- `rtc-answer`
- `rtc-ice-candidate`

Relayed only between paired users. Anything else gets an `error` message
(`not-paired`, `busy`, `bad-message`, `too-large`, `not-found`, `already-paired`)
and is never broadcast.

## Testing

The Durable Object is exercised end to end by a protocol smoke test that drives
a real `wrangler dev` server with plain WebSocket clients:

```bash
pnpm --filter server dev            # terminal 1
pnpm --filter server smoke          # terminal 2
```

It covers presence, the invite handshake, relay authorization (an unpaired peer
cannot push signaling at anyone), rejection of unknown message types, pairing
release, and the reconnect/ghost-socket path.

## TURN relay

STUN only tells a peer its public address; it cannot help when the two peers
cannot reach each other at all (symmetric NAT, most mobile carriers). A TURN
server relays the traffic instead, at the cost of bandwidth through the relay.

**Credentials never ship in the bundle.** The browser asks the Worker for its
ICE configuration with `GET /ice`; the Worker mints short-lived TURN credentials
and returns them. A TURN key can mint unlimited credentials, so it is kept as a
Worker secret and never reaches the client.

### Provider A — Metered Open Relay (free, no card)

Runs on ports 80/443 (good for corporate firewalls) and needs no payment method.
Free accounts start on a trial quota — check the dashboard's "Quota remaining",
since it is not the same as the headline marketing figure.

1. Create a free account at [metered.ca](https://www.metered.ca/).
2. Left navigation → **Developers** → copy the **Secret key** and note your
   **Metered domain**.
3. Store both as secrets:

```bash
cd apps/server
pnpm exec wrangler secret put METERED_SECRET_KEY
pnpm exec wrangler secret put METERED_APP      # island-chat
```

The flow is two calls, both made Worker-side: create a credential
(`POST /api/v1/turn/credential?secretKey=…`) to get a per-credential `apiKey`,
then resolve its ICE servers (`GET /api/v1/turn/credentials?apiKey=…`). The
result is cached for at most an hour.

**Propagation matters:** a freshly created credential can take up to two minutes
to become usable across Metered's network. The client prefetches ICE config when
it connects, so it is usually warm before anyone opens a chat — but a chat
started seconds after a cold restart may fall back to STUN.

### Provider B — Cloudflare TURN (billed per GB)

Requires billing enabled on the account. Create a key at
[dash.cloudflare.com → Realtime](https://dash.cloudflare.com/?to=/:account/calls),
then:

```bash
cd apps/server
pnpm exec wrangler secret put TURN_KEY_ID
pnpm exec wrangler secret put TURN_KEY_API_TOKEN
```

Optional: `TURN_TTL_SECONDS` (default `86400`). Costs **$0.05/GB outbound**
unless used with the Realtime SFU.

Providers are tried in order (Cloudflare → Metered → static → STUN), and a
failed mint falls through to the next one, so a revoked or rate-limited key
degrades connectivity instead of breaking it.

### Local (coturn in Docker)

`infra/turn/` runs coturn with long-term credentials for testing:

```bash
# TURN_EXTERNAL_IP must be an address peers can reach — your LAN IP, not
# 127.0.0.1, because the relay socket lives inside the container network.
# Credentials come from the environment; none are committed.
TURN_EXTERNAL_IP=$(ipconfig getifaddr en0) \
TURN_USER=island TURN_PASS=localdev \
  docker compose -f infra/turn/docker-compose.yml up -d

# Point the Worker at it (no secrets needed locally)
cd apps/server
pnpm exec wrangler dev \
  --var TURN_URLS:"turn:$TURN_EXTERNAL_IP:3478?transport=udp" \
  --var TURN_USERNAME:island --var TURN_PASSWORD:localdev
```

Without any TURN configuration `/ice` still answers, with public STUN only, and
the client falls back to STUN if the endpoint is unreachable — a broken Worker
degrades connectivity rather than breaking it.

### Protecting `/ice`

`/ice` spends real quota (relay bandwidth, or a metered free tier), so it is not
open to the world:

- **Origin allowlist.** A request with no `Origin` header, or one that is not in
  `ALLOWED_ORIGINS`, gets `403`. This blocks casual scraping and bare `curl`. It
  is *not* authentication — the header can be forged — which is why the next
  layer exists.
- **Per-IP rate limit.** A Durable Object (`IceRateLimiter`) counts requests per
  client IP in a sliding window and answers `429` with `Retry-After` when the
  budget is spent. Defaults: 30 requests per hour (`ICE_RATE_LIMIT`,
  `ICE_RATE_WINDOW_SECONDS`). Only active when a TURN provider is configured,
  since STUN-only responses cost nothing.
- Credentials are cached per isolate until a minute before expiry, so normal
  traffic mints rarely.

`curl https://…/ice` now returns `403` by design. To check it manually, send the
header:

```bash
curl -H "Origin: https://p2p-chat-app-cloudflare-workers.pages.dev" \
  https://p2p-chat-server.kusalkalingainfo.workers.dev/ice
```

## Known limitations

- **Relay-to-relay is unverified locally.** With coturn in Docker and both peers
  on the same host, the only peer address available is the TURN server's own
  external address, which coturn refuses to relay to (loop protection). Relay
  allocation itself is verified; a full media path through the relay needs two
  peers on different networks.
- World positions are assigned by the client and rendered by index on a ring;
  there is no movement or collision.

## License

[MIT](LICENSE) © 2026 kusalkalinga00.

Use it, fork it, ship it. Attribution is the only requirement.
