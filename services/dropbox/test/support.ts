import { randomBytes } from "node:crypto";

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64").replace(/=+$/, "");

/** The shape of an age v1 file around the payload as given, with a random header that nothing could decrypt */
export function ageFile(o: { payload: Uint8Array; recipients?: number }): Buffer {
  const header = [
    "age-encryption.org/v1",
    ...Array.from({ length: o.recipients ?? 1 }, () => `-> X25519 ${b64(randomBytes(32))}\n${b64(randomBytes(32))}`),
    `--- ${b64(randomBytes(32))}`,
  ];
  return Buffer.concat([Buffer.from(`${header.join("\n")}\n`, "latin1"), o.payload]);
}

/** ASCII armor as age writes it, in padded base64 of 64 columns */
export function armor(file: Uint8Array, eol = "\n"): string {
  const lines = (Buffer.from(file).toString("base64").match(/.{1,64}/g) ?? []).join(eol);
  return `-----BEGIN AGE ENCRYPTED FILE-----${eol}${lines}${eol}-----END AGE ENCRYPTED FILE-----${eol}`;
}

/** Bytes drawn evenly from `values` distinct values, so the entropy is log2(values) whatever the length */
export function evenBytes(length: number, values: number): Buffer {
  return Buffer.from(Array.from({ length }, (_, i) => (i * 37) % values));
}
