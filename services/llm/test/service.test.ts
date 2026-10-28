import { validateDiscoveryExtension, type DiscoveryExtension } from "@x402/extensions/bazaar";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { serve } from "@z402/service-kit";
import { startTestStack, TEST_NETWORK, TEST_PAY_TO, TEST_PUBLIC_URL, type TestStack } from "@z402/service-kit/testing";
import express from "express";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { LlmConfig } from "../src/config.js";
import { createLlmService, type LlmService } from "../src/service.js";
import { fakeProvider, gate, type FakeProvider } from "./fake-provider.js";

const CONFIG: Omit<LlmConfig, "baseUrl"> = {
  apiKey: undefined,
  model: "test-model",
  chunkTokens: 2,
  maxTokens: 64,
  maxPromptChars: 100,
  maxStreams: 4,
  streamIdleMs: 60_000,
  chunkTimeoutMs: 5_000,
};

const running: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const r of running.splice(0)) await r.close();
});

async function fake(o: Parameters<typeof fakeProvider>[0] = {}): Promise<FakeProvider> {
  const f = await fakeProvider(o);
  running.push(f);
  return f;
}

/** The service in front of `provider`, with the facilitator and a paying client */
async function llmStack(
  provider: FakeProvider,
  o: { config?: Partial<LlmConfig>; log?: string[] } = {},
): Promise<TestStack & { service: LlmService }> {
  const built: { service?: LlmService } = {};
  const stack = await startTestStack({
    build: async (env) =>
      (built.service = await createLlmService({
        env,
        config: { ...CONFIG, baseUrl: provider.baseUrl, ...o.config },
        log: (line) => o.log?.push(line),
      })),
  });
  // Closed before the provider, which it streams from
  running.unshift(stack);
  if (built.service === undefined) throw new Error("the service was not built");
  return Object.assign(stack, { service: built.service });
}

const post = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

interface Answer {
  stream: string;
  index: number;
  text: string;
  done: boolean;
  finishReason?: string;
}

async function json(res: Response | Promise<Response>): Promise<unknown> {
  return (await res).json();
}

/** Repeats an unpaid call until it gets `status` */
async function eventually(call: () => Promise<Response>, status: number): Promise<void> {
  await vi.waitFor(
    async () => {
      const res = await call();
      await res.arrayBuffer();
      expect(res.status).toBe(status);
    },
    { timeout: 5_000, interval: 20 },
  );
}

function paymentRequired(res: Response): {
  resource: { url: string; description: string; serviceName: string };
  extensions: { bazaar: DiscoveryExtension; z402: unknown };
} {
  return JSON.parse(Buffer.from(res.headers.get("payment-required") ?? "", "base64").toString("utf8"));
}

const cumulative = (stack: TestStack): bigint | undefined => stack.scheme.session(TEST_PAY_TO)?.cumulativeZat;

