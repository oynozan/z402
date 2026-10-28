import { randomBytes } from "node:crypto";

/** Bytes after the header: the 16-byte payload nonce and the sealed chunk of a real file, here only random */
export const PAYLOAD_BYTES = 1024;

/** age writes its binary header with standard base64 and no padding */
const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64").replace(/=+$/, "");

/**
 * A file the drop box takes for an age v1 file: the header of one X25519 recipient (an ephemeral share, a wrapped file
 * key and the header MAC, each 32 random bytes) and 1024 random bytes where the ciphertext goes. No key opens it, which
 * is the point: the drop box only checks the shape, and the smoke test has nothing to hide.
 */
export function syntheticAgeFile(random: (size: number) => Uint8Array = randomBytes): Uint8Array<ArrayBuffer> {
  const header = [
    "age-encryption.org/v1",
    `-> X25519 ${b64(random(32))}`,
    b64(random(32)),
    `--- ${b64(random(32))}`,
    "",
  ].join("\n");
  const head = Buffer.from(header, "latin1");
  const file = new Uint8Array(head.length + PAYLOAD_BYTES);
  file.set(head);
  file.set(random(PAYLOAD_BYTES), head.length);
  return file;
}
