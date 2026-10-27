import { ChainUnavailableError, type ChainView, type FoundInspection, type TxInspection } from "@z402/protocol";
import { FakeChain } from "@z402/testkit";
import { afterEach, describe, expect, test, vi } from "vitest";
import { DepositResolver, type Lookup } from "../../src/core/resolver.js";
import { ScriptedChain } from "../support/scriptedChain.js";
import { SESSION_KEY, txidOf } from "./records.js";

const T = txidOf(1);
const NOT_FOUND: TxInspection = { found: false };
const PAY_TO = "uregtest1merchant";

const outage = () => new ChainUnavailableError("lightwalletd is unreachable");

function found(txid: string, over: Partial<FoundInspection> = {}): FoundInspection {
  return {
    found: true,
    txid,
    location: "mempool",
    minedHeight: null,
    expiryHeight: 1041,
    hasTransparent: false,
    outputs: [{ pool: "ironwood", valueZat: 100000n, memo: `${SESSION_KEY}:1` }],
    ...over,
  };
}

/** A clock that moves only when a test advances it or the resolver sleeps, and stops a runaway loop */
function fakeClock() {
  let ms = 0;
  let sleeps = 0;
  return {
    now: () => ms,
    sleep: async (by: number) => {
      if (++sleeps > 1000) throw new Error("runaway polling loop");
      ms += by;
    },
    advance: (by: number) => {
      ms += by;
    },
  };
}

function rig(over: Partial<ConstructorParameters<typeof DepositResolver>[0]> = {}) {
  const chain = new ScriptedChain();
  const clock = fakeClock();
  const resolver = new DepositResolver({ chain, now: clock.now, sleep: clock.sleep, ...over });
  return { chain, clock, resolver };
}

function errorOf(lookup: Lookup): unknown {
  if (lookup.kind !== "unavailable") throw new Error(`expected unavailable, got ${lookup.kind}`);
  return lookup.error;
}

const nextTick = () => new Promise<void>((resolve) => setImmediate(resolve));

afterEach(() => {
  vi.useRealTimers();
});

describe("DepositResolver.lookup", () => {
  test("found on the third inspect makes 3 calls and carries the tip", async () => {
    const { chain, resolver } = rig();
    const inspection = found(T);
    chain.tipHeight = 1234;
    chain.script(T, [NOT_FOUND, NOT_FOUND, inspection]);

    expect(await resolver.lookup(T, 15000)).toEqual({ kind: "found", inspection, tip: 1234 });
    expect(chain.calls.get(T)).toBe(3);
  });

  test("reads the tip once, after the inspection that found the deposit", async () => {
    const calls: string[] = [];
    const answers = [NOT_FOUND, NOT_FOUND, found(T)];
    const chain: ChainView = {
      inspect: async () => {
        calls.push("inspect");
        return answers.shift() ?? NOT_FOUND;
      },
      tip: async () => {
        calls.push("tip");
        return 1234;
      },
    };
    const clock = fakeClock();

    await new DepositResolver({ chain, now: clock.now, sleep: clock.sleep }).lookup(T, 15000);

    expect(calls).toEqual(["inspect", "inspect", "inspect", "tip"]);
  });

  test.each([
    [15000, 16],
    [2500, 3],
    [1000, 2],
    [999, 1],
  ])("a budget of %i ms ends not_found after %i inspect call(s)", async (budget, inspects) => {
    const { chain, resolver } = rig();

    expect(await resolver.lookup(T, budget)).toEqual({ kind: "not_found" });
    expect(chain.calls.get(T)).toBe(inspects);
  });

  test.each([0, -5, NaN])("a budget of %d makes exactly one inspect call", async (budget) => {
    const { chain, resolver } = rig();

    expect(await resolver.lookup(T, budget)).toEqual({ kind: "not_found" });
    expect(chain.calls.get(T)).toBe(1);
  });

  test("errors mixed with not-found end unavailable with the error", async () => {
    const { chain, resolver } = rig();
    const error = outage();
    chain.script(T, [NOT_FOUND, error, NOT_FOUND]);

    expect(errorOf(await resolver.lookup(T, 3000))).toBe(error);
    expect(chain.calls.get(T)).toBe(4);
  });

  test("an outage is polled for the whole budget before it is reported", async () => {
    const { chain, resolver } = rig();
    const error = outage();
    chain.script(T, [error]);

    expect(errorOf(await resolver.lookup(T, 15000))).toBe(error);
    expect(chain.calls.get(T)).toBe(16);
  });

  test("a found answer after errors still wins", async () => {
    const { chain, resolver } = rig();
    const inspection = found(T);
    chain.script(T, [outage(), outage(), inspection]);

    expect(await resolver.lookup(T, 15000)).toMatchObject({ kind: "found", inspection });
    expect(chain.calls.get(T)).toBe(3);
  });

  test("a found deposit whose tip cannot be read is unavailable, never found without a tip", async () => {
    const { chain, resolver } = rig();
    const error = outage();
    chain.script(T, [found(T)]);
    vi.spyOn(chain, "tip").mockRejectedValue(error);

    expect(errorOf(await resolver.lookup(T, 2000))).toBe(error);
    expect(chain.calls.get(T)).toBe(3);
  });

  test("an error that is not a ChainUnavailableError rejects the lookup without retrying", async () => {
    const { chain, resolver } = rig();
    chain.script(T, [new TypeError("txid must be 64 lowercase hex characters")]);

    await expect(resolver.lookup(T, 15000)).rejects.toThrow(TypeError);
    expect(chain.calls.get(T)).toBe(1);
  });
});

