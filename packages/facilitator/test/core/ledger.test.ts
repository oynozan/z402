import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { Ledger, LedgerRefusal, type LedgerEvent } from "../../src/core/ledger.js";
import { depositEvent, statusEvent, unreadableEvents, voucherEvent } from "./events.js";

// The ledger imports appendFileSync by name, so only a module mock can make one write fail part-way
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, appendFileSync: vi.fn(fs.appendFileSync) };
});

const SHAPE_REFUSAL = /^event 2( \((deposit|voucher|status)\))? is not a ledger event$/;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "z402-ledger-"));
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

const file = () => join(dir, "ledger.jsonl");
const line = (x: unknown) => `${JSON.stringify(x)}\n`;
const quietWarn = () => vi.spyOn(console, "warn").mockImplementation(() => {});

describe("Ledger file", () => {
  test("3 events round trip through the file", () => {
    const events = [depositEvent(), voucherEvent(), statusEvent()];
    const ledger = new Ledger(file());
    ledger.appendSync(events.slice(0, 2));
    ledger.appendSync(events.slice(2));
    expect(ledger.replay()).toEqual(events);
  });

  test("a second ledger on the same path replays the first one's events", () => {
    const events = [depositEvent(), voucherEvent()];
    new Ledger(file()).appendSync(events);
    expect(new Ledger(file()).replay()).toEqual(events);
  });

  test("each event is one JSON line", () => {
    new Ledger(file()).appendSync([depositEvent(), voucherEvent()]);
    expect(readFileSync(file(), "utf8")).toBe(line(depositEvent()) + line(voucherEvent()));
  });

  test("replaying a ledger that was never written gives no events", () => {
    expect(new Ledger(file()).replay()).toEqual([]);
  });

  test("appending nothing creates no file", () => {
    new Ledger(file()).appendSync([]);
    expect(existsSync(file())).toBe(false);
  });

  test("the file mode is 0600", () => {
    new Ledger(file()).appendSync([voucherEvent()]);
    expect(statSync(file()).mode & 0o777).toBe(0o600);
  });

  test("the parent directories are created", () => {
    const nested = join(dir, "data", "net", "ledger.jsonl");
    new Ledger(nested).appendSync([voucherEvent()]);
    expect(new Ledger(nested).replay()).toEqual([voucherEvent()]);
  });

  test("blank lines are ignored", () => {
    writeFileSync(file(), `\n${line(depositEvent())}\n\n${line(voucherEvent())}\n`);
    expect(new Ledger(file()).replay()).toEqual([depositEvent(), voucherEvent()]);
  });
});

