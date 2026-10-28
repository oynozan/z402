/**
 * The drops on disk. The file `<id>.age` holds the uploaded bytes untouched and `<id>.json` the metadata, and a drop
 * exists once both are written. Every write goes to a temporary file that is renamed into place, so a crash of the
 * process leaves a whole file or none. The data lands before the metadata, so it leaves at worst a data file without
 * metadata, which the next start removes. A power loss can leave a short file, which the size check at start skips.
 *
 * The file system is used synchronously on purpose. Uploads are capped at a few MiB, so every operation is atomic with
 * respect to the event loop and a sweep, a hold, a delete and a write of the same drop can never interleave.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stderr, type Log } from "./log.js";

export interface DropMeta {
  /** 16 random bytes, base64url */
  id: string;
  size: number;
  createdAt: string;
  /** The drop is gone once the chain tip reaches this height */
  expiresAtHeight: number;
  /** SHA-256 of the delete token in hex, the token itself is only in the upload's answer */
  deleteTokenHash: string;
}

export interface StoreOptions {
  dir: string;
  /** The total `hasRoom` allows, which `put` itself does not enforce */
  maxTotalBytes: number;
  log?: Log;
}

const ID = /^[A-Za-z0-9_-]{22}$/;
const HASH = /^[0-9a-f]{64}$/;
const DATA = ".age";
const META = ".json";
const TEMP = ".tmp";
// Start-up touches only names that are the store's own, since the directory may hold anything else
const DATA_FILE = /^([A-Za-z0-9_-]{22})\.age$/;
const META_FILE = /^([A-Za-z0-9_-]{22})\.json$/;
const TEMP_FILE = /^[A-Za-z0-9_-]{22}\.(?:age|json)\.[0-9a-f]{8}\.tmp$/;

export const isDropId = (value: string): boolean => ID.test(value);

const hashToken = (token: string): Buffer => createHash("sha256").update(token).digest();

function isWhole(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function parseMeta(raw: unknown): DropMeta | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const { id, size, createdAt, expiresAtHeight, deleteTokenHash } = raw as Record<string, unknown>;
  if (typeof id !== "string" || !ID.test(id)) return undefined;
  if (!isWhole(size) || !isWhole(expiresAtHeight)) return undefined;
  if (typeof createdAt !== "string" || Number.isNaN(Date.parse(createdAt))) return undefined;
  if (typeof deleteTokenHash !== "string" || !HASH.test(deleteTokenHash)) return undefined;
  return { id, size, createdAt, expiresAtHeight, deleteTokenHash };
}

export class DropStore {
  readonly #dir: string;
  readonly #maxTotalBytes: number;
  readonly #log: Log;
  readonly #drops = new Map<string, DropMeta>();
  #usedBytes = 0;