describe("single-flight", () => {
  test("two concurrent lookups of one txid share one call sequence and one result", async () => {
    const { chain, resolver } = rig();
    chain.script(T, [NOT_FOUND, NOT_FOUND, found(T)]);

    const [first, second] = await Promise.all([resolver.lookup(T, 15000), resolver.lookup(T, 15000)]);

    expect(first.kind).toBe("found");
    expect(second).toEqual(first);
    expect(chain.calls.get(T)).toBe(3);
  });

  test("a lookup after the flight settled starts a new one", async () => {
    const { chain, resolver } = rig();
    chain.script(T, [found(T)]);

    await resolver.lookup(T, 0);
    await resolver.lookup(T, 0);

    expect(chain.calls.get(T)).toBe(2);
  });

  test("a failed lookup frees its slot and its flight", async () => {
    const { chain, resolver } = rig({ maxConcurrent: 1 });
    chain.script(T, [new TypeError("boom")]);

    const failing = resolver.lookup(T, 0);
    const queued = resolver.lookup(txidOf(2), 0);
    await expect(failing).rejects.toThrow("boom");
    expect(await queued).toEqual({ kind: "not_found" });

    chain.script(T, [found(T)]);
    expect(await resolver.lookup(T, 0)).toMatchObject({ kind: "found" });
  });
});

