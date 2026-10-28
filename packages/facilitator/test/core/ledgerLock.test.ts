import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { lockLedger, type HeldLock, type LockTiming } from "../../src/core/ledgerLock.js";

/** Short enough to keep each wait under half a second */
const FAST: LockTiming = { heartbeatMs: 40, staleMs: 400, pollMs: 20 };
const PACKAGE_DIR = fileURLToPath(new URL("../..", import.meta.url));
const HOLDER = fileURLToPath(new URL("../support/lockHolder.ts", import.meta.url));
const CONTENDER = fileURLToPath(new URL("../support/lockContender.ts", import.meta.url));

let dir: string;
const releases: Array<() => void> = [];
const children: ChildProcess[] = [];
const stops: Array<() => void> = [];
beforeEach(() => {
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), "z402-lock-")));
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const stop of stops.splice(0)) stop();
  for (const release of releases.splice(0)) release();
  for (const child of children.splice(0)) child.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
});

const ledger = () => join(dir, "ledger.jsonl");
const lockFile = () => `${ledger()}.lock`;
const readLock = (path = lockFile()): Record<string, unknown> => JSON.parse(readFileSync(path, "utf8"));

async function lock(path = ledger(), timing: Partial<LockTiming> = FAST): Promise<() => void> {
  return (await held(path, timing)).release;
}

/** The lock itself, released after the test */
async function held(path = ledger(), options: Parameters<typeof lockLedger>[1] = FAST): Promise<HeldLock> {
  const taken = await lockLedger(path, options);
  releases.push(taken.release);
  return taken;
}

/** The error a lock attempt ends with, and how long it took */
async function refusal(path = ledger(), timing: Partial<LockTiming> = FAST): Promise<{ error: Error; ms: number }> {
  const started = performance.now();
  try {
    releases.push((await lockLedger(path, timing)).release);
  } catch (e) {
    return { error: e as Error, ms: performance.now() - started };
  }
  throw new Error("expected the lock to be refused");
}

/** A lock file as another facilitator would have written it, last touched `ageMs` ago */
function writeLock(content: unknown, ageMs = 0, path = lockFile()): void {
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
  const at = new Date(Date.now() - ageMs);
  utimesSync(path, at, at);
}

/** Touches the lock the way a live holder's heartbeat does, until the test ends */
function heartbeat(path = lockFile()): void {
  const timer = setInterval(() => {
    const now = new Date();
    utimesSync(path, now, now);
  }, FAST.heartbeatMs);
  stops.push(() => clearInterval(timer));
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

/** A child process that holds the lock with FAST timing, resolved once it says it holds it */
async function holderProcess(path = ledger()): Promise<ChildProcess> {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", HOLDER, path, String(FAST.heartbeatMs), String(FAST.staleMs), String(FAST.pollMs)],
    { cwd: PACKAGE_DIR, stdio: ["ignore", "pipe", "inherit"] },
  );
  children.push(child);
  await new Promise<void>((resolve, reject) => {
    child.stdout?.on("data", (chunk: Buffer) => {
      if (chunk.toString().startsWith("held")) resolve();
    });
    child.once("exit", (code) => reject(new Error(`the holder exited with ${code} before it held the lock`)));
  });
  return child;
}

