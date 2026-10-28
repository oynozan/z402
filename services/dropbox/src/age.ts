/**
 * Whether a blob looks like an age v1 file (https://age-encryption.org/v1), in its binary form or in ASCII armor.
 *
 * This is a plausibility check and not proof. It reads the header the way age does (intro, recipient stanzas, header
 * MAC line) and then asks the payload to look like ciphertext. The MAC cannot be checked without the file key and
 * nothing can tell ciphertext from random bytes, so someone who builds that shape around garbage gets through. What it
 * keeps out is the honest mistake of an agent that forgot to encrypt and uploaded plaintext, JSON or a key file.
 */

export type AgeCheck = { ok: true } | { ok: false; reason: string };

const INTRO = "age-encryption.org/v1";
const ARMOR_BEGIN = "-----BEGIN AGE ENCRYPTED FILE-----";
const ARMOR_END = "-----END AGE ENCRYPTED FILE-----";

/** A 16-byte payload nonce and the 16-byte tag of the one chunk every file has, even an empty one */
const MIN_PAYLOAD_BYTES = 32;
/** Stanza bodies and armor lines are base64 in lines of 64 characters, the last one shorter */
const BODY_LINE = 64;
/** From this size the byte histogram says something, below it only the number of distinct values does */
const ENTROPY_FROM_BYTES = 512;
const MIN_ENTROPY_BITS = 7.0;
const MAX_DISTINCT_REQUIRED = 64;

const ARG = /^[\x21-\x7e]+$/;
const BODY = /^[A-Za-z0-9+/]*$/;
const MAC = /^[A-Za-z0-9+/]{43}$/;
const ARMOR_BODY = /^[A-Za-z0-9+/]+={0,2}$/;

const refuse = (reason: string): AgeCheck => ({ ok: false, reason });

function isSpace(byte: number): boolean {
  return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;
}

/** A byte that String.prototype.trim removes from a line read as latin1 */
function isTrimmed(byte: number): boolean {
  return byte === 0x20 || (byte >= 0x09 && byte <= 0x0d) || byte === 0xa0;
}

/** Shannon entropy of the byte histogram in bits per byte, which is 8 for uniform bytes */
function entropy(counts: Uint32Array, total: number): number {
  let bits = 0;
  for (const count of counts) {
    if (count > 0) {
      const p = count / total;
      bits -= p * Math.log2(p);
    }
  }
  return bits;
}

function looksLikeCiphertext(payload: Uint8Array): boolean {
  const counts = new Uint32Array(256);
  for (const byte of payload) counts[byte] = (counts[byte] ?? 0) + 1;
  if (payload.length >= ENTROPY_FROM_BYTES) return entropy(counts, payload.length) >= MIN_ENTROPY_BITS;
  let distinct = 0;
  for (const count of counts) if (count > 0) distinct += 1;
  return distinct >= Math.min(MAX_DISTINCT_REQUIRED, payload.length / 2);
}

function binary(file: Buffer): AgeCheck {
  let pos = 0;
  const nextLine = (): string | undefined => {
    const end = file.indexOf(0x0a, pos);
    if (end < 0) return undefined;
    const line = file.toString("latin1", pos, end);
    pos = end + 1;
    return line;
  };

  if (nextLine() !== INTRO) return refuse(`missing the "${INTRO}" header line`);

  let stanzas = 0;
  for (;;) {
    const line = nextLine();
    if (line === undefined) return refuse("the header ends before its MAC line");
    if (line.startsWith("--- ")) {
      if (stanzas === 0) return refuse("the header has no recipient stanza");
      if (!MAC.test(line.slice(4))) return refuse("malformed header MAC line");
      break;
    }
    if (!line.startsWith("-> ") || !line.slice(3).split(" ").every((arg) => ARG.test(arg))) {
      return refuse("malformed recipient stanza");
    }
    stanzas += 1;
    // The body is full lines and then one shorter line, which may be empty
    for (;;) {
      const body = nextLine();
      if (body === undefined) return refuse("the header ends inside a recipient stanza");
      if (body.length > BODY_LINE || !BODY.test(body)) return refuse("malformed recipient stanza body");
      if (body.length < BODY_LINE) break;
    }
  }

  const payload = file.subarray(pos);
  if (payload.length < MIN_PAYLOAD_BYTES) return refuse(`the payload is shorter than ${MIN_PAYLOAD_BYTES} bytes`);
  if (!looksLikeCiphertext(payload)) return refuse("the payload does not look like ciphertext");
  return { ok: true };
}

/** Reads the armor from its begin line in one pass, so no line costs more than its own bytes */
function armored(file: Buffer, begin: number): AgeCheck {
  const body = Buffer.alloc(file.length);
  let size = 0;
  let lines = 0;
  // The last line is the end line, so the base64 stops where it starts
  let lastAt = 0;
  let last = "";
  for (let pos = begin; pos < file.length; ) {
    const newline = file.indexOf(0x0a, pos);
    const stop = newline < 0 ? file.length : newline;
    let from = pos;
    let to = stop;
    pos = stop + 1;
    while (from < to && isTrimmed(file[from] ?? 0)) from += 1;
    while (to > from && isTrimmed(file[to - 1] ?? 0)) to -= 1;
    if (from === to) continue;
    lines += 1;
    if (lines === 1) {
      if (file.toString("latin1", from, to) !== ARMOR_BEGIN) {
        return refuse(`the armor does not start with "${ARMOR_BEGIN}"`);
      }
      continue;
    }
    lastAt = size;
    last = to - from === ARMOR_END.length ? file.toString("latin1", from, to) : "";
    size += file.copy(body, size, from, to);
  }
  if (lines < 2 || last !== ARMOR_END) return refuse(`the armor does not end with "${ARMOR_END}"`);

  const text = body.toString("latin1", 0, lastAt);
  if (!ARMOR_BODY.test(text) || text.length % 4 !== 0) return refuse("the armor body is not base64");
  const inner = binary(Buffer.from(text, "base64"));
  return inner.ok ? inner : refuse(`armored file: ${inner.reason}`);
}

export function isAgeEncrypted(bytes: Uint8Array): AgeCheck {
  const file = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let first = 0;
  while (first < file.length && isSpace(file[first] ?? 0)) first += 1;
  // Armor may be padded with whitespace, the binary form starts at byte 0
  return file.toString("latin1", first, first + ARMOR_BEGIN.length) === ARMOR_BEGIN
    ? armored(file, first)
    : binary(file);
}
