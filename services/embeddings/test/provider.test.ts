import { afterEach, describe, expect, test } from "vitest";
import { createOpenAiProvider, ProviderError } from "../src/index.js";
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

const fakes: FakeProvider[] = [];
afterEach(async () => {
  for (const f of fakes.splice(0)) await f.close();
});

/** A fake provider and a client for it, which sends `clientKey` (by default the key the fake wants) */
async function setup(o: FakeProviderOptions = {}, clientKey: string | undefined = o.apiKey) {
  const fake = await startFakeProvider(o);
  fakes.push(fake);
  return { fake, client: createOpenAiProvider({ baseUrl: fake.url, apiKey: clientKey, model: FAKE_MODEL }) };
}

const failureOf = (p: Promise<unknown>): Promise<unknown> => p.then(() => undefined, (e: unknown) => e);

describe("embed", () => {
  test("posts the model and the inputs, and returns the vectors with the usage", async () => {
    const { fake, client } = await setup();
    const result = await client.embed(["alpha", "beta"]);
    expect(result).toEqual({
      data: [
        { index: 0, embedding: vectorFor("alpha") },
        { index: 1, embedding: vectorFor("beta") },
      ],
      usage: { prompt_tokens: 2 * TOKENS_PER_INPUT, total_tokens: 2 * TOKENS_PER_INPUT },
    });
    expect(fake.embedRequests()).toHaveLength(1);
    expect(fake.embedRequests()[0]?.body).toEqual({ model: FAKE_MODEL, input: ["alpha", "beta"] });
  });

  test("sorts by index whatever order the provider lists the items in", async () => {
    const { fake, client } = await setup();
    fake.embed = (inputs) => honest(inputs, { shuffled: true });
    const { data } = await client.embed(["a", "bb", "ccc"]);
    expect(data.map((d) => d.index)).toEqual([0, 1, 2]);
    expect(data.map((d) => d.embedding)).toEqual([vectorFor("a"), vectorFor("bb"), vectorFor("ccc")]);
  });

  test("sends a bearer token only when a key is set", async () => {
    const keyed = await setup({ apiKey: "sk-test-key" });
    await keyed.client.embed(["x"]);
    await keyed.client.listModels();
    expect(keyed.fake.requests.map((r) => r.authorization)).toEqual(["Bearer sk-test-key", "Bearer sk-test-key"]);

    const open = await setup();
    await open.client.embed(["x"]);
    expect(open.fake.requests.map((r) => r.authorization)).toEqual([undefined]);
  });

  const vector = [{ index: 0, embedding: [1, 2] }];
  test.each<[string, unknown]>([
    ["no usage", undefined],
    ["a usage without a prompt count", { total_tokens: 3 }],
    ["a usage of zero tokens, which a provider that does not count reports", { prompt_tokens: 0, total_tokens: 0 }],
    ["a usage that is not a number", { prompt_tokens: "3" }],
    ["a usage that is not an object", 3],
  ])("leaves the usage out for %s", async (_name, usage) => {
    const { fake, client } = await setup();
    fake.embed = () => ({ json: { data: vector, usage } });
    expect(await client.embed(["x"])).toEqual({ data: vector });
  });

  test("takes the prompt count as the total when the provider gives none or less", async () => {
    const { fake, client } = await setup();
    fake.embed = () => ({ json: { data: vector, usage: { prompt_tokens: 4 } } });
    expect((await client.embed(["x"])).usage).toEqual({ prompt_tokens: 4, total_tokens: 4 });
    fake.embed = () => ({ json: { data: vector, usage: { prompt_tokens: 4, total_tokens: 2 } } });
    expect((await client.embed(["x"])).usage).toEqual({ prompt_tokens: 4, total_tokens: 4 });
  });

  const one = (item: unknown): Reply => ({ json: { data: [item] } });
  test.each<[string, Reply]>([
    ["an answer that is not JSON", { text: "<html>gateway</html>" }],
    ["an answer that is not an object", { json: [] }],
    ["no data", { json: { object: "list" } }],
    ["no items", { json: { data: [] } }],
    ["two items for one input", { json: { data: [...vector, { index: 1, embedding: [3, 4] }] } }],
    ["an item that is not an object", one("vector")],
    ["a missing index", one({ embedding: [1] })],
    ["a negative index", one({ index: -1, embedding: [1] })],
    ["an index out of range", one({ index: 1, embedding: [1] })],
    ["a fractional index", one({ index: 0.5, embedding: [1] })],
    ["an empty vector", one({ index: 0, embedding: [] })],
    ["a vector of strings", one({ index: 0, embedding: ["1", "2"] })],
    ["a vector that is a base64 string", one({ index: 0, embedding: "AAAAAA==" })],
  ])("rejects %s", async (_name, reply) => {
    const { fake, client } = await setup();
    fake.embed = () => reply;
    const failure = await failureOf(client.embed(["x"]));
    expect(failure).toBeInstanceOf(ProviderError);
    expect((failure as ProviderError).status).toBe(200);
  });

  test("rejects a repeated index and vectors of different lengths", async () => {
    const { fake, client } = await setup();
    fake.embed = () => ({
      json: {
        data: [
          { index: 0, embedding: [1] },
          { index: 0, embedding: [2] },
        ],
      },
    });
    await expect(client.embed(["a", "b"])).rejects.toThrow(/an index is missing, repeated or out of range/);

    fake.embed = () => ({
      json: {
        data: [
          { index: 0, embedding: [1, 2] },
          { index: 1, embedding: [3] },
        ],
      },
    });
    await expect(client.embed(["a", "b"])).rejects.toThrow(/the vectors differ in length/);
  });

  test("a failing status is a ProviderError that carries it and never quotes the provider's words", async () => {
    const { fake, client } = await setup();
    for (const status of [400, 429, 500, 503]) {
      fake.embed = () => ({ status, json: { error: { message: "detail sk-leaked" } } });
      const failure = await failureOf(client.embed(["x"]));
      expect(failure).toBeInstanceOf(ProviderError);
      expect((failure as ProviderError).status).toBe(status);
      expect((failure as ProviderError).message).toBe(`provider answered ${status}`);
    }
  });

  test("names the variable to check for a refused key and for a wrong URL", async () => {
    const { fake, client } = await setup({ apiKey: "right" }, "wrong");
    await expect(client.embed(["x"])).rejects.toThrow("provider answered 401 (check EMBEDDINGS_API_KEY)");
    const wrongUrl = createOpenAiProvider({ baseUrl: `${fake.url}/nope`, apiKey: "right", model: FAKE_MODEL });
    await expect(wrongUrl.embed(["x"])).rejects.toThrow("provider answered 404 (check EMBEDDINGS_BASE_URL)");
  });

  test("a provider that is not there is a ProviderError without a status", async () => {
    const { fake, client } = await setup();
    await fake.close();
    const failure = await failureOf(client.embed(["x"]));
    expect(failure).toBeInstanceOf(ProviderError);
    expect((failure as ProviderError).status).toBeUndefined();
    expect((failure as ProviderError).message).toBe("provider unreachable (ECONNREFUSED)");
  });

  test("a connection that drops without an answer is a ProviderError", async () => {
    const { fake, client } = await setup();
    fake.embed = () => ({ drop: true });
    const failure = await failureOf(client.embed(["x"]));
    expect(failure).toBeInstanceOf(ProviderError);
    expect((failure as ProviderError).status).toBeUndefined();
  });
});

