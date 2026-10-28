import { validateDiscoveryExtension, type DiscoveryExtension } from "@x402/extensions/bazaar";
import { PROBE_HEADER } from "@z402/service-kit";
import { startTestStack, TEST_PAY_TO, TEST_PUBLIC_URL, type TestStack } from "@z402/service-kit/testing";
import { afterEach, describe, expect, test, vi } from "vitest";
import { loadEmbeddingsConfig, type EmbeddingsConfig } from "../src/index.js";
import { createEmbeddingsService } from "../src/service.js";
import {
  FAKE_MODEL,
  honest,
  startFakeProvider,
  TOKENS_PER_INPUT,
  vectorFor,
  type FakeProvider,
  type FakeProviderOptions,
  type Reply,
} from "./fake-provider.js";

const stacks: TestStack[] = [];
const fakes: FakeProvider[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const s of stacks.splice(0)) await s.close();
  for (const f of fakes.splice(0)) await f.close();
});

interface Harness {
  stack: TestStack;
  fake: FakeProvider;
  logs: string[];
  url: string;
}

async function harness(o: { fake?: FakeProviderOptions; config?: Partial<EmbeddingsConfig> } = {}): Promise<Harness> {
  const fake = await startFakeProvider(o.fake);
  fakes.push(fake);
  const config = {
    ...loadEmbeddingsConfig({ EMBEDDINGS_BASE_URL: fake.url, EMBEDDINGS_API_KEY: o.fake?.apiKey }),
    ...o.config,
  };
  const logs: string[] = [];
  const stack = await startTestStack({
    build: (env) => createEmbeddingsService({ env, config, log: (line) => logs.push(line) }),
  });
  stacks.push(stack);
  return { stack, fake, logs, url: `${stack.url}/v1/embeddings` };
}

const post = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const raw = (body: string, contentType = "application/json"): RequestInit => ({
  method: "POST",
  headers: { "content-type": contentType },
  body,
});

/** A JSON escape for one UTF-16 code unit, written out the way a client that escapes everything writes it */
const unitEscape = (unit: number): string => `\\u${unit.toString(16).padStart(4, "0")}`;
const escapeAll = (text: string): string => Array.from({ length: text.length }, (_, i) => unitEscape(text.charCodeAt(i))).join("");

/** No deposit and no voucher, so the client never paid for this service */
const unpaid = (h: Harness): boolean => h.stack.scheme.session(TEST_PAY_TO) === undefined;

interface PaymentRequired {
  resource: Record<string, unknown>;
  accepts: Record<string, unknown>[];
  extensions: Record<string, unknown>;
}

function decodeHeader(value: string | null): PaymentRequired {
  return JSON.parse(Buffer.from(value ?? "", "base64").toString("utf8")) as PaymentRequired;
}

