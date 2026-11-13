/**
 * End-to-end encryption for private chat.
 *
 * ---------------------------------------------------------------------------
 * What this defends against, and what it does not
 * ---------------------------------------------------------------------------
 *
 * Chat already travels over a WebRTC DataChannel, which is encrypted with
 * DTLS, and on a direct connection the messages never reach the server at
 * all. So "encrypt the messages" on its own would add nothing.
 *
 * The gap is the part DTLS cannot cover: the signalling relay. It forwards
 * the SDP, and the SDP carries the DTLS fingerprints. Whoever controls that
 * relay can substitute its own fingerprints, terminate two separate DTLS
 * sessions — one with each peer — and read everything while both sides
 * believe they are talking directly to each other.
 *
 * Ephemeral ECDH over the relay closes the *passive* half of that: the relay
 * only ever sees public keys, and each chat derives a fresh shared secret it
 * cannot compute. It does not authenticate the peer. A relay that actively
 * joins two sessions can still sit between them, because these are strangers
 * and there is no out-of-band channel over which to compare keys.
 *
 * This is why there is deliberately no safety-code / emoji comparison step.
 * The only channel two strangers share is the chat itself, so asking them to
 * read a code to each other inside it is circular: whoever is in the middle
 * can rewrite the code along with everything else. The app does not pretend
 * that comparison adds a guarantee it cannot add here.
 *
 * The guarantee is therefore: message contents are end-to-end encrypted
 * against the relay and the server, but the peer is not authenticated.
 *
 * ---------------------------------------------------------------------------
 * What is here
 * ---------------------------------------------------------------------------
 *
 * - Ephemeral ECDH P-256 per chat. WebCrypto, so no third-party crypto code
 *   and no new dependency. P-256 rather than X25519 only because WebCrypto
 *   support for X25519 is not yet universal; the construction is the same.
 * - HKDF-SHA256 to turn the shared secret into two independent chains, one
 *   per direction, so the two sides can never reuse a key or a nonce.
 * - A symmetric ratchet: every message gets its own key, derived from a chain
 *   key that is advanced and then discarded. Compromising the current state
 *   does not expose earlier messages.
 * - AES-256-GCM, with the room id as associated data so a ciphertext cannot
 *   be replayed into a different conversation.
 * - A key confirmation tag (HMAC over both public keys) in each direction, so
 *   a peer that is not holding the same shared secret is detected before the
 *   first message, not after it fails to decrypt. Agreement, not identity.
 */

const ECDH = { name: "ECDH", namedCurve: "P-256" } as const;
const AES = { name: "AES-GCM", length: 256 } as const;

/** Bump when the derivation changes; mixed versions must fail loudly. */
const PROTOCOL = "island-chat/e2ee/v4";

/**
 * Version advertised on the wire so a peer running different derivation code
 * is rejected with a clear message instead of silently deriving other keys.
 */
export const E2EE_VERSION = 4;

/** How far ahead of the expected counter a message may jump. */
const MAX_SKIP = 256;

export interface EncryptedPayload {
  /** Ratchet step. Also selects the nonce. */
  n: number;
  /** base64 ciphertext, GCM tag included. */
  c: string;
}

export type E2eeRole = "initiator" | "responder";

export class DecryptionError extends Error {}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * UTF-8 bytes in an ArrayBuffer-backed view.
 *
 * TextEncoder returns Uint8Array<ArrayBufferLike> under TS 5.9's stricter
 * typing, which WebCrypto's BufferSource parameters reject; copying into a
 * fresh view gives the ArrayBuffer-backed type they want.
 */
function utf8(value: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(encoder.encode(value));
}

function toBase64(bytes: Uint8Array | ArrayBuffer): string {
  const array = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const byte of array) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** HKDF-SHA256 over raw key material, returning `length` bytes. */
async function hkdf(
  ikm: Uint8Array,
  info: string,
  length = 32,
  salt?: Uint8Array,
): Promise<Uint8Array> {
  const base = await crypto.subtle.importKey("raw", ikm, "HKDF", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: salt ?? new Uint8Array(0),
      info: utf8(`${PROTOCOL}/${info}`),
    },
    base,
    length * 8,
  );
  return new Uint8Array(bits);
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

/** Nonce for message `n`: 4 zero bytes then the counter, big-endian. */
function nonceFor(n: number): Uint8Array {
  const nonce = new Uint8Array(12);
  new DataView(nonce.buffer).setBigUint64(4, BigInt(n));
  return nonce;
}

