import { randomBytes } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, unlinkSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, join } from "node:path";

/** Who holds a ledger, as its lock file records it */
interface Holder {
  pid: number;
  host: string;
  token: string;
  since: string;
}

/** Ledgers this process holds, by real path, since a lock naming this pid is taken over when it is not in here */
const held = new Set<string>();

/** Makes this process the one writer of the ledger at `path` through `<path>.lock`, and returns its release */
export function lockLedger(path: string): () => void {
  const key = keyOf(path);
  if (held.has(key)) throw new Error(`ledgerPath: ${path} is already open in this process`);

  const lock = `${path}.lock`;
  const me: Holder = {
    pid: process.pid,
    host: hostname(),
    token: randomBytes(8).toString("hex"),
    since: new Date().toISOString(),
  };
  if (!create(lock, me)) {
    const holder = holderOf(lock);
    if (!isStale(holder)) throw inUse(path, lock, holder);
    try {
      unlinkSync(lock);
    } catch (e) {
      if (codeOf(e) !== "ENOENT") throw cannot(`remove the stale ${lock}`, e);
    }
    if (!create(lock, me)) throw inUse(path, lock, holderOf(lock));
  }
  held.add(key);

  let released = false;
  return () => {
    if (released) return;
    released = true;
    held.delete(key);
    // A lock that someone else wrote since then is theirs, so it stays
    try {
      if (holderOf(lock).token === me.token) unlinkSync(lock);
    } catch {}
  };
}

function keyOf(path: string): string {
  try {
    mkdirSync(dirname(path), { recursive: true });
    return join(realpathSync(dirname(path)), basename(path));
  } catch (e) {
    throw cannot(`create the directory of ${path}`, e);
  }
}

/** Writes the lock unless one exists, false when it does */
function create(lock: string, me: Holder): boolean {
  let fd: number;
  try {
    fd = openSync(lock, "wx", 0o600);
  } catch (e) {
    if (codeOf(e) === "EEXIST") return false;
    throw cannot(`create ${lock}`, e);
  }
  try {
    writeSync(fd, JSON.stringify(me));
  } catch (e) {
    rmSync(lock, { force: true });
    throw cannot(`write ${lock}`, e);
  } finally {
    closeSync(fd);
  }
  return true;
}

function holderOf(lock: string): Holder {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(lock, "utf8"));
  } catch {
    throw unreadable(lock);
  }
  if (!isHolder(value)) throw unreadable(lock);
  return value;
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

/** Left by a crash on this host, with a dead pid or this very pid from an earlier run, as pid 1 is after a restart */
function isStale(h: Holder): boolean {
  return h.host === hostname() && (h.pid === process.pid || !isAlive(h.pid));
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

function codeOf(e: unknown): string | undefined {
  return typeof e === "object" && e !== null && "code" in e && typeof e.code === "string" ? e.code : undefined;
}

function cannot(what: string, e: unknown): Error {
  return new Error(`ledgerPath: cannot ${what} (${codeOf(e) ?? "unknown error"})`, { cause: e });
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