describe("the 402", () => {
  test("declares the route for discovery", async () => {
    const h = await harness();
    const res = await fetch(h.url, post({ input: "hello" }));
    expect(res.status).toBe(402);
    const required = decodeHeader(res.headers.get("payment-required"));
    expect(required.resource).toMatchObject({
      url: `${TEST_PUBLIC_URL}/v1/embeddings`,
      description: "Embeds up to about 1,000 tokens of text per paid call (OpenAI-style request and answer).",
      mimeType: "application/json",
      serviceName: "Text embeddings",
      tags: ["embeddings", "vectors", "rag"],
    });
    expect(required.accepts[0]).toMatchObject({
      scheme: "prepaid-voucher",
      amount: "500",
      asset: "ZEC",
      payTo: TEST_PAY_TO,
    });
    expect(required.extensions.z402).toEqual({ unit: "1k tokens", note: "About 1,000 tokens per call." });

    const bazaar = required.extensions.bazaar as DiscoveryExtension;
    expect(validateDiscoveryExtension(bazaar)).toEqual({ valid: true });
    expect(bazaar).toMatchObject({
      info: {
        input: { type: "http", method: "POST", bodyType: "json", body: { input: ["The quick brown fox"] } },
        output: {
          type: "json",
          example: {
            object: "list",
            model: "nomic-embed-text",
            dimensions: 3,
            data: [{ object: "embedding", index: 0, embedding: Array.from({ length: 3 }, () => expect.any(Number)) }],
            usage: { prompt_tokens: expect.any(Number), total_tokens: expect.any(Number) },
          },
        },
      },
    });
  });

  test("states the limits of the configuration in the input schema", async () => {
    const h = await harness({ config: { maxInputs: 8, maxChars: 1234 } });
    const res = await fetch(h.url, post({ input: "hello" }));
    const bazaar = decodeHeader(res.headers.get("payment-required")).extensions.bazaar as DiscoveryExtension;
    expect(bazaar).toMatchObject({
      schema: {
        properties: {
          input: {
            properties: {
              body: {
                type: "object",
                required: ["input"],
                properties: {
                  input: {
                    description: expect.stringMatching(/up to 8 strings.*at most 1234 characters/),
                    oneOf: [
                      { type: "string", minLength: 1, maxLength: 1234 },
                      { type: "array", minItems: 1, maxItems: 8, items: { type: "string", minLength: 1, maxLength: 1234 } },
                    ],
                  },
                },
              },
            },
          },
        },
      },
    });
  });

  test("states the cap on one string in the schema, where it is the lower one", async () => {
    const h = await harness({ config: { maxInputs: 8, maxChars: 4000, maxInputChars: 500 } });
    const res = await fetch(h.url, post({ input: "hello" }));
    const bazaar = decodeHeader(res.headers.get("payment-required")).extensions.bazaar as DiscoveryExtension;
    const schema = bazaar.schema as unknown as { properties: { input: { properties: { body: { properties: { input: unknown } } } } } };
    const input = schema.properties.input.properties.body.properties.input;
    expect(input).toMatchObject({
      description: expect.stringMatching(/at most 4000 characters in total, at most 500 per string/),
      oneOf: [
        { type: "string", minLength: 1, maxLength: 500 },
        { type: "array", items: { type: "string", minLength: 1, maxLength: 500 } },
      ],
    });
  });

  test("a discovery probe gets it without a body, and a request that carries a payment is still checked", async () => {
    const h = await harness();
    const probe = await fetch(h.url, { method: "POST", headers: { [PROBE_HEADER]: "1" } });
    expect(probe.status).toBe(402);
    const headers = { [PROBE_HEADER]: "1", "payment-signature": "e30=" };
    const disguised = await fetch(h.url, { method: "POST", headers });
    expect(disguised.status).toBe(400);
    expect(h.fake.embedRequests()).toHaveLength(0);
  });

  test.each(["/v1/embeddings/", "/V1/Embeddings", "/v1/embeddings//", "/v1/embeddings?free=1"])(
    "%s does not skip payment",
    async (path) => {
      const h = await harness();
      const res = await fetch(`${h.stack.url}${path}`, post({ input: "free?" }));
      expect(res.status).toBe(402);
      expect(h.fake.embedRequests()).toHaveLength(0);
    },
  );
});

