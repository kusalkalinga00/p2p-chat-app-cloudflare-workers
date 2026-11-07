/**
 * Protocol smoke test for the World Durable Object.
 *
 * Drives a real `wrangler dev` server with plain WebSocket clients, so it
 * exercises hibernatable WebSocket attachments, the invite handshake, and
 * the relay authorization rules exactly as the browser would.
 *
 *   pnpm --filter server dev            # in one terminal
 *   node apps/server/scripts/smoke.mjs  # in another
 */
import assert from "node:assert/strict";

const ORIGIN = process.env.WORLD_URL ?? "ws://127.0.0.1:8787";
/** Each run gets its own Durable Object so runs never share presence. */
const WORLD = `smoke-${Date.now().toString(36)}`;

let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`  ✓ ${name}`);
}

/** Minimal client: buffers messages and lets you await the next match. */
function connect(id) {
  const ws = new WebSocket(
    `${ORIGIN}/world/${WORLD}?id=${encodeURIComponent(id)}`,
  );
  const buffer = [];
  const waiters = [];
  const closes = [];

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    const index = waiters.findIndex((w) => w.predicate(msg));
    if (index >= 0) {
      const [waiter] = waiters.splice(index, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(msg);
    } else {
      buffer.push(msg);
    }
  };

  ws.onclose = (event) => {
    for (const waiter of closes.splice(0)) waiter.resolve(event.code);
  };

  const opened = new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error(`${id}: failed to connect`));
  });

  return {
    id,
    ws,
    opened,
    send(payload) {
      ws.send(JSON.stringify(payload));
    },
    spawn(available = true) {
      this.send({
        type: "spawn",
        x: 0,
        y: 0.5,
        z: 0,
        color: "#123456",
        available,
      });
    },
    /** Resolve with the next message matching `predicate` (buffered first). */
    next(predicate, label = "message", timeoutMs = 3000) {
      const match = (msg) => (typeof predicate === "string" ? msg.type === predicate : predicate(msg));

      const index = buffer.findIndex(match);
      if (index >= 0) return Promise.resolve(buffer.splice(index, 1)[0]);

      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const seen = buffer.map((m) => m.type).join(", ") || "none";
          reject(new Error(`${id}: timed out waiting for ${label} (buffered: ${seen})`));
        }, timeoutMs);
        waiters.push({ predicate: match, resolve, timer });
      });
    },
    nextClose() {
      return new Promise((resolve) => closes.push({ resolve }));
    },
    /** Everything received so far, for negative assertions. */
    drain() {
      return buffer.splice(0);
    },
    close() {
      ws.close();
    },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const HTTP = ORIGIN.replace(/^ws/, "http");