describe("concurrency limit", () => {
  test.each([
    { limit: 4, peak: 4 },
    { limit: undefined, peak: 4 },
    { limit: 2, peak: 2 },
    { limit: 6, peak: 6 },
  ])("six txids with maxConcurrent $limit have at most $peak inspects in flight", async ({ limit, peak }) => {
    vi.useFakeTimers();
    const chain = new ScriptedChain();
    chain.delayMs = 100;
    const resolver = new DepositResolver({ chain, maxConcurrent: limit });

    const lookups = [1, 2, 3, 4, 5, 6].map((n) => resolver.lookup(txidOf(n), 0));
    await vi.advanceTimersByTimeAsync(300);

    expect(await Promise.all(lookups)).toEqual(lookups.map(() => ({ kind: "not_found" })));
    expect(chain.maxInFlight).toBe(peak);
  });

  test("lookups that arrive after slots were handed on still wait for a free one", async () => {
    vi.useFakeTimers();
    const chain = new ScriptedChain();
    chain.delayMs = 100;
    const resolver = new DepositResolver({ chain, maxConcurrent: 2 });

    const early = [1, 2, 3, 4].map((n) => resolver.lookup(txidOf(n), 0));
    await vi.advanceTimersByTimeAsync(150);
    const late = [5, 6].map((n) => resolver.lookup(txidOf(n), 0));
    await vi.advanceTimersByTimeAsync(300);
    await Promise.all([...early, ...late]);

    expect(chain.maxInFlight).toBe(2);
  });

  test("queued lookups start in the order they arrived", async () => {
    vi.useFakeTimers();
    const chain = new ScriptedChain();
    chain.delayMs = 100;
    const resolver = new DepositResolver({ chain, maxConcurrent: 2 });

    const lookups = [1, 2, 3, 4, 5].map((n) => resolver.lookup(txidOf(n), 0));
    await vi.advanceTimersByTimeAsync(300);
    await Promise.all(lookups);

    expect([...chain.calls.keys()]).toEqual([1, 2, 3, 4, 5].map(txidOf));
  });

  test("a lookup holds its slot for its whole polling loop", async () => {
    const { chain, resolver } = rig({ maxConcurrent: 1 });
    chain.script(txidOf(1), [NOT_FOUND, NOT_FOUND, found(txidOf(1))]);
    chain.script(txidOf(2), [found(txidOf(2))]);
    const inspect = vi.spyOn(chain, "inspect");

    await Promise.all([resolver.lookup(txidOf(1), 5000), resolver.lookup(txidOf(2), 5000)]);

    expect(inspect.mock.calls.map(([txid]) => txid)).toEqual([txidOf(1), txidOf(1), txidOf(1), txidOf(2)]);
  });

  test("the wait for a slot counts against the budget", async () => {
    const { chain, resolver } = rig({ maxConcurrent: 1 });

    await Promise.all([resolver.lookup(txidOf(1), 5000), resolver.lookup(txidOf(2), 5000)]);

    expect(chain.calls.get(txidOf(1))).toBe(6);
    expect(chain.calls.get(txidOf(2))).toBe(1);
  });
});

describe("negative cache", () => {
  test.each([
    [9_999, 1],
    [10_000, 16],
  ])("a lookup %i ms after a not-found makes %i inspect call(s)", async (gap, inspects) => {
    const { chain, clock, resolver } = rig();
    await resolver.lookup(T, 15000);
    const before = chain.calls.get(T) ?? 0;

    clock.advance(gap);

    expect(await resolver.lookup(T, 15000)).toEqual({ kind: "not_found" });
    expect((chain.calls.get(T) ?? 0) - before).toBe(inspects);
  });

  test("the single probe still finds a deposit that has appeared since", async () => {
    const { chain, resolver } = rig();
    chain.script(T, [...Array<TxInspection>(16).fill(NOT_FOUND), found(T)]);
    await resolver.lookup(T, 15000);

    expect(await resolver.lookup(T, 15000)).toMatchObject({ kind: "found" });
    expect(chain.calls.get(T)).toBe(17);
  });

  test("another txid still gets its full budget", async () => {
    const { chain, resolver } = rig();
    await resolver.lookup(T, 15000);

    await resolver.lookup(txidOf(2), 15000);

    expect(chain.calls.get(txidOf(2))).toBe(16);
  });

  test("only a not-found shortens the next lookup, an outage is polled out again", async () => {
    const { chain, resolver } = rig();
    chain.script(T, [outage(), outage(), found(T)]);
    expect((await resolver.lookup(T, 0)).kind).toBe("unavailable");

    expect(await resolver.lookup(T, 3000)).toMatchObject({ kind: "found" });
    expect(chain.calls.get(T)).toBe(3);
  });
});

