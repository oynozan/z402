import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test, vi } from "vitest";
import {
  zdecryptDecrypt,
  zdecryptOwns,
  zdecryptOwnsShielded,
  ZdecryptError,
  ZdecryptRefused,
} from "../../src/chain/zdecrypt.js";
import { FakeBinaries } from "../support/fakeZdecrypt.js";
import { failure } from "../support/failure.js";

const fakes = new FakeBinaries();
afterAll(() => fakes.dispose());

const KEY = "uivktest1thisisnotarealkeybutmustneverleak";
const TXID = "ab".repeat(32);

const REPORT = {
  txid: TXID,
  version: 6,
  expiryHeight: 4547450,
  transparentIn: 0,
  transparentOut: 0,
  outputs: [
    { pool: "ironwood", scope: "external", valueZat: 100000, memoKind: "text", memoText: "m:0", toPayTo: true },
  ],
};

const decrypt = (bin: string, o: { timeoutMs?: number; rawHex?: string } = {}) =>
  zdecryptDecrypt({ bin, key: KEY, rawHex: o.rawHex ?? "00", at: { tip: 1 }, network: "testnet", ...o });

const owns = (bin: string) => zdecryptOwns({ bin, key: KEY, address: "utest1x", network: "testnet" });
const shielded = (bin: string) => zdecryptOwnsShielded({ bin, key: KEY, address: "utest1x", network: "testnet" });

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

describe("zdecryptDecrypt report", () => {
  test("keeps the fields the verdict needs and drops the rest", async () => {
    const printed = {
      ...REPORT,
      heightKind: "mempool",
      outputs: [{ ...REPORT.outputs[0], index: 0, recipient: "utest1x", receiverHex: "00", memoHex: null }],
    };
    await expect(decrypt(fakes.canned(JSON.stringify(printed)).bin)).resolves.toStrictEqual(REPORT);
  });

  test("an output without toPayTo stays without it", async () => {
    const { toPayTo: _, ...bare } = REPORT.outputs[0]!;
    const report = await decrypt(fakes.canned(JSON.stringify({ ...REPORT, outputs: [bare] })).bin);
    expect(report.outputs).toStrictEqual([bare]);
  });

  const out = (change: Record<string, unknown>) => ({ ...REPORT, outputs: [{ ...REPORT.outputs[0], ...change }] });
  const without = (field: string) => {
    const { [field]: _, ...rest } = REPORT as Record<string, unknown>;
    return rest;
  };

  test.each([
    ["is not an object", null],
    ["has no txid", without("txid")],
    ["has a numeric txid", { ...REPORT, txid: 7 }],
    ["has no version", without("version")],
    ["has no transparentIn", without("transparentIn")],
    ["has a text transparentOut", { ...REPORT, transparentOut: "1" }],
    ["has a negative transparentIn", { ...REPORT, transparentIn: -1 }],
    ["has a fractional expiryHeight", { ...REPORT, expiryHeight: 1.5 }],
    ["has no outputs", without("outputs")],
    ["has an output in an unknown pool", out({ pool: "transparent" })],
    ["has an output of unknown scope", out({ scope: "other" })],
    ["has a negative value", out({ valueZat: -1 })],
    ["has a fractional value", out({ valueZat: 1.5 })],
    ["has a value beyond 2^53", out({ valueZat: Number.MAX_SAFE_INTEGER + 1 })],
    ["has an unknown memoKind", out({ memoKind: "hex" })],
    ["has a numeric memoText", out({ memoText: 5 })],
    ["has a text toPayTo", out({ toPayTo: "yes" })],
  ])("a report that %s is refused", async (_name, printed) => {
    const error = await failure(decrypt(fakes.canned(JSON.stringify(printed)).bin));
    expect(error).toBeInstanceOf(ZdecryptError);
    expect(error.message).toMatch(/report is malformed/);
  });
});

