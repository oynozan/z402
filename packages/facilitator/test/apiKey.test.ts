import { randomBytes } from "node:crypto";
import { describe, expect, test, vi } from "vitest";
import { API_KEY_RE, keyDigest, newApiKey } from "../src/providers/apiKey.js";

// randomBytes is imported by name, so only a module mock shows what the key was drawn from
vi.mock("node:crypto", async (importOriginal) => {
  const crypto = await importOriginal<typeof import("node:crypto")>();
  return { ...crypto, randomBytes: vi.fn(crypto.randomBytes) };
});

const BODY = "A".repeat(43);
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

describe("newApiKey", () => {
  test("is z402_ and 43 base64url characters", () => {
    const key = newApiKey();
    expect(key).toMatch(/^z402_[A-Za-z0-9_-]{43}$/);
    expect(API_KEY_RE.test(key)).toBe(true);
  });

  test("encodes 32 random bytes in base64url without padding", () => {
    vi.mocked(randomBytes).mockImplementationOnce(() => Buffer.alloc(32, 0xff));

    // 30 bytes of ones make 40 underscores and the last 2 make two more and an 8 from the zero padded bits
    expect(newApiKey()).toBe(`z402_${"_".repeat(42)}8`);
    expect(randomBytes).toHaveBeenLastCalledWith(32);
  });

  test("a key decodes to 32 bytes", () => {
    const body = newApiKey().slice("z402_".length);
    const bytes = Buffer.from(body, "base64url");
    expect(bytes.length).toBe(32);
    expect(bytes.toString("base64url")).toBe(body);
  });

  test("2000 keys are all distinct and all well formed", () => {
    const keys = new Set(Array.from({ length: 2000 }, () => newApiKey()));
    expect(keys.size).toBe(2000);
    for (const key of keys) expect(API_KEY_RE.test(key)).toBe(true);
  });
});

describe("API_KEY_RE", () => {
  test("is the pattern of the design", () => {
    expect(API_KEY_RE.source).toBe("^z402_[A-Za-z0-9_-]{43}$");
    expect(API_KEY_RE.flags).toBe("");
  });

  test.each([
    ["a body of letters", `z402_${BODY}`],
    ["the first 43 characters of the alphabet", `z402_${ALPHABET.slice(0, 43)}`],
    ["the last 43 characters of the alphabet, with both - and _", `z402_${ALPHABET.slice(-43)}`],
    ["a body of digits", `z402_${"7".repeat(43)}`],
  ])("accepts %s", (_label, key) => {
    expect(API_KEY_RE.test(key)).toBe(true);
  });

  test.each([
    ["the empty string", ""],
    ["no prefix", BODY],
    ["a prefix in capitals", `Z402_${BODY}`],
    ["a hyphen in the prefix", `z402-${BODY}`],
    ["another prefix", `z403_${BODY}`],
    ["a body of 42 characters", `z402_${"A".repeat(42)}`],
    ["a body of 44 characters", `z402_${"A".repeat(44)}`],
    ["base64 padding", `z402_${"A".repeat(42)}=`],
    ["the standard base64 plus", `z402_${"A".repeat(42)}+`],
    ["the standard base64 slash", `z402_${"A".repeat(42)}/`],
    ["a space inside the body", `z402_${"A".repeat(21)} ${"A".repeat(21)}`],
    ["a trailing space", `z402_${BODY} `],
    ["a trailing newline", `z402_${BODY}\n`],
    ["a leading space", ` z402_${BODY}`],
    ["a letter outside ASCII", `z402_${"A".repeat(42)}é`],
    ["a NUL", `z402_${"A".repeat(42)}\0`],
    ["the whole Authorization value", `Bearer z402_${BODY}`],
  ])("refuses %s", (_label, key) => {
    expect(API_KEY_RE.test(key)).toBe(false);
  });

  test("answers the same each time it is asked, since it holds no state", () => {
    const key = `z402_${BODY}`;
    expect([API_KEY_RE.test(key), API_KEY_RE.test(key), API_KEY_RE.test(key)]).toEqual([true, true, true]);
  });
});

describe("keyDigest", () => {
  // Taken with shasum -a 256 and cross-checked in Python, never with the code under test
  test.each([
    ["a body of A", `z402_${"A".repeat(43)}`, "d8fb5d4d2cbedc4bacde4b4ce37b2c0fdb0dc6e8529aec9fb71ca372025ec0f8"],
    [
      "digits and letters",
      "z402_0123456789abcdefghijklmnopqrstuvwxyzABCDEFG",
      "0be83748d24d9850c27fd70b717e1f61a76bfb447b14dab2c5731c460da1bfe4",
    ],
    [
      "hyphens and underscores",
      `z402_${"-_".repeat(21)}-`,
      "58ee57c4d0d31592c50e7558877673c6acf244172279f18a1a02a8d465a3c15e",
    ],
    [
      "an operator token that is no API key, abc",
      "abc",
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    ],
    ["the empty string", "", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
    [
      "a letter outside ASCII, taken as UTF-8",
      "z402_é",
      "d73314d06d909f84ad4a24f6732cf28d7dfc3b06ece743d204164880814bc59c",
    ],
  ])("the sha256 of %s", (_label, key, digest) => {
    expect(keyDigest(key)).toBe(digest);
  });

  test("is 64 lowercase hex, which is what a registry entry holds as keyHash", () => {
    expect(keyDigest(newApiKey())).toMatch(/^[0-9a-f]{64}$/);
  });

  test("is the same for the same key and different for another", () => {
    const a = newApiKey();
    const b = newApiKey();
    expect(keyDigest(a)).toBe(keyDigest(a));
    expect(keyDigest(a)).not.toBe(keyDigest(b));
  });
});