describe("a paid call", () => {
  test("embeds one string", async () => {
    const h = await harness();
    const res = await h.stack.paidFetch(h.url, post({ input: "hello world" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("payment-response")).toBeTruthy();
    expect(await res.json()).toEqual({
      object: "list",
      model: FAKE_MODEL,
      dimensions: 4,
      data: [{ object: "embedding", index: 0, embedding: vectorFor("hello world") }],
      usage: { prompt_tokens: TOKENS_PER_INPUT, total_tokens: TOKENS_PER_INPUT },
    });
    expect(h.fake.embedRequests().map((r) => r.body)).toEqual([{ model: FAKE_MODEL, input: ["hello world"] }]);
    expect(h.stack.scheme.session(TEST_PAY_TO)?.cumulativeZat).toBe(500n);
  });

  test("embeds an array, one vector for each string in the order of the inputs", async () => {
    const h = await harness();
    const inputs = ["first", "second one", "third", "ünïcödé 😀"];
    const res = await h.stack.paidFetch(h.url, post({ input: inputs }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { dimensions: number; data: unknown[] };
    expect(body.dimensions).toBe(4);
    const expected = inputs.map((text, index) => ({ object: "embedding", index, embedding: vectorFor(text) }));
    expect(body.data).toEqual(expected);
    expect(h.fake.embedRequests().map((r) => r.body)).toEqual([{ model: FAKE_MODEL, input: inputs }]);
  });

  test("two calls in a row are two payments, counted once each", async () => {
    const h = await harness();
    expect((await h.stack.paidFetch(h.url, post({ input: "one" }))).status).toBe(200);
    expect((await h.stack.paidFetch(h.url, post({ input: ["two", "three"] }))).status).toBe(200);
    expect(h.stack.scheme.session(TEST_PAY_TO)?.cumulativeZat).toBe(1000n);
    const health = await fetch(`${h.stack.url}/health`);
    expect(await health.json()).toMatchObject({ ok: true, ready: true, service: "Text embeddings", callsToday: 2 });
  });

  test("keeps the index order and the dimensions when the provider lists the items the other way round", async () => {
    const h = await harness();
    h.fake.embed = (inputs) => honest(inputs, { shuffled: true });
    const inputs = ["a", "bb", "ccc"];
    const res = await h.stack.paidFetch(h.url, post({ input: inputs }));
    const body = (await res.json()) as { dimensions: number; data: { index: number; embedding: number[] }[] };
    expect(body.data.map((d) => d.index)).toEqual([0, 1, 2]);
    expect(body.data.map((d) => d.embedding)).toEqual(inputs.map(vectorFor));
    expect(body.dimensions).toBe(body.data[0]?.embedding.length);
  });

  test("reports the usage of the provider as it is", async () => {
    const h = await harness();
    const res = await h.stack.paidFetch(h.url, post({ input: ["a", "b", "c"] }));
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.usage).toEqual({ prompt_tokens: 3 * TOKENS_PER_INPUT, total_tokens: 3 * TOKENS_PER_INPUT });
    expect(body).not.toHaveProperty("usageEstimated");
  });

  test("estimates the usage and says so when the provider reports none", async () => {
    const h = await harness();
    h.fake.embed = (inputs) => honest(inputs, { usage: false });
    // 5, 4 and 5 characters are 2, 1 and 2 tokens at four characters each
    const res = await h.stack.paidFetch(h.url, post({ input: ["alpha", "beta", "gamma"] }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.usage).toEqual({ prompt_tokens: 5, total_tokens: 5 });
    expect(body.usageEstimated).toBe(true);
  });

  test("ignores the fields it does not know, even one nested 20,000 levels deep, and sends only the model and the inputs", async () => {
    const h = await harness();
    const deep = `{"a":`.repeat(20_000) + "1" + "}".repeat(20_000);
    const res = await h.stack.paidFetch(h.url, raw(`{"input":["a"],"model":"another","dimensions":2,"user":"u","x":${deep}}`));
    expect(res.status).toBe(200);
    expect(h.fake.embedRequests().map((r) => r.body)).toEqual([{ model: FAKE_MODEL, input: ["a"] }]);
  });

  test("sends the key to the provider when one is set", async () => {
    const h = await harness({ fake: { apiKey: "sk-test-key" } });
    const res = await h.stack.paidFetch(h.url, post({ input: "hello" }));
    expect(res.status).toBe(200);
    expect(h.fake.requests.every((r) => r.authorization === "Bearer sk-test-key")).toBe(true);
  });
});

describe("length", () => {
  test("the cap is on the total, counted in code points, and a call at the cap is served", async () => {
    const h = await harness();
    const atCap = await h.stack.paidFetch(h.url, post({ input: "a".repeat(4000) }));
    expect(atCap.status).toBe(200);
    const emoji = await h.stack.paidFetch(h.url, post({ input: ["😀".repeat(2000), "🎉".repeat(2000)] }));
    expect(emoji.status).toBe(200);
    expect(h.fake.embedRequests()).toHaveLength(2);
    expect(h.stack.scheme.session(TEST_PAY_TO)?.cumulativeZat).toBe(1000n);
  });

  test.each([
    ["one string over the cap", { input: "a".repeat(4001) }],
    ["inputs that add up to more than the cap", { input: ["a".repeat(2000), "b".repeat(2001)] }],
    ["emoji, which are two UTF-16 units each but one code point", { input: "😀".repeat(4001) }],
    ["a body past the 256 kB the parser reads", { input: "a".repeat(300_000) }],
  ])("%s is refused with a 413 before payment", async (_name, body) => {
    const h = await harness();
    const res = await h.stack.paidFetch(h.url, post(body));
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "too_many_tokens", maxChars: 4000 });
    expect(unpaid(h)).toBe(true);
    expect(h.fake.embedRequests()).toHaveLength(0);
  });

  test("a call at a large cap is served when a client writes every character as an escape, which is how Python writes JSON", async () => {
    const h = await harness({ config: { maxChars: 60_000 } });
    const emoji = escapeAll("\u{1f600}".repeat(30_000));
    expect(emoji.length).toBe(360_000);
    const astral = await h.stack.paidFetch(h.url, raw(`{"input":"${emoji}"}`));
    expect(astral.status).toBe(200);

    const cjk = await h.stack.paidFetch(h.url, raw(`{"input":"${escapeAll("\u6f22".repeat(60_000))}"}`));
    expect(cjk.status).toBe(200);
    expect(h.fake.embedRequests()).toHaveLength(2);
  });

  test("the body limit follows the cap, and a body past what the cap allows is still refused", async () => {
    const h = await harness({ config: { maxChars: 60_000 } });
    const res = await h.stack.paidFetch(h.url, post({ input: "a".repeat(1_000_000) }));
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "too_many_tokens", maxChars: 60000 });
    expect(unpaid(h)).toBe(true);
  });

  test("the cap follows the configuration", async () => {
    const h = await harness({ config: { maxChars: 10 } });
    const over = await h.stack.paidFetch(h.url, post({ input: ["12345", "678901"] }));
    expect(over.status).toBe(413);
    expect(await over.json()).toEqual({ error: "too_many_tokens", maxChars: 10 });
    expect(unpaid(h)).toBe(true);
    const at = await h.stack.paidFetch(h.url, post({ input: ["12345", "67890"] }));
    expect(at.status).toBe(200);
  });

  test("a per-string cap refuses one long string before payment and still serves the total", async () => {
    const h = await harness({ config: { maxChars: 10, maxInputChars: 5 } });
    const long = await h.stack.paidFetch(h.url, post({ input: ["123456"] }));
    expect(long.status).toBe(413);
    expect(await long.json()).toEqual({ error: "too_many_tokens", maxChars: 10, maxInputChars: 5 });
    expect(unpaid(h)).toBe(true);
    const split = await h.stack.paidFetch(h.url, post({ input: ["12345", "67890"] }));
    expect(split.status).toBe(200);
  });
});