describe("startBackground and peek", () => {
  test("peek has nothing until the background lookup resolves, then the found result", async () => {
    vi.useFakeTimers();
    const chain = new ScriptedChain();
    const inspection = found(T);
    chain.delayMs = 10;
    chain.tipHeight = 1500;
    chain.script(T, [inspection]);
    const resolver = new DepositResolver({ chain });

    resolver.startBackground(T, 1000);
    expect(resolver.peek(T)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(10);
    expect(resolver.peek(T)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(10);

    expect(resolver.peek(T)).toEqual({ kind: "found", inspection, tip: 1500 });
  });

  test("a lookup that joins the background flight makes no calls of its own", async () => {
    const { chain, resolver } = rig();
    chain.script(T, [NOT_FOUND, found(T)]);

    resolver.startBackground(T, 15000);
    const joined = await resolver.lookup(T, 15000);

    expect(joined.kind).toBe("found");
    expect(chain.calls.get(T)).toBe(2);
  });

  test("peek reports a not_found result", async () => {
    const { resolver } = rig();

    await resolver.lookup(T, 0);

    expect(resolver.peek(T)).toEqual({ kind: "not_found" });
  });

  test("peek reports an unavailable result with its error", async () => {
    const { chain, resolver } = rig();
    const error = outage();
    chain.script(T, [error]);

    await resolver.lookup(T, 0);

    expect(errorOf(resolver.peek(T) ?? { kind: "not_found" })).toBe(error);
  });

  test("forget drops that txid's result and keeps the others", async () => {
    const { chain, resolver } = rig();
    chain.script(txidOf(1), [found(txidOf(1))]);
    chain.script(txidOf(2), [found(txidOf(2))]);
    await resolver.lookup(txidOf(1), 0);
    await resolver.lookup(txidOf(2), 0);
    expect(resolver.peek(txidOf(1))).toMatchObject({ kind: "found" });

    resolver.forget(txidOf(1));

    expect(resolver.peek(txidOf(1))).toBeUndefined();
    expect(resolver.peek(txidOf(2))).toMatchObject({ kind: "found" });
  });

  test("a result is kept for 10 minutes and then dropped", async () => {
    const { chain, clock, resolver } = rig();
    chain.script(T, [found(T)]);
    await resolver.lookup(T, 0);

    clock.advance(599_999);
    expect(resolver.peek(T)).toMatchObject({ kind: "found" });
    clock.advance(1);

    expect(resolver.peek(T)).toBeUndefined();
  });

  test("a later lookup replaces the result", async () => {
    const { chain, resolver } = rig();
    chain.tipHeight = 1000;
    chain.script(T, [found(T)]);
    await resolver.lookup(T, 0);

    chain.tipHeight = 1001;
    chain.script(T, [found(T, { location: "mined", minedHeight: 1001 })]);

    expect(await resolver.lookup(T, 0)).toMatchObject({ kind: "found", tip: 1001, inspection: { location: "mined" } });
    expect(resolver.peek(T)).toMatchObject({ kind: "found", tip: 1001, inspection: { location: "mined" } });
  });

  test("a background lookup that fails unexpectedly leaves nothing to peek and rejects nobody", async () => {
    const { chain, resolver } = rig();
    chain.script(T, [new TypeError("boom")]);

    resolver.startBackground(T, 0);
    await nextTick();

    expect(chain.calls.get(T)).toBe(1);
    expect(resolver.peek(T)).toBeUndefined();
  });
});

describe("inFlight", () => {
  test("is false before a lookup, true while it waits on the chain, and false once it settles", async () => {
    vi.useFakeTimers();
    const chain = new ScriptedChain();
    chain.delayMs = 100;
    const resolver = new DepositResolver({ chain });
    expect(resolver.inFlight(T)).toBe(false);

    const lookup = resolver.lookup(T, 0);
    expect(resolver.inFlight(T)).toBe(true);
    await vi.advanceTimersByTimeAsync(50);
    expect(resolver.inFlight(T)).toBe(true);
    expect(resolver.inFlight(txidOf(2))).toBe(false);

    await vi.advanceTimersByTimeAsync(50);
    await lookup;
    expect(resolver.inFlight(T)).toBe(false);
  });

  test("is true for a background lookup until it resolves, when peek takes over", async () => {
    vi.useFakeTimers();
    const chain = new ScriptedChain();
    chain.delayMs = 100;
    chain.script(T, [found(T)]);
    const resolver = new DepositResolver({ chain });

    resolver.startBackground(T, 1000);
    await vi.advanceTimersByTimeAsync(150);
    expect(resolver.inFlight(T)).toBe(true);
    expect(resolver.peek(T)).toBeUndefined();

    await vi.advanceTimersByTimeAsync(50);
    expect(resolver.inFlight(T)).toBe(false);
    expect(resolver.peek(T)).toMatchObject({ kind: "found" });
  });

  test("is true for a lookup that is still queued for a slot", async () => {
    vi.useFakeTimers();
    const chain = new ScriptedChain();
    chain.delayMs = 100;
    const resolver = new DepositResolver({ chain, maxConcurrent: 1 });

    const running = resolver.lookup(txidOf(1), 0);
    const queued = resolver.lookup(txidOf(2), 0);
    expect(chain.calls.has(txidOf(2))).toBe(false);
    expect(resolver.inFlight(txidOf(2))).toBe(true);

    await vi.advanceTimersByTimeAsync(100);
    expect(resolver.inFlight(txidOf(1))).toBe(false);
    expect(resolver.inFlight(txidOf(2))).toBe(true);

    await vi.advanceTimersByTimeAsync(100);
    await Promise.all([running, queued]);
    expect(resolver.inFlight(txidOf(2))).toBe(false);
  });

  test("is true for a new lookup of a txid whose earlier result is still held", async () => {
    vi.useFakeTimers();
    const chain = new ScriptedChain();
    chain.script(T, [found(T)]);
    const resolver = new DepositResolver({ chain });
    await resolver.lookup(T, 0);
    expect(resolver.inFlight(T)).toBe(false);

    chain.delayMs = 100;
    const again = resolver.lookup(T, 0);

    expect(resolver.inFlight(T)).toBe(true);
    expect(resolver.peek(T)).toMatchObject({ kind: "found" });
    await vi.advanceTimersByTimeAsync(200);
    await again;
    expect(resolver.inFlight(T)).toBe(false);
  });

  test("is false again after a lookup that failed", async () => {
    const { chain, resolver } = rig();
    chain.script(T, [new TypeError("boom")]);

    await expect(resolver.lookup(T, 0)).rejects.toThrow("boom");

    expect(resolver.inFlight(T)).toBe(false);
  });
});

describe("a slow chain", () => {
  test("lookup(t, 30000) with 4 s per call settles within 30000 + 5000 ms", async () => {
    vi.useFakeTimers();
    const chain = new ScriptedChain();
    chain.delayMs = 4000;
    const resolver = new DepositResolver({ chain });
    let settled: Lookup | undefined;
    void resolver.lookup(T, 30000).then((lookup) => {
      settled = lookup;
    });

    await vi.advanceTimersByTimeAsync(35000);

    expect(settled).toEqual({ kind: "not_found" });
    expect(chain.calls.get(T)).toBe(7);
  });
});

describe("against a FakeChain", () => {
  test("a broadcast deposit is found with the chain's inspection and tip, and mining moves both", async () => {
    const fake = new FakeChain({ expiryDelta: 40 });
    const memo = `${SESSION_KEY}:1`;
    const txid = fake.broadcast({ outputs: [{ to: PAY_TO, valueZat: 100000n, memo }] });
    const resolver = new DepositResolver({ chain: fake.viewFor(PAY_TO) });

    expect(await resolver.lookup(txid, 0)).toEqual({
      kind: "found",
      inspection: {
        found: true,
        txid,
        location: "mempool",
        minedHeight: null,
        expiryHeight: 1041,
        hasTransparent: false,
        outputs: [{ pool: "ironwood", valueZat: 100000n, memo }],
      },
      tip: 1000,
    });

    fake.mine();

    expect(await resolver.lookup(txid, 0)).toMatchObject({
      kind: "found",
      inspection: { location: "mined", minedHeight: 1001 },
      tip: 1001,
    });
  });

  test("an unknown txid is not_found and an unavailable chain is unavailable", async () => {
    const fake = new FakeChain();
    const resolver = new DepositResolver({ chain: fake.viewFor(PAY_TO) });

    expect(await resolver.lookup(T, 0)).toEqual({ kind: "not_found" });

    fake.setUnavailable(true);
    expect(await resolver.lookup(txidOf(2), 0)).toEqual({
      kind: "unavailable",
      error: expect.any(ChainUnavailableError),
    });
  });
});
