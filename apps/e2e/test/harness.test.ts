import { setTimeout as sleep } from "node:timers/promises";
import { expect, test } from "vitest";
import { startStack } from "../src/harness.js";

/** A closed server leaves the list a few event-loop turns after close() resolves, far sooner than this */
const SETTLE_MS = 2_000;

function counts(): Map<string, number> {
  const seen = new Map<string, number>();
  for (const kind of process.getActiveResourcesInfo()) seen.set(kind, (seen.get(kind) ?? 0) + 1);
  return seen;
}

/** Each resource kind open now beyond its count in `before`, as `kind x extra` */
function extra(before: Map<string, number>): string[] {
  return [...counts()].flatMap(([kind, n]) => {
    const over = n - (before.get(kind) ?? 0);
    return over > 0 ? [`${kind} x${over}`] : [];
  });
}

test("a stack whose client cannot be built rejects and leaves no server or handle open", async () => {
  const before = counts();

  await expect(startStack({ priceZat: 500n, maxDeposits: -1 })).rejects.toThrow(RangeError);

  const deadline = Date.now() + SETTLE_MS;
  while (extra(before).length > 0 && Date.now() < deadline) await sleep(10);
  expect(extra(before)).toEqual([]);
});
