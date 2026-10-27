import { describe, expect, it } from "vitest";
import { expiryHeightFromRawTx, ProtocolError, REASON } from "../src/index.js";

function u32(...values: number[]): Uint8Array {
  const out = new Uint8Array(values.length * 4);
  const view = new DataView(out.buffer);
  values.forEach((v, i) => view.setUint32(i * 4, v, true));
  return out;
}

function header(...words: number[]): Uint8Array {
  return u32(...words);
}

function withTail(head: Uint8Array, expiry: number, extra = 0): Uint8Array {
  const out = new Uint8Array(head.length + 4 + extra);
  out.set(head, 0);
  new DataView(out.buffer).setUint32(head.length, expiry, true);
  return out;
}

function invalidPayload(fn: () => unknown): void {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ProtocolError);
    expect((e as ProtocolError).code).toBe(REASON.invalidPayload);
    return;
  }
  throw new Error("expected a ProtocolError, nothing was thrown");
}

describe("expiryHeightFromRawTx", () => {
  it("reads a v6 transaction", () => {
    const raw = withTail(header(0x80000006, 0xd884b698, 0x77190ad9, 0x00000000), 4547271);
    expect(raw.length).toBe(20);
    expect(expiryHeightFromRawTx(raw)).toBe(4547271);
  });

  it("reads a v5 transaction", () => {
    const raw = withTail(header(0x80000005, 0x26a7270a, 0xc2d6d0b4, 0x00000000), 123);
    expect(expiryHeightFromRawTx(raw)).toBe(123);
  });

  it("ignores bytes after the expiry height", () => {
    const raw = withTail(header(0x80000006, 0xd884b698, 0x77190ad9, 0x00000000), 4547271, 64);
    expect(expiryHeightFromRawTx(raw)).toBe(4547271);
  });

  it("reads expiryHeight 0 and the full u32 range", () => {
    const head = header(0x80000005, 0x26a7270a, 0xc2d6d0b4, 0x00000000);
    expect(expiryHeightFromRawTx(withTail(head, 0))).toBe(0);
    expect(expiryHeightFromRawTx(withTail(head, 0xffffffff))).toBe(0xffffffff);
  });

  it("reads a view with a non-zero byteOffset", () => {
    const raw = withTail(header(0x80000005, 0x26a7270a, 0xc2d6d0b4, 0x00000000), 777);
    const padded = new Uint8Array(raw.length + 8);
    padded.set(raw, 3);
    expect(expiryHeightFromRawTx(padded.subarray(3, 3 + raw.length))).toBe(777);
  });

  it("throws for a v4 header", () => {
    invalidPayload(() => expiryHeightFromRawTx(withTail(header(0x80000004, 0x892f2085, 0xc2d6d0b4, 0), 123)));
  });

  it("throws for other versions", () => {
    for (const version of [0, 1, 2, 3, 7, 0x7fffffff]) {
      invalidPayload(() =>
        expiryHeightFromRawTx(withTail(header((version | 0x80000000) >>> 0, 0x26a7270a, 0xc2d6d0b4, 0), 123)),
      );
    }
  });

  it("throws when the overwintered bit is clear", () => {
    invalidPayload(() => expiryHeightFromRawTx(withTail(header(0x00000005, 0x26a7270a, 0xc2d6d0b4, 0), 123)));
    invalidPayload(() => expiryHeightFromRawTx(withTail(header(0x00000006, 0xd884b698, 0x77190ad9, 0), 123)));
  });

  it("throws for 19 bytes and for empty input", () => {
    const raw = withTail(header(0x80000006, 0xd884b698, 0x77190ad9, 0), 4547271);
    invalidPayload(() => expiryHeightFromRawTx(raw.subarray(0, 19)));
    invalidPayload(() => expiryHeightFromRawTx(new Uint8Array(0)));
  });
});
