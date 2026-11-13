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

  // ── Both sides derive the same keys ───────────────────────────────────
  const alice = new ChatCipher(roomId, "initiator");
  const bob = new ChatCipher(roomId, "responder");
  const aliceKey = await alice.init();
  const bobKey = await bob.init();

  check("public keys are distinct", aliceKey !== bobKey);

  await alice.derive(bobKey);
  await bob.derive(aliceKey);

  check("both sides are ready", alice.ready && bob.ready);

  // ── Key confirmation ─────────────────────────────────────────────────
  const aliceTag = await alice.confirmationTag();
  const bobTag = await bob.confirmationTag();
  check("both sides compute the same confirmation tag", aliceTag === bobTag);

  let unconfirmedRejected = false;
  try {
    await alice.encrypt("sent before confirmation");
  } catch {
    unconfirmedRejected = true;
  }
  check("encrypt refuses before confirmation", unconfirmedRejected);

  await alice.verifyConfirmation(bobTag);
  await bob.verifyConfirmation(aliceTag);
  check("both sides are confirmed", alice.confirmed && bob.confirmed);

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

  // ── A relay in the middle is not detectable from the crypto alone ─────
  // Mallory terminates two sessions. Both peers complete a handshake and
  // everything "works": without an out-of-band channel there is no way to
  // authenticate the peer. This is documented, not accidental — the app
  // removes the safety-code step because comparing it inside the chat is
  // circular.
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
    "MITM handshake completes: the crypto does not authenticate the peer",
    alice2.ready &&
      bob2.ready &&
      malloryForAlice.ready &&
      malloryForBob.ready,
  );

  // Key confirmation is not a MITM defence (a relay holds a valid, matching
  // secret with each victim). It proves the two ends of *this* session derived
  // the same secret, so a tag from a different session must not verify.
  let crossSessionRejected = false;
  try {
    await alice2.verifyConfirmation(await bob2.confirmationTag());
  } catch (error) {
    crossSessionRejected = error instanceof DecryptionError;
  }
  check("confirmation tag from another session is rejected", crossSessionRejected);
  check("a failed confirmation poisons the cipher", alice2.failed && !alice2.confirmed);


  console.log(
    `\n${passed} checks passed${failures.length ? `, ${failures.length} failed` : ""}`,
  );
  if (failures.length) {
    console.log(failures.map((f) => `  - ${f}`).join("\n"));
    process.exitCode = 1;
  }
}

await main();
