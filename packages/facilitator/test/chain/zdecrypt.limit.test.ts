import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { zdecryptDecrypt, zdecryptOwns, ZdecryptError } from "../../src/chain/zdecrypt.js";

// A real child cannot be held at an exact moment, so spawn is replaced and each child is ended by hand
vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

const OWNS = { hasTransparent: false, ownedByKey: true };

class Child extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stdin = new PassThrough();
  readonly kill = vi.fn(() => true);
  closed = false;

  /** Prints the report and exits, closing only once the report has been read as a real child does */
  async finish(report: unknown, code = 0): Promise<void> {
    await new Promise<void>((resolve) => {
      this.stdout.once("end", resolve);
      this.stdout.end(JSON.stringify(report));
    });
    this.closed = true;
    this.emit("close", code, null);
  }
}

const children: Child[] = [];
const asked: string[] = [];

beforeEach(() => {
  children.length = 0;
  asked.length = 0;
  vi.mocked(spawn).mockReset();
  vi.mocked(spawn).mockImplementation(((_bin: string, args: string[]) => {
    const child = new Child();
    children.push(child);
    asked.push(args[2] ?? "");
    return child;
  }) as never);
});

afterEach(async () => {
  vi.useRealTimers();
  // A test that failed midway leaves children running, which would hold the slots of the tests after it
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (child === undefined || child.closed) continue;
    child.closed = true;
    child.emit("close", 1, null);
    await flush();
  }
});

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** The call as it is, with a handler on it so that one a failed test abandoned is no unhandled rejection */
function tracked<T>(call: Promise<T>): Promise<T> {
  call.catch(() => undefined);
  return call;
}

const owns = (i: number) =>
  tracked(zdecryptOwns({ bin: "zdecrypt", key: "key", address: `a${i}`, network: "regtest" }));
const decrypt = (i: number, timeoutMs: number) =>
  tracked(
    zdecryptDecrypt({ bin: "zdecrypt", key: "key", rawHex: "00", at: { tip: i }, network: "regtest", timeoutMs }),
  );

/** What a call ended with, so that no rejection goes unhandled while the test is busy elsewhere */
const outcome = (call: Promise<unknown>): Promise<string> =>
  call.then(
    () => "finished",
    (e: unknown) => (e as Error).message,
  );

describe("the process-wide limit on zdecrypt runs", () => {
  test("at most 8 children run at once, and the rest wait for a slot in the order they asked", async () => {
    const calls = Array.from({ length: 12 }, (_, i) => owns(i));
    await flush();
    expect(asked).toEqual(["a0", "a1", "a2", "a3", "a4", "a5", "a6", "a7"]);

    // The slot a child frees goes to the call that has waited longest, whichever child ended
    const done = new Set<number>();
    for (const i of [5, 2]) {
      await children[i]?.finish(OWNS);
      done.add(i);
      await flush();
    }
    expect(asked.slice(8)).toEqual(["a8", "a9"]);

    for (let i = 0; i < children.length; i++) {
      if (done.has(i)) continue;
      await children[i]?.finish(OWNS);
      done.add(i);
      await flush();
      expect(children.length - done.size).toBeLessThanOrEqual(8);
    }
    expect(asked.slice(8)).toEqual(["a8", "a9", "a10", "a11"]);
    await expect(Promise.all(calls)).resolves.toHaveLength(12);
  });

  test("a call that fits spawns at once", async () => {
    const call = owns(0);
    await flush();
    expect(children).toHaveLength(1);
    await children[0]?.finish(OWNS);
    await expect(call).resolves.toEqual(OWNS);
  });

  test("a child that cannot be started frees its slot", async () => {
    const calls = Array.from({ length: 9 }, (_, i) => owns(i));
    const settled = Promise.allSettled(calls);
    await flush();
    expect(children).toHaveLength(8);

    children[0]?.emit("error", Object.assign(new Error("spawn zdecrypt ENOENT"), { code: "ENOENT" }));
    await flush();
    expect(children).toHaveLength(9);
    expect(asked[8]).toBe("a8");

    for (const child of children.slice(1)) await child.finish(OWNS);
    const results = await settled;
    expect(results[0]).toMatchObject({ status: "rejected", reason: expect.any(ZdecryptError) });
    expect(String((results[0] as PromiseRejectedResult).reason)).toMatch(/could not be started \(ENOENT\)/);
    expect(results.slice(1).map((r) => r.status)).toEqual(Array(8).fill("fulfilled"));
  });

  test("a spawn that throws frees its slot", async () => {
    vi.mocked(spawn).mockImplementationOnce(() => {
      throw Object.assign(new Error("spawn EAGAIN"), { code: "EAGAIN" });
    });
    const first = owns(0);
    await expect(first).rejects.toThrow(/could not be started \(EAGAIN\)/);

    // A slot kept by the failed spawn would leave one of these waiting
    const calls = Array.from({ length: 8 }, (_, i) => owns(i + 1));
    await flush();
    expect(children).toHaveLength(8);
    for (const child of children) await child.finish(OWNS);
    await expect(Promise.all(calls)).resolves.toHaveLength(8);
  });

  test("the timeout of a call starts when its child is spawned, not while it waits", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const blockers = Array.from({ length: 8 }, (_, i) => owns(i));
    const queued = outcome(decrypt(100, 1000));
    await flush();
    expect(children).toHaveLength(8);

    await vi.advanceTimersByTimeAsync(5000);
    expect(children).toHaveLength(8);

    await children[0]?.finish(OWNS);
    await flush();
    expect(children).toHaveLength(9);
    await vi.advanceTimersByTimeAsync(999);
    expect(children[8]?.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(children[8]?.kill).toHaveBeenCalledWith("SIGKILL");
    await expect(queued).resolves.toBe("zdecrypt timed out after 1000 ms");

    for (const child of children.slice(1, 8)) await child.finish(OWNS);
    await Promise.all(blockers);
  });

  test("a child killed for its timeout frees its slot at once", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const timedOut = Array.from({ length: 8 }, (_, i) => outcome(decrypt(i, 1000)));
    const waiting = owns(99);
    await flush();
    expect(children).toHaveLength(8);

    await vi.advanceTimersByTimeAsync(1000);
    await expect(Promise.all(timedOut)).resolves.toEqual(Array(8).fill("zdecrypt timed out after 1000 ms"));
    await flush();
    expect(asked[8]).toBe("a99");
    await children[8]?.finish(OWNS);
    await expect(waiting).resolves.toEqual(OWNS);
  });
});
