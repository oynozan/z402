import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
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
const servers: Server[] = [];
afterEach(async () => {
  for (const f of fakes.splice(0)) await f.close();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
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
    ["a usage with a fraction", { prompt_tokens: 2.5, total_tokens: 2.5 }],
    ["a usage too big to be a count", { prompt_tokens: 1e300, total_tokens: 1e300 }],
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
    ["a vector with NaN in it, which is not JSON", { text: '{"data":[{"index":0,"embedding":[1,NaN]}]}' }],
    ["a vector with a number too big for a double", { text: '{"data":[{"index":0,"embedding":[1,1e999]}]}' }],
    ["a vector with null in it", one({ index: 0, embedding: [1, null] })],
    ["a vector with a boolean in it", one({ index: 0, embedding: [1, true] })],
    ["an index written as text", one({ index: "0", embedding: [1] })],
    ["an index too big to be a count", one({ index: 1e300, embedding: [1] })],
    ["an item without a vector", one({ index: 0 })],
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

/** A provider that answers 200 and then writes filler for as long as the client reads, up to `total` bytes */
async function flood(total: number, o: { declare?: number } = {}) {
  let written = 0;
  const server = createServer((req, res) => {
    req.resume();
    res.writeHead(200, {
      "content-type": "application/json",
      ...(o.declare !== undefined && { "content-length": String(o.declare) }),
    });
    const chunk = "0,".repeat(32 * 1024);
    const pump = (): void => {
      while (!res.destroyed && written < total) {
        written += chunk.length;
        if (!res.write(chunk)) {
          res.once("drain", pump);
          return;
        }
      }
      if (!res.destroyed && o.declare === undefined) res.end();
    };
    pump();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  return { url, written: () => written, client: createOpenAiProvider({ baseUrl: url, apiKey: undefined, model: FAKE_MODEL }) };
}

describe("a provider that sends more than an answer can hold", () => {
  const total = 256 * 1024 * 1024;

  test("embed stops reading once the answer is larger than vectors for the inputs can be", async () => {
    const provider = await flood(total);
    const failure = await failureOf(provider.client.embed(["x"]));
    expect(failure).toBeInstanceOf(ProviderError);
    expect((failure as ProviderError).message).toBe("provider answer is larger than 1.3 MiB");
    expect((failure as ProviderError).status).toBe(200);
    expect(provider.written()).toBeLessThan(total / 4);
  });

  test("the size an answer may have grows with the number of inputs", async () => {
    const { fake, client } = await setup();
    const dimensions = 3072;
    const inputs = Array.from({ length: 64 }, (_, i) => `text ${i}`);
    fake.embed = () => ({
      json: { data: inputs.map((_, index) => ({ index, embedding: Array.from({ length: dimensions }, (_v, i) => (i + index) / 7) })) },
    });
    const result = await client.embed(inputs);
    expect(result.data).toHaveLength(64);
    expect(result.data[63]?.embedding).toHaveLength(dimensions);
  });

  test("listModels stops reading once the list is larger than 8 MiB", async () => {
    const provider = await flood(total);
    const failure = await failureOf(provider.client.listModels());
    expect(failure).toBeInstanceOf(ProviderError);
    expect((failure as ProviderError).message).toBe("provider answer is larger than 8 MiB");
    expect(provider.written()).toBeLessThan(total / 4);
  });

  test("an answer that declares more than it may have is refused without waiting for it", async () => {
    const provider = await flood(1024, { declare: 200 * 1024 * 1024 });
    const started = performance.now();
    const failure = await failureOf(provider.client.embed(["x"]));
    expect(failure).toBeInstanceOf(ProviderError);
    expect((failure as ProviderError).message).toBe("provider answer is larger than 1.3 MiB");
    expect(performance.now() - started).toBeLessThan(2000);
  });

  test("an error status is not read at all", async () => {
    const failing = createServer((req, res) => {
      req.resume();
      res.writeHead(500, { "content-type": "text/plain" });
      const timer = setInterval(() => res.write("x".repeat(65536)), 1);
      res.on("close", () => clearInterval(timer));
    });
    servers.push(failing);
    await new Promise<void>((resolve) => failing.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(failing.address() as AddressInfo).port}/v1`;
    const client = createOpenAiProvider({ baseUrl: url, apiKey: undefined, model: FAKE_MODEL });
    const started = performance.now();
    const failure = await failureOf(client.embed(["x"]));
    expect((failure as ProviderError).message).toBe("provider answered 500");
    expect(performance.now() - started).toBeLessThan(2000);
  });
});