describe("Ledger recovery", () => {
  test("a truncated last line is dropped with exactly one warning", () => {
    const warn = quietWarn();
    new Ledger(file()).appendSync([depositEvent(), voucherEvent()]);
    appendFileSync(file(), '{"t":"status","txid":"00');
    expect(new Ledger(file()).replay()).toEqual([depositEvent(), voucherEvent()]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test("a truncated last line that ends in a newline is dropped too", () => {
    const warn = quietWarn();
    new Ledger(file()).appendSync([depositEvent()]);
    appendFileSync(file(), '{"t":"voucher","sessionK\n');
    expect(new Ledger(file()).replay()).toEqual([depositEvent()]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test("appending after a dropped tail keeps the log readable", () => {
    const warn = quietWarn();
    new Ledger(file()).appendSync([depositEvent()]);
    appendFileSync(file(), '{"t":"voucher","sessionKey":"ab');

    const restarted = new Ledger(file());
    expect(restarted.replay()).toEqual([depositEvent()]);
    restarted.appendSync([voucherEvent()]);

    expect(new Ledger(file()).replay()).toEqual([depositEvent(), voucherEvent()]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test("a file holding only a truncated line replays nothing", () => {
    const warn = quietWarn();
    writeFileSync(file(), '{"t":"vouc');
    expect(new Ledger(file()).replay()).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(readFileSync(file(), "utf8")).toBe("");
  });

  test("a complete last line without its newline is kept and the log stays aligned", () => {
    const warn = quietWarn();
    writeFileSync(file(), line(depositEvent()) + JSON.stringify(voucherEvent()));
    const restarted = new Ledger(file());
    expect(restarted.replay()).toEqual([depositEvent(), voucherEvent()]);
    restarted.appendSync([statusEvent()]);
    expect(new Ledger(file()).replay()).toEqual([depositEvent(), voucherEvent(), statusEvent()]);
    expect(warn).not.toHaveBeenCalled();
  });

  test("a clean replay does not warn", () => {
    const warn = quietWarn();
    new Ledger(file()).appendSync([depositEvent(), voucherEvent()]);
    new Ledger(file()).replay();
    expect(warn).not.toHaveBeenCalled();
  });

  test("a malformed middle line makes replay throw", () => {
    writeFileSync(file(), line(depositEvent()) + "not json\n" + line(voucherEvent()));
    expect(() => new Ledger(file()).replay()).toThrow(/ledger line 2/);
  });

  test("a malformed middle line is not repaired away", () => {
    const text = line(depositEvent()) + "not json\n" + line(voucherEvent());
    writeFileSync(file(), text);
    expect(() => new Ledger(file()).replay()).toThrow();
    expect(readFileSync(file(), "utf8")).toBe(text);
  });

  test.each([
    ["an unknown event type", { t: "bogus" }],
    ["a deposit with a numeric txid", { ...depositEvent(), txid: 7 }],
    ["a deposit with an empty session key", { ...depositEvent(), sessionKey: "" }],
    ["a deposit value that is not canonical", { ...depositEvent(), valueZat: "0100" }],
    ["a deposit value above the money supply", { ...depositEvent(), valueZat: "2100000000000001" }],
    ["a deposit value as a number", { ...depositEvent(), valueZat: 100000 }],
    ["a deposit with an unknown status", { ...depositEvent(), status: "bogus" }],
    ["a deposit with a flag that is not boolean", { ...depositEvent(), zeroConf: "yes" }],
    ["a deposit with a negative expiry", { ...depositEvent(), expiryHeight: -1 }],
    ["a deposit with a fractional tip", { ...depositEvent(), firstSeenTip: 1.5 }],
    ["a deposit without a mined height", { ...depositEvent(), minedHeight: undefined }],
    ["a voucher without a session key", { ...voucherEvent(), sessionKey: undefined }],
    ["a voucher with a negative cumulative", { ...voucherEvent(), cumulativeZat: "-5" }],
    ["a status without deadAtTip", { ...statusEvent(), deadAtTip: undefined }],
    ["a status without a txid", { ...statusEvent(), txid: undefined }],
    ["a JSON array", [depositEvent()]],
    ["a JSON string", "voucher"],
    ["JSON null", null],
  ])("%s is refused even as the last line", (_what, bad) => {
    const warn = quietWarn();
    writeFileSync(file(), line(depositEvent()) + line(bad));
    expect(() => new Ledger(file()).replay()).toThrow(/ledger line 2/);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe.each<[string, () => Ledger]>([
  ["file", () => new Ledger(file())],
  ["memory", () => new Ledger()],
])("Ledger.appendSync with a %s ledger", (_kind, makeLedger) => {
  test.each(unreadableEvents)("%s is refused and nothing from its batch is written", (_what, bad) => {
    const ledger = makeLedger();
    ledger.appendSync([depositEvent()]);
    expect(() => ledger.appendSync([voucherEvent(), bad as LedgerEvent])).toThrow(LedgerRefusal);
    expect(() => ledger.appendSync([voucherEvent(), bad as LedgerEvent])).toThrow(SHAPE_REFUSAL);
    expect(ledger.replay()).toEqual([depositEvent()]);
  });

  test("a refused event is named by its type, and the next good batch is still taken", () => {
    const ledger = makeLedger();
    const unsafe = { ...statusEvent(), confirmations: 2 ** 53 };
    expect(() => ledger.appendSync([unsafe])).toThrow("event 1 (status) is not a ledger event");
    expect(() => ledger.appendSync([unsafe])).toThrow(LedgerRefusal);
    expect(ledger.replay()).toEqual([]);

    ledger.appendSync([voucherEvent()]);
    expect(ledger.replay()).toEqual([voucherEvent()]);
  });

  test("an event of an unknown type is named by its place only", () => {
    expect(() => makeLedger().appendSync([{ t: "secret-value" } as unknown as LedgerEvent])).toThrow(
      /^event 1 is not a ledger event$/,
    );
  });
});

describe("Ledger after a failed write", () => {
  /** Makes the next append write its first 37 bytes and then fail, as a full disk can */
  async function tearNextAppend(): Promise<void> {
    const real = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.mocked(appendFileSync).mockImplementationOnce((path, data, options) => {
      real.appendFileSync(path, String(data).slice(0, 37), options);
      throw Object.assign(new Error("EIO: i/o error, write"), { code: "EIO" });
    });
  }

  test("a torn write is cut back off, so the file is byte for byte what it was", async () => {
    const ledger = new Ledger(file());
    ledger.appendSync([depositEvent()]);
    const before = readFileSync(file());

    await tearNextAppend();
    expect(() => ledger.appendSync([voucherEvent(), statusEvent()])).toThrow(/EIO/);

    expect(readFileSync(file())).toEqual(before);
    expect(new Ledger(file()).replay()).toEqual([depositEvent()]);
  });

  test("every later write is refused without touching the file", async () => {
    const ledger = new Ledger(file());
    ledger.appendSync([depositEvent()]);
    const before = readFileSync(file());
    await tearNextAppend();
    expect(() => ledger.appendSync([voucherEvent()])).toThrow(/EIO/);
    const writes = vi.mocked(appendFileSync).mock.calls.length;

    const refused = (() => {
      try {
        ledger.appendSync([statusEvent()]);
      } catch (e) {
        return e as Error;
      }
      throw new Error("expected the append to be refused");
    })();
    expect(refused.message).toBe(
      "the ledger refuses writes after a failed write; restart the facilitator to replay it",
    );
    expect(refused.cause).toMatchObject({ code: "EIO" });
    expect(refused).not.toBeInstanceOf(LedgerRefusal);
    expect(vi.mocked(appendFileSync).mock.calls.length).toBe(writes);
    expect(readFileSync(file())).toEqual(before);
    expect(new Ledger(file()).replay()).toEqual([depositEvent()]);
  });

  test("a torn first write leaves an empty file that replays nothing", async () => {
    const ledger = new Ledger(file());
    await tearNextAppend();
    expect(() => ledger.appendSync([depositEvent()])).toThrow(/EIO/);
    expect(readFileSync(file(), "utf8")).toBe("");
    expect(new Ledger(file()).replay()).toEqual([]);
  });

  test("a refused batch does not stop the ledger", () => {
    const ledger = new Ledger(file());
    expect(() => ledger.appendSync([{ ...depositEvent(), valueZat: "-1" }])).toThrow(LedgerRefusal);
    ledger.appendSync([depositEvent()]);
    expect(new Ledger(file()).replay()).toEqual([depositEvent()]);
  });
});

describe("Ledger in memory", () => {
  test("a new in-memory ledger replays nothing", () => {
    expect(new Ledger().replay()).toEqual([]);
  });

  test("an in-memory ledger replays what was appended", () => {
    const ledger = new Ledger();
    ledger.appendSync([depositEvent()]);
    ledger.appendSync([voucherEvent()]);
    expect(ledger.replay()).toEqual([depositEvent(), voucherEvent()]);
  });

  test("an in-memory ledger keeps its own copies", () => {
    const ledger = new Ledger();
    const event = voucherEvent();
    ledger.appendSync([event]);
    event.cumulativeZat = "999999";
    ledger.replay()[0] = depositEvent();
    expect(ledger.replay()).toEqual([voucherEvent()]);
  });
});
