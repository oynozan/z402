import { afterEach, describe, expect, test, vi } from "vitest";
import { createTipSource, TIP_STALE_MS, type TipClient } from "../src/tip.js";

/** A client that answers from a queue, where a number is a tip and an Error a failure, and the last answer repeats */
function scripted(...answers: Array<number | Error>): TipClient & { calls: number } {
  const client = {
    calls: 0,
    getTip(): Promise<number> {
      const answer = answers[Math.min(client.calls, answers.length - 1)];
      client.calls += 1;
      return answer instanceof Error || answer === undefined ? Promise.reject(answer) : Promise.resolve(answer);
    },
  };
  return client;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("poll", () => {
  test("has no tip until the first answer, then the latest one", async () => {
    const source = createTipSource({ client: scripted(100, 101), pollMs: 1000, log: () => undefined });
    expect(source.tip()).toBeUndefined();
    await source.poll();
    expect(source.tip()).toBe(100);
    await source.poll();
    expect(source.tip()).toBe(101);
  });

  test("calls onTip for a tip that is new and not for one that repeats", async () => {
    const seen: number[] = [];
    const source = createTipSource({
      client: scripted(100, 100, 101, 101, 100),
      pollMs: 1000,
      onTip: (tip) => seen.push(tip),
      log: () => undefined,
    });
    for (let i = 0; i < 5; i += 1) await source.poll();
    expect(seen).toEqual([100, 101, 100]);
  });

  test("keeps the last good tip through failures and reports an outage once", async () => {
    const logs: string[] = [];
    const source = createTipSource({
      client: scripted(100, new Error("unavailable"), new Error("still unavailable"), 105),
      pollMs: 1000,
      log: (line) => logs.push(line),
    });
    await source.poll();
    await source.poll();
    expect(source.tip()).toBe(100);
    await source.poll();
    expect(source.tip()).toBe(100);
    expect(logs).toEqual(["dropbox: cannot read the chain tip, keeping the last one: unavailable"]);

    await source.poll();
    expect(source.tip()).toBe(105);
    expect(logs).toEqual([
      "dropbox: cannot read the chain tip, keeping the last one: unavailable",
      "dropbox: the chain tip is readable again",
    ]);
  });

  test("logs a failure again after it has recovered", async () => {
    const logs: string[] = [];
    const source = createTipSource({
      client: scripted(new Error("down"), 7, new Error("down again")),
      pollMs: 1000,
      log: (line) => logs.push(line),
    });
    await source.poll();
    await source.poll();
    await source.poll();
    expect(logs.filter((line) => line.includes("cannot read"))).toHaveLength(2);
  });

  test("goes stale after a minute without a good answer, and a good answer renews it", async () => {
    let clock = 1_000_000;
    const source = createTipSource({
      client: scripted(100, new Error("down"), 100),
      pollMs: 1000,
      now: () => clock,
      log: () => undefined,
    });
    await source.poll();
    clock += TIP_STALE_MS;
    expect(source.tip()).toBe(100);
    clock += 1;
    expect(source.tip()).toBeUndefined();
    await source.poll();
    expect(source.tip()).toBeUndefined();
    // The same height again still counts as news that the tip is alive
    await source.poll();
    expect(source.tip()).toBe(100);
  });

  test("does not take what is not a block height", async () => {
    const logs: string[] = [];
    const source = createTipSource({
      client: scripted(50, Number.NaN, -1, 1.5, 51),
      pollMs: 1000,
      log: (line) => logs.push(line),
    });
    for (let i = 0; i < 4; i += 1) await source.poll();
    expect(source.tip()).toBe(50);
    expect(logs).toHaveLength(1);
    await source.poll();
    expect(source.tip()).toBe(51);
  });

  test("survives an onTip that throws", async () => {
    const logs: string[] = [];
    const source = createTipSource({
      client: scripted(1, 2),
      pollMs: 1000,
      onTip: () => {
        throw new Error("disk on fire");
      },
      log: (line) => logs.push(line),
    });
    await source.poll();
    await source.poll();
    expect(source.tip()).toBe(2);
    expect(logs).toEqual(["dropbox: tip handler failed: disk on fire", "dropbox: tip handler failed: disk on fire"]);
  });
});

describe("start and stop", () => {
  test("polls at once and then every interval, and stops when told to", async () => {
    vi.useFakeTimers();
    const client = scripted(1, 2, 3, 4, 5);
    const source = createTipSource({ client, pollMs: 10_000, log: () => undefined });

    source.start();
    source.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(client.calls).toBe(1);
    expect(source.tip()).toBe(1);

    await vi.advanceTimersByTimeAsync(9_999);
    expect(client.calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(client.calls).toBe(2);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(client.calls).toBe(4);
    expect(source.tip()).toBe(4);

    source.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(client.calls).toBe(4);
  });

  test("a poll that was in flight when the source stopped changes nothing", async () => {
    let answer: (tip: number) => void = () => undefined;
    const seen: number[] = [];
    const source = createTipSource({
      client: { getTip: () => new Promise<number>((resolve) => (answer = resolve)) },
      pollMs: 1000,
      onTip: (tip) => seen.push(tip),
      log: () => undefined,
    });
    source.start();
    source.stop();
    answer(42);
    await new Promise((resolve) => setImmediate(resolve));
    expect(source.tip()).toBeUndefined();
    expect(seen).toEqual([]);
  });

  test("can be started again after it was stopped", async () => {
    vi.useFakeTimers();
    const client = scripted(1, 2, 3);
    const source = createTipSource({ client, pollMs: 1000, log: () => undefined });
    source.start();
    await vi.advanceTimersByTimeAsync(0);
    source.stop();
    source.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(client.calls).toBe(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(client.calls).toBe(3);
    source.stop();
  });
});
