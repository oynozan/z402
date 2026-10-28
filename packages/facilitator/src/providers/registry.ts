/**
 * The providers registered with this facilitator, kept in `registry.json` of the providers directory.
 *
 * One start writes it at a time, under the heartbeat lock of the ledgers. A write goes to a temp file that is synced
 * and renamed over the registry, and the directory is synced after the rename, so a crash leaves the old file or the
 * new one whole. The list in memory changes only once all of that has succeeded. A file that is not exactly what a
 * write produces refuses the start, and no message ever quotes a viewing key or a key hash.
 */
import { randomBytes } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { isValidPayTo, isZcashNetwork, type ZcashNetwork } from "@z402-net/protocol";
import { lockLedger, type HeldLock } from "../core/ledgerLock.js";
import { MAX_PAY_TO_LENGTH } from "../payTo.js";

/** One registered provider, as the registry file holds it */
export interface ProviderEntry {
  /** 16 lowercase hex, fixed by the network and the payTo, and the name of the provider's ledger */
  id: string;
  payTo: string;
  /** The provider's view-only key */
  uivk: string;
  /** The sha256 of the provider's API key, in lowercase hex */
  keyHash: string;
  /** An ISO 8601 timestamp, as toISOString writes it */
  createdAt: string;
  /** When the current API key was issued, in the same form */
  keyIssuedAt: string;
}

/** A registry that cannot be used, which refuses startup or the registration it was asked to store */
export class RegistryError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "RegistryError";
  }
}

const REGISTRY_FILE = "registry.json";
const FIELDS = ["id", "payTo", "uivk", "keyHash", "createdAt", "keyIssuedAt"] as const;
const EXTRA_FIELDS = `fields other than ${FIELDS.slice(0, -1).join(", ")} and ${FIELDS.at(-1)}`;
const TIMESTAMP = "an ISO 8601 timestamp like 2026-10-28T12:00:00.000Z";
const ID_RE = /^[0-9a-f]{16}$/;
const KEY_HASH_RE = /^[0-9a-f]{64}$/;
const MAX_UIVK_LENGTH = 1024;

/** Takes the lock on the registry of `o.dir`, makes the directory, and loads what an earlier start wrote */
export async function openRegistry(o: {
  dir: string;
  network: ZcashNetwork;
  /** Told once if the lock stops naming this start, after which the registry writes nothing more */
  onLost?: (err: unknown) => void;
}): Promise<ProviderRegistry> {
  makeDir(o.dir);
  makeDir(join(o.dir, "ledgers"));
  const path = join(o.dir, REGISTRY_FILE);
  const lock = await lockRegistry(path, o.onLost);
  try {
    return new ProviderRegistry(o.dir, o.network, loadEntries(path, o.network), lock);
  } catch (e) {
    lock.release();
    throw e;
  }
}

/** The registered providers and the one writer of their file, made by openRegistry */
export class ProviderRegistry {
  readonly dir: string;
  readonly network: ZcashNetwork;
  readonly #path: string;
  readonly #lock: HeldLock;
  #entries: readonly ProviderEntry[];

  constructor(dir: string, network: ZcashNetwork, entries: readonly ProviderEntry[], lock: HeldLock) {
    this.dir = dir;
    this.network = network;
    this.#path = join(dir, REGISTRY_FILE);
    this.#lock = lock;
    this.#entries = entries;
  }

  /** The providers in the order they registered, a snapshot that no later put changes */
  entries(): readonly ProviderEntry[] {
    return this.#entries;
  }

  get(payTo: string): ProviderEntry | undefined {
    return this.#entries.find((e) => e.payTo === payTo);
  }

  /** Where the ledger of a provider lives, and only for an id that cannot name a file outside ledgers/ */
  ledgerPath(id: string): string {
    if (!ID_RE.test(id)) throw new RegistryError("providersDir: a provider id is 16 lowercase hex");
    return join(this.dir, "ledgers", `${id}.jsonl`);
  }

  catalogPath(): string {
    return join(this.dir, "discovery.json");
  }

  /** Stores the provider in place of the one with its payTo, or after the others, and throws with the list unchanged */
  put(entry: ProviderEntry): void {
    const stored = this.#checked(entry);
    const at = this.#entries.findIndex((e) => e.payTo === stored.payTo);
    const next = at < 0 ? [...this.#entries, stored] : this.#entries.map((e, i) => (i === at ? stored : e));
    this.#lock.assertHeld();
    this.#write(next);
    this.#entries = Object.freeze(next);
  }

  /** Frees the lock, and does nothing the second time */
  close(): void {
    this.#lock.release();
  }

  #checked(entry: unknown): ProviderEntry {
    const problem = entryProblem(entry, this.network) ?? this.#conflict(entry as ProviderEntry);
    if (problem !== undefined) throw new RegistryError(`providersDir: cannot store the provider (${problem})`);
    return frozenCopy(entry as ProviderEntry);
  }

  /** The id of a payTo is fixed for life, since its ledger is named by it, and no two payTo values share one */
  #conflict(entry: ProviderEntry): string | undefined {
    const registered = this.#entries.find((e) => e.payTo === entry.payTo);
    if (registered !== undefined && registered.id !== entry.id) return "the id of a registered payTo cannot change";
    if (this.#entries.some((e) => e.id === entry.id && e.payTo !== entry.payTo)) {
      return "the id belongs to another payTo";
    }
    return undefined;
  }

  // Whatever fails, the temp file goes and the error is the caller's, and a rename that already happened stays
  #write(list: readonly ProviderEntry[]): void {
    const text = `${JSON.stringify({ version: 1, network: this.network, providers: list })}\n`;
    const temp = `${this.#path}.${randomBytes(6).toString("hex")}.tmp`;
    let fd: number | undefined;
    try {
      fd = openSync(temp, "wx", 0o600);
      writeFileSync(fd, text);
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(temp, this.#path);
      syncDirectory(this.dir);
    } catch (e) {
      const unclosed = fd;
      if (unclosed !== undefined) quietly(() => closeSync(unclosed));
      quietly(() => unlinkSync(temp));
      throw e;
    }
  }
}