describe("lockLedger", () => {
  test("a second lock of one ledger in this process is refused until the first is released", async () => {
    const release = await lock();
    await expect(lockLedger(ledger(), FAST)).rejects.toThrow(/^ledgerPath: .*already open in this process$/);
    await expect(lockLedger(join(dir, ".", "ledger.jsonl"), FAST)).rejects.toThrow(/already open/);

    release();
    await expect(lock()).resolves.toBeTypeOf("function");
  });

  test("the lock names this process and host, and only its owner can read it", async () => {
    await lock();
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

  test("the holder touches its lock every heartbeat", async () => {
    await lock();
    const first = statSync(lockFile()).mtimeMs;
    await new Promise((resolve) => setTimeout(resolve, FAST.heartbeatMs * 4));
    expect(statSync(lockFile()).mtimeMs).toBeGreaterThan(first);
  });

  test("release removes the lock, and twice is harmless", async () => {
    const release = await lock();
    release();
    release();
    expect(existsSync(lockFile())).toBe(false);
  });

  test("release leaves a lock that someone else wrote meanwhile", async () => {
    const release = await lock();
    writeLock(holder({ host: "facilitator-elsewhere" }));
    release();
    expect(readLock()).toEqual(holder({ host: "facilitator-elsewhere" }));
  });

  test("the directory of a ledger that does not exist yet is created", async () => {
    const nested = join(dir, "data", "regtest", "ledger.jsonl");
    await lock(nested);
    expect(existsSync(`${nested}.lock`)).toBe(true);
  });
});

describe("a live holder is never taken over", () => {
  test("a fresh lock of a live process on this host is refused at once", async () => {
    writeLock(holder({ pid: process.ppid }));
    const { error, ms } = await refusal();
    expect(error.message).toContain(`is in use by pid ${process.ppid} on ${hostname()}`);
    expect(ms).toBeLessThan(FAST.staleMs / 2);
    expect(readLock()).toEqual(holder({ pid: process.ppid }));
  });

  test.skipIf(process.getuid?.() === 0)("a pid of another user counts as alive, kill answering EPERM", async () => {
    writeLock(holder({ pid: 1 }));
    const { error, ms } = await refusal();
    expect(error.message).toContain("is in use by pid 1 on");
    expect(ms).toBeLessThan(FAST.staleMs / 2);
  });

  test.each<[string, () => Promise<Record<string, unknown>>]>([
    ["a pid that looks dead, as another pid namespace's would", async () => holder({ pid: await deadPid() })],
    ["this very pid, as a sibling container's pid 1 would", async () => holder()],
    ["another host", async () => holder({ host: "facilitator-elsewhere" })],
  ])("a lock naming %s is refused while its heartbeat goes on", async (_, make) => {
    const live = await make();
    writeLock(live);
    heartbeat();

    const { error } = await refusal();

    expect(error.message).toBe(
      `ledgerPath: ${ledger()} is in use by pid ${String(live.pid)} on ${String(live.host)} ` +
        `since 2026-10-28T00:00:00.000Z; stop that facilitator, or delete ${lockFile()} if none is running`,
    );
    expect(readLock()).toEqual(live);
  });

  test("a holder in another process is refused while it lives", async () => {
    await holderProcess();
    const { error } = await refusal();
    expect(error.message).toMatch(/is in use by pid \d+ on /);
  });
});

describe("a crashed holder is taken over without help", () => {
  test("a lock whose heartbeat stopped is taken over once it has been untouched for staleMs", async () => {
    writeLock(holder({ pid: await deadPid() }));
    const started = performance.now();
    await lock();
    const waited = performance.now() - started;
    expect(waited).toBeGreaterThanOrEqual(FAST.staleMs - 60);
    expect(waited).toBeLessThan(FAST.staleMs + 1500);
    expect(readLock()).toMatchObject({ pid: process.pid, host: hostname() });
  });

  test.each([
    ["a dead pid on this host", { host: hostname(), pid: 999_999 }],
    ["another host", { host: "facilitator-elsewhere" }],
    ["this very pid", {}],
  ])("a lock naming %s, already untouched for staleMs, is taken over at once", async (_, over) => {
    writeLock(holder(over), FAST.staleMs + 100);
    const started = performance.now();
    await lock();
    expect(performance.now() - started).toBeLessThan(FAST.staleMs / 2);
    expect(readLock()).toMatchObject({ pid: process.pid, host: hostname() });
  });

  test("a holder killed with SIGKILL leaves a lock the next start takes over within staleMs", async () => {
    const child = await holderProcess();
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));

    const started = performance.now();
    await lock();
    expect(performance.now() - started).toBeLessThan(FAST.staleMs + 1500);
    expect(readLock()).toMatchObject({ pid: process.pid });
  });

  test("a holder sent SIGTERM removes its lock as it stops", async () => {
    const child = await holderProcess();
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
    expect(existsSync(lockFile())).toBe(false);
  });
});

