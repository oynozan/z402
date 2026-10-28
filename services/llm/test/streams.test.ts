import { afterEach, describe, expect, test, vi } from "vitest";
import type { ChatEnd, ChatRequest, LlmProvider } from "../src/provider.js";
import { StreamError, StreamRegistry, type Generation, type StreamRegistryOptions } from "../src/streams.js";

type Item = string | { end: string | undefined } | { fail: Error };

/** A provider whose deltas the test pushes one by one */
class Feed implements LlmProvider {
  readonly requests: ChatRequest[] = [];
  aborted = false;
  #queue: Item[] = [];
  #wake: (() => void) | undefined;

  push(...texts: string[]): void {
    this.#queue.push(...texts);
    this.#wake?.();
  }

  end(reason?: string): void {
    this.#queue.push({ end: reason });
    this.#wake?.();
  }

  fail(error: Error): void {
    this.#queue.push({ fail: error });
    this.#wake?.();
  }

  async *streamChat(r: ChatRequest): AsyncGenerator<string, ChatEnd, void> {
    this.requests.push(r);
    r.signal?.addEventListener("abort", () => {
      this.aborted = true;
      this.#wake?.();
    });
    for (;;) {
      r.signal?.throwIfAborted();
      const item = this.#queue.shift();
      if (item === undefined) {
        await new Promise<void>((resolve) => {
          this.#wake = resolve;
        });
        continue;
      }
      if (typeof item === "string") yield item;
      else if ("fail" in item) throw item.fail;
      else return { finishReason: item.end };
    }
  }

  async listModels(): Promise<string[]> {
    return [];
  }
}

const GENERATION: Generation = { messages: [{ role: "user", content: "hi" }], maxTokens: 16 };
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

const registries: StreamRegistry[] = [];
afterEach(() => {
  for (const r of registries.splice(0)) r.close();
});

function registryFor(feed: Feed, o: Partial<StreamRegistryOptions> = {}): StreamRegistry {
  const registry = new StreamRegistry({ provider: feed, chunkTokens: 2, capacity: 4, idleMs: 1_000, ...o });
  registries.push(registry);
  return registry;
}

describe("publishing", () => {
  test("a full chunk waits for the next delta, which starts the next chunk", async () => {
    const feed = new Feed();
    const stream = registryFor(feed).create(GENERATION);
    expect(feed.requests[0]).toMatchObject({ messages: GENERATION.messages, maxTokens: 16 });
    feed.push("a", "b");
    await tick();
    expect(stream.published).toBe(0);
    feed.push("c");
    await vi.waitFor(() => expect(stream.published).toBe(1));
    expect(stream.chunk(0)).toEqual({ text: "ab", final: false });
    feed.end("stop");
    await vi.waitFor(() => expect(stream.state).toBe("done"));
    expect(stream.chunk(1)).toEqual({ text: "c", final: true });
    expect(stream.published).toBe(2);
    expect(stream.finishReason).toBe("stop");
  });

  test("a generation that fills its last chunk exactly marks that chunk final", async () => {
    const feed = new Feed();
    const stream = registryFor(feed).create(GENERATION);
    feed.push("a", "b", "c", "d");
    await vi.waitFor(() => expect(stream.published).toBe(1));
    await tick();
    expect(stream.published).toBe(1);
    feed.end("length");
    await vi.waitFor(() => expect(stream.state).toBe("done"));
    expect([stream.chunk(0), stream.chunk(1)]).toEqual([
      { text: "ab", final: false },
      { text: "cd", final: true },
    ]);
    expect(stream.finishReason).toBe("length");
  });

  test("empty deltas count for nothing", async () => {
    const feed = new Feed();
    const stream = registryFor(feed).create(GENERATION);
    feed.push("", "a", "", "b", "");
    await tick();
    expect(stream.published).toBe(0);
    feed.push("c");
    await vi.waitFor(() => expect(stream.chunk(0)).toEqual({ text: "ab", final: false }));
  });

  test("a generation with no output publishes one empty final chunk", async () => {
    const feed = new Feed();
    const stream = registryFor(feed).create(GENERATION);
    feed.end(undefined);
    expect(await stream.waitFor(0, 1_000)).toEqual({ text: "", final: true });
    expect(stream.published).toBe(1);
    expect(stream.finishReason).toBeUndefined();
  });
});