describe("listModels", () => {
  test("returns the ids", async () => {
    const { fake, client } = await setup({ models: ["a", "b:latest"] });
    expect(await client.listModels()).toEqual(["a", "b:latest"]);
    expect(fake.modelRequests()).toHaveLength(1);
  });

  test("skips entries that have no id", async () => {
    const { fake, client } = await setup();
    fake.list = () => ({ json: { data: [{ id: "a" }, { object: "model" }, { id: 7 }, "x", { id: "b" }] } });
    expect(await client.listModels()).toEqual(["a", "b"]);
  });

  test.each<[string, Reply]>([
    ["an answer without a list", { json: { object: "list" } }],
    ["an answer that is not JSON", { text: "nope" }],
  ])("rejects %s", async (_name, reply) => {
    const { fake, client } = await setup();
    fake.list = () => reply;
    const failure = await failureOf(client.listModels());
    expect(failure).toBeInstanceOf(ProviderError);
    expect((failure as ProviderError).status).toBe(200);
  });

  test("a failing status is a ProviderError that carries it", async () => {
    const { client } = await setup({ apiKey: "right" }, "wrong");
    const failure = await failureOf(client.listModels());
    expect(failure).toBeInstanceOf(ProviderError);
    expect((failure as ProviderError).status).toBe(401);
  });
});
