import type { SessionSnapshot } from "@z402/protocol";
import { afterEach, expect, test } from "vitest";
import { CLOSE_TIMEOUT_MS, paidSnapshot, PAY_TO, PAY_TO_2, startMerchants, type MultiStack } from "../src/harness.js";

const LONG = 30_000;
const PRICES = [500, 800] as const;

let stack: MultiStack | undefined;
afterEach(async () => {
  await stack?.close();
  stack = undefined;
}, CLOSE_TIMEOUT_MS);

async function start(): Promise<MultiStack> {
  return (stack = await startMerchants({
    merchants: [
      { payTo: PAY_TO, priceZat: BigInt(PRICES[0]) },
      { payTo: PAY_TO_2, priceZat: BigInt(PRICES[1]) },
    ],
  }));
}

/** The txids each merchant's snapshots ever listed */
function txidsSeen(snapshots: readonly SessionSnapshot[]): string[] {
  return [...new Set(snapshots.flatMap((s) => s.deposits.map((d) => d.txid)))];
}

test(
  "one client pays two merchants in turn at their own prices, and each merchant credits only its own session's deposits",
  async () => {
    const s = await start();
    const snapshots: SessionSnapshot[][] = [[], []];

    for (let round = 1; round <= 40; round++) {
      for (const [m, merchant] of s.merchants.entries()) {
        const res = await s.paidFetch(`${merchant.api.url}/chunk`);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ chunk: round, cumulativeZat: String(PRICES[m]! * round), data: `chunk-${round}` });
        snapshots[m]!.push(paidSnapshot(res));
      }
      if (round === 10) {
        s.chain.mine();
        for (const merchant of s.merchants) await merchant.facilitator.pollNow();
      }
    }

    const sessions = s.scheme.sessions();
    expect(sessions.map((v) => [v.payTo, v.cumulativeZat])).toEqual([
      [PAY_TO, 20_000n],
      [PAY_TO_2, 32_000n],
    ]);
    const [keyA, keyB] = sessions.map((v) => v.sessionKey);
    expect(keyA).not.toBe(keyB);
    expect(snapshots[0]!.every((snap) => snap.sessionKey === keyA)).toBe(true);
    expect(snapshots[1]!.every((snap) => snap.sessionKey === keyB)).toBe(true);

    // At 800 zat the second merchant's headroom first drops below windowZat on call 33 (125,000 - 32 x 800),
    // which starts its D2; the first merchant at 500 zat would need call 52
    expect(s.wallet.sent.map((d) => [d.to, d.memo])).toEqual([
      [PAY_TO, `${keyA}:1`],
      [PAY_TO_2, `${keyB}:1`],
      [PAY_TO_2, `${keyB}:2`],
    ]);
    const paidBy = sessions.map((v) => v.deposits.map((d) => d.txid));
    expect(paidBy.map((txids) => txids.length)).toEqual([1, 2]);
    expect(txidsSeen(snapshots[0]!)).toEqual(paidBy[0]);
    expect(txidsSeen(snapshots[1]!)).toEqual(paidBy[1]);
    expect(snapshots[0]!.at(-1)).toMatchObject({ cumulativeZat: "20000", confirmedZat: "100000", limitZat: "125000" });
    expect(snapshots[1]!.at(-1)).toMatchObject({ cumulativeZat: "32000", confirmedZat: "100000", pendingZat: "100000", limitZat: "225000" });
  },
  LONG,
);

test(
  "calls to both merchants at once each go through, with an inline deposit to each",
  async () => {
    const s = await start();

    for (let round = 1; round <= 5; round++) {
      const answers = await Promise.all(s.merchants.map((merchant) => s.paidFetch(`${merchant.api.url}/chunk`)));
      for (const [m, res] of answers.entries()) {
        expect(res.status).toBe(200);
        expect(paidSnapshot(res).cumulativeZat).toBe(String(PRICES[m]! * round));
        await res.body?.cancel();
      }
    }

    expect(s.wallet.sent.map((d) => d.to).sort()).toEqual([PAY_TO, PAY_TO_2].sort());
    // Which session starts first depends on which 402 comes back first, so each is looked up by its payee
    expect(s.scheme.session(PAY_TO)?.cumulativeZat).toBe(2_500n);
    expect(s.scheme.session(PAY_TO_2)?.cumulativeZat).toBe(4_000n);
  },
  LONG,
);
