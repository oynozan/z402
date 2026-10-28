import type { ClientEvent } from "@z402-net/client";
import { REASON, type SessionSnapshot } from "@z402-net/protocol";
import { afterEach, expect, test } from "vitest";
import {
  CLOSE_TIMEOUT_MS,
  paidSnapshot,
  paymentRequired,
  refusalSnapshot,
  startStack,
  type Stack,
} from "../src/harness.js";

const LONG = 30_000;
/** Well past the expected refusal at call 251, so a stack that never refuses fails instead of looping */
const MAX_CALLS = 300;

let stack: Stack | undefined;
afterEach(async () => {
  await stack?.close();
  stack = undefined;
}, CLOSE_TIMEOUT_MS);

test(
  "cheat refused at the limit",
  async () => {
    const events: ClientEvent[] = [];
    const s = (stack = await startStack({ priceZat: 500n, maxDeposits: 1, onEvent: (e) => events.push(e) }));
    let lastPaid: SessionSnapshot | undefined;
    let refused: { call: number; res: Response } | undefined;

    for (let call = 1; call <= MAX_CALLS; call++) {
      const res = await s.paidFetch(`${s.api.url}/chunk`);
      if (res.status === 402) {
        refused = { call, res };
        break;
      }
      expect(res.status).toBe(200);
      await res.json();
      lastPaid = paidSnapshot(res);
      if (call === 1) {
        s.chain.mine();
        await s.facilitator.pollNow();
      }
    }

    if (refused === undefined) throw new Error(`no 402 within ${MAX_CALLS} calls`);
    const required = await paymentRequired(refused.res);
    expect(required.error).toBe(REASON.depositRequired);
    expect(lastPaid?.cumulativeZat).toBe("125000");
    expect(refused.call).toBe(251);
    // The corrective 402 shows the session at its limit, D1 confirmed plus the 25% credit
    expect(refusalSnapshot(required)).toMatchObject({
      cumulativeZat: "125000",
      limitZat: "125000",
      confirmedZat: "100000",
      creditZat: "25000",
      pendingZat: "0",
    });
    expect(s.wallet.sent).toHaveLength(1);
    expect(events.filter((e) => e.type === "refused")).toEqual([
      expect.objectContaining({ code: REASON.depositRequired, recovering: false }),
    ]);
    expect(events.filter((e) => e.type === "fatal")).toEqual([]);
  },
  LONG,
);
