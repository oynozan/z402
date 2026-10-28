import type { ClientEvent } from "@z402-net/client";
import { describe, expect, it } from "vitest";
import { formatEvent, shortAddress, shortHex } from "../src/log.js";

const TXID = `3f2a${"0".repeat(58)}c1`;
const KEY = `a1b2${"4".repeat(58)}ff`;

describe("formatEvent", () => {
  it.each<[ClientEvent, string | undefined]>([
    [{ type: "session", network: "zcash:regtest", payTo: "uregtest1x", sessionKey: KEY }, "  * session a1b2…ff on zcash:regtest"],
    [{ type: "deposit_started", index: 1, inline: true }, "  * deposit D1 started, paid inline"],
    [{ type: "deposit_started", index: 2, inline: false }, "  * deposit D2 started, in the background"],
    [{ type: "deposit_broadcast", index: 1, txid: TXID, ms: 4213 }, "  * deposit D1 broadcast 3f2a…c1 in 4213 ms"],
    [{ type: "deposit_failed", index: 1, error: new Error("insufficient funds") }, "  * deposit D1 failed: insufficient funds"],
    [{ type: "deposit_acked", txid: TXID }, "  * deposit 3f2a…c1 acknowledged by the merchant"],
    [{ type: "deposit_confirmed", txid: TXID, index: 1, height: 123 }, "  * deposit D1 3f2a…c1 confirmed at height 123"],
    [{ type: "deposit_confirmed", txid: TXID }, "  * deposit 3f2a…c1 confirmed"],
    [{ type: "deposit_dead", txid: TXID }, "  * deposit 3f2a…c1 DEAD, it will not count"],
    [{ type: "waiting", txid: TXID }, "  * waiting for deposit 3f2a…c1 to confirm"],
    [{ type: "ambiguous", attemptedZat: "1500" }, "  * outcome unknown, voucher of 1500 zat may or may not have been accepted"],
    [{ type: "fatal", code: "client_error", message: "boom" }, "  * FATAL client_error: boom"],
    [{ type: "refused", code: "z402_deposit_required", recovering: true }, "  * refused z402_deposit_required, recovering"],
    [{ type: "refused", code: "z402_deposit_required", recovering: false }, undefined],
    [{ type: "voucher", cumulativeZat: "500" }, undefined],
    [{ type: "paid", cumulativeZat: "500" }, undefined],
  ])("%j", (event, line) => {
    expect(formatEvent(event)).toBe(line);
  });

  it("keeps a message from the wallet to one line", () => {
    const line = formatEvent({ type: "deposit_failed", index: 1, error: new Error("a\nb\u001b[2J") });
    expect(line).toBe("  * deposit D1 failed: a b [2J");
  });
});

describe("shortHex and shortAddress", () => {
  it("keeps the first four and last two characters of an id, and short ones whole", () => {
    expect(shortHex(TXID)).toBe("3f2a…c1");
    expect(shortHex("abcd")).toBe("abcd");
  });

  it("keeps the start and the end of an address", () => {
    const payTo = `uregtest1${"q".repeat(60)}xyz789`;
    expect(shortAddress(payTo)).toBe("uregtest1qqq…xyz789");
    expect(shortAddress("uregtest1abc")).toBe("uregtest1abc");
  });
});
