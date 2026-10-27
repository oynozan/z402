import type { ClientEvent } from "@z402/client";
import { REASON } from "@z402/protocol";
import { afterEach, expect, test } from "vitest";
import { CLOSE_TIMEOUT_MS, paidSnapshot, paymentResponse, PAY_TO, startStack, type Stack } from "../src/harness.js";

const LONG = 30_000;
/** D1 broadcast at tip h expires at h + 1 + 40, and the chain evicts it on reaching that height */
const PAST_EXPIRY = 41;

let stack: Stack | undefined;
afterEach(async () => {
  await stack?.close();
  stack = undefined;
}, CLOSE_TIMEOUT_MS);

test(
  "dead deposit is replaced",
  async () => {
    const events: ClientEvent[] = [];
    const s = (stack = await startStack({ priceZat: 500n, onEvent: (e) => events.push(e) }));
    const url = `${s.api.url}/chunk`;

    const first = await s.paidFetch(url);
    expect(first.status).toBe(200);
    await first.json();
    const d1 = paymentResponse(first).transaction;
    expect(d1).toMatch(/^[0-9a-f]{64}$/);
    expect(paidSnapshot(first).deposits).toEqual([expect.objectContaining({ txid: d1, status: "pending" })]);

    s.chain.hold(d1);
    s.chain.mine(PAST_EXPIRY);
    await s.facilitator.pollNow();

    const second = await s.paidFetch(url);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ chunk: 2, cumulativeZat: "1000", data: "chunk-2" });
    expect(s.wallet.sent).toHaveLength(2);
    expect(s.wallet.sent[1]?.memo).toMatch(/:2$/);
    const d2 = paymentResponse(second).transaction;
    expect(d2).toMatch(/^[0-9a-f]{64}$/);
    expect(d2).not.toBe(d1);
    expect(paidSnapshot(second)).toMatchObject({
      cumulativeZat: "1000",
      pendingZat: "100000",
      limitZat: "100000",
      deposits: [
        expect.objectContaining({ txid: d1, status: "dead" }),
        expect.objectContaining({ txid: d2, status: "pending", zeroConf: true }),
      ],
    });
    expect(events).toContainEqual({ type: "deposit_dead", txid: d1 });
    expect(events).toContainEqual(expect.objectContaining({ type: "deposit_started", index: 2, inline: true }));
    expect(events.filter((e) => e.type === "refused")).toEqual([
      expect.objectContaining({ code: REASON.depositRequired, recovering: true }),
    ]);

    // The session goes on paying on D2
    for (let i = 3; i <= 10; i++) {
      const res = await s.paidFetch(url);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ chunk: i, cumulativeZat: String(500 * i), data: `chunk-${i}` });
    }
    expect(s.wallet.sent).toHaveLength(2);
    expect(s.scheme.session(PAY_TO)?.deposits.map((d) => d.state)).toEqual(["dead", "acked"]);
    expect(events.filter((e) => e.type === "fatal" || e.type === "ambiguous")).toEqual([]);
  },
  LONG,
);
