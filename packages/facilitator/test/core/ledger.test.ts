import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { NETWORK_MAINNET, NETWORK_REGTEST, NETWORK_TESTNET, type ZcashNetwork } from "@z402/protocol";
import { checkLedgerHeader, Ledger, LedgerRefusal, type LedgerEvent } from "../../src/core/ledger.js";
import { depositEvent, statusEvent, unreadableEvents, voucherEvent } from "./events.js";

// The ledger imports fs functions by name, so only a module mock can make a write fail part-way or a read refuse
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, appendFileSync: vi.fn(fs.appendFileSync), readFileSync: vi.fn(fs.readFileSync) };
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

describe.each([1, 7, 65536])("Ledger replay read %i bytes at a time", (chunkBytes) => {
  const open = () => new Ledger(file(), { chunkBytes });
  /** A session key of multi-byte characters, so that a chunk boundary can fall inside one */
  const wide = voucherEvent({ sessionKey: "ключ-🔑-鍵" });

  test("events round trip, multi-byte characters included", () => {
    const events = [depositEvent(), wide, statusEvent()];
    writeFileSync(file(), events.map(line).join(""));
    expect(open().replay()).toEqual(events);
  });

  test("blank lines are ignored", () => {
    writeFileSync(file(), `\n${line(depositEvent())}  \n\n${line(wide)}\n`);
    expect(open().replay()).toEqual([depositEvent(), wide]);
  });

  test("a truncated last line is cut off with one warning, and the next append lines up", () => {
    const warn = quietWarn();
    const kept = line(depositEvent()) + line(wide);
    writeFileSync(file(), `${kept}{"t":"status","txid":"00`);

    const ledger = open();
    expect(ledger.replay()).toEqual([depositEvent(), wide]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(readFileSync(file(), "utf8")).toBe(kept);
    ledger.appendSync([statusEvent()]);
    expect(open().replay()).toEqual([depositEvent(), wide, statusEvent()]);
  });

  test("a truncated last line that ends in a newline, followed by blank lines, is cut off too", () => {
    const warn = quietWarn();
    writeFileSync(file(), `${line(depositEvent())}{"t":"voucher","sessionK\n\n  \n`);
    expect(open().replay()).toEqual([depositEvent()]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(readFileSync(file(), "utf8")).toBe(line(depositEvent()));
  });

  test("a complete last line without its newline is kept, and gets one", () => {
    writeFileSync(file(), line(depositEvent()) + JSON.stringify(wide));
    expect(open().replay()).toEqual([depositEvent(), wide]);
    expect(readFileSync(file(), "utf8")).toBe(line(depositEvent()) + line(wide));
  });

  test("a malformed middle line throws naming its line, and the file is left as it was", () => {
    const text = `${line(depositEvent())}\nnot json\n${line(wide)}`;
    writeFileSync(file(), text);
    expect(() => open().replay()).toThrow("ledger line 3 is not valid JSON");
    expect(readFileSync(file(), "utf8")).toBe(text);
  });

  test("an event of an unknown type throws naming its line, even as the last line", () => {
    writeFileSync(file(), line(depositEvent()) + line({ t: "bogus" }));
    expect(() => open().replay()).toThrow("ledger line 2 is not a ledger event");
  });

  test("a line over 1 MiB counts as torn when it is the last one", () => {
    const warn = quietWarn();
    writeFileSync(file(), `${line(depositEvent())}${"x".repeat(1024 * 1024 + 10)}`);
    expect(open().replay()).toEqual([depositEvent()]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(readFileSync(file(), "utf8")).toBe(line(depositEvent()));
  });

  test("a line over 1 MiB in the middle is not valid JSON", () => {
    writeFileSync(file(), `${line(depositEvent())}${"x".repeat(1024 * 1024 + 10)}\n${line(wide)}`);
    expect(() => open().replay()).toThrow("ledger line 2 is not valid JSON");
  });
});

describe("Ledger replay of a large file", () => {
  test("200,000 lines replay one event at a time, without reading the whole file at once", async () => {
    const real = await vi.importActual<typeof import("node:fs")>("node:fs");
    const count = 200_000;
    real.writeFileSync(file(), line(voucherEvent()).repeat(count));
    vi.mocked(readFileSync).mockImplementation(() => {
      throw new Error("the ledger must not read its whole file at once");
    });
    try {
      let seen = 0;
      for (const event of new Ledger(file()).events()) {
        expect(event.t).toBe("voucher");
        seen++;
      }
      expect(seen).toBe(count);
    } finally {
      vi.mocked(readFileSync).mockImplementation(real.readFileSync);
    }
  });
});

describe("a ledger whose guard refuses", () => {
  test("writes nothing, and refuses every append after, as after a failed write", () => {
    let owned = false;
    const guard = vi.fn(() => {
      if (!owned) throw new Error("ledgerPath: the lock is someone else's");
    });
    const ledger = new Ledger(file(), { guard });

    expect(() => ledger.appendSync([voucherEvent()])).toThrow("ledgerPath: the lock is someone else's");
    expect(existsSync(file())).toBe(false);
    owned = true;
    expect(() => ledger.appendSync([voucherEvent()])).toThrow(/refuses writes after a failed write/);
    expect(existsSync(file())).toBe(false);
  });

  test("is asked before every write and lets a good one through", () => {
    const guard = vi.fn();
    const ledger = new Ledger(file(), { guard });
    ledger.appendSync([voucherEvent()]);
    ledger.appendSync([depositEvent()]);
    expect(guard).toHaveBeenCalledTimes(2);
    expect(new Ledger(file()).replay()).toEqual([voucherEvent(), depositEvent()]);
  });
});

describe("the ledger header", () => {
  const PAY_TO = `uregtest1${"q".repeat(60)}`;
  const header = (over: Record<string, unknown> = {}) =>
    ({ t: "ledger", network: NETWORK_REGTEST, payTo: PAY_TO, ...over }) as LedgerEvent;
  const own = { network: NETWORK_REGTEST, payTo: PAY_TO } as const;

  test("is a ledger event the file can carry and replay", () => {
    new Ledger(file()).appendSync([header(), voucherEvent()]);
    expect(new Ledger(file()).replay()).toEqual([header(), voucherEvent()]);
  });

  test.each<[string, Record<string, unknown>]>([
    ["a network that is not Zcash", { network: "eip155:1" }],
    ["no payTo", { payTo: "" }],
  ])("with %s is not a ledger event", (_, over) => {
    expect(() => new Ledger(file()).appendSync([header(over)])).toThrow(LedgerRefusal);
  });

  test("an empty ledger and this facilitator's own header pass", () => {
    expect(() => checkLedgerHeader(undefined, own, file())).not.toThrow();
    expect(() => checkLedgerHeader(header(), own, file())).not.toThrow();
  });

  test.each<[string, Record<string, unknown>, string]>([
    ["another payTo", { payTo: `uregtest1${"p".repeat(60)}` }, `${NETWORK_REGTEST} uregtest1${"p".repeat(60)}`],
    ["another network", { network: NETWORK_TESTNET }, `${NETWORK_TESTNET} ${PAY_TO}`],
  ])("a header with %s refuses the ledger", (_, over, whose) => {
    expect(() => checkLedgerHeader(header(over), own, file())).toThrow(
      `ledgerPath: ${file()} is the ledger of ${whose}, not of this facilitator`,
    );
  });

  const offMainnet: ZcashNetwork[] = [NETWORK_REGTEST, NETWORK_TESTNET];
  test.each(offMainnet)("a ledger with no header still opens on %s", (network) => {
    expect(() => checkLedgerHeader(depositEvent(), { network, payTo: PAY_TO }, file())).not.toThrow();
  });

  test("a ledger with no header is refused on mainnet", () => {
    expect(() =>
      checkLedgerHeader(voucherEvent(), { network: NETWORK_MAINNET, payTo: `u1${"q".repeat(60)}` }, file()),
    ).toThrow(`ledgerPath: ${file()} has no ledger header; a mainnet facilitator opens only a ledger it created`);
  });
});
