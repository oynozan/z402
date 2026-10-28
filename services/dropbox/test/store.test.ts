import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { DropStore, isDropId, type DropMeta } from "../src/store.js";

let dir: string;
let logs: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dropbox-store-"));
  logs = [];
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const open = (maxTotalBytes = 10_000): DropStore =>
  new DropStore({ dir, maxTotalBytes, log: (line) => logs.push(line) });
const names = (): string[] => readdirSync(dir).sort();
const metaOf = (id: string): DropMeta => JSON.parse(readFileSync(join(dir, `${id}.json`), "utf8")) as DropMeta;

describe("put", () => {
  test("writes the bytes and the metadata, and leaves no temporary file", () => {
    const store = open();
    const bytes = randomBytes(300);
    const { meta, deleteToken } = store.put({ bytes, expiresAtHeight: 110 });

    expect(names()).toEqual([`${meta.id}.age`, `${meta.id}.json`]);
    expect(readFileSync(join(dir, `${meta.id}.age`)).equals(bytes)).toBe(true);
    expect(store.read(meta.id)?.equals(bytes)).toBe(true);
    expect(metaOf(meta.id)).toEqual({
      id: meta.id,
      size: 300,
      createdAt: meta.createdAt,
      expiresAtHeight: 110,
      deleteTokenHash: meta.deleteTokenHash,
    });
    expect(new Date(meta.createdAt).toISOString()).toBe(meta.createdAt);
    expect(statSync(join(dir, `${meta.id}.age`)).mode & 0o077).toBe(0);
    expect(store.get(meta.id)).toEqual(meta);
    expect(store.count).toBe(1);
    expect(store.usedBytes).toBe(300);
    expect(deleteToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  test("makes ids of 16 random bytes and tokens of 32, and keeps only the hash of the token", () => {
    const store = open();
    const a = store.put({ bytes: randomBytes(10), expiresAtHeight: 1 });
    const b = store.put({ bytes: randomBytes(10), expiresAtHeight: 1 });
    expect(a.meta.id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(isDropId(a.meta.id)).toBe(true);
    expect(a.meta.id).not.toBe(b.meta.id);
    expect(a.deleteToken).not.toBe(b.deleteToken);
    expect(a.meta.deleteTokenHash).toMatch(/^[0-9a-f]{64}$/);
    for (const name of names()) expect(readFileSync(join(dir, name), "latin1")).not.toContain(a.deleteToken);
  });

  test("creates the directory when it is missing", () => {
    const nested = join(dir, "a", "b");
    const store = new DropStore({ dir: nested, maxTotalBytes: 100, log: () => undefined });
    store.put({ bytes: randomBytes(5), expiresAtHeight: 1 });
    expect(readdirSync(nested)).toHaveLength(2);
  });

  test("does not refuse for room, since the caller has checked and been paid", () => {
    const store = open(100);
    expect(store.hasRoom(100)).toBe(true);
    store.put({ bytes: randomBytes(100), expiresAtHeight: 1 });
    store.put({ bytes: randomBytes(100), expiresAtHeight: 1 });
    expect(store.usedBytes).toBe(200);
    expect(store.hasRoom(1)).toBe(false);
  });
});

describe("accounting", () => {
  test("counts the stored bytes and says whether another upload fits", () => {
    const store = open(1000);
    expect(store.hasRoom(1000)).toBe(true);
    expect(store.hasRoom(1001)).toBe(false);
    const a = store.put({ bytes: randomBytes(400), expiresAtHeight: 5 });
    const b = store.put({ bytes: randomBytes(500), expiresAtHeight: 5 });
    expect(store.usedBytes).toBe(900);
    expect(store.hasRoom(100)).toBe(true);
    expect(store.hasRoom(101)).toBe(false);
    store.remove(a.meta.id);
    expect(store.usedBytes).toBe(500);
    expect(store.hasRoom(500)).toBe(true);
    store.remove(b.meta.id);
    expect(store.usedBytes).toBe(0);
    expect(store.count).toBe(0);
  });
});

describe("reload", () => {
  test("a new store on the same directory has the same drops, bytes, expiries and tokens", () => {
    const first = open();
    const a = first.put({ bytes: randomBytes(120), expiresAtHeight: 50 });
    const b = first.put({ bytes: randomBytes(80), expiresAtHeight: 60 });
    first.extend(a.meta.id, 70);

    const second = open();
    expect(second.count).toBe(2);
    expect(second.usedBytes).toBe(200);
    expect(second.get(a.meta.id)).toEqual({ ...a.meta, expiresAtHeight: 70 });
    expect(second.get(b.meta.id)).toEqual(b.meta);
    expect(second.read(a.meta.id)?.length).toBe(120);
    expect(second.checkToken(a.meta.id, a.deleteToken)).toBe(true);
    expect(second.checkToken(a.meta.id, b.deleteToken)).toBe(false);
    expect(logs).toEqual([]);
  });

  test("removes what a crash leaves: temporary files, and data without metadata", () => {
    const first = open();
    const kept = first.put({ bytes: randomBytes(50), expiresAtHeight: 9 });
    const orphan = `${randomBytes(16).toString("base64url")}.age`;
    writeFileSync(join(dir, orphan), randomBytes(40));
    writeFileSync(join(dir, `${kept.meta.id}.json.1a2b3c4d.tmp`), "{");
    writeFileSync(join(dir, "AAAAAAAAAAAAAAAAAAAAAA.age.deadbeef.tmp"), randomBytes(10));

    const second = open();
    expect(names()).toEqual([`${kept.meta.id}.age`, `${kept.meta.id}.json`]);
    expect(second.count).toBe(1);
    expect(second.usedBytes).toBe(50);
  });

  test("skips corrupt entries, says so, and leaves their files alone", () => {
    const first = open();
    const good = first.put({ bytes: randomBytes(30), expiresAtHeight: 9 });
    const other = first.put({ bytes: randomBytes(30), expiresAtHeight: 9 });
    const third = first.put({ bytes: randomBytes(30), expiresAtHeight: 9 });
    const fourth = first.put({ bytes: randomBytes(30), expiresAtHeight: 9 });

    writeFileSync(join(dir, `${other.meta.id}.json`), "{ not json");
    unlinkSync(join(dir, `${third.meta.id}.age`));
    writeFileSync(join(dir, `${fourth.meta.id}.age`), randomBytes(31));
    const mismatched = { ...good.meta, id: "BBBBBBBBBBBBBBBBBBBBBB" };
    writeFileSync(join(dir, "AAAAAAAAAAAAAAAAAAAAAA.json"), JSON.stringify(mismatched));

    logs = [];
    const second = open();
    expect(second.count).toBe(1);
    expect(second.get(good.meta.id)).toEqual(good.meta);
    expect(second.usedBytes).toBe(30);
    expect(logs).toHaveLength(4);
    expect(logs.join("\n")).toMatch(/skipping \S+\.json: unreadable metadata/);
    expect(logs.join("\n")).toMatch(/its data file is missing/);
    expect(logs.join("\n")).toMatch(/its data file does not have the recorded size/);
    expect(logs.join("\n")).toMatch(/invalid metadata/);
    expect(existsSync(join(dir, `${other.meta.id}.json`))).toBe(true);
    expect(existsSync(join(dir, `${fourth.meta.id}.age`))).toBe(true);
  });

  test("leaves alone every file that is not its own, so a directory that holds other things is safe", () => {
    const strangers = ["notes.tmp", "secrets.age", "config.json", "short.age", "x.age.deadbeef.tmp", "README.md"];
    for (const name of strangers) writeFileSync(join(dir, name), "mine");
    mkdirSync(join(dir, "AAAAAAAAAAAAAAAAAAAAAA.age.deadbeef.tmp.d"));
    const aged = `${randomBytes(16).toString("base64url")}.age.txt`;
    writeFileSync(join(dir, aged), "mine");

    const store = open();
    store.put({ bytes: randomBytes(10), expiresAtHeight: 1 });
    open();
    for (const name of [...strangers, aged]) expect(readFileSync(join(dir, name), "utf8"), name).toBe("mine");
    expect(logs).toEqual([]);
  });

  test("skips metadata with a field of the wrong kind", () => {
    const first = open();
    const { meta } = first.put({ bytes: randomBytes(30), expiresAtHeight: 9 });
    for (const bad of [
      { expiresAtHeight: -1 },
      { expiresAtHeight: 1.5 },
      { size: "30" },
      { createdAt: "yesterday" },
      { deleteTokenHash: "abc" },
      { deleteTokenHash: "G".repeat(64) },
    ]) {
      writeFileSync(join(dir, `${meta.id}.json`), JSON.stringify({ ...meta, ...bad }));
      expect(open().count, JSON.stringify(bad)).toBe(0);
    }
    writeFileSync(join(dir, `${meta.id}.json`), "null");
    expect(open().count).toBe(0);
  });
});

describe("sweep", () => {
  test("removes the drops the tip has reached, files and accounting included", () => {
    const store = open();
    const a = store.put({ bytes: randomBytes(100), expiresAtHeight: 110 });
    const b = store.put({ bytes: randomBytes(100), expiresAtHeight: 120 });
    const c = store.put({ bytes: randomBytes(100), expiresAtHeight: 130 });

    expect(store.sweep(109)).toBe(0);
    expect(store.count).toBe(3);
    expect(logs).toEqual([]);

    // A drop is gone once the tip reaches its height and not one block later
    expect(store.sweep(110)).toBe(1);
    expect(store.get(a.meta.id)).toBeUndefined();
    expect(existsSync(join(dir, `${a.meta.id}.age`))).toBe(false);
    expect(existsSync(join(dir, `${a.meta.id}.json`))).toBe(false);
    expect(store.usedBytes).toBe(200);

    expect(store.sweep(500)).toBe(2);
    expect(store.count).toBe(0);
    expect(store.usedBytes).toBe(0);
    expect(names()).toEqual([]);
    expect(store.get(b.meta.id)).toBeUndefined();
    expect(store.get(c.meta.id)).toBeUndefined();
    expect(logs).toEqual(["dropbox: swept 1 expired drop at tip 110", "dropbox: swept 2 expired drops at tip 500"]);
  });
});

describe("extend", () => {
  test("moves the expiry later and persists it, and never moves it earlier", () => {
    const store = open();
    const { meta } = store.put({ bytes: randomBytes(10), expiresAtHeight: 110 });
    expect(store.extend(meta.id, 120)?.expiresAtHeight).toBe(120);
    expect(metaOf(meta.id).expiresAtHeight).toBe(120);
    expect(store.extend(meta.id, 115)?.expiresAtHeight).toBe(120);
    expect(store.extend(meta.id, 120)?.expiresAtHeight).toBe(120);
    expect(metaOf(meta.id).expiresAtHeight).toBe(120);
    expect(store.get(meta.id)?.expiresAtHeight).toBe(120);
    expect(store.extend("AAAAAAAAAAAAAAAAAAAAAA", 5)).toBeUndefined();
    expect(names()).toEqual([`${meta.id}.age`, `${meta.id}.json`]);
  });
});

describe("the delete token", () => {
  test("is checked against the hash, for the drop it belongs to", () => {
    const store = open();
    const a = store.put({ bytes: randomBytes(10), expiresAtHeight: 1 });
    const b = store.put({ bytes: randomBytes(10), expiresAtHeight: 1 });
    expect(store.checkToken(a.meta.id, a.deleteToken)).toBe(true);
    expect(store.checkToken(a.meta.id, b.deleteToken)).toBe(false);
    expect(store.checkToken(a.meta.id, a.deleteToken.slice(0, -1))).toBe(false);
    expect(store.checkToken(a.meta.id, `${a.deleteToken}x`)).toBe(false);
    expect(store.checkToken(a.meta.id, "")).toBe(false);
    expect(store.checkToken(a.meta.id, a.meta.deleteTokenHash)).toBe(false);
    expect(store.checkToken("AAAAAAAAAAAAAAAAAAAAAA", a.deleteToken)).toBe(false);
  });
});

describe("remove and read", () => {
  test("remove deletes both files once, and read answers only for known drops", () => {
    const store = open();
    const { meta } = store.put({ bytes: randomBytes(10), expiresAtHeight: 1 });
    expect(store.remove(meta.id)).toBe(true);
    expect(store.remove(meta.id)).toBe(false);
    expect(names()).toEqual([]);
    expect(store.read(meta.id)).toBeUndefined();
    expect(store.get(meta.id)).toBeUndefined();
  });

  test("a drop whose data file has vanished is forgotten on the first read", () => {
    const store = open();
    const { meta } = store.put({ bytes: randomBytes(10), expiresAtHeight: 1 });
    unlinkSync(join(dir, `${meta.id}.age`));
    expect(store.read(meta.id)).toBeUndefined();
    expect(store.count).toBe(0);
    expect(store.usedBytes).toBe(0);
    expect(names()).toEqual([]);
  });

  test("never reaches the disk for something that is not a drop id", () => {
    const store = open();
    store.put({ bytes: randomBytes(10), expiresAtHeight: 1 });
    for (const id of ["../x", "..", "", "a/b", "%2e%2e", `${"A".repeat(21)}.`, "A".repeat(23)]) {
      expect(isDropId(id)).toBe(false);
      expect(store.get(id)).toBeUndefined();
      expect(store.read(id)).toBeUndefined();
      expect(store.remove(id)).toBe(false);
    }
  });
});