  /** Creates the directory if it is missing, then adopts every whole drop in it */
  constructor(o: StoreOptions) {
    this.#dir = o.dir;
    this.#maxTotalBytes = o.maxTotalBytes;
    this.#log = o.log ?? stderr;
    mkdirSync(this.#dir, { recursive: true, mode: 0o700 });
    this.#load();
  }

  get usedBytes(): number {
    return this.#usedBytes;
  }

  get count(): number {
    return this.#drops.size;
  }

  hasRoom(size: number): boolean {
    return this.#usedBytes + size <= this.#maxTotalBytes;
  }

  get(id: string): Readonly<DropMeta> | undefined {
    return this.#drops.get(id);
  }

  /** The stored bytes, undefined for an unknown drop or one whose file has vanished */
  read(id: string): Buffer | undefined {
    if (!this.#drops.has(id)) return undefined;
    try {
      return readFileSync(this.#path(id, DATA));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      this.remove(id);
      return undefined;
    }
  }

  /** Never refuses for room, since hasRoom ran before payment and a paid put must not fail */
  put(o: { bytes: Uint8Array; expiresAtHeight: number }): { meta: Readonly<DropMeta>; deleteToken: string } {
    const id = randomBytes(16).toString("base64url");
    const deleteToken = randomBytes(32).toString("base64url");
    const meta: DropMeta = {
      id,
      size: o.bytes.byteLength,
      createdAt: new Date().toISOString(),
      expiresAtHeight: o.expiresAtHeight,
      deleteTokenHash: hashToken(deleteToken).toString("hex"),
    };
    this.#write(this.#path(id, DATA), o.bytes);
    try {
      this.#write(this.#path(id, META), JSON.stringify(meta));
    } catch (e) {
      this.#unlink(this.#path(id, DATA));
      throw e;
    }
    this.#drops.set(id, meta);
    this.#usedBytes += meta.size;
    return { meta, deleteToken };
  }

  /** Moves the expiry later and never earlier, undefined for an unknown drop */
  extend(id: string, expiresAtHeight: number): Readonly<DropMeta> | undefined {
    const meta = this.#drops.get(id);
    if (meta === undefined) return undefined;
    if (expiresAtHeight <= meta.expiresAtHeight) return meta;
    const next = { ...meta, expiresAtHeight };
    this.#write(this.#path(id, META), JSON.stringify(next));
    this.#drops.set(id, next);
    return next;
  }

  /** Whether the token is the one `put` handed out for this drop, compared in constant time */
  checkToken(id: string, token: string): boolean {
    const meta = this.#drops.get(id);
    if (meta === undefined) return false;
    return timingSafeEqual(hashToken(token), Buffer.from(meta.deleteTokenHash, "hex"));
  }

  remove(id: string): boolean {
    const meta = this.#drops.get(id);
    if (meta === undefined) return false;
    this.#drops.delete(id);
    this.#usedBytes -= meta.size;
    // The metadata goes first, so that a failure in between leaves a data file that start-up removes
    this.#unlink(this.#path(id, META));
    this.#unlink(this.#path(id, DATA));
    return true;
  }

  /** Removes every drop the tip has reached and returns how many that was */
  sweep(tip: number): number {
    let removed = 0;
    for (const meta of [...this.#drops.values()]) {
      if (tip >= meta.expiresAtHeight && this.remove(meta.id)) removed += 1;
    }
    if (removed > 0) this.#log(`dropbox: swept ${removed} expired ${removed === 1 ? "drop" : "drops"} at tip ${tip}`);
    return removed;
  }

  #path(id: string, extension: string): string {
    return join(this.#dir, `${id}${extension}`);
  }

  #write(path: string, data: string | Uint8Array): void {
    const temporary = `${path}.${randomBytes(4).toString("hex")}${TEMP}`;
    try {
      writeFileSync(temporary, data, { mode: 0o600 });
      renameSync(temporary, path);
    } catch (e) {
      this.#unlink(temporary);
      throw e;
    }
  }

  #unlink(path: string): void {
    try {
      unlinkSync(path);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") this.#log(`dropbox: cannot remove ${path} (${code ?? "error"})`);
    }
  }

  #load(): void {
    const names = readdirSync(this.#dir);
    const withMeta = new Set(names.flatMap((name) => META_FILE.exec(name)?.[1] ?? []));
    for (const name of names) {
      const meta = META_FILE.exec(name)?.[1];
      const data = DATA_FILE.exec(name)?.[1];
      if (TEMP_FILE.test(name)) {
        // A write that never finished
        this.#unlink(join(this.#dir, name));
      } else if (meta !== undefined) {
        const problem = this.#adopt(meta);
        if (problem !== undefined) this.#log(`dropbox: skipping ${name}: ${problem}`);
      } else if (data !== undefined && !withMeta.has(data)) {
        // The metadata is written last, so this upload was never answered
        this.#unlink(join(this.#dir, name));
      }
    }
  }

  /** Adds the drop to the index, or says what is wrong with it */
  #adopt(id: string): string | undefined {
    let meta: DropMeta | undefined;
    try {
      meta = parseMeta(JSON.parse(readFileSync(this.#path(id, META), "utf8")));
    } catch {
      return "unreadable metadata";
    }
    if (meta === undefined || meta.id !== id) return "invalid metadata";
    let size: number;
    try {
      size = statSync(this.#path(id, DATA)).size;
    } catch {
      return "its data file is missing";
    }
    if (size !== meta.size) return "its data file does not have the recorded size";
    this.#drops.set(id, meta);
    this.#usedBytes += meta.size;
    return undefined;
  }
}
