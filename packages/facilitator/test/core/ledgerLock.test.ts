import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { lockLedger } from "../../src/core/ledgerLock.js";

let dir: string;
const releases: Array<() => void> = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "z402-lock-"));
});
afterEach(() => {
  for (const release of releases.splice(0)) release();
  rmSync(dir, { recursive: true, force: true });
});

const ledger = () => join(dir, "ledger.jsonl");
const lockFile = () => `${ledger()}.lock`;
const readLock = (): Record<string, unknown> => JSON.parse(readFileSync(lockFile(), "utf8"));

function lock(path = ledger()): () => void {
  const release = lockLedger(path);
  releases.push(release);
  return release;
}

/** A lock file as another facilitator would have written it */
function writeLock(content: unknown): void {
  writeFileSync(lockFile(), typeof content === "string" ? content : JSON.stringify(content));
}

const holder = (over: Record<string, unknown> = {}) => ({
  pid: process.pid,
  host: hostname(),
  token: "0123456789abcdef",
  since: "2026-10-28T00:00:00.000Z",
  ...over,
});

/** The pid of a process that has exited and been reaped, so no live process has it */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise((resolve) => child.once("exit", resolve));
  if (child.pid === undefined) throw new Error("the child never started");
  return child.pid;
}

describe("lockLedger", () => {
  test("a second lock of one ledger in this process is refused until the first is released", () => {
    const release = lock();
    expect(() => lockLedger(ledger())).toThrow(/^ledgerPath: .*already open in this process$/);
    expect(() => lockLedger(join(dir, ".", "ledger.jsonl"))).toThrow(/already open/);

    release();
    expect(() => lock()).not.toThrow();
  });

  test("the lock names this process and host, and only its owner can read it", () => {
    lock();
    const held = readLock();
    expect(held).toEqual({
      pid: process.pid,
      host: hostname(),
      token: expect.stringMatching(/^[0-9a-f]{16}$/),
      since: expect.any(String),
    });
    expect(new Date(String(held.since)).toISOString()).toBe(held.since);
    expect(statSync(lockFile()).mode & 0o777).toBe(0o600);
  });

  test("a lock left by a process of this host that has died is taken over", async () => {
    writeLock(holder({ pid: await deadPid() }));
    lock();
    expect(readLock()).toMatchObject({ pid: process.pid, host: hostname() });
    expect(readLock().token).not.toBe("0123456789abcdef");
  });

  test("a lock that names this process, which this process does not hold, is taken over", () => {
    writeLock(holder());
    lock();
    expect(readLock().token).not.toBe("0123456789abcdef");
  });

  test("a lock of a live process on this host is refused", () => {
    writeLock(holder({ pid: process.ppid }));
    expect(() => lock()).toThrow(`is in use by pid ${process.ppid} on ${hostname()}`);
    expect(readLock()).toEqual(holder({ pid: process.ppid }));
  });

  test("a lock of another host is refused, naming that host and how to recover", () => {
    writeLock(holder({ host: "facilitator-elsewhere" }));
    const attempt = () => lock();
    expect(attempt).toThrow(
      `ledgerPath: ${ledger()} is in use by pid ${process.pid} on facilitator-elsewhere ` +
        `since 2026-10-28T00:00:00.000Z; stop that facilitator, or delete ${lockFile()} if none is running`,
    );
    expect(readLock()).toEqual(holder({ host: "facilitator-elsewhere" }));
  });

  test.each<[string, unknown]>([
    ["not JSON", '{"pid":'],
    ["empty", ""],
    ["an array", [1]],
    ["no pid", { ...holder(), pid: undefined }],
    ["pid 0, which would signal a process group", holder({ pid: 0 })],
    ["a negative pid", holder({ pid: -1 })],
    ["a pid that is a string", holder({ pid: String(process.pid) })],
    ["no host", { ...holder(), host: undefined }],
    ["a host with a newline", holder({ host: "a\nb" })],
  ])("a lock that cannot be read (%s) is refused", (_what, content) => {
    writeLock(content);
    expect(() => lock()).toThrow(
      `ledgerPath: ${lockFile()} exists and cannot be read; delete it if no facilitator is running`,
    );
    expect(existsSync(lockFile())).toBe(true);
  });

  test("release twice is harmless, and a lock someone else wrote meanwhile stays", () => {
    const release = lock();
    writeLock(holder({ host: "facilitator-elsewhere" }));

    release();
    release();

    expect(readLock()).toEqual(holder({ host: "facilitator-elsewhere" }));
    // Released in this process, so the refusal comes from the other host's lock and not from the first lock
    expect(() => lock()).toThrow(/in use by pid \d+ on facilitator-elsewhere/);
  });

  test("release removes this process's own lock", () => {
    const release = lock();
    release();
    expect(existsSync(lockFile())).toBe(false);
  });

  test("the directory of a ledger that does not exist yet is created", () => {
    const nested = join(dir, "data", "regtest", "ledger.jsonl");
    lock(nested);
    expect(existsSync(`${nested}.lock`)).toBe(true);
  });
});