describe("a lock that cannot be read", () => {
  test.each<[string, unknown]>([
    ["not JSON", '{"pid":'],
    ["empty, as a crash between create and write leaves it", ""],
    ["an array", [1]],
    ["no pid", { ...holder(), pid: undefined }],
    ["pid 0, which would signal a process group", holder({ pid: 0 })],
    ["a negative pid", holder({ pid: -1 })],
    ["a host with a newline", holder({ host: "a\nb" })],
  ])("%s, untouched for staleMs, is taken over at once", async (_, content) => {
    writeLock(content, FAST.staleMs + 100);
    const started = performance.now();
    await lock();
    expect(performance.now() - started).toBeLessThan(FAST.staleMs / 2);
    expect(readLock()).toMatchObject({ pid: process.pid });
  });

  test("an empty lock that is still fresh is taken over once it has been untouched for staleMs", async () => {
    writeLock("");
    const started = performance.now();
    await lock();
    expect(performance.now() - started).toBeGreaterThanOrEqual(FAST.staleMs - 60);
  });

  test("one that keeps being touched is refused as unreadable", async () => {
    writeLock("{");
    heartbeat();
    const { error } = await refusal();
    expect(error.message).toBe(
      `ledgerPath: ${lockFile()} exists and cannot be read; delete it if no facilitator is running`,
    );
  });

  test.each<[string, () => void]>([
    ["a FIFO", () => execFileSync("mkfifo", [lockFile()])],
    ["a directory", () => mkdirSync(lockFile())],
    ["a symlink", () => symlinkSync(join(dir, "elsewhere"), lockFile())],
  ])("%s at the lock path is refused at once, without blocking", async (_, make) => {
    make();
    const { error, ms } = await refusal();
    expect(error.message).toBe(
      `ledgerPath: ${lockFile()} is not a regular file; delete it if no facilitator is running`,
    );
    expect(ms).toBeLessThan(FAST.staleMs / 2);
  });
});

describe("starts that race for one stale lock", () => {
  test("a takeover waits while another start holds the takeover mutex, and then meets that start's lock", async () => {
    writeLock(holder({ pid: await deadPid() }), FAST.staleMs + 100);
    writeFileSync(`${lockFile()}.takeover`, "");
    // The other start finishes its takeover a little later
    setTimeout(() => {
      writeLock(holder({ pid: process.ppid }));
      rmSync(`${lockFile()}.takeover`);
    }, 100);

    const { error } = await refusal();

    expect(error.message).toContain(`is in use by pid ${process.ppid}`);
    expect(readLock()).toEqual(holder({ pid: process.ppid }));
  });

  test("a takeover mutex left by a crashed start is cleared once it is untouched for staleMs", async () => {
    writeLock(holder({ pid: await deadPid() }), FAST.staleMs + 100);
    writeFileSync(`${lockFile()}.takeover`, "");
    const old = new Date(Date.now() - FAST.staleMs - 100);
    utimesSync(`${lockFile()}.takeover`, old, old);

    await lock();

    expect(readLock()).toMatchObject({ pid: process.pid });
    expect(existsSync(`${lockFile()}.takeover`)).toBe(false);
  });

  test("of eight starts racing for one stale lock, exactly one wins", async () => {
    writeLock(holder({ pid: await deadPid() }), FAST.staleMs + 100);
    const goAt = Date.now() + 3000;
    const contenders = Array.from({ length: 8 }, () => {
      const timing = [FAST.heartbeatMs, FAST.staleMs, FAST.pollMs].map(String);
      const child = spawn(process.execPath, ["--import", "tsx", CONTENDER, ledger(), String(goAt), ...timing, "2500"], {
        cwd: PACKAGE_DIR,
        stdio: ["ignore", "pipe", "inherit"],
      });
      children.push(child);
      return new Promise<string>((resolve) => {
        let out = "";
        child.stdout?.on("data", (chunk: Buffer) => {
          out += chunk.toString();
        });
        child.once("exit", () => resolve(out.trim()));
      });
    });

    const outcomes = await Promise.all(contenders);

    expect(outcomes.filter((o) => o === "won")).toHaveLength(1);
    expect(outcomes.filter((o) => o === "lost")).toHaveLength(7);
  }, 20_000);
});

