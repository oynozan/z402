import { randomBytes } from "node:crypto";
import { describe, expect, test } from "vitest";
import { isAgeEncrypted } from "../src/age.js";
import { EXAMPLE_AGE_FILE } from "../src/example.js";
import { EMPTY, HELLO, HYBRID, SCRYPT, TWO_RECIPIENTS, TWO_RECIPIENTS_ARMORED } from "./fixtures.js";
import { ageFile, armor, evenBytes } from "./support.js";

function refusal(bytes: Uint8Array | string): string {
  const verdict = isAgeEncrypted(typeof bytes === "string" ? Buffer.from(bytes, "latin1") : bytes);
  if (verdict.ok) throw new Error("expected a refusal");
  return verdict.reason;
}

const accepts = (bytes: Uint8Array | string): boolean =>
  isAgeEncrypted(typeof bytes === "string" ? Buffer.from(bytes, "latin1") : bytes).ok;

describe("files from the age reference implementation", () => {
  test.each([
    ["no plaintext, the smallest file", EMPTY],
    ["a short plaintext", HELLO],
    ["a passphrase recipient", SCRYPT],
    ["two recipients and a payload past the entropy rule", TWO_RECIPIENTS],
    ["a hybrid recipient with a 1.5 KB stanza line", HYBRID],
  ])("accepts %s", (_name, file) => {
    expect(isAgeEncrypted(file)).toEqual({ ok: true });
  });

  test("accepts armor, and the example that discovery shows", () => {
    expect(isAgeEncrypted(Buffer.from(TWO_RECIPIENTS_ARMORED))).toEqual({ ok: true });
    expect(isAgeEncrypted(Buffer.from(EXAMPLE_AGE_FILE))).toEqual({ ok: true });
  });
});

describe("binary files", () => {
  test("accepts the shape with random payloads of any size from 32 bytes", () => {
    for (const length of [32, 33, 64, 200, 511, 512, 4096, 100_000]) {
      expect(accepts(ageFile({ payload: randomBytes(length) })), `payload of ${length} bytes`).toBe(true);
    }
  });

  test("accepts several recipients, and a stanza body that is a whole number of lines", () => {
    expect(accepts(ageFile({ payload: randomBytes(64), recipients: 5 }))).toBe(true);
    const full = "A".repeat(64);
    const withFullBody = `age-encryption.org/v1\n-> t arg\n${full}\n\n--- ${"A".repeat(43)}\n`;
    expect(accepts(Buffer.concat([Buffer.from(withFullBody), randomBytes(64)]))).toBe(true);
    const withEmptyBody = `age-encryption.org/v1\n-> grease\n\n--- ${"A".repeat(43)}\n`;
    expect(accepts(Buffer.concat([Buffer.from(withEmptyBody), randomBytes(64)]))).toBe(true);
  });

  test("works on a view into a larger buffer", () => {
    const file = ageFile({ payload: randomBytes(100) });
    const padded = Buffer.concat([Buffer.from("xxxxx"), file]);
    expect(isAgeEncrypted(padded.subarray(5))).toEqual({ ok: true });
    expect(isAgeEncrypted(new Uint8Array(padded.subarray(5)))).toEqual({ ok: true });
  });

  test("refuses plain text, JSON, an archive and random bytes without a header", () => {
    expect(refusal("The meeting is at noon, bring the keys.\n".repeat(20))).toMatch(/header line/);
    expect(refusal(JSON.stringify({ apiKey: "sk-live-0123456789abcdef", note: "private" }))).toMatch(/header line/);
    expect(refusal(Buffer.from([0x50, 0x4b, 0x03, 0x04, ...randomBytes(500)]))).toMatch(/header line/);
    expect(refusal(randomBytes(4096))).toMatch(/header line/);
    expect(refusal(new Uint8Array(0))).toMatch(/header line/);
  });

  test("refuses a file whose header is cut short or malformed", () => {
    const file = ageFile({ payload: randomBytes(100) });
    // The intro is 22 bytes and the stanza's first line another 54
    expect(refusal(file.subarray(0, 22))).toMatch(/ends before its MAC line/);
    expect(refusal(file.subarray(0, 60))).toMatch(/ends before its MAC line/);
    expect(refusal(file.subarray(0, 76))).toMatch(/ends inside a recipient stanza/);

    const text = file.toString("latin1");
    const noStanza = text.replace(/-> X25519 [^\n]*\n[^\n]*\n/, "");
    expect(refusal(noStanza)).toMatch(/no recipient stanza/);
    expect(refusal(text.replace("-> X25519", "-> "))).toMatch(/malformed recipient stanza$/);
    expect(refusal(text.replace("-> X25519", "-X X25519"))).toMatch(/malformed recipient stanza$/);
    expect(refusal(text.replace(/\n--- [^\n]*\n/, "\n--- short\n"))).toMatch(/malformed header MAC line/);
    expect(refusal(text.replace(/\n--- /, "\n--- \u0000"))).toMatch(/malformed header MAC line/);
    // A body line that is not base64, and one that is longer than 64 columns
    expect(refusal(text.replace(/(-> X25519 [^\n]*\n)[^\n]*\n/, "$1not base64 at all!\n"))).toMatch(/stanza body/);
    expect(refusal(text.replace(/(-> X25519 [^\n]*\n)[^\n]*\n/, `$1${"A".repeat(65)}\n`))).toMatch(/stanza body/);
  });

  test("refuses a truncated payload", () => {
    expect(refusal(ageFile({ payload: randomBytes(31) }))).toMatch(/shorter than 32 bytes/);
    expect(refusal(ageFile({ payload: new Uint8Array(0) }))).toMatch(/shorter than 32 bytes/);
    expect(refusal(EMPTY.subarray(0, EMPTY.length - 1))).toMatch(/shorter than 32 bytes/);
  });

  test("refuses a payload that does not look like ciphertext", () => {
    expect(refusal(ageFile({ payload: Buffer.alloc(2000, 0x41) }))).toMatch(/ciphertext/);
    expect(refusal(ageFile({ payload: Buffer.alloc(40) }))).toMatch(/ciphertext/);
    expect(refusal(ageFile({ payload: Buffer.from("This is a perfectly readable sentence. ".repeat(40)) }))).toMatch(
      /ciphertext/,
    );
    // 32 bytes of 8 values are fewer than the 16 distinct values that half the length asks for
    expect(refusal(ageFile({ payload: evenBytes(32, 8) }))).toMatch(/ciphertext/);
  });

  test("judges the payload by its entropy from 512 bytes and by its distinct values below", () => {
    // 100 distinct values spread evenly make 6.6 bits per byte
    expect(accepts(ageFile({ payload: evenBytes(400, 100) }))).toBe(true);
    expect(accepts(ageFile({ payload: evenBytes(511, 100) }))).toBe(true);
    expect(accepts(ageFile({ payload: evenBytes(512, 100) }))).toBe(false);
    expect(accepts(ageFile({ payload: evenBytes(600, 100) }))).toBe(false);
    // 200 distinct values spread evenly make 7.6 bits per byte
    expect(accepts(ageFile({ payload: evenBytes(600, 200) }))).toBe(true);
    // Below 64 distinct values a payload below 512 bytes is refused
    expect(accepts(ageFile({ payload: evenBytes(300, 60) }))).toBe(false);
    expect(accepts(ageFile({ payload: evenBytes(300, 64) }))).toBe(true);
  });

  test("looks only at the payload, so a header with plain text after it is refused", () => {
    expect(refusal(ageFile({ payload: Buffer.from("plaintext hidden behind a header ".repeat(30)) }))).toMatch(
      /ciphertext/,
    );
  });
});