/**
 * Compares two byte arrays without an early exit.
 *
 * The confirmation tag is compared against a value an attacker would have to
 * guess; a length-dependent early return leaks how much of the guess was
 * right, which is exactly the one bit useful to them.
 */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i += 1) difference |= a[i] ^ b[i];
  return difference === 0;
}

/**
 * One side of one chat's encryption.
 *
 * Lifecycle: `init()` to publish a public key, `derive(peerKey)` once the
 * peer's arrives, `confirmationTag()` / `verifyConfirmation()` to prove both
 * sides agree, then `encrypt` / `decrypt` per message. Keys are ephemeral and
 * this object is discarded when the chat ends.
 */
export class ChatCipher {
  private privateKey: CryptoKey | null = null;
  private publicKeyB64: string | null = null;

  /**
   * Key generation is async, and the peer's key can arrive before it settles.
   * Caching the promise makes `init()` idempotent and lets `derive()` wait for
   * it instead of throwing away an otherwise valid key exchange.
   */
  private initPromise: Promise<string> | null = null;

  /** Same idea for derivation: a duplicate key message must not re-derive. */
  private derivePromise: Promise<void> | null = null;

  private sendChain: Uint8Array | null = null;
  private receiveChain: Uint8Array | null = null;
  private sendCounter = 0;
  private receiveCounter = 0;

  /** Keyed HMAC used to prove both sides derived the same secret. */
  private confirmKey: CryptoKey | null = null;
  /** The exact bytes the confirmation is bound to. */
  private transcript: string | null = null;

  private confirmedState = false;
  private failedState = false;

  private readonly roomId: string;
  private readonly role: E2eeRole;

  constructor(roomId: string, role: E2eeRole) {
    this.roomId = roomId;
    this.role = role;
  }

  /** Generates this side's ephemeral key pair and returns the public half. */
  async init(): Promise<string> {
    if (!this.initPromise) {
      this.initPromise = (async () => {
        const pair = (await crypto.subtle.generateKey(ECDH, true, [
          "deriveBits",
        ])) as CryptoKeyPair;

        this.privateKey = pair.privateKey;
        this.publicKeyB64 = toBase64(
          await crypto.subtle.exportKey("spki", pair.publicKey),
        );
        return this.publicKeyB64;
      })();
    }
    return this.initPromise;
  }

  get publicKey(): string {
    if (!this.publicKeyB64) throw new Error("call init() first");
    return this.publicKeyB64;
  }

  /** True once both keys have been exchanged and chains are ready. */
  get ready(): boolean {
    return this.sendChain !== null && this.receiveChain !== null;
  }

  /**
   * True once the peer's confirmation tag verified. Messages must not be sent
   * before this: it is the proof that both ends hold the same secret.
   */
  get confirmed(): boolean {
    return this.confirmedState;
  }

  /** True if confirmation failed; this cipher must never be used again. */
  get failed(): boolean {
    return this.failedState;
  }

  /**
   * Derives both chains from the peer's public key.
   *
   * The direction names are the *roles*, not the sides, so both ends derive
   * the same pair of chains without needing to agree on anything else: what
   * the initiator calls "send" the responder calls "receive".
   *
   * Safe to call before `init()` has settled: it awaits key generation rather
   * than dropping the peer's key. Idempotent, so a repeated key message is
   * harmless.
   */
  async derive(peerPublicKeyB64: string): Promise<void> {
    if (!this.derivePromise) {
      this.derivePromise = this.deriveOnce(peerPublicKeyB64);
    }
    return this.derivePromise;
  }

  private async deriveOnce(peerPublicKeyB64: string): Promise<void> {
    await this.init();
    if (!this.privateKey) throw new Error("call init() first");

    let peerKey: CryptoKey;
    try {
      peerKey = await crypto.subtle.importKey(
        "spki",
        fromBase64(peerPublicKeyB64),
        ECDH,
        false,
        [],
      );
    } catch {
      throw new DecryptionError("Peer sent an unusable public key");
    }

    const shared = new Uint8Array(
      await crypto.subtle.deriveBits(
        { name: "ECDH", public: peerKey },
        this.privateKey,
        256,
      ),
    );

    const salt = await sha256(utf8(this.roomId));
    const root = await hkdf(shared, "root", 32, salt);

    const sendInfo = this.role === "initiator" ? "chain/initiator" : "chain/responder";
    const receiveInfo =
      this.role === "initiator" ? "chain/responder" : "chain/initiator";

    this.sendChain = await hkdf(root, sendInfo);
    this.receiveChain = await hkdf(root, receiveInfo);

    // A separate key proves key agreement without being usable to encrypt
    // messages, so the confirmation can never leak a message key.
    this.confirmKey = await crypto.subtle.importKey(
      "raw",
      await hkdf(root, "confirm"),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );

    // Bind both public keys *in sorted order*, so each side computes the same
    // transcript regardless of who sent first. This is what the confirmation
    // HMAC covers.
    const keys = [this.publicKeyB64, peerPublicKeyB64].sort().join("|");
    this.transcript = `${PROTOCOL}/transcript|${this.roomId}|${keys}`;
  }

