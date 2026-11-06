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

## Known limitations

- **No TURN server.** ICE uses public STUN only, so peers behind symmetric NAT
  (most mobile carriers) cannot connect. Adding a TURN relay is the next step for
  real-world connectivity.
- World positions are assigned by the client and rendered by index on a ring;
  there is no movement or collision.
