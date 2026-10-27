import { setTimeout as sleep } from "node:timers/promises";
import type { ClientEvent } from "@z402/client";
import { REASON, type SessionSnapshot } from "@z402/protocol";
import { afterEach, expect, test } from "vitest";
import { CLOSE_TIMEOUT_MS, paidSnapshot, PAY_TO, startStack, type Stack } from "../src/harness.js";

const LONG = 30_000;
/** How long call 201 is left waiting before its deposit is mined */
const HELD_MS = 300;
/** Bound on reaching the hook's wait, far above the few milliseconds it takes */
const REACH_WAIT_MS = 5_000;

let stack: Stack | undefined;
let pending: Promise<unknown> | undefined;
afterEach(async () => {
  // A failed test can leave call 201 waiting in the hook, so its block is mined to end the wait before closing
  if (stack !== undefined && pending !== undefined) {
    stack.chain.mine();
    await stack.facilitator.pollNow();
    await pending.catch(() => undefined);
  }
  pending = undefined;
  await stack?.close();
  stack = undefined;
}, CLOSE_TIMEOUT_MS);

/** Resolves once `seen()` holds, checking every 10 ms, or rejects after `ms` */
async function until(seen: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!seen()) {
    if (Date.now() > deadline) throw new Error(`timed out after ${ms} ms waiting for ${what}`);
    await sleep(10);
  }
}

test(
  "awaiting confirmation then recovered",
  async () => {
    const events: ClientEvent[] = [];
    const s = (stack = await startStack({ priceZat: 500n, onEvent: (e) => events.push(e) }));
    let last: SessionSnapshot | undefined;

    for (let i = 1; i <= 200; i++) {
      const res = await s.paidFetch(`${s.api.url}/chunk`);
      expect(res.status).toBe(200);
      await res.json();
      last = paidSnapshot(res);
    }
    // D1's zero-conf window is spent and nothing is mined
    expect(last).toMatchObject({
      cumulativeZat: "100000",
      limitZat: "100000",
      pendingZat: "100000",
      confirmedZat: "0",
    });
    const d1 = s.scheme.session(PAY_TO)?.deposits[0]?.txid;
    expect(d1).toMatch(/^[0-9a-f]{64}$/);

    let resolved = false;
    const call201 = s.paidFetch(`${s.api.url}/chunk`);
    pending = call201;
    void call201.finally(() => {
      resolved = true;
    });
    const waiting = (): boolean => events.some((e) => e.type === "waiting" && e.txid === d1);
    await Promise.all([sleep(HELD_MS), until(waiting, REACH_WAIT_MS, "the hook to wait on D1")]);

    // The hook holds call 201 on z402_awaiting_confirmation and deposits nothing
    expect(resolved).toBe(false);
    expect(events.filter((e) => e.type === "refused")).toEqual([
      expect.objectContaining({ code: REASON.awaitingConfirmation, recovering: true }),
    ]);
    expect(s.wallet.sent).toHaveLength(1);

    s.chain.mine();
    await s.facilitator.pollNow();

    const res = await call201;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ chunk: 201, cumulativeZat: "100500", data: "chunk-201" });
    expect(paidSnapshot(res)).toMatchObject({
      cumulativeZat: "100500",
      confirmedZat: "100000",
      creditZat: "25000",
      limitZat: "125000",
    });
    // The wait deposited nothing, and D2 starts in the background only once call 201 is paid with nothing pending
    const paid201 = events.findIndex((e) => e.type === "paid" && e.cumulativeZat === "100500");
    const started = events.flatMap((e, at) =>
      e.type === "deposit_started" ? [{ at, index: e.index, inline: e.inline }] : [],
    );
    expect(started).toEqual([
      { at: expect.any(Number), index: 1, inline: true },
      { at: expect.any(Number), index: 2, inline: false },
    ]);
    expect(paid201).toBeGreaterThanOrEqual(0);
    expect(started[1]!.at).toBeGreaterThan(paid201);
    expect(events.filter((e) => e.type === "fatal" || e.type === "ambiguous")).toEqual([]);
  },
  LONG,
);
