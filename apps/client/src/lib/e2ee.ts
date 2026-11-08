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
 * Closing that needs two things, and the second is useless without the first
 * (and vice versa):
 *
 *   1. A key agreement the relay cannot substitute — ephemeral ECDH, with the
 *      public keys exchanged over the relay but never trusted as identities.
 *   2. A way for the two humans to check that the keys they ended up with are
 *      the same ones — the short authentication string below.
 *
 * Without step 2 a man in the middle simply relays both public keys, derives
 * both shared secrets, and reads the conversation while every check passes.
 * So the safety string is not decoration; it is the security property.
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
 */

const ECDH = { name: "ECDH", namedCurve: "P-256" } as const;
const AES = { name: "AES-GCM", length: 256 } as const;

/** Bump when the derivation changes; mixed versions must fail loudly. */
const PROTOCOL = "island-chat/e2ee/v1";

/** How far ahead of the expected counter a message may jump. */
const MAX_SKIP = 256;

/**
 * Fixed emoji vocabulary for the safety string. Sixteen entries so each word
 * can be selected by four bits of the digest.
 */
export const SAS_EMOJI = [
  "🐳",
  "🦀",
  "🌴",
  "🐠",
  "🪸",
  "⛵",
  "🐙",
  "🦈",
  "🌊",
  "🦭",
  "🐚",
  "⭐",
  "🪝",
  "🧭",
  "🐡",
  "🦑",
] as const;

/** Four emoji, shown on both sides, compared by the two people. */
export type SafetyString = readonly string[];

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
 * One side of one chat's encryption.
 *
 * Lifecycle: `init()` to publish a public key, `derive(peerKey)` once the
 * peer's arrives, then `encrypt` / `decrypt` per message. Keys are ephemeral
 * and this object is discarded when the chat ends.
 */
export class ChatCipher {
  private privateKey: CryptoKey | null = null;
  private publicKeyB64: string | null = null;

  private sendChain: Uint8Array | null = null;
  private receiveChain: Uint8Array | null = null;
  private sendCounter = 0;
  private receiveCounter = 0;

  private safety: SafetyString | null = null;

  private readonly roomId: string;
  private readonly role: E2eeRole;

  constructor(roomId: string, role: E2eeRole) {
    this.roomId = roomId;
    this.role = role;
  }

  /** Generates this side's ephemeral key pair and returns the public half. */
  async init(): Promise<string> {
    const pair = (await crypto.subtle.generateKey(ECDH, true, [
      "deriveBits",
    ])) as CryptoKeyPair;

    this.privateKey = pair.privateKey;
    this.publicKeyB64 = toBase64(
      await crypto.subtle.exportKey("spki", pair.publicKey),
    );
    return this.publicKeyB64;
  }

  get publicKey(): string {
    if (!this.publicKeyB64) throw new Error("call init() first");
    return this.publicKeyB64;
  }

  /** True once both keys have been exchanged and chains are ready. */
  get ready(): boolean {
    return this.sendChain !== null && this.receiveChain !== null;
  }

  /** The safety string, or null until `derive` has run. */
  get safetyString(): SafetyString | null {
    return this.safety;
  }

  /**
   * Derives both chains from the peer's public key.
   *
   * The direction names are the *roles*, not the sides, so both ends derive
   * the same pair of chains without needing to agree on anything else: what
   * the initiator calls "send" the responder calls "receive".
   */
  async derive(peerPublicKeyB64: string): Promise<void> {
    if (!this.privateKey) throw new Error("call init() first");
    if (this.ready) return; // idempotent: a duplicate key message is harmless

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

    // Safety string: bind both public keys *in sorted order*, so each side
    // computes the same value regardless of who sent first. A relay that
    // swaps either key produces a different set of emoji on each side.
    const keys = [this.publicKeyB64, peerPublicKeyB64].sort().join("|");
    const digest = await sha256(
      utf8(`${PROTOCOL}/sas|${this.roomId}|${keys}`),
    );
    this.safety = [0, 1, 2, 3].map(
      (i) => SAS_EMOJI[digest[i] % SAS_EMOJI.length],
    );
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