describe("a lock that another start took", () => {
  /** A heartbeat too slow to run within a test, so only assertHeld looks */
  const QUIET = { ...FAST, heartbeatMs: 60_000 };
  const LOST = /^ledgerPath: .*ledger\.jsonl is no longer locked by this facilitator/;

  /** Replaces the lock the way a start that took it over writes its own */
  function takeOver(over: Record<string, unknown> = {}, ageMs = 0): void {
    rmSync(lockFile());
    writeLock(holder({ token: "f0f0f0f0f0f0f0f0", ...over }), ageMs);
  }

  test("checks out while the lock is this start's, and not once it is released", async () => {
    const lock = await held(ledger(), QUIET);
    expect(() => lock.assertHeld()).not.toThrow();
    lock.release();
    expect(() => lock.assertHeld()).toThrow(LOST);
  });

  test.each([
    ["another token under this pid, as a sibling container's pid 1 would write it", {}],
    ["another pid", { pid: 1 }],
  ])("is refused before the next write when it holds %s", async (_, over) => {
    const lock = await held(ledger(), QUIET);
    takeOver(over);
    expect(() => lock.assertHeld()).toThrow(LOST);
    expect(() => lock.assertHeld()).toThrow(/pid \d+ on .* holds it/);
  });

  test("is refused before the next write once its file is gone", async () => {
    const lock = await held(ledger(), QUIET);
    rmSync(lockFile());
    expect(() => lock.assertHeld()).toThrow(/its lock is gone/);
  });

  test("is found by the heartbeat, which stops touching it and reports the loss once", async () => {
    const onLost = vi.fn<(err: Error) => void>();
    const lock = await held(ledger(), { ...FAST, onLost });
    // Rewritten in place, so a heartbeat that kept touching its descriptor would move this file's time
    writeLock(holder({ token: "f0f0f0f0f0f0f0f0" }), 60_000);
    const stale = statSync(lockFile()).mtimeMs;

    await vi.waitFor(() => expect(onLost).toHaveBeenCalledTimes(1), { timeout: 2000 });
    await new Promise((resolve) => setTimeout(resolve, 5 * FAST.heartbeatMs));

    expect(onLost).toHaveBeenCalledTimes(1);
    expect(onLost.mock.calls[0]?.[0].message).toMatch(LOST);
    expect(statSync(lockFile()).mtimeMs).toBe(stale);
    expect(() => lock.assertHeld()).toThrow(LOST);
    lock.release();
    expect(readLock()).toMatchObject({ token: "f0f0f0f0f0f0f0f0" });
  });

  const asRoot = process.getuid?.() === 0;
  test.skipIf(asRoot)("that cannot be read refuses a write, while the heartbeat still touches it", async () => {
    const onLost = vi.fn<(err: Error) => void>();
    const lock = await held(ledger(), { ...FAST, onLost });
    chmodSync(lockFile(), 0o000);
    stops.push(() => chmodSync(lockFile(), 0o600));
    const before = statSync(lockFile()).mtimeMs;
    await new Promise((resolve) => setTimeout(resolve, 4 * FAST.heartbeatMs));

    expect(() => lock.assertHeld()).toThrow(/is no longer locked by this facilitator \(its lock cannot be read/);
    expect(statSync(lockFile()).mtimeMs).toBeGreaterThan(before);
    expect(onLost).not.toHaveBeenCalled();
  });
});

describe("one lock for every spelling of a ledger path", () => {
  test("a ledger reached through a symlink shares the real file's lock", async () => {
    writeFileSync(ledger(), "");
    const alias = join(dir, "alias.jsonl");
    symlinkSync(ledger(), alias);

    await lock(alias);

    expect(existsSync(lockFile())).toBe(true);
    expect(existsSync(`${alias}.lock`)).toBe(false);
    await expect(lockLedger(ledger(), FAST)).rejects.toThrow(/already open in this process/);
  });

  test("a ledger reached through a symlinked directory shares the real file's lock", async () => {
    mkdirSync(join(dir, "real"));
    symlinkSync(join(dir, "real"), join(dir, "linked"));

    await lock(join(dir, "linked", "ledger.jsonl"));

    expect(existsSync(join(dir, "real", "ledger.jsonl.lock"))).toBe(true);
    await expect(lockLedger(join(dir, "real", "ledger.jsonl"), FAST)).rejects.toThrow(/already open/);
  });

  test("a case variant of the ledger path shares its lock where the file system ignores case", async () => {
    writeFileSync(ledger(), "");
    const variant = join(dir, "LEDGER.jsonl");
    if (!existsSync(variant)) return;

    await lock(variant);

    expect(existsSync(lockFile())).toBe(true);
    await expect(lockLedger(ledger(), FAST)).rejects.toThrow(/already open/);
  });
});