/** ICE configuration endpoint: what the browser uses to build its connection. */
async function checkIceEndpoint() {
  // No Origin header at all (a bare curl) must be refused: minting credentials
  // for anonymous callers spends the relay quota on anyone's behalf.
  const noOrigin = await fetch(`${HTTP}/ice`);
  assert.equal(noOrigin.status, 403);
  ok("/ice refuses a request with no Origin header");

  const response = await fetch(`${HTTP}/ice`, {
    headers: { Origin: "http://localhost:5180" },
  });
  assert.equal(response.status, 200);

  const body = await response.json();
  assert.ok(Array.isArray(body.iceServers) && body.iceServers.length > 0);
  assert.equal(
    response.headers.get("access-control-allow-origin"),
    "http://localhost:5180",
  );
  assert.match(response.headers.get("vary") ?? "", /Origin/i);
  ok("/ice returns an ICE config with CORS for an allowed origin");

  // An unknown origin is refused outright, not merely left un-echoed.
  const foreign = await fetch(`${HTTP}/ice`, {
    headers: { Origin: "https://evil.example" },
  });
  assert.equal(foreign.status, 403);
  assert.notEqual(
    foreign.headers.get("access-control-allow-origin"),
    "https://evil.example",
  );
  ok("/ice refuses an unknown origin");

  const health = await fetch(`${HTTP}/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).ok, true);
  ok("/health responds");

  const missing = await fetch(`${HTTP}/nope`);
  assert.equal(missing.status, 404);
  ok("unknown routes 404");
}

async function main() {
  console.log(`\nworld: ${ORIGIN}/world/${WORLD}\n`);

  await checkIceEndpoint();

  const a = connect("user-a");
  await a.opened;
  a.spawn();
  const firstState = await a.next("world-state");
  assert.deepEqual(firstState.users, []);
  ok("first user gets an empty world-state");

  const b = connect("user-b");
  await b.opened;
  b.spawn();
  const stateForB = await b.next("world-state");
  assert.equal(stateForB.users.length, 1);
  assert.equal(stateForB.users[0].id, "user-a");
  ok("second user sees the first in world-state");

  const joined = await a.next("user-joined");
  assert.equal(joined.user.id, "user-b");
  assert.equal(joined.user.available, true);
  ok("first user is told about the join");

  // ── Invitation handshake ──────────────────────────────────────────
  a.send({ type: "chat-request", target: "user-b" });
  const invite = await b.next("chat-request");
  assert.equal(invite.from, "user-a");
  ok("invitation is delivered to the target");

  b.send({ type: "chat-response", target: "user-a", accept: true, roomId: "r1" });
  const accepted = await a.next("chat-response");
  assert.equal(accepted.accept, true);
  assert.equal(accepted.from, "user-b");
  ok("acceptance is relayed to the inviter");

  const busyA = await a.next("availability-changed");
  const busyB = await a.next("availability-changed");
  const busy = new Map([
    [busyA.id, busyA.available],
    [busyB.id, busyB.available],
  ]);
  assert.deepEqual(
    [...busy.entries()].sort(),
    [
      ["user-a", false],
      ["user-b", false],
    ],
  );
  ok("both users are marked unavailable once paired");

  // ── Signaling relay ───────────────────────────────────────────────
  a.send({
    type: "rtc-offer",
    target: "user-b",
    payload: { type: "offer", sdp: "v=0..." },
  });
  const offer = await b.next("rtc-offer");
  assert.equal(offer.from, "user-a");
  assert.equal(offer.payload.sdp, "v=0...");
  ok("SDP offer is relayed to the paired peer");

  b.send({
    type: "rtc-ice-candidate",
    target: "user-a",
    payload: { candidate: "candidate:1 1 udp 1 1.2.3.4 5000 typ host" },
  });
  const candidate = await a.next("rtc-ice-candidate");
  assert.equal(candidate.from, "user-b");
  ok("ICE candidate is relayed to the paired peer");

  // ── Authorization ─────────────────────────────────────────────────
  const c = connect("user-c");
  await c.opened;
  c.spawn();
  await c.next("world-state");

  c.send({
    type: "rtc-offer",
    target: "user-a",
    payload: { type: "offer", sdp: "evil" },
  });
  const notPaired = await c.next("error");
  assert.equal(notPaired.code, "not-paired");
  ok("unpaired peer cannot push signaling at another user");

  c.send({ type: "totally-made-up", target: "user-a" });
  const unknown = await c.next("error");
  assert.equal(unknown.code, "bad-message");
  ok("unknown message types are rejected, not broadcast");

  await sleep(100);
  assert.deepEqual(a.drain().filter((m) => m.type === "rtc-offer"), []);
  ok("rejected messages never reach the world");

  c.send({ type: "chat-request", target: "user-a" });
  const busyDecline = await c.next("chat-response");
  assert.equal(busyDecline.accept, false);
  ok("inviting a busy user declines immediately");

  // ── Leaving ───────────────────────────────────────────────────────
  a.send({ type: "chat-leave" });
  const peerLeft = await b.next("peer-left");
  assert.equal(peerLeft.id, "user-a");
  ok("leaving a chat notifies the peer");

  const freeAgain = await b.next(
    (m) => m.type === "availability-changed" && m.id === "user-b" && m.available,
  );
  assert.equal(freeAgain.available, true);
  ok("leaving a chat makes the peer available again");

  // ── Reconnect / ghost sockets ─────────────────────────────────────
  const replaced = a.nextClose();
  const a2 = connect("user-a");
  await a2.opened;
  a2.spawn();
  const code = await replaced;
  assert.equal(code, 4001);
  ok("re-spawning an ID closes the stale socket with 4001");

  const observer = connect("observer");
  await observer.opened;
  observer.spawn();
  const seen = await observer.next("world-state");
  const ids = seen.users.map((u) => u.id).sort();
  assert.deepEqual(ids, ["user-a", "user-b", "user-c"]);
  ok("a reconnecting user appears exactly once");

  a2.close();
  const left = await observer.next(
    (m) => m.type === "user-left" && m.id === "user-a",
  );
  assert.equal(left.id, "user-a");
  ok("closing a socket removes the user");

  for (const client of [a2, b, c, observer]) client.close();
  console.log(`\n${passed} checks passed\n`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(`\n✗ ${err.message}\n`);
    process.exit(1);
  },
);
