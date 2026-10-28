/**
 * What the drop box asks of the binary form of an age v1 file (services/dropbox/src/age.ts, README "The age check is a
 * plausibility check"), written out again here because a test of this package cannot import another package's source.
 * Returns why the bytes are refused, or undefined when the drop box would take them.
 */
const INTRO = "age-encryption.org/v1";
const ARG = /^[\x21-\x7e]+$/;
const BODY = /^[A-Za-z0-9+/]*$/;
const MAC = /^[A-Za-z0-9+/]{43}$/;
const BODY_LINE = 64;
const MIN_PAYLOAD_BYTES = 32;
const ENTROPY_FROM_BYTES = 512;
const MIN_ENTROPY_BITS = 7.0;
const MAX_DISTINCT_REQUIRED = 64;

function entropy(counts: Uint32Array, total: number): number {
  let bits = 0;
  for (const count of counts) {
    if (count > 0) bits -= (count / total) * Math.log2(count / total);
  }
  return bits;
}

function looksLikeCiphertext(payload: Uint8Array): boolean {
  const counts = new Uint32Array(256);
  for (const byte of payload) counts[byte] = (counts[byte] ?? 0) + 1;
  if (payload.length >= ENTROPY_FROM_BYTES) return entropy(counts, payload.length) >= MIN_ENTROPY_BITS;
  const distinct = counts.reduce((n, count) => n + (count > 0 ? 1 : 0), 0);
  return distinct >= Math.min(MAX_DISTINCT_REQUIRED, payload.length / 2);
}

export function ageRefusal(bytes: Uint8Array): string | undefined {
  const file = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 0;
  const nextLine = (): string | undefined => {
    const end = file.indexOf(0x0a, pos);
    if (end < 0) return undefined;
    const line = file.toString("latin1", pos, end);
    pos = end + 1;
    return line;
  };

  if (nextLine() !== INTRO) return `missing the "${INTRO}" header line`;
  let stanzas = 0;
  for (;;) {
    const line = nextLine();
    if (line === undefined) return "the header ends before its MAC line";
    if (line.startsWith("--- ")) {
      if (stanzas === 0) return "the header has no recipient stanza";
      if (!MAC.test(line.slice(4))) return "malformed header MAC line";
      break;
    }
    if (!line.startsWith("-> ") || !line.slice(3).split(" ").every((arg) => ARG.test(arg))) {
      return "malformed recipient stanza";
    }
    stanzas += 1;
    for (;;) {
      const body = nextLine();
      if (body === undefined) return "the header ends inside a recipient stanza";
      if (body.length > BODY_LINE || !BODY.test(body)) return "malformed recipient stanza body";
      if (body.length < BODY_LINE) break;
    }
  }
  const payload = file.subarray(pos);
  if (payload.length < MIN_PAYLOAD_BYTES) return `the payload is shorter than ${MIN_PAYLOAD_BYTES} bytes`;
  return looksLikeCiphertext(payload) ? undefined : "the payload does not look like ciphertext";
}