describe("zdecryptOwns report", () => {
  test("hands on both flags exactly as printed", async () => {
    const printed = JSON.stringify({ hasTransparent: true, ownedByKey: false, orchardOwned: false });
    await expect(owns(fakes.canned(printed).bin)).resolves.toStrictEqual({ hasTransparent: true, ownedByKey: false });
  });

  test.each([
    ["ownedByKey is not a boolean", { hasTransparent: false, ownedByKey: "yes" }],
    ["hasTransparent is missing", { ownedByKey: true }],
  ])("a report where %s is refused", async (_name, printed) => {
    const error = await failure(owns(fakes.canned(JSON.stringify(printed)).bin));
    expect(error).toBeInstanceOf(ZdecryptError);
    expect(error.message).toMatch(/report is malformed/);
  });
});

describe("zdecryptOwnsShielded", () => {
  test.each([
    ["the key owns an address that takes only shielded deposits", { hasTransparent: false, ownedByKey: true }, true],
    ["the key does not own the address", { hasTransparent: false, ownedByKey: false }, false],
    ["the address has a transparent receiver", { hasTransparent: true, ownedByKey: true }, false],
    ["the key owns nothing and the address is transparent", { hasTransparent: true, ownedByKey: false }, false],
  ])("answers for the registration when %s", async (_name, printed, expected) => {
    await expect(shielded(fakes.canned(JSON.stringify(printed)).bin)).resolves.toBe(expected);
  });

  test("answers false when zdecrypt refuses the key or the address, since that is no key of that address", async () => {
    const refused = JSON.stringify({ error: "not a testnet unified address" });
    await expect(shielded(fakes.canned(refused, 2).bin)).resolves.toBe(false);
  });

  // Every one of these is a failure to ask, which the caller must see as one and never as a "no"
  test.each([
    ["exit 2 with nothing readable", () => fakes.canned("not json", 2).bin, /exited with code 2/],
    ["an exit code of 1", () => fakes.canned(JSON.stringify({ error: "x" }), 1).bin, /exited with code 1/],
    ["a crash", () => fakes.script("process.stdout.write('x'); process.exitCode = 101;").bin, /exited with code 101/],
    ["a kill by a signal", () => fakes.script(`process.kill(process.pid, "SIGKILL");`).bin, /killed by SIGKILL/],
    [
      "a binary that is not there",
      () => join(tmpdir(), "z402-no-such-dir", "zdecrypt"),
      /could not be started \(ENOENT\)/,
    ],
    ["output that is no JSON", () => fakes.canned("this is not json").bin, /printed no JSON report/],
    ["a report with the wrong shape", () => fakes.canned(JSON.stringify({ hasTransparent: "no" })).bin, /malformed/],
  ])("still rejects, as a ZdecryptError that is no refusal, for %s", async (_name, bin, message) => {
    const error = await failure(shielded(bin()));
    expect(error).toBeInstanceOf(ZdecryptError);
    expect(error).not.toBeInstanceOf(ZdecryptRefused);
    expect(error.message).toMatch(message);
  });
});

