/**
 * An OpenAI-style embeddings provider on a local port, serving GET /v1/models and POST /v1/embeddings. Every request
 * is recorded, and each answer can be replaced to make the provider fail in a chosen way.
 */
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export const FAKE_MODEL = "nomic-embed-text";
/** What the fake provider reports for each input, unlike the service's own estimate */
export const TOKENS_PER_INPUT = 7;

export interface Recorded {
  method: string;
  path: string;
  authorization: string | undefined;
  body: unknown;
}

/** `drop` closes the connection without an answer */
export type Reply = { status?: number; json?: unknown; text?: string; drop?: true };

export interface FakeProvider {
  /** The OpenAI-style base URL, ending in /v1 */
  url: string;
  models: string[];
  /** Answers GET /v1/models, by default with the ids in `models` */
  list: () => Reply;
  /** Answers POST /v1/embeddings, by default with `honest` */
  embed: (inputs: string[]) => Reply;
  requests: Recorded[];
  embedRequests(): Recorded[];
  modelRequests(): Recorded[];
  close(): Promise<void>;
}

export interface FakeProviderOptions {
  /** When set, a request without this exact bearer token gets a 401 */
  apiKey?: string;
  models?: string[];
}

/** Four numbers that depend on the text, so that a test can tell which input a vector belongs to */
export function vectorFor(text: string): number[] {
  const points = [...text];
  const checksum = points.reduce((n, c) => (n * 31 + (c.codePointAt(0) ?? 0)) % 9973, 7);
  return [points.length, text.length, text.codePointAt(0) ?? 0, checksum].map((n) => n / 1000);
}

/** The answer of a working provider, with the items in reverse or the usage left out on request */
export function honest(inputs: string[], o: { shuffled?: boolean; usage?: boolean } = {}): Reply {
  const items = inputs.map((text, index) => ({ object: "embedding", index, embedding: vectorFor(text) }));
  const tokens = TOKENS_PER_INPUT * inputs.length;
  return {
    json: {
      object: "list",
      model: FAKE_MODEL,
      data: o.shuffled === true ? items.toReversed() : items,
      ...(o.usage !== false && { usage: { prompt_tokens: tokens, total_tokens: tokens } }),
    },
  };
}

function send(res: ServerResponse, reply: Reply): void {
  if (reply.drop === true) {
    res.socket?.destroy();
    return;
  }
  const status = reply.status ?? 200;
  if (reply.text !== undefined) {
    res.writeHead(status, { "content-type": "text/plain" }).end(reply.text);
    return;
  }
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(reply.json ?? {}));
}

function parse(text: string): unknown {
  try {
    return text === "" ? undefined : JSON.parse(text);
  } catch {
    return text;
  }
}

export async function startFakeProvider(o: FakeProviderOptions = {}): Promise<FakeProvider> {
  const fake: FakeProvider = {
    url: "",
    models: o.models ?? [`${FAKE_MODEL}:latest`],
    list: () => ({ json: { object: "list", data: fake.models.map((id) => ({ id, object: "model" })) } }),
    embed: (inputs) => honest(inputs),
    requests: [],
    embedRequests: () => fake.requests.filter((r) => r.method === "POST" && r.path === "/v1/embeddings"),
    modelRequests: () => fake.requests.filter((r) => r.method === "GET" && r.path === "/v1/models"),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = parse(Buffer.concat(chunks).toString("utf8"));
      const { method = "", url: path = "" } = req;
      fake.requests.push({ method, path, authorization: req.headers.authorization, body });

      if (o.apiKey !== undefined && req.headers.authorization !== `Bearer ${o.apiKey}`) {
        send(res, { status: 401, json: { error: { message: "Incorrect API key provided" } } });
      } else if (method === "GET" && path === "/v1/models") {
        send(res, fake.list());
      } else if (method === "POST" && path === "/v1/embeddings") {
        const input = (body as { input?: unknown } | undefined)?.input;
        const inputs = Array.isArray(input) ? (input as string[]) : [];
        send(res, fake.embed(inputs));
      } else {
        send(res, { status: 404, json: { error: { message: "not found" } } });
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  return fake;
}