function makeDir(path: string): void {
  try {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  } catch (e) {
    throw new RegistryError(`providersDir: cannot create ${path} (${codeOf(e) ?? "unknown error"})`, { cause: e });
  }
}

async function lockRegistry(path: string, onLost: ((err: unknown) => void) | undefined): Promise<HeldLock> {
  try {
    return await lockLedger(path, { onLost });
  } catch (e) {
    // The lock speaks of a ledger, while the setting to look at here is the providers directory
    const why = e instanceof Error ? e.message.replace(/^ledgerPath: /, "") : `${path} cannot be locked`;
    throw new RegistryError(`providersDir: ${why}`, { cause: e });
  }
}

/** The providers of the file, none if there is no file, and a RegistryError for a file a write could not have made */
function loadEntries(path: string, network: ZcashNetwork): readonly ProviderEntry[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if (codeOf(e) === "ENOENT") return [];
    throw new RegistryError(`providersDir: cannot read ${path} (${codeOf(e) ?? "unknown error"})`, { cause: e });
  }
  const invalid = (reason: string) =>
    new RegistryError(`providersDir: ${path} is not a valid provider registry (${reason})`);

  // JSON.parse quotes the start of its input in its error, which here could be a viewing key
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw invalid("not JSON");
  }
  if (!isRecord(parsed)) throw invalid("not a JSON object");
  if (parsed.version !== 1) throw invalid("version is not 1");
  if (!isZcashNetwork(parsed.network)) throw invalid("network is not a Zcash network");
  // Judged before the entries, which are valid addresses of that other network and not of this one
  if (parsed.network !== network) throw new RegistryError(`providersDir: ${path} is the registry of ${parsed.network}`);
  if (!Array.isArray(parsed.providers)) throw invalid("providers is not an array");
  if (Object.keys(parsed).length !== 3) throw invalid("fields other than version, network and providers");

  const entries: ProviderEntry[] = [];
  const payTos = new Map<string, number>();
  const ids = new Map<string, number>();
  for (const [i, raw] of parsed.providers.entries()) {
    const problem = entryProblem(raw, network);
    if (problem !== undefined) throw invalid(`entry ${i + 1}: ${problem}`);
    const entry = frozenCopy(raw as ProviderEntry);
    const samePayTo = payTos.get(entry.payTo);
    if (samePayTo !== undefined) throw invalid(`entries ${samePayTo + 1} and ${i + 1} share a payTo`);
    const sameId = ids.get(entry.id);
    if (sameId !== undefined) throw invalid(`entries ${sameId + 1} and ${i + 1} share an id`);
    payTos.set(entry.payTo, i);
    ids.set(entry.id, i);
    entries.push(entry);
  }
  return Object.freeze(entries);
}

/** Why `x` is no provider of `network`, or undefined, in words that never carry a value from `x` */
function entryProblem(x: unknown, network: ZcashNetwork): string | undefined {
  if (!isRecord(x)) return "not an object";
  if (Object.keys(x).some((key) => !(FIELDS as readonly string[]).includes(key))) return EXTRA_FIELDS;
  if (typeof x.id !== "string" || !ID_RE.test(x.id)) return "id is not 16 lowercase hex";
  if (typeof x.payTo === "string" && x.payTo.length > MAX_PAY_TO_LENGTH) {
    return `payTo is over ${MAX_PAY_TO_LENGTH} characters`;
  }
  if (typeof x.payTo !== "string" || !isValidPayTo(x.payTo, network)) return `payTo is not valid for ${network}`;
  if (typeof x.uivk !== "string" || !isUivk(x.uivk)) return "uivk is not 1 to 1024 characters without whitespace";
  if (typeof x.keyHash !== "string" || !KEY_HASH_RE.test(x.keyHash)) return "keyHash is not 64 lowercase hex";
  if (!isTimestamp(x.createdAt)) return `createdAt is not ${TIMESTAMP}`;
  if (!isTimestamp(x.keyIssuedAt)) return `keyIssuedAt is not ${TIMESTAMP}`;
  return undefined;
}

const isRecord = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);

const isUivk = (s: string): boolean => s.length > 0 && s.length <= MAX_UIVK_LENGTH && !/\s/.test(s);

/** A string that toISOString writes back unchanged, which leaves out the forms Date.parse takes in a loose reading */
function isTimestamp(x: unknown): boolean {
  if (typeof x !== "string") return false;
  const ms = Date.parse(x);
  return !Number.isNaN(ms) && new Date(ms).toISOString() === x;
}

/** The six fields in file order, so the file reads the same whatever order the caller built the entry in */
function frozenCopy(e: ProviderEntry): ProviderEntry {
  return Object.freeze({
    id: e.id,
    payTo: e.payTo,
    uivk: e.uivk,
    keyHash: e.keyHash,
    createdAt: e.createdAt,
    keyIssuedAt: e.keyIssuedAt,
  });
}

function syncDirectory(dir: string): void {
  const fd = openSync(dir, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function quietly(fn: () => void): void {
  try {
    fn();
  } catch {}
}

function codeOf(e: unknown): string | undefined {
  return typeof e === "object" && e !== null && "code" in e && typeof e.code === "string" ? e.code : undefined;
}