  /**
   * This side's confirmation tag: an HMAC over the key-exchange transcript.
   * The peer verifies it with the key derived from the shared secret, so a
   * peer that did not derive the same secret cannot produce a matching tag.
   */
  async confirmationTag(): Promise<string> {
    if (!this.confirmKey || !this.transcript) {
      throw new Error("not derived yet");
    }
    const tag = await crypto.subtle.sign(
      "HMAC",
      this.confirmKey,
      utf8(this.transcript),
    );
    return toBase64(tag);
  }

  /**
   * Verifies the peer's confirmation tag.
   *
   * Awaits an in-flight `derive()` rather than reading half-built state: the
   * tag is sent over the signalling socket *after* the peer's key, but this
   * side handles that key asynchronously, so the two can overlap.
   */
  async verifyConfirmation(tag: string): Promise<void> {
    if (!this.derivePromise) {
      throw new DecryptionError("Confirmation arrived before the key exchange");
    }
    await this.derivePromise;

    let received: Uint8Array;
    try {
      received = fromBase64(tag);
    } catch {
      this.failedState = true;
      throw new DecryptionError("Malformed key confirmation");
    }

    const expected = fromBase64(await this.confirmationTag());
    if (!timingSafeEqual(expected, received)) {
      this.failedState = true;
      throw new DecryptionError("Key confirmation failed");
    }
    this.confirmedState = true;
  }

  /** Advances a chain one step, returning the message key and the new chain. */
  private async step(chain: Uint8Array): Promise<{
    messageKey: CryptoKey;
    nextChain: Uint8Array;
  }> {
    const raw = await hkdf(chain, "message");
    const messageKey = await crypto.subtle.importKey("raw", raw, AES, false, [
      "encrypt",
      "decrypt",
    ]);
    return { messageKey, nextChain: await hkdf(chain, "next") };
  }

  async encrypt(plaintext: string): Promise<EncryptedPayload> {
    if (!this.sendChain) throw new Error("not derived yet");
    // Fail closed: a session whose confirmation has not verified could be
    // talking to a relay that does not hold the same secret.
    if (!this.confirmed) throw new Error("key confirmation is not complete");

    const { messageKey, nextChain } = await this.step(this.sendChain);
    const n = this.sendCounter;
    this.sendCounter += 1;
    // The old chain key is dropped here: this is the forward-secrecy step.
    this.sendChain = nextChain;

    const ciphertext = await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: nonceFor(n),
        additionalData: utf8(this.roomId),
      },
      messageKey,
      utf8(plaintext),
    );

    return { n, c: toBase64(ciphertext) };
  }

  async decrypt(payload: EncryptedPayload): Promise<string> {
    if (!this.receiveChain) throw new Error("not derived yet");
    if (!Number.isInteger(payload.n) || payload.n < 0) {
      throw new DecryptionError("Malformed message counter");
    }

    const skip = payload.n - this.receiveCounter;
    if (skip < 0) throw new DecryptionError("Replayed message counter");
    if (skip > MAX_SKIP) throw new DecryptionError("Message counter too far ahead");

    // DataChannels are ordered, so this normally advances by one. Skipping is
    // supported for the rare case of a dropped frame.
    let chain = this.receiveChain;
    let messageKey: CryptoKey | null = null;
    for (let i = 0; i <= skip; i += 1) {
      const stepped = await this.step(chain);
      chain = stepped.nextChain;
      messageKey = stepped.messageKey;
    }
    this.receiveChain = chain;
    this.receiveCounter = payload.n + 1;

    try {
      const plaintext = await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: nonceFor(payload.n),
          additionalData: utf8(this.roomId),
        },
        messageKey!,
        fromBase64(payload.c),
      );
      return decoder.decode(plaintext);
    } catch {
      // Wrong key, tampered ciphertext, or a different room's message.
      throw new DecryptionError("Message could not be decrypted");
    }
  }
}
