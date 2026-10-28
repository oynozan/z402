import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, test, vi } from "vitest";
import { listsModel, OpenAiProvider, ProviderError, readLines, type ChatEnd } from "../src/provider.js";
import { fakeProvider, gate, type FakeProvider, type Reply } from "./fake-provider.js";

const fakes: FakeProvider[] = [];
afterEach(async () => {
  for (const f of fakes.splice(0)) await f.close();
});

async function fake(o: Parameters<typeof fakeProvider>[0] = {}): Promise<FakeProvider> {
  const f = await fakeProvider(o);
  fakes.push(f);
  return f;
}

const MESSAGES = [{ role: "user" as const, content: "hi" }];

async function drain(g: AsyncGenerator<string, ChatEnd, void>): Promise<{ deltas: string[]; end: ChatEnd }> {
  const deltas: string[] = [];
  for (;;) {
    const step = await g.next();
    if (step.done === true) return { deltas, end: step.value };
    deltas.push(step.value);
  }
}

function bodyOf(...parts: (string | Uint8Array)[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const p of parts) controller.enqueue(typeof p === "string" ? encoder.encode(p) : p);
      controller.close();
    },
  });
}

async function lines(body: ReadableStream<Uint8Array>): Promise<string[]> {
  const out: string[] = [];
  for await (const line of readLines(body)) out.push(line);
  return out;
}

describe("streamChat", () => {
  test("yields the non-empty deltas and returns the finish reason", async () => {
    const f = await fake({ reply: () => ({ steps: ["Hel", "lo", "", " world"], finish: "length" }) });
    const provider = new OpenAiProvider({ baseUrl: f.baseUrl, apiKey: undefined, model: "m" });
    const { deltas, end } = await drain(provider.streamChat({ messages: MESSAGES, maxTokens: 5 }));
    expect(deltas).toEqual(["Hel", "lo", " world"]);
    expect(end).toEqual({ finishReason: "length" });
    expect(f.chats).toEqual([{ model: "m", messages: MESSAGES, max_tokens: 5, stream: true }]);
    expect(f.authorizations).toEqual([undefined]);
  });

  test("skips comments and other fields, and accepts an end without [DONE] after a finish reason", async () => {
    const f = await fake({
      reply: () => ({ steps: [{ raw: ": keep-alive\n\nevent: message\nid: 7\n" }, "a"], done: false }),
    });
    const provider = new OpenAiProvider({ baseUrl: f.baseUrl, apiKey: undefined, model: "m" });
    expect(await drain(provider.streamChat({ messages: MESSAGES, maxTokens: 5 }))).toEqual({
      deltas: ["a"],
      end: { finishReason: "stop" },
    });
  });

  test("sends the key as a bearer token when one is set", async () => {
    const f = await fake();
    const provider = new OpenAiProvider({ baseUrl: f.baseUrl, apiKey: "sk-test", model: "m" });
    await drain(provider.streamChat({ messages: MESSAGES, maxTokens: 5 }));
    await provider.listModels();
    expect(f.authorizations).toEqual(["Bearer sk-test", "Bearer sk-test"]);
  });

  test("a refusal throws a ProviderError with the status and the provider's words, the key masked", async () => {
    const f = await fake({
      reply: () => ({ status: 401, body: { error: { message: "Incorrect API key provided: sk-secret-1" } } }),
    });
    const provider = new OpenAiProvider({ baseUrl: f.baseUrl, apiKey: "sk-secret-1", model: "m" });
    const error = await drain(provider.streamChat({ messages: MESSAGES, maxTokens: 5 })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ status: 401 });
    expect((error as Error).message).toBe(
      `the provider at ${new URL(f.baseUrl).origin} answered 401: Incorrect API key provided: [redacted]`,
    );
  });

  const malformed: [string, Reply, RegExp][] = [
    ["an event that is not JSON", { steps: ["a", { raw: "data: {nope\n\n" }] }, /not JSON/],
    ["an error event", { steps: ["a", { error: "model crashed" }] }, /reported an error mid-stream: model crashed/],
    ["an end without [DONE] or a finish reason", { steps: ["a"], finish: null, done: false }, /before \[DONE\]/],
    ["a dropped connection", { steps: ["a", "drop"] }, /failed: /],
  ];
  test.each(malformed)("%s throws a ProviderError carrying the status", async (_name, reply, pattern) => {
    const f = await fake({ reply: () => reply });
    const provider = new OpenAiProvider({ baseUrl: f.baseUrl, apiKey: undefined, model: "m" });
    const deltas: string[] = [];
    const error = await (async () => {
      for await (const d of provider.streamChat({ messages: MESSAGES, maxTokens: 5 })) deltas.push(d);
    })().catch((e: unknown) => e);
    expect(deltas).toEqual(["a"]);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ status: 200 });
    expect((error as Error).message).toMatch(pattern);
  });

  test("an unreachable provider throws a ProviderError without a status", async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const provider = new OpenAiProvider({ baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: undefined, model: "m" });
    const error = await drain(provider.streamChat({ messages: MESSAGES, maxTokens: 5 })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ status: undefined });
    expect((error as Error).message).toMatch(/ECONNREFUSED/);
    await expect(provider.listModels()).rejects.toBeInstanceOf(ProviderError);
  });

  test("an abort rejects with the abort reason and closes the connection", async () => {
    const hold = gate();
    const f = await fake({ reply: () => ({ steps: ["a", hold, "b"] }) });
    const provider = new OpenAiProvider({ baseUrl: f.baseUrl, apiKey: undefined, model: "m" });
    const controller = new AbortController();
    const stream = provider.streamChat({ messages: MESSAGES, maxTokens: 5, signal: controller.signal });
    expect(await stream.next()).toEqual({ done: false, value: "a" });
    const next = stream.next();
    controller.abort();
    await expect(next).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(f.aborted).toBe(1));
    hold.open();
  });
});

