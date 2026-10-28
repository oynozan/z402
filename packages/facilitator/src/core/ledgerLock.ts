/**
 * One writer per ledger file, through `<ledger>.lock` beside the canonical path of the ledger.
 *
 * The holder keeps the lock open and touches it every heartbeat. A lock nobody touched for staleMs was left by a crash,
 * whatever pid or host it names, so it is taken over. A fresh lock whose pid is alive on this host is refused at once.
 * Any other fresh lock (a dead pid, this very pid, another host, or content that cannot be read) may belong to a live
 * holder this process cannot see, such as a container sharing the volume, so a start watches it: a heartbeat means a
 * live holder and a refusal, and staleMs without one means a takeover. A takeover runs under `<lock>.takeover`, created
 * exclusively, and checks again under it that the lock is still the one judged stale, so two starts cannot both win.
 */
import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  futimesSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, join } from "node:path";

/** How a held lock proves its holder alive, in milliseconds */
export interface LockTiming {
  /** How often the holder touches its lock */
  heartbeatMs: number;
  /** How long a lock nobody touched is taken for a crash's */
  staleMs: number;
  /** How often a start that watches a fresh lock looks at it again */
  pollMs: number;
}

const TIMING: LockTiming = { heartbeatMs: 5000, staleMs: 15_000, pollMs: 250 };
/** A lock is a few dozen bytes, so anything longer is not one */
const MAX_LOCK_BYTES = 4096;

/** Who holds a ledger, as its lock file records it */
interface Holder {
  pid: number;
  host: string;
  token: string;
  since: string;
}

/** A lock as one look at it found it */
interface Seen {
  holder: Holder | undefined;
  mtimeMs: number;
  ino: number;
  size: number;
}

/** Ledgers this process holds or is taking, by canonical path */
const held = new Set<string>();

/** Makes this process the one writer of the ledger at `path`, and resolves with the release of its lock */
export async function lockLedger(path: string, timing: Partial<LockTiming> = {}): Promise<() => void> {
  const t = { ...TIMING, ...timing };
  const key = canonicalOf(path);
  if (held.has(key)) throw new Error(`ledgerPath: ${path} is already open in this process`);
  held.add(key);
  try {
    const lock = `${key}.lock`;
    const me: Holder = {
      pid: process.pid,
      host: hostname(),
      token: randomBytes(8).toString("hex"),
      since: new Date().toISOString(),
    };
    const fd = await acquire(path, lock, me, t);
    return holding(key, lock, me, fd, t);
  } catch (e) {
    held.delete(key);
    throw e;
  }
}

/** The ledger path with links and case resolved as far as it exists, so every spelling of one ledger shares a lock */
function canonicalOf(path: string): string {
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch (e) {
    throw cannot(`create the directory of ${path}`, e);
  }
  return realOf(path);
}

function realOf(path: string): string {
  try {
    return realpathSync.native(path);
  } catch (e) {
    const parent = dirname(path);
    if (codeOf(e) !== "ENOENT" || parent === path) throw cannot(`resolve ${path}`, e);
    return join(realOf(parent), basename(path));
  }
}

async function acquire(path: string, lock: string, me: Holder, t: LockTiming): Promise<number> {
  let watched: { seen: Seen; since: number } | undefined;
  for (;;) {
    const fd = create(lock, me);
    if (fd !== undefined) return fd;
    const seen = look(lock);
    if (seen === undefined) continue;

    const watchedFor = watched !== undefined && same(watched.seen, seen) ? performance.now() - watched.since : 0;
    if (Date.now() - seen.mtimeMs >= t.staleMs || watchedFor >= t.staleMs) {
      const won = takeover(lock, seen, me, t);
      if (won !== undefined) return won;
      watched = undefined;
      await sleep(t.pollMs);
      continue;
    }
    // A live pid of this host is the holder for sure, so there is nothing to wait for
    const h = seen.holder;
    if (h !== undefined && h.host === hostname() && h.pid !== process.pid && isAlive(h.pid)) throw inUse(path, lock, h);
    // Touched or rewritten while watched, so something this process cannot see keeps it alive
    if (watched !== undefined && !same(watched.seen, seen)) {
      throw h === undefined ? unreadable(lock) : inUse(path, lock, h);
    }
    watched ??= { seen, since: performance.now() };
    await sleep(t.pollMs);
  }
}

/** Creates the lock unless one exists, and keeps it open for the heartbeat */
function create(lock: string, me: Holder): number | undefined {
  let fd: number;
  try {
    fd = openSync(lock, "wx", 0o600);
  } catch (e) {
    if (codeOf(e) === "EEXIST") return undefined;
    throw cannot(`create ${lock}`, e);
  }
  try {
    writeSync(fd, JSON.stringify(me));
  } catch (e) {
    closeSync(fd);
    unlinkIfThere(lock);
    throw cannot(`write ${lock}`, e);
  }
  return fd;
}

