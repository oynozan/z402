import { readFileSync } from "node:fs";
import type { SessionSnapshot } from "@z402/protocol";
import { afterEach, expect, test } from "vitest";
import { CLOSE_TIMEOUT_MS, paidSnapshot, PAY_TO, PAY_TO_2, startRail, type Rail } from "../src/harness.js";

const LONG = 30_000;
const UIVK_2 = `uivkregtest1${"q".repeat(80)}`;
// Until the per-route amount rule lands (design §4.2), the facilitator holds every provider to the operator's price
const PRICES = [500, 500] as const;

let rail: Rail | undefined;
afterEach(async () => {
  await rail?.close();
  rail = undefined;
}, CLOSE_TIMEOUT_MS);

type LedgerLine = { t: string; payTo?: string; txid?: string; sessionKey?: string; cumulativeZat?: string };

function ledger(path: string): LedgerLine[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as LedgerLine);
}

test(
  "one facilitator serves the operator and a provider that registered itself, and each one's ledger holds only its own session",
  async () => {
    const r = (rail = await startRail({
      operator: { payTo: PAY_TO, priceZat: BigInt(PRICES[0]) },
      providers: [{ payTo: PAY_TO_2, uivk: UIVK_2, priceZat: BigInt(PRICES[1]) }],
    }));
    expect(r.providers.map((p) => p.payTo)).toEqual([PAY_TO, PAY_TO_2]);
    expect(r.providers[1]!.providerId).toMatch(/^[0-9a-f]{16}$/);
    const snapshots: SessionSnapshot[][] = [[], []];

    for (let round = 1; round <= 20; round++) {
      for (const [p, provider] of r.providers.entries()) {
        const res = await r.paidFetch(`${provider.api.url}/chunk`);
        expect(res.status).toBe(200);
        snapshots[p]!.push(paidSnapshot(res));
        await res.body?.cancel();
      }
      if (round === 10) {
        r.chain.mine();
        await r.facilitator.pollNow();
      }
    }

    const sessions = r.providers.map((p) => r.scheme.session(p.payTo)!);
    expect(sessions.map((v) => v.cumulativeZat)).toEqual([BigInt(PRICES[0] * 20), BigInt(PRICES[1] * 20)]);
    expect(sessions[0]!.sessionKey).not.toBe(sessions[1]!.sessionKey);
    for (const [p, view] of sessions.entries()) {
      expect(snapshots[p]!.every((snap) => snap.sessionKey === view.sessionKey)).toBe(true);
      expect(snapshots[p]!.at(-1)).toMatchObject({ cumulativeZat: String(PRICES[p]! * 20), confirmedZat: "100000" });
    }
    expect(r.wallet.sent.map((d) => d.to)).toEqual([PAY_TO, PAY_TO_2]);

    // The live check's claim, read from the files: a header naming its own payTo, then only its own session
    for (const [p, provider] of r.providers.entries()) {
      const lines = ledger(provider.ledgerPath);
      const own = sessions[p]!;
      expect(lines[0]).toMatchObject({ t: "ledger", payTo: provider.payTo });
      const keyed = lines.filter((l) => l.sessionKey !== undefined);
      expect(keyed.length).toBeGreaterThan(0);
      expect(keyed.every((l) => l.sessionKey === own.sessionKey)).toBe(true);
      expect(lines.filter((l) => l.t === "deposit").map((l) => l.txid)).toEqual(own.deposits.map((d) => d.txid));
      expect(lines.filter((l) => l.t === "voucher").at(-1)?.cumulativeZat).toBe(String(PRICES[p]! * 20));
    }
  },
  LONG,
);
