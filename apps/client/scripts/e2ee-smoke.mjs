/**
 * Smoke test for the E2EE layer.
 *
 * Imports src/lib/e2ee.ts directly — Node strips the types on load (22.18+,
 * 23 and later by default), so the exact module the browser runs is what gets
 * tested here: no reimplementation, no mocks, no bundler step.
 *
 * Run: node apps/client/scripts/e2ee-smoke.mjs
 */

import { pathToFileURL } from "node:url";
import path from "node:path";

const here = path.dirname(new URL(import.meta.url).pathname);
const moduleUrl = pathToFileURL(path.join(here, "../src/lib/e2ee.ts")).href;

let passed = 0;
const failures = [];

function check(name, condition) {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL ${name}`);
  }
}

async function main() {
  const { ChatCipher, DecryptionError } = await import(moduleUrl);

  const roomId = "aaa-bbb";

  // ── Both sides derive the same keys and the same safety string ─────────
  const alice = new ChatCipher(roomId, "initiator");
  const bob = new ChatCipher(roomId, "responder");
  const aliceKey = await alice.init();
  const bobKey = await bob.init();

  check("public keys are distinct", aliceKey !== bobKey);
  check("no safety string before deriving", alice.safetyString === null);

  await alice.derive(bobKey);
  await bob.derive(aliceKey);

  check("both sides are ready", alice.ready && bob.ready);
  check(
    "safety strings match",
    alice.safetyString.join("") === bob.safetyString.join(""),
  );
  check("safety string is four emoji", alice.safetyString.length === 4);

  // ── Round trip in both directions ──────────────────────────────────────
  const outbound = await alice.encrypt("hello from alice");
  check("ciphertext does not contain plaintext", !outbound.c.includes("alice"));
  check(
    "responder decrypts initiator's message",
    (await bob.decrypt(outbound)) === "hello from alice",
  );

  const reply = await bob.encrypt("and hello back");
  check(
    "initiator decrypts responder's message",
    (await alice.decrypt(reply)) === "and hello back",
  );

  // ── Direction chains are independent ───────────────────────────────────
  check(
    "no nonce collision between directions",
    outbound.n === 0 && reply.n === 0 && outbound.c !== reply.c,
  );

  // ── Tampering and replay ───────────────────────────────────────────────
  const third = await alice.encrypt("third message");
  const tampered = { n: third.n, c: Buffer.from(third.c, "base64").toString("base64") };
  tampered.c = tampered.c.slice(0, -8) + "AAAAAAAA";
  let tamperRejected = false;
  try {
    await bob.decrypt(tampered);
  } catch (error) {
    tamperRejected = error instanceof DecryptionError;
  }
  check("tampered ciphertext is rejected", tamperRejected);

  await alice.encrypt("fourth message");
  let replayRejected = false;
  try {
    await bob.decrypt(outbound); // counter already consumed
  } catch (error) {
    replayRejected = error instanceof DecryptionError;
  }
  check("replayed message is rejected", replayRejected);

  // ── A relay in the middle is detectable ────────────────────────────────
  // Mallory terminates two sessions. Each peer completes a handshake and
  // everything "works" — but the safety strings differ, which is the whole
  // point of showing them.
  const malloryForAlice = new ChatCipher(roomId, "responder");
  const malloryForBob = new ChatCipher(roomId, "initiator");
  const m1 = await malloryForAlice.init();
  const m2 = await malloryForBob.init();

  const alice2 = new ChatCipher(roomId, "initiator");
  const bob2 = new ChatCipher(roomId, "responder");
  const a2 = await alice2.init();
  const b2 = await bob2.init();
  await alice2.derive(m1);
  await malloryForAlice.derive(a2);
  await malloryForBob.derive(b2);
  await bob2.derive(m2);

  check(
    "MITM handshake succeeds (the attack is not blocked by crypto alone)",
    alice2.ready && bob2.ready,
  );
  check(
    "MITM safety strings differ, so comparison catches it",
    alice2.safetyString.join("") !== bob2.safetyString.join(""),
  );

  console.log(
    `\n${passed} checks passed${failures.length ? `, ${failures.length} failed` : ""}`,
  );
  if (failures.length) {
    console.log(failures.map((f) => `  - ${f}`).join("\n"));
    process.exitCode = 1;
  }
}

await main();
