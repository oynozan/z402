import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { abortable, BodyTooLarge, clean, describeError, excerpt, readBody } from "../src/http.js";

const cp = (...points: number[]): string => String.fromCodePoint(...points);
const ESC = cp(0x1b);
const BEL = cp(0x07);
const CSI = cp(0x9b);
const LINE_SEPARATOR = cp(0x2028);
const RIGHT_TO_LEFT_OVERRIDE = cp(0x202e);
const LEFT_TO_RIGHT_ISOLATE = cp(0x2066);
const RIGHT_TO_LEFT_MARK = cp(0x200f);

describe("clean and excerpt", () => {
  it("turns control characters, escapes and line breaks into single spaces, so text from a service cannot drive a terminal", () => {
    const hostile = `a${ESC}[2Jb${ESC}]0;pwned${BEL}c${CSI}31md\r\ne${LINE_SEPARATOR}f${RIGHT_TO_LEFT_OVERRIDE}g${LEFT_TO_RIGHT_ISOLATE}h${RIGHT_TO_LEFT_MARK}i\t\tj`;
    const text = clean(hostile);
    expect(text).toBe("a [2Jb ]0;pwned c 31md e f g h i j");
    for (const char of [ESC, BEL, CSI, LINE_SEPARATOR, RIGHT_TO_LEFT_OVERRIDE, LEFT_TO_RIGHT_ISOLATE, RIGHT_TO_LEFT_MARK, "\r", "\n", "\t"]) {
      expect(text).not.toContain(char);
    }
  });

  it("keeps ordinary text, emoji and non-Latin scripts", () => {
    const text = `Zcash ${cp(0x1f6e1, 0xfe0f)} shielded ${cp(0xe9, 0xe8)} ${cp(0x65e5, 0x672c, 0x8a9e)}`;
    expect(clean(text)).toBe(text);
    expect(clean("  a   b  ")).toBe(" a b ");
  });

  it("cuts by characters, never through a surrogate pair", () => {
    expect(excerpt("abcdef", 3)).toBe(`abc${cp(0x2026)}`);
    expect(excerpt("abc", 3)).toBe("abc");
    const faces = cp(0x1f600, 0x1f600, 0x1f600);
    expect(excerpt(faces, 2)).toBe(`${cp(0x1f600, 0x1f600)}${cp(0x2026)}`);
  });
});

describe("describeError", () => {
  it("shows the cause that fetch hides behind 'fetch failed'", () => {
    const cause = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:4031"), { code: "ECONNREFUSED" });
    expect(describeError(new TypeError("fetch failed", { cause }))).toBe("fetch failed: connect ECONNREFUSED 127.0.0.1:4031");
  });

  it("falls back to the error code, as an AggregateError from two refused addresses has no message", () => {
    const cause = Object.assign(new AggregateError([]), { code: "ECONNREFUSED" });
    expect(describeError(new TypeError("fetch failed", { cause }))).toBe("fetch failed: ECONNREFUSED");
  });

  it("handles errors with no cause and values that are not errors", () => {
    expect(describeError(new Error("boom"))).toBe("boom");
    expect(describeError("plain")).toBe("plain");
  });
});

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

describe("readBody", () => {
  it("reads a body that fits", async () => {
    expect((await readBody(new Response("hello"), 5)).toString()).toBe("hello");
    expect((await readBody(new Response(null), 5)).length).toBe(0);
  });

  it("stops at the limit, and cancels what a service goes on sending", async () => {
    let cancelled = false;
    let sent = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += 1024;
        controller.enqueue(new Uint8Array(1024));
      },
      cancel() {
        cancelled = true;
      },
    });
    await expect(readBody(new Response(endless), 10_000)).rejects.toBeInstanceOf(BodyTooLarge);
    expect(cancelled).toBe(true);
    // The stream may have queued a few chunks ahead, but nothing like an unbounded read
    expect(sent).toBeLessThan(1_000_000);
  });

  it("counts the bytes after decompression, so a few kilobytes on the wire cannot fill the memory", async () => {
    const packed = gzipSync(Buffer.alloc(64 * 1024 * 1024));
    expect(packed.length).toBeLessThan(200_000);
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-encoding": "gzip", "content-type": "application/json" }).end(packed);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    servers.push(server);
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
    await expect(readBody(res, 1024 * 1024)).rejects.toBeInstanceOf(BodyTooLarge);
  });

  it("refuses a body one byte over", async () => {
    await expect(readBody(new Response("123456"), 5)).rejects.toThrow(/over 5 bytes/);
  });
});

describe("abortable", () => {
  it("passes the result of the work through, with or without a signal", async () => {
    expect(await abortable(Promise.resolve(7), new AbortController().signal)).toBe(7);
    expect(await abortable(Promise.resolve(8), undefined)).toBe(8);
    await expect(abortable(Promise.reject(new Error("boom")), new AbortController().signal)).rejects.toThrow("boom");
  });

  it("gives up on work that never settles as soon as the signal fires, because fetch cannot be relied on to notice", async () => {
    const controller = new AbortController();
    const waiting = abortable(new Promise<never>(() => undefined), controller.signal);
    controller.abort(new Error("stopped"));
    await expect(waiting).rejects.toThrow("stopped");
  });

  it("gives up at once on a signal that has already fired", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(abortable(new Promise<never>(() => undefined), controller.signal)).rejects.toThrow(/abort/i);
  });

  it("is quiet about work that fails after it was given up on", async () => {
    const unhandled: unknown[] = [];
    const record = (reason: unknown): void => void unhandled.push(reason);
    process.on("unhandledRejection", record);
    try {
      const controller = new AbortController();
      let fail: (e: Error) => void = () => undefined;
      const waiting = abortable(new Promise<never>((_, reject) => (fail = reject)), controller.signal);
      controller.abort();
      await expect(waiting).rejects.toThrow(/abort/i);
      fail(new Error("late"));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", record);
    }
  });
});