describe("zdecrypt process", () => {
  test("a child past timeoutMs is killed with SIGKILL", async () => {
    const hang = fakes.script(
      [
        `if (process.argv[2] === "warm") process.exit(0);`,
        `process.on("SIGTERM", () => {});`,
        `setTimeout(() => {}, 15000);`,
      ].join("\n"),
    );
    // The first start of a new file is slow on macOS, and the child must be running before the timer fires
    spawnSync(hang.bin, ["warm"]);
    const warmed = hang.calls().length;
    const outcome = failure(decrypt(hang.bin, { timeoutMs: 2000 }));
    await expect.poll(() => hang.calls().length, { timeout: 5000 }).toBeGreaterThan(warmed);
    const error = await outcome;
    expect(error).toBeInstanceOf(ZdecryptError);
    expect(error).not.toBeInstanceOf(ZdecryptRefused);
    expect(error.message).toMatch(/timed out after 2000 ms/);
    await expect.poll(() => alive(hang.calls().at(-1)!.pid), { timeout: 5000 }).toBe(false);
  }, 20000);

  test("an unexpected exit code is reported without anything the child printed", async () => {
    const crash = fakes.script(
      [
        `const k = process.env.ZDECRYPT_KEY;`,
        `process.stderr.write("panic " + k);`,
        `process.stdout.write("panic " + k);`,
        `process.exitCode = 101;`,
      ].join("\n"),
    );
    const error = await failure(decrypt(crash.bin));
    expect(error).toBeInstanceOf(ZdecryptError);
    expect(error.message).toMatch(/exited with code 101/);
    expect(error.message).not.toContain(KEY);
    expect(error.cause).toBeUndefined();
  });

  test("output that is not JSON is reported without quoting it", async () => {
    const error = await failure(decrypt(fakes.canned(KEY).bin));
    expect(error).toBeInstanceOf(ZdecryptError);
    expect(error.message).not.toContain(KEY.slice(0, 8));
    expect(error.cause).toBeUndefined();
  });

  test("a child killed by a signal is reported by the signal", async () => {
    const killed = fakes.script(`process.kill(process.pid, "SIGKILL");`);
    const error = await failure(decrypt(killed.bin));
    expect(error).toBeInstanceOf(ZdecryptError);
    expect(error.message).toMatch(/killed by SIGKILL/);
  });

  test("exit 2 without an error object has no message to forward, and is no refusal", async () => {
    const error = await failure(decrypt(fakes.canned("not json", 2).bin));
    expect(error).toBeInstanceOf(ZdecryptError);
    expect(error).not.toBeInstanceOf(ZdecryptRefused);
    expect(error.message).toMatch(/exited with code 2/);
  });

  test("exit 2 forwards the error text the binary printed, as a refusal", async () => {
    const printed = JSON.stringify({ error: "transaction does not parse: x" });
    const error = await failure(decrypt(fakes.canned(printed, 2).bin));
    expect(error).toBeInstanceOf(ZdecryptError);
    expect(error).toBeInstanceOf(ZdecryptRefused);
    expect(error.name).toBe("ZdecryptRefused");
    expect(error.message).toBe("transaction does not parse: x");
  });

  test("a child that exits without reading its input does not crash the caller", async () => {
    const uncaught: unknown[] = [];
    const record = (e: unknown) => uncaught.push(e);
    process.on("uncaughtException", record);
    try {
      const deaf = fakes.script(`process.exitCode = 1;`);
      const error = await failure(decrypt(deaf.bin, { rawHex: "00".repeat(4_000_000) }));
      expect(error).toBeInstanceOf(ZdecryptError);
      expect(error.message).toMatch(/exited with code 1/);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(uncaught).toEqual([]);
    } finally {
      process.off("uncaughtException", record);
    }
  });

  test("no timeout timer outlives a call, whatever its outcome", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await decrypt(fakes.canned(JSON.stringify(REPORT)).bin);
      await failure(decrypt(fakes.canned(JSON.stringify({ error: "x" }), 2).bin));
      await failure(decrypt(join(tmpdir(), "z402-no-such-dir", "zdecrypt")));
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a key that cannot be passed on is not quoted in the error", async () => {
    const attempt = zdecryptDecrypt({
      bin: fakes.canned("{}").bin,
      key: `${KEY}\0`,
      rawHex: "00",
      at: { tip: 1 },
      network: "testnet",
    });
    const error = await failure(attempt);
    expect(error).toBeInstanceOf(ZdecryptError);
    expect(error.message).not.toContain(KEY.slice(0, 8));
    expect(error.cause).toBeUndefined();
  });

  test("a binary that cannot be started is a ZdecryptError", async () => {
    const error = await failure(decrypt(join(tmpdir(), "z402-no-such-dir", "zdecrypt")));
    expect(error).toBeInstanceOf(ZdecryptError);
    expect(error.message).toMatch(/could not be started \(ENOENT\)/);
  });
});
