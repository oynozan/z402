import { describe, expect, it } from "vitest";
import { PAYLOAD_BYTES, syntheticAgeFile } from "../src/age.js";
import { ageRefusal } from "./age-shape.js";

/** 0, 1, 2, ... so the base64 in the header is known */
const counting = (n: number): Uint8Array => Uint8Array.from({ length: n }, (_, i) => i);

describe("syntheticAgeFile", () => {
  it("has exactly the layout of an age v1 file with one X25519 recipient", () => {
    const file = syntheticAgeFile(counting);
    const share = Buffer.from(counting(32)).toString("base64").replace(/=+$/, "");
    expect(share).toHaveLength(43);

    const header = `age-encryption.org/v1\n-> X25519 ${share}\n${share}\n--- ${share}\n`;
    expect(Buffer.from(file).toString("latin1", 0, header.length)).toBe(header);
    expect(file.length).toBe(header.length + 1024);
    expect(PAYLOAD_BYTES).toBe(1024);
    expect(Buffer.from(file.subarray(header.length))).toEqual(Buffer.from(counting(1024)));
  });

  it("is a different file every time, with 1024 random payload bytes", () => {
    const a = syntheticAgeFile();
    const b = syntheticAgeFile();
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
    const header = (f: Uint8Array): string => Buffer.from(f).toString("latin1", 0, f.length - 1024);
    expect(header(a)).not.toBe(header(b));
    expect(a.length).toBe(b.length);
  });

  it("passes the drop box's header, payload size and entropy rules every time", () => {
    for (let i = 0; i < 200; i++) expect(ageRefusal(syntheticAgeFile())).toBeUndefined();
  });

  it("is plain bytes that fetch takes as a body", () => {
    const file = syntheticAgeFile();
    expect(file).toBeInstanceOf(Uint8Array);
    expect(file.buffer).toBeInstanceOf(ArrayBuffer);
    expect(new Request("http://x.test", { method: "POST", body: file }).method).toBe("POST");
  });
});

describe("the drop box rules in age-shape.ts", () => {
  it("refuse what the real check refuses, so the test above cannot pass by accident", () => {
    const good = Buffer.from(syntheticAgeFile());
    expect(ageRefusal(good)).toBeUndefined();
    expect(ageRefusal(Buffer.from("hello world, this is plain text that is long enough to be a payload"))).toMatch(/header line/);
    expect(ageRefusal(good.subarray(0, 100))).toMatch(/header|payload/);
    const flat = Buffer.concat([good.subarray(0, good.length - 1024), Buffer.alloc(1024, 0x41)]);
    expect(ageRefusal(flat)).toMatch(/ciphertext/);
    const noMac = Buffer.from(good.toString("latin1").replace(/--- [^\n]*\n/, "--- short\n"), "latin1");
    expect(ageRefusal(noMac)).toMatch(/MAC/);
  });
});
