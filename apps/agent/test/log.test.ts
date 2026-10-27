import { encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";
import type { PaymentRequired, SettleResponse } from "@x402/core/types";
import type { ClientEvent } from "@z402/client";
import { NETWORK_REGTEST, REASON, SCHEME, type SessionSnapshot } from "@z402/protocol";
import { describe, expect, it } from "vitest";
import {
  formatCallFailure,
  formatCallLine,
  formatEvent,
  formatZat,
  outcomeOf,
  shortHex,
  stopAtDepositRefusal,
} from "../src/log.js";

const TXID = `3f2a${"0".repeat(58)}c1`;
const TXID_2 = `9b1e${"7".repeat(58)}07`;
const SESSION_KEY = `a1b2${"4".repeat(58)}ff`;
const PAY_TO = "uregtest1etwrjmjldyyet5pge876dfxerpgmsmarxg920s50y3dgc3wa36xmemqexfyw87jm3h0cttupk92qkrv8uafvjrl2j73d8nck7g35axkz";

/** Call 12 of the honest run, 12 x 500 zat spent and the first deposit still in the mempool */
const SNAP: SessionSnapshot = {
  sessionKey: SESSION_KEY,
  cumulativeZat: "6000",
  limitZat: "100000",
  headroomZat: "94000",
  confirmedZat: "0",
  pendingZat: "100000",
  creditZat: "0",
  tip: 1200,
  deposits: [{ txid: TXID, valueZat: "100000", status: "pending", confirmations: 0, expiryHeight: 1241, zeroConf: true }],
};

/** The cheat run at the end, the whole 125,000 limit spent and no second deposit */
const AT_LIMIT: SessionSnapshot = {
  ...SNAP,
  cumulativeZat: "125000",
  limitZat: "125000",
  headroomZat: "0",
  confirmedZat: "100000",
  pendingZat: "0",
  creditZat: "25000",
  deposits: [{ txid: TXID, valueZat: "100000", status: "confirmed", confirmations: 3, expiryHeight: 1241, zeroConf: true }],
};

describe("formatZat", () => {
  it.each([
    ["0", "0"],
    ["999", "999"],
    ["1000", "1,000"],
    ["6000", "6,000"],
    ["125000", "125,000"],
    ["1234567", "1,234,567"],
    ["2100000000000000", "2,100,000,000,000,000"],
  ])("%s -> %s", (zat, shown) => {
    expect(formatZat(zat)).toBe(shown);
  });

  it("formats bigint amounts too", () => {
    expect(formatZat(250000n)).toBe("250,000");
  });
});

describe("shortHex", () => {
  it("keeps the first 4 and last 2 characters", () => {
    expect(shortHex(TXID)).toBe("3f2a…c1");
  });

  it("leaves a string that is already short alone", () => {
    expect(shortHex("abcdef")).toBe("abcdef");
  });
});

describe("formatCallLine", () => {
  it("shows the running total against the limit on a paid call", () => {
    expect(formatCallLine(12, 200, SNAP)).toBe(
      "#012 200  c=6,000  limit=100,000  conf=0  pend=100,000  credit=0  D1 3f2a…c1 pending",
    );
  });

  it("pads the call number to three digits and lets it grow", () => {
    expect(formatCallLine(1, 200, SNAP)).toMatch(/^#001 200 /);
    expect(formatCallLine(150, 200, SNAP)).toMatch(/^#150 200 /);
    expect(formatCallLine(1234, 200, SNAP)).toMatch(/^#1234 200 /);
  });

  it("lists every deposit in the snapshot", () => {
    const snap: SessionSnapshot = {
      ...AT_LIMIT,
      deposits: [
        { txid: TXID, valueZat: "100000", status: "final", confirmations: 12, expiryHeight: 1241, zeroConf: true },
        { txid: TXID_2, valueZat: "100000", status: "pending", confirmations: 0, expiryHeight: 1300, zeroConf: true },
      ],
    };
    expect(formatCallLine(80, 200, snap)).toBe(
      "#080 200  c=125,000  limit=125,000  conf=100,000  pend=0  credit=25,000  D1 3f2a…c1 final, D2 9b1e…07 pending",
    );
  });

  it("ends cleanly when the snapshot has no deposits yet", () => {
    expect(formatCallLine(1, 200, { ...SNAP, deposits: [] })).toBe(
      "#001 200  c=6,000  limit=100,000  conf=0  pend=100,000  credit=0",
    );
  });

  it("names the refusal and the limit it hit", () => {
    const line = formatCallLine(126, 402, AT_LIMIT, "z402_deposit_required");
    expect(line).toContain("REFUSED z402_deposit_required at limit 125,000");
    expect(line).toBe(
      "#126 402  REFUSED z402_deposit_required at limit 125,000  c=125,000  conf=100,000  pend=0  credit=25,000  D1 3f2a…c1 confirmed",
    );
  });

  it("falls back to the limit of the snapshot it is given", () => {
    expect(formatCallLine(126, 402, SNAP, "z402_deposit_required")).toContain("at limit 100,000");
  });

  it("still reports a refusal with no snapshot", () => {
    expect(formatCallLine(3, 402, undefined, "z402_deposit_dead")).toBe("#003 402  REFUSED z402_deposit_dead");
  });

  it("still reports a status with no snapshot", () => {
    expect(formatCallLine(3, 200)).toBe("#003 200");
    expect(formatCallLine(3, 502)).toBe("#003 502");
  });
});

describe("formatCallFailure", () => {
  it("prints the message of a thrown error on the call's line", () => {
    expect(formatCallFailure(7, new Error("fetch failed"))).toBe("#007 ERROR  fetch failed");
  });

  it("adds the cause that fetch hides behind its own message", () => {
    const cause = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:4021"), { code: "ECONNREFUSED" });
    expect(formatCallFailure(7, new TypeError("fetch failed", { cause }))).toBe(
      "#007 ERROR  fetch failed: connect ECONNREFUSED 127.0.0.1:4021",
    );
  });

  it("falls back to the code of a cause with no message, as an AggregateError has", () => {
    const cause = Object.assign(new AggregateError([]), { code: "ECONNREFUSED" });
    expect(formatCallFailure(7, new TypeError("fetch failed", { cause }))).toBe("#007 ERROR  fetch failed: ECONNREFUSED");
  });

  it("accepts a non-Error throw", () => {
    expect(formatCallFailure(7, "boom")).toBe("#007 ERROR  boom");
  });
});

describe("formatEvent", () => {
  const line = (e: ClientEvent): string | undefined => formatEvent(e);

  it("deposit_broadcast carries the index, a shortened txid and the time taken", () => {
    const text = line({ type: "deposit_broadcast", index: 2, txid: TXID, ms: 812 });
    expect(text).toContain("D2");
    expect(text).toContain("3f2a…c1");
    expect(text).not.toContain(TXID);
    expect(text).toContain("812 ms");
  });

  it("deposit_started says whether the call waits for it", () => {
    expect(line({ type: "deposit_started", index: 1, inline: true })).toBe("  * deposit D1 started, paid inline");
    expect(line({ type: "deposit_started", index: 2, inline: false })).toBe("  * deposit D2 started, in the background");
  });

  it("deposit_failed carries the reason", () => {
    expect(line({ type: "deposit_failed", index: 2, error: new Error("insufficient funds") })).toBe(
      "  * deposit D2 failed: insufficient funds",
    );
  });

  it("deposit_acked, deposit_confirmed and deposit_dead each get their own line", () => {
    expect(line({ type: "deposit_acked", txid: TXID })).toBe("  * deposit 3f2a…c1 acknowledged by the merchant");
    expect(line({ type: "deposit_confirmed", txid: TXID, height: 1203 })).toBe(
      "  * deposit 3f2a…c1 confirmed at height 1,203",
    );
    expect(line({ type: "deposit_dead", txid: TXID })).toBe("  * deposit 3f2a…c1 DEAD, it will not count");
  });

  it("waiting names the deposit the call is held for", () => {
    expect(line({ type: "waiting", txid: TXID })).toBe("  * waiting for deposit 3f2a…c1 to confirm");
  });

  it("session opens with a shortened key", () => {
    const text = line({ type: "session", network: NETWORK_REGTEST, payTo: PAY_TO, sessionKey: SESSION_KEY });
    expect(text).toBe("  * session a1b2…ff on zcash:regtest");
  });

  it("ambiguous shows the voucher total that may or may not have landed", () => {
    expect(line({ type: "ambiguous", attemptedZat: "6500" })).toBe(
      "  * outcome unknown, voucher of 6,500 zat may or may not have been accepted",
    );
  });

  it("fatal is loud", () => {
    expect(line({ type: "fatal", code: "deposit_status_unknown", message: "deposit status unknown" })).toBe(
      "  * FATAL deposit_status_unknown: deposit status unknown",
    );
  });

  it("refused is only a line while the client is still recovering, the call line reports the rest", () => {
    expect(line({ type: "refused", code: "z402_cumulative_mismatch", recovering: true })).toBe(
      "  * refused z402_cumulative_mismatch, recovering",
    );
    expect(line({ type: "refused", code: "z402_deposit_required", snapshot: AT_LIMIT, recovering: false })).toBeUndefined();
  });

  it("paid and voucher print nothing, the per-call line already says it", () => {
    expect(line({ type: "paid", cumulativeZat: "6000", snapshot: SNAP })).toBeUndefined();
    expect(line({ type: "paid", cumulativeZat: "6000" })).toBeUndefined();
    expect(line({ type: "voucher", cumulativeZat: "6000" })).toBeUndefined();
  });
});

describe("outcomeOf", () => {
  const settle = (extra?: Record<string, unknown>): SettleResponse => ({
    success: true,
    transaction: "",
    network: NETWORK_REGTEST,
    payer: SESSION_KEY,
    ...(extra === undefined ? {} : { extra }),
  });

  const required = (error: string | undefined, extra: Record<string, unknown>): PaymentRequired => ({
    x402Version: 2,
    ...(error === undefined ? {} : { error }),
    resource: { url: "http://127.0.0.1:4021/chunk" },
    accepts: [
      { scheme: SCHEME, network: NETWORK_REGTEST, amount: "500", asset: "ZEC", payTo: PAY_TO, maxTimeoutSeconds: 60, extra },
    ],
  });

  it("reads the snapshot from a 200's PAYMENT-RESPONSE", () => {
    const res = new Response("{}", {
      status: 200,
      headers: { "PAYMENT-RESPONSE": encodePaymentResponseHeader(settle({ session: SNAP })) },
    });
    expect(outcomeOf(res)).toEqual({ snapshot: SNAP });
  });

  it("reads the error and snapshot from the corrective 402", () => {
    const res = new Response("{}", {
      status: 402,
      headers: { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(required("z402_deposit_required", { session: AT_LIMIT })) },
    });
    expect(outcomeOf(res)).toEqual({ snapshot: AT_LIMIT, error: "z402_deposit_required" });
  });

  describe("a 402 from a settle failure", () => {
    const failed = (extra: Record<string, unknown> | undefined, errorReason?: string): SettleResponse => ({
      success: false,
      transaction: "",
      network: NETWORK_REGTEST,
      payer: SESSION_KEY,
      ...(errorReason === undefined ? {} : { errorReason }),
      ...(extra === undefined ? {} : { extra }),
    });
    const settleFailure = (settle: SettleResponse, headers: Record<string, string> = {}): Response =>
      new Response("{}", {
        status: 402,
        headers: { "PAYMENT-RESPONSE": encodePaymentResponseHeader(settle), ...headers },
      });

    it("reads the code and snapshot from PAYMENT-RESPONSE when there is no PAYMENT-REQUIRED", () => {
      const res = settleFailure(failed({ session: AT_LIMIT }, "z402_deposit_required"));
      const outcome = outcomeOf(res);
      expect(outcome).toEqual({ snapshot: AT_LIMIT, error: "z402_deposit_required" });
      expect(formatCallLine(126, res.status, outcome.snapshot, outcome.error)).toBe(
        "#126 402  REFUSED z402_deposit_required at limit 125,000  c=125,000  conf=100,000  pend=0  credit=25,000  D1 3f2a…c1 confirmed",
      );
    });

    it("falls back to the client's unexpected_settle_error when errorReason is missing or empty", () => {
      expect(outcomeOf(settleFailure(failed({ session: AT_LIMIT })))).toEqual({
        snapshot: AT_LIMIT,
        error: "unexpected_settle_error",
      });
      expect(outcomeOf(settleFailure(failed(undefined, "")))).toEqual({ error: "unexpected_settle_error" });
    });

    it("keeps the error when the snapshot is missing or does not validate", () => {
      expect(outcomeOf(settleFailure(failed(undefined, "z402_deposit_dead")))).toEqual({ error: "z402_deposit_dead" });
      expect(outcomeOf(settleFailure(failed({ session: { ...SNAP, tip: -1 } }, "z402_deposit_dead")))).toEqual({
        error: "z402_deposit_dead",
      });
    });

    it("lets PAYMENT-RESPONSE win when both headers are there, as the client's classifyOutcome does", () => {
      const both = settleFailure(failed({ session: AT_LIMIT }, "z402_deposit_required"), {
        "PAYMENT-REQUIRED": encodePaymentRequiredHeader(required("z402_cumulative_mismatch", { session: SNAP })),
      });
      expect(outcomeOf(both)).toEqual({ snapshot: AT_LIMIT, error: "z402_deposit_required" });
    });

    it("uses PAYMENT-REQUIRED when PAYMENT-RESPONSE does not decode", () => {
      const res = new Response("{}", {
        status: 402,
        headers: {
          "PAYMENT-RESPONSE": "!!not base64 json!!",
          "PAYMENT-REQUIRED": encodePaymentRequiredHeader(required("z402_deposit_required", { session: AT_LIMIT })),
        },
      });
      expect(outcomeOf(res)).toEqual({ snapshot: AT_LIMIT, error: "z402_deposit_required" });
    });

    it("reports a garbled PAYMENT-RESPONSE with no PAYMENT-REQUIRED as unspecified", () => {
      const res = new Response("{}", { status: 402, headers: { "PAYMENT-RESPONSE": "!!not base64 json!!" } });
      expect(outcomeOf(res)).toEqual({ error: "unspecified" });
    });
  });

  it("drops a snapshot that does not validate", () => {
    const bad = { ...SNAP, limitZat: "-1" };
    const res = new Response("{}", {
      status: 200,
      headers: { "PAYMENT-RESPONSE": encodePaymentResponseHeader(settle({ session: bad })) },
    });
    expect(outcomeOf(res)).toEqual({});
  });

  it("reports a 402 with no error field as unspecified", () => {
    const res = new Response("{}", {
      status: 402,
      headers: { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(required(undefined, {})) },
    });
    expect(outcomeOf(res)).toEqual({ error: "unspecified" });
  });

  it("survives a missing or garbled header", () => {
    expect(outcomeOf(new Response("{}", { status: 200 }))).toEqual({});
    expect(outcomeOf(new Response("{}", { status: 200, headers: { "PAYMENT-RESPONSE": "!!not base64 json!!" } }))).toEqual({});
    expect(outcomeOf(new Response("{}", { status: 402 }))).toEqual({ error: "unspecified" });
    expect(outcomeOf(new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": "garbled" } }))).toEqual({
      error: "unspecified",
    });
  });

  it("ignores the headers of other statuses", () => {
    expect(outcomeOf(new Response("{}", { status: 500 }))).toEqual({});
  });
});

describe("stopAtDepositRefusal", () => {
  it("is only true for that one code", () => {
    expect(stopAtDepositRefusal({ error: REASON.depositRequired })).toBe(true);
    expect(stopAtDepositRefusal({ error: REASON.awaitingConfirmation })).toBe(false);
    expect(stopAtDepositRefusal({ snapshot: SNAP })).toBe(false);
  });
});