/** One look at the lock, undefined when it is gone, opened so a FIFO or a link can neither block nor redirect it */
function look(lock: string): Seen | undefined {
  let fd: number;
  try {
    fd = openSync(lock, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (e) {
    const code = codeOf(e);
    if (code === "ENOENT") return undefined;
    if (code === "ELOOP" || code === "EMLINK") throw notRegular(lock);
    throw cannot(`read ${lock}`, e);
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw notRegular(lock);
    const bytes = Buffer.alloc(MAX_LOCK_BYTES);
    const length = readSync(fd, bytes, 0, MAX_LOCK_BYTES, 0);
    return { holder: holderIn(bytes.subarray(0, length)), mtimeMs: st.mtimeMs, ino: st.ino, size: st.size };
  } finally {
    closeSync(fd);
  }
}

function holderIn(bytes: Buffer): Holder | undefined {
  try {
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    return isHolder(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

const same = (a: Seen, b: Seen): boolean => a.mtimeMs === b.mtimeMs && a.ino === b.ino && a.size === b.size;

/** Replaces the stale lock under the takeover mutex, undefined when another start got there first */
function takeover(lock: string, stale: Seen, me: Holder, t: LockTiming): number | undefined {
  const mutex = `${lock}.takeover`;
  let m: number;
  try {
    m = openSync(mutex, "wx", 0o600);
  } catch (e) {
    if (codeOf(e) !== "EEXIST") throw cannot(`create ${mutex}`, e);
    clearIfStale(mutex, t);
    return undefined;
  }
  let fd: number | undefined;
  try {
    // Under the mutex the lock must still be the one judged stale, or another start already took it
    const now = look(lock);
    if (now !== undefined && !same(now, stale)) return undefined;
    if (now !== undefined) unlinkIfThere(lock);
    fd = create(lock, me);
  } finally {
    closeSync(m);
    unlinkIfThere(mutex);
  }
  if (fd !== undefined && look(lock)?.holder?.token === me.token) return fd;
  if (fd !== undefined) closeSync(fd);
  return undefined;
}

/** A start that crashed in the middle of a takeover leaves its mutex behind */
function clearIfStale(mutex: string, t: LockTiming): void {
  try {
    const st = lstatSync(mutex);
    if (st.isFile() && Date.now() - st.mtimeMs >= t.staleMs) unlinkSync(mutex);
  } catch {}
}

function holding(key: string, lock: string, me: Holder, fd: number, t: LockTiming): () => void {
  const timer = setInterval(() => {
    try {
      const now = new Date();
      futimesSync(fd, now, now);
    } catch {}
  }, t.heartbeatMs);
  timer.unref();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    clearInterval(timer);
    held.delete(key);
    try {
      closeSync(fd);
    } catch {}
    // A lock that someone else wrote since then is theirs, so it stays
    try {
      if (look(lock)?.holder?.token === me.token) unlinkSync(lock);
    } catch {}
  };
}

const PRINTABLE = /^[^\x00-\x1f\x7f]+$/;

function isHolder(x: unknown): x is Holder {
  if (typeof x !== "object" || x === null || Array.isArray(x)) return false;
  const h = x as Record<string, unknown>;
  return (
    // Pid 0 and negative pids would signal a whole process group
    typeof h.pid === "number" &&
    Number.isSafeInteger(h.pid) &&
    h.pid > 0 &&
    typeof h.host === "string" &&
    PRINTABLE.test(h.host) &&
    typeof h.token === "string" &&
    typeof h.since === "string" &&
    PRINTABLE.test(h.since)
  );
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM is a live process of another user
    return codeOf(e) !== "ESRCH";
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function unlinkIfThere(path: string): void {
  try {
    unlinkSync(path);
  } catch (e) {
    if (codeOf(e) !== "ENOENT") throw cannot(`remove ${path}`, e);
  }
}

function codeOf(e: unknown): string | undefined {
  return typeof e === "object" && e !== null && "code" in e && typeof e.code === "string" ? e.code : undefined;
}

function cannot(what: string, e: unknown): Error {
  return new Error(`ledgerPath: cannot ${what} (${codeOf(e) ?? "unknown error"})`, { cause: e });
}

function notRegular(lock: string): Error {
  return new Error(`ledgerPath: ${lock} is not a regular file; delete it if no facilitator is running`);
}

function unreadable(lock: string): Error {
  return new Error(`ledgerPath: ${lock} exists and cannot be read; delete it if no facilitator is running`);
}

function inUse(path: string, lock: string, h: Holder): Error {
  return new Error(
    `ledgerPath: ${path} is in use by pid ${h.pid} on ${h.host} since ${h.since}; ` +
      `stop that facilitator, or delete ${lock} if none is running`,
  );
}
