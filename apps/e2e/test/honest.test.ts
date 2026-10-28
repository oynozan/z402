import type { ClientEvent } from "@z402-net/client";
import type { SessionSnapshot } from "@z402-net/protocol";
import { afterEach, expect, test } from "vitest";
import { CLOSE_TIMEOUT_MS, paidSnapshot, PAY_TO, startStack, type Stack } from "../src/harness.js";

const LONG = 30_000;

let stack: Stack | undefined;
afterEach(async () => {
  await stack?.close();
  stack = undefined;
}, CLOSE_TIMEOUT_MS);

test(
  "honest ramp",
  async () => {
    const events: ClientEvent[] = [];
    const s = (stack = await startStack({ priceZat: 500n, onEvent: (e) => events.push(e) }));
    const snapshots: SessionSnapshot[] = [];
    const sentAfter: number[] = [];

    for (let i = 1; i <= 150; i++) {
      const res = await s.paidFetch(`${s.api.url}/chunk`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ chunk: i, cumulativeZat: String(500 * i), data: `chunk-${i}` });
      snapshots.push(paidSnapshot(res));
      sentAfter.push(s.wallet.sent.length);
      if (i === 10) {
        s.chain.mine();
        await s.facilitator.pollNow();
      }
    }

    // D1 serves the first ten calls on zero-conf, then its block brings the credit line
    expect(snapshots[9]).toMatchObject({ confirmedZat: "0", pendingZat: "100000", limitZat: "100000" });
    expect(snapshots[10]).toMatchObject({ confirmedZat: "100000", creditZat: "25000", limitZat: "125000" });
    // Headroom first drops below windowZat after call 51 (125,000 - 25,500), which starts D2 in the background
    expect(snapshots[50]?.headroomZat).toBe("99500");
    expect(sentAfter.indexOf(2) + 1).toBe(51);

    expect(snapshots.at(-1)).toMatchObject({
      cumulativeZat: "75000",
      confirmedZat: "100000",
      creditZat: "25000",
      pendingZat: "100000",
      limitZat: "225000",
    });
    expect(s.wallet.sent).toHaveLength(2);
    expect(s.wallet.sent.map((d) => ({ to: d.to, amountZat: d.amountZat }))).toEqual([
      { to: PAY_TO, amountZat: 100000n },
      { to: PAY_TO, amountZat: 100000n },
    ]);
    expect(s.wallet.sent[0]?.memo).toMatch(/:1$/);
    expect(s.wallet.sent[1]?.memo).toMatch(/:2$/);
    expect(s.scheme.session(PAY_TO)?.deposits.map((d) => d.state)).toEqual(["acked", "acked"]);
    expect(events.filter((e) => e.type === "refused" || e.type === "fatal" || e.type === "ambiguous")).toEqual([]);
  },
  LONG,
);