describe("listModels", () => {
  test("returns the ids the provider lists", async () => {
    const f = await fake({ models: ["qwen2.5:0.5b", "nomic-embed-text:latest"] });
    const provider = new OpenAiProvider({ baseUrl: f.baseUrl, apiKey: undefined, model: "m" });
    expect(await provider.listModels()).toEqual(["qwen2.5:0.5b", "nomic-embed-text:latest"]);
  });

  test("a model llama.cpp server is still loading (meta: null) is not listed", async () => {
    const answer = (meta: unknown): string =>
      JSON.stringify({ object: "list", data: [{ id: "qwen2.5-0.5b-instruct", object: "model", meta }] });
    let body = answer(null);
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" }).end(body);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const provider = new OpenAiProvider({ baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: undefined, model: "m" });
      expect(await provider.listModels()).toEqual([]);
      body = answer({ n_vocab: 151936, n_ctx_train: 32768 });
      expect(await provider.listModels()).toEqual(["qwen2.5-0.5b-instruct"]);
      body = JSON.stringify({ models: [] });
      await expect(provider.listModels()).rejects.toThrow(/without a data array/);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("an untagged model name also matches name:latest", () => {
    expect(listsModel(["qwen2.5:0.5b"], "qwen2.5:0.5b")).toBe(true);
    expect(listsModel(["llama3.2:latest"], "llama3.2")).toBe(true);
    expect(listsModel(["llama3.2:3b"], "llama3.2")).toBe(false);
    expect(listsModel(["qwen2.5:latest"], "qwen2.5:0.5b")).toBe(false);
    expect(listsModel(["gpt-4o-mini"], "gpt-4o-mini")).toBe(true);
  });
});

describe("readLines", () => {
  test("splits lines across chunk boundaries, CRLF and multi-byte characters", async () => {
    const e = new TextEncoder().encode("é");
    expect(
      await lines(bodyOf("data: a\r", "\ndata: caf", e.subarray(0, 1), Uint8Array.of(e[1] ?? 0, 0x0a), "\n", "last")),
    ).toEqual(["data: a", "data: café", "", "last"]);
  });

  test("refuses a line over 1 MiB", async () => {
    await expect(lines(bodyOf("x".repeat((1 << 20) + 1)))).rejects.toThrow(/over 1 MiB/);
  });
});