describe("POST /v1/generate", () => {
  test("an unpaid call gets a 402 that declares the route, and nothing is generated", async () => {
    const provider = await fake();
    const stack = await llmStack(provider);
    const url = `${stack.url}/v1/generate`;
    const res = await fetch(url, post({ prompt: "hi" }));
    expect(res.status).toBe(402);
    const required = paymentRequired(res);
    expect(required.resource).toMatchObject({ url: `${TEST_PUBLIC_URL}/v1/generate`, serviceName: "LLM inference" });
    expect(required.resource.description).toBe(
      "Streams test-model output, one chunk of about 2 tokens per paid call: " +
        "send {prompt} to start, then {stream} to continue.",
    );
    expect(required.extensions.z402).toEqual({
      unit: "output chunk",
      note: "The operator sees your prompts. Open-weights model.",
    });
    expect(required.extensions.bazaar.info.input).toMatchObject({
      type: "http",
      method: "POST",
      bodyType: "json",
      body: { prompt: "Write a haiku about privacy." },
    });
    expect(validateDiscoveryExtension(required.extensions.bazaar)).toEqual({ valid: true });

    // A discovery probe skips the body checks and gets the same 402
    const probe = await fetch(url, { method: "POST", headers: { "x-z402-probe": "1" } });
    expect(probe.status).toBe(402);
    expect(provider.chats).toHaveLength(0);
  });

  test("a start call returns chunk 0 and a stream id, each continue the next chunk, done only on the last", async () => {
    const provider = await fake({ reply: () => ({ steps: ["a", "b", "c", "d", "e"] }) });
    const stack = await llmStack(provider);
    const url = `${stack.url}/v1/generate`;

    const start = await stack.paidFetch(url, post({ prompt: "Say hi", system: "Be brief", maxTokens: 10 }));
    expect(start.status).toBe(200);
    expect(start.headers.get("payment-response")).toBeTruthy();
    const first = (await start.json()) as Answer;
    expect(first).toEqual({ stream: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/), index: 0, text: "ab", done: false });
    expect(provider.chats).toEqual([
      {
        model: "test-model",
        messages: [
          { role: "system", content: "Be brief" },
          { role: "user", content: "Say hi" },
        ],
        max_tokens: 10,
        stream: true,
      },
    ]);

    const id = first.stream;
    const second = await json(stack.paidFetch(url, post({ stream: id })));
    expect(second).toEqual({ stream: id, index: 1, text: "cd", done: false });
    expect(await json(stack.paidFetch(url, post({ stream: id })))).toEqual({
      stream: id,
      index: 2,
      text: "e",
      done: true,
      finishReason: "stop",
    });
    expect(cumulative(stack)).toBe(1500n);

    // Nothing is left to sell, so the call is refused on its unpaid attempt and no voucher is sent
    const after = await stack.paidFetch(url, post({ stream: id }));
    expect(after.status).toBe(410);
    expect(await after.json()).toEqual({ error: "stream_finished" });
    expect(cumulative(stack)).toBe(1500n);
    expect(await json(fetch(`${stack.url}/health`))).toMatchObject({ ready: true, callsToday: 3 });
    expect(provider.chats).toHaveLength(1);
  });

  test("without maxTokens the output is capped at LLM_MAX_TOKENS, and an empty system prompt is left out", async () => {
    const provider = await fake();
    const stack = await llmStack(provider);
    await json(stack.paidFetch(`${stack.url}/v1/generate`, post({ prompt: "hi", system: "" })));
    expect(provider.chats[0]).toMatchObject({ messages: [{ role: "user", content: "hi" }], max_tokens: 64 });
  });

  test("an unknown stream and invalid bodies are refused before payment", async () => {
    const provider = await fake();
    const stack = await llmStack(provider);
    const url = `${stack.url}/v1/generate`;
    const invalid: unknown[] = [
      {},
      { prompt: "" },
      { prompt: "   " },
      { prompt: 5 },
      { prompt: "x".repeat(101) },
      { prompt: "hi", system: 3 },
      { prompt: "hi", system: "x".repeat(101) },
      { prompt: "hi", maxTokens: 0 },
      { prompt: "hi", maxTokens: 1.5 },
      { prompt: "hi", maxTokens: 65 },
      { prompt: "hi", maxTokens: "5" },
      { prompt: "hi", temperature: 0.2 },
      { prompt: "hi", stream: "abc" },
      { stream: "abc", maxTokens: 5 },
      { stream: 7 },
      { stream: "" },
      [],
      "hi",
    ];
    for (const body of invalid) {
      const res = await stack.paidFetch(url, post(body));
      expect([res.status, ((await res.json()) as { error: string }).error]).toEqual([400, "invalid_request"]);
    }
    const notJson = await stack.paidFetch(url, { ...post(null), body: "{" });
    expect(notJson.status).toBe(400);
    const untyped = await stack.paidFetch(url, { method: "POST", body: JSON.stringify({ prompt: "hi" }) });
    const hint = expect.stringContaining("content-type");
    expect(await untyped.json()).toMatchObject({ error: "invalid_request", message: hint });
    const huge = await stack.paidFetch(url, post({ prompt: "x".repeat(70_000) }));
    expect([huge.status, ((await huge.json()) as { error: string }).error]).toEqual([413, "body_too_large"]);

    for (const id of ["AAAAAAAAAAAAAAAAAAAAAA", "../../etc/passwd"]) {
      const res = await stack.paidFetch(url, post({ stream: id }));
      expect([res.status, await res.json()]).toEqual([404, { error: "unknown_stream" }]);
    }
    expect(stack.scheme.session(TEST_PAY_TO)).toBeUndefined();
    expect(provider.chats).toHaveLength(0);
  });

  test("a prompt that is not well-formed text is refused before payment, not by the provider after it", async () => {
    // llama.cpp and vLLM refuse a lone surrogate, which JSON can carry as an escape
    const loneSurrogate = /\\ud[89a-f][0-9a-f]{2}/i;
    const provider = await fake({
      reply: (body) =>
        loneSurrogate.test(JSON.stringify(body.messages))
          ? { status: 400, body: { error: { message: "invalid string: surrogate U+D800..U+DBFF" } } }
          : { steps: ["a"] },
    });
    const stack = await llmStack(provider);
    const url = `${stack.url}/v1/generate`;
    const bodies = [
      '{"prompt":"hi \\ud83d"}',
      '{"prompt":"\\ude00 hi"}',
      '{"prompt":"hi","system":"\\udbff"}',
      '{"prompt":"\\ude00\\ud83d"}',
    ];
    for (const body of bodies) {
      const res = await stack.paidFetch(url, { method: "POST", headers: { "content-type": "application/json" }, body });
      expect([body, res.status, await res.json()]).toEqual([
        body,
        400,
        { error: "invalid_request", message: expect.stringMatching(/^(prompt|system) /) },
      ]);
    }
    expect(stack.scheme.session(TEST_PAY_TO)).toBeUndefined();
    expect(provider.chats).toHaveLength(0);
    // A pair written as escapes is one character, and fine
    const paired = await stack.paidFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"prompt":"hi \\ud83d\\ude00"}',
    });
    expect([paired.status, provider.chats[0]?.messages]).toEqual([200, [{ role: "user", content: "hi \u{1F600}" }]]);
  });

  test("a prompt and a system prompt of the largest size fit the body, every character escaped", async () => {
    const provider = await fake();
    const stack = await llmStack(provider, { config: { maxPromptChars: 20_000 } });
    // How Python's json.dumps writes text by default
    const escaped = "\\u00e9".repeat(20_000);
    const body = `{"prompt":"${escaped}","system":"${escaped}"}`;
    const res = await fetch(`${stack.url}/v1/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    expect(res.status).toBe(402);
  });

  test("a refused settle delivers nothing: a start drops its stream, a continue keeps its chunk", async () => {
    const provider = await fake({ reply: () => ({ steps: ["a", "b", "c", "d", "e"] }) });
    let refuseSettle = false;
    let refused = 0;
    const built: { service?: LlmService } = {};
    const stack = await startTestStack({
      build: async (env) => {
        // Between the service and the facilitator, refusing the next settle when told to
        const proxy = express();
        proxy.use(express.text({ type: () => true }));
        proxy.use(async (req, res) => {
          if (req.path === "/settle" && refuseSettle) {
            refuseSettle = false;
            refused += 1;
            res.json({ success: false, errorReason: "unexpected_settle_error", transaction: "", network: env.network });
            return;
          }
          const answer = await fetch(`${env.facilitatorUrl}${req.url}`, {
            method: req.method,
            headers: { "content-type": "application/json", authorization: req.get("authorization") ?? "" },
            body: req.method === "GET" ? undefined : (req.body as string),
          });
          res.status(answer.status).type("application/json").send(await answer.text());
        });
        const listening = await serve(proxy, { host: "127.0.0.1", port: 0 });
        running.push({
          close: async () => {
            listening.server.closeAllConnections();
            await listening.close();
          },
        });
        built.service = await createLlmService({
          env: { ...env, facilitatorUrl: listening.url },
          config: { ...CONFIG, baseUrl: provider.baseUrl },
          log: () => undefined,
        });
        return built.service;
      },
    });
    running.unshift(stack);
    const url = `${stack.url}/v1/generate`;

    // The client backs off and pays again, and that start makes a stream of its own
    refuseSettle = true;
    const first = (await json(stack.paidFetch(url, post({ prompt: "hi" })))) as Answer;
    expect([refused, provider.chats.length]).toEqual([1, 2]);
    expect(first).toMatchObject({ index: 0, text: "ab", done: false });
    // The refused start's stream is gone, so only the one its retry made is held
    expect(built.service?.streams.size).toBe(1);
    expect(built.service?.streams.get(first.stream)).toBeDefined();

    // The refused continue did not move the cursor, so its retry gets the same chunk, and nothing is skipped
    refuseSettle = true;
    const retried = await json(stack.paidFetch(url, post({ stream: first.stream })));
    expect(refused).toBe(2);
    expect(retried).toEqual({ stream: first.stream, index: 1, text: "cd", done: false });
    expect(await json(stack.paidFetch(url, post({ stream: first.stream })))).toMatchObject({ index: 2, text: "e" });
    expect(await json(fetch(`${stack.url}/health`))).toMatchObject({ callsToday: 3 });
  });

  test("a voucher that already paid for a call is refused before the handler, on any call", async () => {
    const provider = await fake({ reply: () => ({ steps: ["a", "b", "c", "d", "e"] }) });
    const stack = await llmStack(provider);
    const url = `${stack.url}/v1/generate`;
    const vouchers: string[] = [];
    const recording: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      const voucher = request.headers.get("payment-signature");
      if (voucher !== null) vouchers.push(voucher);
      return fetch(request);
    };
    const paidFetch = wrapFetchWithPayment(recording, new x402Client().register(TEST_NETWORK, stack.scheme));
    const { stream } = (await json(paidFetch(url, post({ prompt: "hi" })))) as Answer;
    const [used] = vouchers;
    if (used === undefined) throw new Error("no voucher was sent");

    const replay = (body: unknown): Promise<Response> =>
      fetch(url, { ...post(body), headers: { "content-type": "application/json", "payment-signature": used } });
    for (const body of [{ prompt: "again" }, { stream }]) {
      const res = await replay(body);
      expect(res.status).toBe(402);
      expect(await res.text()).not.toContain('"text"');
    }
    expect(provider.chats).toHaveLength(1);
    const held = stack.service.streams.get(stream);
    expect([held?.cursor, held?.inFlight]).toEqual([1, false]);
  });

  test("a second call on a stream while one is in flight gets 409 before payment", async () => {
    const hold = gate();
    const provider = await fake({ reply: () => ({ steps: ["a", "b", "c", hold, "d", "e"] }) });
    const stack = await llmStack(provider);
    const url = `${stack.url}/v1/generate`;
    const { stream } = (await json(stack.paidFetch(url, post({ prompt: "hi" })))) as Answer;

    // This one waits for chunk 1, which the provider holds back
    const pending = stack.paidFetch(url, post({ stream }));
    await eventually(() => fetch(url, post({ stream })), 409);
    const busy = await stack.paidFetch(url, post({ stream }));
    expect([busy.status, await busy.json()]).toEqual([409, { error: "stream_busy" }]);

    hold.open();
    expect(await json(pending)).toEqual({ stream, index: 1, text: "cd", done: false });
    expect(cumulative(stack)).toBe(1000n);
  });

  test("a client that hangs up mid-call releases the stream, and its chunk stays for sale", async () => {
    const hold = gate();
    const provider = await fake({ reply: () => ({ steps: ["a", "b", "c", hold] }) });
    const stack = await llmStack(provider);
    const url = `${stack.url}/v1/generate`;
    const { stream } = (await json(stack.paidFetch(url, post({ prompt: "hi" })))) as Answer;

    const controller = new AbortController();
    const abandoned = stack.paidFetch(url, { ...post({ stream }), signal: controller.signal }).catch((e: unknown) => e);
    await eventually(() => fetch(url, post({ stream })), 409);
    controller.abort();
    await abandoned;
    await eventually(() => fetch(url, post({ stream })), 402);

    // The generation ends with chunk 1, which the abandoned call was waiting for: it is still for sale
    hold.open();
    const held = stack.service.streams.get(stream);
    await vi.waitFor(() => expect(held?.state).toBe("done"));
    expect([held?.published, held?.cursor, held?.inFlight]).toEqual([2, 1, false]);
    expect((await fetch(url, post({ stream }))).status).toBe(402);
  });

  test("a provider that does not list the model makes the service not ready, refused before payment", async () => {
    const provider = await fake({ models: ["other:latest"] });
    const log: string[] = [];
    const stack = await llmStack(provider, { log });
    const health = await fetch(`${stack.url}/health`);
    expect(health.status).toBe(503);
    expect(await health.json()).toMatchObject({ ready: false, service: "LLM inference" });
    const res = await stack.paidFetch(`${stack.url}/v1/generate`, post({ prompt: "hi" }));
    expect([res.status, await res.json()]).toEqual([503, { error: "not_ready" }]);
    expect(stack.scheme.session(TEST_PAY_TO)).toBeUndefined();
    expect(log).toEqual(["not ready: the provider does not list test-model (it lists other:latest)"]);
  });

  test("a model configured without a tag is ready when the provider lists it as :latest", async () => {
    const provider = await fake({ models: ["llama3.2:latest"] });
    const stack = await llmStack(provider, { config: { model: "llama3.2" } });
    expect((await fetch(`${stack.url}/health`)).status).toBe(200);
  });

  test("after a failure mid-stream, published chunks are sold and the next call is refused before payment", async () => {
    const provider = await fake({ reply: () => ({ steps: ["a", "b", "c", "drop"] }) });
    const log: string[] = [];
    const stack = await llmStack(provider, { log });
    const url = `${stack.url}/v1/generate`;
    const first = (await json(stack.paidFetch(url, post({ prompt: "hi" })))) as Answer;
    expect(first).toMatchObject({ index: 0, text: "ab", done: false });

    await eventually(() => fetch(url, post({ stream: first.stream })), 502);
    const res = await stack.paidFetch(url, post({ stream: first.stream }));
    expect([res.status, await res.json()]).toEqual([502, { error: "provider_failed" }]);
    expect(cumulative(stack)).toBe(500n);
    expect(log.filter((l) => l.startsWith("generation failed: "))).toHaveLength(1);
  });

  test("a provider that refuses the generation fails the paid start with 502, logged without the key", async () => {
    const provider = await fake({
      reply: () => ({ status: 401, body: { error: { message: "Incorrect API key provided: sk-secret-9" } } }),
    });
    const log: string[] = [];
    const stack = await llmStack(provider, { log, config: { apiKey: "sk-secret-9" } });
    const res = await stack.paidFetch(`${stack.url}/v1/generate`, post({ prompt: "hi" }));
    expect([res.status, await res.json()]).toEqual([502, { error: "provider_failed" }]);
    expect(log.at(-1)).toMatch(/^generation failed: .* answered 401: Incorrect API key provided: \[redacted\]$/);
    expect(log.join("\n")).not.toContain("sk-secret-9");
  });

  test("a first chunk that is not ready in time gets 504 and its generation is stopped", async () => {
    const hold = gate();
    const provider = await fake({ reply: () => ({ steps: [hold] }) });
    const stack = await llmStack(provider, { config: { chunkTimeoutMs: 300 } });
    const res = await stack.paidFetch(`${stack.url}/v1/generate`, post({ prompt: "hi" }));
    expect([res.status, await res.json()]).toEqual([504, { error: "chunk_timeout" }]);
    await vi.waitFor(() => expect(provider.aborted).toBe(1));
    hold.open();
  });

  test("a call that times out on a stalled generation fails it, so the next is refused before payment", async () => {
    const hold = gate();
    const provider = await fake({ reply: () => ({ steps: ["a", "b", "c", hold] }) });
    const log: string[] = [];
    const stack = await llmStack(provider, { log, config: { chunkTimeoutMs: 300 } });
    const url = `${stack.url}/v1/generate`;
    const { stream } = (await json(stack.paidFetch(url, post({ prompt: "hi" })))) as Answer;

    const timedOut = await stack.paidFetch(url, post({ stream }));
    expect([timedOut.status, await timedOut.json()]).toEqual([504, { error: "chunk_timeout" }]);
    const charged = cumulative(stack);
    const next = await stack.paidFetch(url, post({ stream }));
    expect([next.status, await next.json()]).toEqual([502, { error: "provider_failed" }]);
    expect(cumulative(stack)).toBe(charged);
    await vi.waitFor(() => expect(provider.aborted).toBe(1));
    expect(log).toContainEqual("generation failed: the provider sent nothing for 300 ms");
    hold.open();
  });

  test("paid starts that arrive together never run more generations than LLM_MAX_STREAMS", async () => {
    const hold = gate();
    const provider = await fake({ reply: () => ({ steps: [hold, "a", "b", "c"] }) });
    const stack = await llmStack(provider, { config: { maxStreams: 2 } });
    const url = `${stack.url}/v1/generate`;
    // Five sessions, so that the five paid retries reach the service together
    const clients = [stack, ...Array.from({ length: 4 }, () => stack.client())];
    const statuses: number[] = [];
    const answers = clients.map(async (c) => {
      const res = await c.paidFetch(url, post({ prompt: "hi" })).catch(() => undefined);
      statuses.push(res?.status ?? 0);
      return res?.status;
    });
    // All five paid retries are in once a generation started and every other one was answered
    await vi.waitFor(() => expect(statuses.length + provider.chats.length).toBeGreaterThanOrEqual(5), {
      timeout: 5_000,
      interval: 20,
    });
    expect([provider.chats.length, stack.service.streams.live, statuses]).toEqual([2, 2, [503, 503, 503]]);
    hold.open();
    expect((await Promise.all(answers)).filter((s) => s === 200)).toHaveLength(2);
    // The refused ones were never settled
    expect(await json(fetch(`${stack.url}/health`))).toMatchObject({ callsToday: 2 });
  }, 15_000);

  test("a provider that ignores max_tokens is cut at maxTokens, and its request is closed", async () => {
    const hold = gate();
    const provider = await fake({ reply: () => ({ steps: ["a", "b", "c", "d", "e", "f", hold, "g"] }) });
    const stack = await llmStack(provider);
    const url = `${stack.url}/v1/generate`;
    const first = (await json(stack.paidFetch(url, post({ prompt: "hi", maxTokens: 5 })))) as Answer;
    expect(first).toMatchObject({ index: 0, text: "ab", done: false });
    await vi.waitFor(() => expect(provider.aborted).toBe(1));
    expect(await json(stack.paidFetch(url, post({ stream: first.stream })))).toMatchObject({ index: 1, text: "cd" });
    expect(await json(stack.paidFetch(url, post({ stream: first.stream })))).toEqual({
      stream: first.stream,
      index: 2,
      text: "e",
      done: true,
      finishReason: "length",
    });
    hold.open();
  });

  test("a full registry refuses a new stream before payment", async () => {
    const hold = gate();
    const provider = await fake({ reply: () => ({ steps: ["a", "b", "c", hold] }) });
    const stack = await llmStack(provider, { config: { maxStreams: 1 } });
    const url = `${stack.url}/v1/generate`;
    await json(stack.paidFetch(url, post({ prompt: "one" })));
    const res = await stack.paidFetch(url, post({ prompt: "two" }));
    expect([res.status, await res.json()]).toEqual([503, { error: "too_many_streams" }]);
    expect(cumulative(stack)).toBe(500n);
    hold.open();
  });
});