describe("armored files", () => {
  test("accepts armor around a file, with CRLF line ends and with whitespace around it", () => {
    const file = ageFile({ payload: randomBytes(300) });
    expect(accepts(armor(file))).toBe(true);
    expect(accepts(armor(file, "\r\n"))).toBe(true);
    expect(accepts(`\n\n  ${armor(file)}\n\n`)).toBe(true);
    expect(accepts(armor(file).replace(/\n$/, ""))).toBe(true);
  });

  test("refuses armor without its end line, or around something that is not base64", () => {
    const text = armor(ageFile({ payload: randomBytes(300) }));
    expect(refusal(text.replace("-----END AGE ENCRYPTED FILE-----\n", ""))).toMatch(/does not end with/);
    expect(refusal(text.replace(/\n[^\n]*\n-----END/, "\n*** not base64 ***\n-----END"))).toMatch(/not base64/);
    const doubled = text.replace("FILE-----\n", "FILE-----\n-----BEGIN AGE ENCRYPTED FILE-----\n");
    expect(refusal(doubled)).toMatch(/not base64/);
    expect(refusal("-----BEGIN AGE ENCRYPTED FILE-----\n")).toMatch(/does not end with/);
    expect(refusal("-----BEGIN AGE ENCRYPTED FILE-----xyz\nabcd\n-----END AGE ENCRYPTED FILE-----\n")).toMatch(
      /does not start with/,
    );
    expect(refusal("-----BEGIN PGP MESSAGE-----\nabcd\n-----END PGP MESSAGE-----\n")).toMatch(/header line/);
    expect(refusal("- a markdown list\n- of private things\n")).toMatch(/header line/);
  });

  test("applies the binary rules to what the armor holds", () => {
    expect(refusal(armor(Buffer.from("not an age file, only text, wrapped in armor ".repeat(8))))).toMatch(
      /^armored file: missing the "age-encryption.org\/v1" header line$/,
    );
    expect(refusal(armor(ageFile({ payload: randomBytes(10) })))).toMatch(/^armored file: .*shorter than 32 bytes/);
    expect(refusal(armor(ageFile({ payload: Buffer.alloc(500, 1) })))).toMatch(/^armored file: .*ciphertext/);
  });
});