describe("an invalid request", () => {
  const cases: [string, RequestInit][] = [
    ["a body that is not JSON", raw("{nope")],
    ["a truncated body", raw('{"input": ["a", ')],
    ["an empty body", { method: "POST", headers: { "content-type": "application/json" } }],
    ["a body in another content type", raw('{"input": "hi"}', "text/plain")],
    ["a JSON string", post("hello")],
    ["a JSON array", post(["hello"])],
    ["null", post(null)],
    ["no input", post({})],
    ["a number as input", post({ input: 42 })],
    ["an object as input", post({ input: { text: "hi" } })],
    ["an empty string", post({ input: "" })],
    ["a blank string", post({ input: " \n\t " })],
    ["an empty array", post({ input: [] })],
    ["65 strings", post({ input: Array.from({ length: 65 }, () => "x") })],
    ["a number among the strings", post({ input: ["ok", 7] })],
    ["token ids", post({ input: [[1, 2, 3]] })],
    ["an empty string among the strings", post({ input: ["ok", "", "fine"] })],
    ["a blank string among the strings", post({ input: ["ok", "  "] })],
    ["objects among the strings", post({ input: [{ text: "a" }] })],
    ["null among the strings", post({ input: ["ok", null] })],
    ["true as input", post({ input: true })],
    ["null as input", post({ input: null })],
    ["a number too big for a double as input", raw('{"input":1e999}')],
    ["NaN as input, which is not JSON", raw('{"input":NaN}')],
    ["a string with a trailing comma", raw('{"input":["a",]}')],
    ["60,000 strings, which fit the body limit and not the limit on strings", raw(`{"input":[${Array(60_000).fill('"a"').join(",")}]}`)],
    ["arrays nested 100,000 levels deep", raw(`{"input":${"[".repeat(100_000)}${"]".repeat(100_000)}}`)],
  ];

  test.each(cases)("%s is refused with a 400 before payment", async (_name, init) => {
    const h = await harness();
    const res = await h.stack.paidFetch(h.url, init);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("invalid_request");
    expect(body.message).toEqual(expect.any(String));
    expect(unpaid(h)).toBe(true);
    expect(h.fake.embedRequests()).toHaveLength(0);
  });

  describe("text no provider can parse", () => {
    const high = unitEscape(0xd800);
    const low = unitEscape(0xdc00);
    const pair = `${unitEscape(0xd83d)}${unitEscape(0xde00)}`;
    const refused: [string, string, string][] = [
      ["a lone high surrogate", `{"input":"abc${high}def"}`, "input must be valid Unicode text, with no unpaired surrogate"],
      ["a lone low surrogate", `{"input":"${low}"}`, "input must be valid Unicode text, with no unpaired surrogate"],
      ["a high surrogate at the end", `{"input":"abc${high}"}`, "input must be valid Unicode text, with no unpaired surrogate"],
      ["a pair written the wrong way round", `{"input":"${low}${high}"}`, "input must be valid Unicode text, with no unpaired surrogate"],
      ["a lone surrogate in the second string", `{"input":["fine","a${high}"]}`, "input[1] must be valid Unicode text, with no unpaired surrogate"],
      ["a pair split over two strings", `{"input":["${unitEscape(0xd83d)}","${unitEscape(0xde00)}"]}`, "input[0] must be valid Unicode text, with no unpaired surrogate"],
    ];

    test.each(refused)("%s is refused with a 400 before payment", async (_name, body, message) => {
      const h = await harness();
      const res = await h.stack.paidFetch(h.url, raw(body));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_request", message });
      expect(unpaid(h)).toBe(true);
      expect(h.fake.embedRequests()).toHaveLength(0);
    });

    test("a surrogate pair, which is one character, is served and sent on as the emoji", async () => {
      const h = await harness();
      const res = await h.stack.paidFetch(h.url, raw(`{"input":["a${pair}b"]}`));
      expect(res.status).toBe(200);
      expect(h.fake.embedRequests().map((r) => r.body)).toEqual([{ model: FAKE_MODEL, input: ["a\u{1f600}b"] }]);
    });

    test("is refused before the cap on characters is even looked at", async () => {
      const h = await harness({ config: { maxChars: 3 } });
      const res = await h.stack.paidFetch(h.url, raw(`{"input":"${high}${high}${high}${high}"}`));
      expect(res.status).toBe(400);
    });
  });

  test("the message names what is wrong", async () => {
    const h = await harness();
    const message = async (init: RequestInit): Promise<string> =>
      ((await (await fetch(h.url, init)).json()) as { message: string }).message;
    expect(await message(raw("{nope"))).toBe("the body is not valid JSON");
    const object = "send a JSON object with an input field (Content-Type: application/json)";
    expect(await message(post("hello"))).toBe(object);
    expect(await message(raw('{"input": "hi"}', "text/plain"))).toBe(object);
    expect(await message(post({ input: ["ok", "  "] }))).toBe("input[1] must be a string that is not blank");
    expect(await message(post({ input: ["ok", 7] }))).toBe("input[1] must be a string that is not blank");
    expect(await message(post({ input: [] }))).toBe("input must hold 1 to 64 strings");
    expect(await message(post({ input: 42 }))).toBe("input must be a string or an array of strings");
    expect(await message(post({ input: "" }))).toBe("input must not be blank");
    expect(await message(post({ input: " \n" }))).toBe("input must not be blank");
  });

  test("64 strings are served", async () => {
    const h = await harness();
    const res = await h.stack.paidFetch(h.url, post({ input: Array.from({ length: 64 }, (_, i) => `text ${i}`) }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: unknown[] }).data).toHaveLength(64);
  });

  test("the number of strings follows the configuration", async () => {
    const h = await harness({ config: { maxInputs: 2 } });
    const res = await h.stack.paidFetch(h.url, post({ input: ["a", "b", "c"] }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toBe("input must hold 1 to 2 strings");
    expect(unpaid(h)).toBe(true);
  });

  test("a wrong method is refused before payment", async () => {
    const h = await harness();
    const res = await h.stack.paidFetch(h.url);
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
    expect(unpaid(h)).toBe(true);
  });
});

describe("readiness", () => {
  test("a provider that does not list the model makes the route 503 before payment", async () => {
    const h = await harness({ fake: { models: ["some-other-model"] } });
    const res = await h.stack.paidFetch(h.url, post({ input: "hello" }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "not_ready" });
    expect(unpaid(h)).toBe(true);
    expect(h.fake.embedRequests()).toHaveLength(0);

    const health = await fetch(`${h.stack.url}/health`);
    expect(health.status).toBe(503);
    expect(await health.json()).toMatchObject({ ok: true, ready: false });
    expect(h.logs).toEqual([`embeddings: not ready, the provider does not list ${FAKE_MODEL}`]);
  });

  test("a provider that is down makes the route 503 before payment", async () => {
    const h = await harness();
    await h.fake.close();
    const res = await h.stack.paidFetch(h.url, post({ input: "hello" }));
    expect(res.status).toBe(503);
    expect(unpaid(h)).toBe(true);
    expect(h.logs).toEqual(["embeddings: not ready, provider unreachable (ECONNREFUSED)"]);
  });

  test("a provider that refuses the key makes the route 503 and the log names the variable", async () => {
    const h = await harness({ fake: { apiKey: "sk-right" }, config: { apiKey: "sk-wrong" } });
    const res = await h.stack.paidFetch(h.url, post({ input: "hello" }));
    expect(res.status).toBe(503);
    expect(h.logs).toEqual(["embeddings: not ready, provider answered 401 (check EMBEDDINGS_API_KEY)"]);
    expect(h.logs.join("\n")).not.toContain("sk-");
  });

  test.each([
    ["the provider lists the tagged name", FAKE_MODEL, [`${FAKE_MODEL}:latest`], 200],
    ["the provider lists the bare name of a tagged model", `${FAKE_MODEL}:latest`, [FAKE_MODEL], 200],
    ["the names are the same", FAKE_MODEL, [FAKE_MODEL], 200],
    ["only another tag is listed", FAKE_MODEL, [`${FAKE_MODEL}:v1.5`], 503],
    ["only a model that starts with the name is listed", FAKE_MODEL, [`${FAKE_MODEL}-large`], 503],
    ["nothing is listed", FAKE_MODEL, [], 503],
  ])("%s", async (_name, model, models, status) => {
    const h = await harness({ fake: { models }, config: { model } });
    expect((await fetch(`${h.stack.url}/health`)).status).toBe(status);
  });

  test("the model list is asked for at most every 10 seconds, and again after that", async () => {
    const h = await harness();
    const base = Date.now();
    vi.useFakeTimers({ toFake: ["Date"], now: base });
    const health = async (secondsLater: number): Promise<number> => {
      vi.setSystemTime(base + secondsLater * 1000);
      return (await fetch(`${h.stack.url}/health`)).status;
    };

    expect(await health(0)).toBe(200);
    expect(h.fake.modelRequests()).toHaveLength(1);
    // The kit's own cache of 5 s has run out here, so the 10 s cache of the service is what answers
    expect(await health(6)).toBe(200);
    expect(await health(9)).toBe(200);
    expect(h.fake.modelRequests()).toHaveLength(1);

    h.fake.models = ["gone"];
    expect(await health(12)).toBe(503);
    expect(h.fake.modelRequests()).toHaveLength(2);
    expect(h.logs).toEqual([
      `embeddings: provider ready, it lists ${FAKE_MODEL}`,
      `embeddings: not ready, the provider does not list ${FAKE_MODEL}`,
    ]);

    h.fake.models = [FAKE_MODEL];
    expect(await health(30)).toBe(200);
    expect(h.logs).toHaveLength(3);
  });
});

describe("a provider that fails after payment", () => {
  const failures: [string, Reply][] = [
    ["answers 500", { status: 500, json: { error: { message: "model crashed" } } }],
    ["answers 429", { status: 429, json: { error: { message: "rate limited" } } }],
    ["answers something that is not JSON", { text: "<html>bad gateway</html>" }],
    ["answers vectors the service cannot use", { json: { data: [{ index: 3, embedding: [1] }] } }],
    ["closes the connection", { drop: true }],
  ];

  test.each(failures)("%s, which gives a 502 and nothing else", async (_name, reply) => {
    const h = await harness({ fake: { apiKey: "sk-secret-key" } });
    h.fake.embed = () => reply;
    const res = await h.stack.paidFetch(h.url, post({ input: "hello" }));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "provider_failed" });
    expect(h.fake.embedRequests()).toHaveLength(1);
    // The voucher was sent before the provider was asked, which is what the checks before payment exist for
    expect(h.stack.scheme.session(TEST_PAY_TO)?.cumulativeZat).toBe(500n);

    const failedLines = h.logs.filter((l) => l.startsWith("embeddings: the provider failed after payment"));
    expect(failedLines).toHaveLength(1);
    expect(h.logs.join("\n")).not.toContain("sk-secret-key");
    expect(h.logs.join("\n")).not.toContain("model crashed");
    // A failed call is not a delivered one
    expect(await (await fetch(`${h.stack.url}/health`)).json()).toMatchObject({ callsToday: 0 });
  });

  test("the next call is served once the provider is back", async () => {
    const h = await harness();
    h.fake.embed = () => ({ status: 500 });
    expect((await h.stack.paidFetch(h.url, post({ input: "one" }))).status).toBe(502);
    h.fake.embed = (inputs) => honest(inputs);
    const res = await h.stack.paidFetch(h.url, post({ input: "two" }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { embedding: number[] }[] }).data[0]?.embedding).toEqual(vectorFor("two"));
  });
});