describe("waiting and delivery", () => {
  test("a wait ends with the chunk, a timeout, or the producer's failure", async () => {
    const feed = new Feed();
    const failures: unknown[] = [];
    const stream = registryFor(feed, { onFailure: (e) => failures.push(e) }).create(GENERATION);
    const first = stream.waitFor(0, 1_000);
    feed.push("a", "b", "c");
    expect(await first).toEqual({ text: "ab", final: false });
    await expect(stream.waitFor(1, 30)).rejects.toMatchObject({ kind: "timeout" });

    const second = stream.waitFor(1, 1_000);
    const boom = new Error("boom");
    feed.fail(boom);
    await expect(second).rejects.toMatchObject({ kind: "failed", cause: boom });
    expect(stream.state).toBe("failed");
    expect(failures).toEqual([boom]);
    // What was published before the failure can still be delivered
    expect(await stream.waitFor(0, 1_000)).toEqual({ text: "ab", final: false });
  });

  test("the cursor moves only on commit, so a failed delivery offers the same chunk again", async () => {
    const feed = new Feed();
    const stream = registryFor(feed).create(GENERATION);
    feed.push("a", "b", "c", "d", "e");
    feed.end("stop");
    await vi.waitFor(() => expect(stream.state).toBe("done"));

    // create() claimed chunk 0 for the start call
    expect(stream.inFlight).toBe(true);
    expect(stream.claim()).toBeUndefined();
    stream.commit(0);
    expect([stream.cursor, stream.inFlight]).toEqual([1, false]);

    expect(stream.claim()).toBe(1);
    expect(stream.claim()).toBeUndefined();
    stream.release();
    expect([stream.cursor, stream.inFlight]).toEqual([1, false]);

    expect(stream.claim()).toBe(1);
    stream.commit(1);
    expect(stream.cursor).toBe(2);
    // A commit for an index that is not the cursor's leaves it alone
    expect(stream.claim()).toBe(2);
    stream.commit(1);
    expect([stream.cursor, stream.inFlight]).toEqual([2, false]);

    expect(stream.spent).toBe(false);
    stream.claim();
    stream.commit(2);
    expect(stream.spent).toBe(true);
    // Past the last chunk there is nothing to commit
    stream.claim();
    stream.commit(3);
    expect(stream.cursor).toBe(3);
  });
});

describe("stalls", () => {
  test("a generation that sent nothing for the given time fails at once, aborted and reported", async () => {
    let now = 0;
    const feed = new Feed();
    const failures: unknown[] = [];
    const registry = registryFor(feed, { now: () => now, onFailure: (e) => failures.push(e) });
    const stream = registry.create(GENERATION);
    now = 400;
    feed.push("a");
    await vi.waitFor(() => expect(feed.requests).toHaveLength(1));
    await tick();
    now = 1_300;
    expect(stream.failIfStalled(1_000)).toBe(false);
    now = 1_400;
    const waiting = stream.waitFor(0, 5_000);
    expect(stream.failIfStalled(1_000)).toBe(true);
    expect(stream.state).toBe("failed");
    await expect(waiting).rejects.toMatchObject({ kind: "failed" });
    expect(feed.aborted).toBe(true);
    await tick();
    expect(failures).toHaveLength(1);
    expect(String(failures[0])).toMatch(/sent nothing for 1000 ms/);
    expect(stream.failIfStalled(1_000)).toBe(false);
  });

  test("a finished generation is never stalled", async () => {
    let now = 0;
    const feed = new Feed();
    const stream = registryFor(feed, { now: () => now }).create(GENERATION);
    feed.end("stop");
    await vi.waitFor(() => expect(stream.state).toBe("done"));
    now = 10_000;
    expect(stream.failIfStalled(1_000)).toBe(false);
  });
});

describe("lifetime", () => {
  test("an idle stream is swept and its generation stopped, but not while a call is in flight", async () => {
    let now = 0;
    const feed = new Feed();
    const registry = registryFor(feed, { idleMs: 1_000, now: () => now });
    const stream = registry.create(GENERATION);
    now = 5_000;
    expect(registry.sweep()).toBe(0);
    stream.release();
    now = 5_500;
    expect(registry.sweep()).toBe(0);
    now = 6_001;
    expect(registry.sweep()).toBe(1);
    expect(registry.get(stream.id)).toBeUndefined();
    expect([stream.closed, feed.aborted]).toEqual([true, true]);
    await vi.waitFor(() => expect(stream.state).toBe("failed"));
  });

  test("a lookup counts as use", () => {
    let now = 0;
    const registry = registryFor(new Feed(), { idleMs: 1_000, now: () => now });
    const stream = registry.create(GENERATION);
    stream.release();
    now = 900;
    expect(registry.get(stream.id)).toBe(stream);
    now = 1_800;
    expect(registry.sweep()).toBe(0);
  });

  test("close stops every generation, ends every wait and refuses new streams", async () => {
    const feeds: Feed[] = [];
    const failures: unknown[] = [];
    const provider: LlmProvider = {
      streamChat: (r) => {
        const feed = new Feed();
        feeds.push(feed);
        return feed.streamChat(r);
      },
      listModels: async () => [],
    };
    const registry = new StreamRegistry({
      provider,
      chunkTokens: 2,
      capacity: 4,
      idleMs: 1_000,
      onFailure: (e) => failures.push(e),
    });
    const waits = [registry.create(GENERATION), registry.create(GENERATION)].map((s) => s.waitFor(0, 5_000));
    registry.close();
    for (const wait of waits) await expect(wait).rejects.toMatchObject({ kind: "closed" });
    await vi.waitFor(() => expect(feeds.map((f) => f.aborted)).toEqual([true, true]));
    expect(registry.size).toBe(0);
    expect(() => registry.create(GENERATION)).toThrow(StreamError);
    // An abort is not a provider failure
    expect(failures).toEqual([]);
  });

  test("capacity counts live streams only", async () => {
    const feed = new Feed();
    const registry = registryFor(feed, { capacity: 2 });
    const first = registry.create(GENERATION);
    feed.end("stop");
    await first.waitFor(0, 1_000);
    registry.create(GENERATION);
    expect([registry.live, registry.hasRoom()]).toEqual([2, false]);
    // Delivering the only chunk of the finished stream frees its place, though it is kept to answer 410
    first.commit(0);
    expect([registry.live, registry.size, registry.hasRoom()]).toEqual([1, 2, true]);
    registry.remove(first.id);
    expect(registry.size).toBe(1);
  });
});
