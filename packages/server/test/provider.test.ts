import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { inspect } from "node:util";
import { gzipSync } from "node:zlib";
import { NETWORK_REGTEST, NETWORK_TESTNET } from "@z402-net/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkProvider, ProviderCheckError } from "../src/index.js";

const NETWORK = NETWORK_REGTEST;
const PAY_TO = `uregtest1${"q".repeat(60)}`;
const OTHER_PAY_TO = `uregtest1${"p".repeat(60)}`;
const TOKEN = "z402_k3y-s3cret-0123456789abcdef";
const FACILITATOR = "http://facilitator.test:4022";
/** What the facilitator answers to the operator, whose providerId packages/facilitator/test/app.test.ts pins */
const ME = { providerId: "f93eeecbf393ea04", network: NETWORK, payTo: PAY_TO };

type Options = Parameters<typeof checkProvider>[0];
/** The type of fetch, which a test that names a variable `fetch` cannot spell */
type Fetch = typeof fetch;

const base: Options = { facilitatorUrl: FACILITATOR, token: TOKEN, payTo: PAY_TO, network: NETWORK };
/** What the message says of an answer that cannot be read, after the facilitator is named */
const UNREADABLE = "answered /providers/me with a body that is not {providerId, network, payTo}";

afterEach(() => {
  vi.restoreAllMocks();
});

/** A fetch that gives each request a fresh response, since a body can be read only once */
const answering = (answer: () => Response) => vi.fn<Fetch>(async () => answer());
const reply = (status: number, body?: string) => () => new Response(body ?? null, { status });
const replyJson = (status: number, body: unknown) => reply(status, JSON.stringify(body));

/** A fetch that never answers until its signal aborts, as one waiting on a facilitator that hangs */
const hanging = () =>
  vi.fn<Fetch>(
    (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal) signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
  );

/** A 200 over `chunks` chunks of `size` spaces, pulled one at a time, with a count of the pulls and of the cancel */
function spaces(size: number, chunks: number, headers?: Record<string, string>) {
  const seen = { pulls: 0, cancelled: false };
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        seen.pulls += 1;
        if (seen.pulls > chunks) controller.close();
        else controller.enqueue(new Uint8Array(size).fill(0x20));
      },
      cancel() {
        seen.cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { seen, fetch: vi.fn<Fetch>(async () => new Response(body, { status: 200, headers })) };
}

/** The error a failed check throws, after the checks that every one of them must pass */
async function refused(over: Partial<Options>, secret?: string): Promise<ProviderCheckError> {
  const err: unknown = await checkProvider({ ...base, ...over }).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ProviderCheckError);
  const error = err as ProviderCheckError;
  expect(error.message.startsWith(`${error.field}: `)).toBe(true);
  // The whole error as a logger would print it, which is the message, the stack, the cause and every field
  const printed = inspect(error, { depth: 10 });
  for (const leak of secret === undefined ? [TOKEN] : [TOKEN, secret]) expect(printed).not.toContain(leak);
  return error;
}

describe("ProviderCheckError", () => {
  it("is an Error that says which setting to fix and whether waiting could help", () => {
    const e = new ProviderCheckError("payTo", false, "the key is for another address");
    expect(e).toBeInstanceOf(Error);
    expect(e).toMatchObject({
      name: "ProviderCheckError",
      field: "payTo",
      retryable: false,
      message: "payTo: the key is for another address",
    });
  });
});

describe("checkProvider", () => {
  describe("a facilitator that knows the key", () => {
    it("resolves when the key's provider has this payTo and network", async () => {
      await expect(checkProvider({ ...base, fetch: answering(replyJson(200, ME)) })).resolves.toBeUndefined();
    });

    it("accepts an answer with more fields than the three it reads", async () => {
      const fetch = answering(replyJson(200, { ...ME, createdAt: "2026-10-28T00:00:00Z" }));
      await expect(checkProvider({ ...base, fetch })).resolves.toBeUndefined();
    });

    it("sends GET <url>/providers/me with the key as a bearer token", async () => {
      const fetch = answering(replyJson(200, ME));
      await checkProvider({ ...base, fetch });
      expect(fetch).toHaveBeenCalledTimes(1);
      const [url, init] = fetch.mock.calls[0] ?? [];
      expect(url).toBe(`${FACILITATOR}/providers/me`);
      expect(init?.method ?? "GET").toBe("GET");
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
    });

    it("sends no Authorization header when it has no token", async () => {
      const fetch = answering(replyJson(200, ME));
      await checkProvider({ ...base, token: undefined, fetch });
      const [, init] = fetch.mock.calls[0] ?? [];
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
    });

    it.each([
      ["http://f.test:4022/", "http://f.test:4022/providers/me"],
      ["http://f.test:4022///", "http://f.test:4022/providers/me"],
      ["https://f.test/z402/", "https://f.test/z402/providers/me"],
      ["https://f.test/z402", "https://f.test/z402/providers/me"],
    ])("builds the route from %s without trailing slashes", async (facilitatorUrl, route) => {
      const fetch = answering(replyJson(200, ME));
      await checkProvider({ ...base, facilitatorUrl, fetch });
      expect(fetch.mock.calls[0]?.[0]).toBe(route);
    });

    it("gives the request 5000 ms by default and timeoutMs when it is given", async () => {
      const timeout = vi.spyOn(AbortSignal, "timeout");
      const fetch = answering(replyJson(200, ME));
      await checkProvider({ ...base, fetch });
      await checkProvider({ ...base, fetch, timeoutMs: 1234 });
      expect(timeout.mock.calls).toEqual([[5000], [1234]]);
      for (const [, init] of fetch.mock.calls) expect(init?.signal).toBeInstanceOf(AbortSignal);
    });

    it("uses the global fetch, looked up at the call, when it is given none", async () => {
      const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify(ME)));
      await expect(checkProvider(base)).resolves.toBeUndefined();
      expect(spy.mock.calls[0]?.[0]).toBe(`${FACILITATOR}/providers/me`);
    });
  });

  describe("facilitatorUrl, retryable: the facilitator may only be starting", () => {
    it("a connection error", async () => {
      const cause = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:4022"), { code: "ECONNREFUSED" });
      const fetch = vi.fn<Fetch>().mockRejectedValue(new TypeError("fetch failed", { cause }));
      const e = await refused({ fetch });
      expect(e).toMatchObject({ field: "facilitatorUrl", retryable: true });
      expect(e.message).toBe(`facilitatorUrl: cannot reach the facilitator at ${FACILITATOR} (ECONNREFUSED)`);
    });

    it("a connection error with no code names the kind of error", async () => {
      const e = await refused({ fetch: vi.fn<Fetch>().mockRejectedValue(new TypeError("fetch failed")) });
      expect(e).toMatchObject({ field: "facilitatorUrl", retryable: true });
      expect(e.message).toBe(`facilitatorUrl: cannot reach the facilitator at ${FACILITATOR} (TypeError)`);
    });

    it("a timeout", async () => {
      const e = await refused({ fetch: hanging(), timeoutMs: 20 });
      expect(e).toMatchObject({ field: "facilitatorUrl", retryable: true });
      expect(e.message).toBe(
        `facilitatorUrl: the facilitator at ${FACILITATOR} did not answer /providers/me within 20 ms`,
      );
    });

    it.each([500, 502, 503, 504, 599])("a %i answer", async (status) => {
      const e = await refused({ fetch: answering(reply(status, "boom")) });
      expect(e).toMatchObject({ field: "facilitatorUrl", retryable: true });
      expect(e.message).toBe(`facilitatorUrl: the facilitator at ${FACILITATOR} answered /providers/me with ${status}`);
    });

    // Beyond the table, a slow or busy facilitator will answer later
    it.each([408, 429])("a %i answer, which is a facilitator that is slow or busy", async (status) => {
      expect(await refused({ fetch: answering(reply(status)) })).toMatchObject({
        field: "facilitatorUrl",
        retryable: true,
      });
    });

    it("an answer whose body breaks off, as the connection does", async () => {
      const broken = () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(Object.assign(new Error("terminated"), { code: "UND_ERR_SOCKET" }));
            },
          }),
          { status: 200 },
        );
      const e = await refused({ fetch: answering(broken) });
      expect(e).toMatchObject({ field: "facilitatorUrl", retryable: true });
      expect(e.message).toContain("UND_ERR_SOCKET");
    });
  });

  describe("facilitatorUrl, not retryable: this is not a facilitator that serves providers", () => {
    it("a 404, a facilitator without the route", async () => {
      const e = await refused({ fetch: answering(replyJson(404, { error: "not_found" })) });
      expect(e).toMatchObject({ field: "facilitatorUrl", retryable: false });
      expect(e.message).toContain("/providers/me");
      expect(e.message).toContain("404");
    });

    it.each<[string, string]>([
      ["an empty object", "{}"],
      ["an array", "[]"],
      ["null", "null"],
      ["a string", '"f93eeecbf393ea04"'],
      ["no providerId", JSON.stringify({ network: NETWORK, payTo: PAY_TO })],
      ["no network", JSON.stringify({ providerId: ME.providerId, payTo: PAY_TO })],
      ["no payTo", JSON.stringify({ providerId: ME.providerId, network: NETWORK })],
      ["a providerId that is a number", JSON.stringify({ ...ME, providerId: 7 })],
      ["a network that is null", JSON.stringify({ ...ME, network: null })],
      ["a payTo that is an object", JSON.stringify({ ...ME, payTo: {} })],
      ["a /supported answer", JSON.stringify({ kinds: [], extensions: [], signers: {} })],
      ["text that is not JSON", "<html>welcome</html>"],
      ["an empty body", ""],
    ])("a 200 with %s", async (_name, body) => {
      const e = await refused({ fetch: answering(reply(200, body)) });
      expect(e).toMatchObject({ field: "facilitatorUrl", retryable: false });
      expect(e.message).toContain("{providerId, network, payTo}");
    });

    describe("a 200 body past 4096 bytes", () => {
      it("is read up to 4096 bytes and refused from 4097", async () => {
        const padded = (bytes: number) => JSON.stringify(ME).padEnd(bytes, " ");
        await expect(checkProvider({ ...base, fetch: answering(reply(200, padded(4096))) })).resolves.toBeUndefined();
        const e = await refused({ fetch: answering(reply(200, padded(4097))) });
        expect(e).toMatchObject({ field: "facilitatorUrl", retryable: false });
        expect(e.message).toBe(`facilitatorUrl: the facilitator at ${FACILITATOR} ${UNREADABLE}`);
      });

      it("is pulled on no further than the chunk that crosses the cap, and the stream is cancelled", async () => {
        const { seen, fetch } = spaces(1024, 1000);
        const e = await refused({ fetch });
        expect(e).toMatchObject({ field: "facilitatorUrl", retryable: false });
        expect(e.message).toBe(`facilitatorUrl: the facilitator at ${FACILITATOR} ${UNREADABLE}`);
        expect(seen).toEqual({ pulls: 5, cancelled: true });
      });

      it("is refused on its declared length, with none of it read", async () => {
        const { seen, fetch } = spaces(1024, 1000, { "content-length": "1024000" });
        const e = await refused({ fetch });
        expect(e).toMatchObject({ field: "facilitatorUrl", retryable: false });
        expect(e.message).toBe(`facilitatorUrl: the facilitator at ${FACILITATOR} ${UNREADABLE}`);
        expect(seen).toEqual({ pulls: 0, cancelled: true });
      });
    });

    // Beyond the table, nothing else is a z402 facilitator's answer and asking again gets the same
    it.each([400, 405, 410, 301, 204])("a %i answer, which no facilitator of this rail sends", async (status) => {
      const e = await refused({ fetch: answering(reply(status)) });
      expect(e).toMatchObject({ field: "facilitatorUrl", retryable: false });
      expect(e.message).toBe(`facilitatorUrl: the facilitator at ${FACILITATOR} answered /providers/me with ${status}`);
    });
  });

  describe("facilitatorToken, not retryable: the key is refused", () => {
    it.each([401, 403])("a %i answer", async (status) => {
      const e = await refused({ fetch: answering(replyJson(status, { error: "unauthorized" })) });
      expect(e).toMatchObject({ field: "facilitatorToken", retryable: false });
      expect(e.message).toBe(`facilitatorToken: the facilitator at ${FACILITATOR} refused the API key (${status})`);
    });

    it("a 401 to a request that carried no key says that none is set", async () => {
      const e = await refused({ token: undefined, fetch: answering(replyJson(401, { error: "unauthorized" })) });
      expect(e).toMatchObject({ field: "facilitatorToken", retryable: false });
      expect(e.message).toContain("none is set");
    });
  });

  describe("payTo, not retryable: the key belongs to another provider", () => {
    it("a 200 for another payTo", async () => {
      const e = await refused({ fetch: answering(replyJson(200, { ...ME, payTo: OTHER_PAY_TO })) });
      expect(e).toMatchObject({ field: "payTo", retryable: false });
      expect(e.message).toBe(
        `payTo: the facilitator at ${FACILITATOR} has this API key for another payTo than ${PAY_TO}`,
      );
    });

    it("a 200 for another network", async () => {
      const e = await refused({ fetch: answering(replyJson(200, { ...ME, network: NETWORK_TESTNET })) });
      expect(e).toMatchObject({ field: "payTo", retryable: false });
      expect(e.message).toBe(`payTo: the facilitator at ${FACILITATOR} serves ${NETWORK_TESTNET}, not ${NETWORK}`);
    });

    it("a 200 for another payTo on another network names the network", async () => {
      const other = { ...ME, network: NETWORK_TESTNET, payTo: OTHER_PAY_TO };
      const e = await refused({ fetch: answering(replyJson(200, other)) });
      expect(e).toMatchObject({ field: "payTo", retryable: false });
      expect(e.message).toContain(NETWORK_TESTNET);
    });

    it("a network that is no Zcash network is not repeated", async () => {
      const hostile = "zcash:\u001b[2Jfake";
      const e = await refused({ fetch: answering(replyJson(200, { ...ME, network: hostile })) });
      expect(e).toMatchObject({ field: "payTo", retryable: false });
      expect(e.message).not.toContain(hostile);
      expect(e.message).toContain("another network");
    });
  });

  describe("input that no request could carry", () => {
    it.each<[string, string]>([
      ["a newline", "abc\nSECRET"],
      ["a space", "two words SECRET"],
      ["a character no header takes", "téSECRET"],
      ["nothing in it", ""],
    ])("a token with %s is facilitatorToken, not retryable, and nothing is sent", async (_what, token) => {
      const fetch = answering(replyJson(200, ME));
      const e = await refused({ token, fetch }, "SECRET");
      expect(e).toMatchObject({ field: "facilitatorToken", retryable: false });
      expect(fetch).not.toHaveBeenCalled();
    });

    it.each<[string, string]>([
      ["an empty one", ""],
      ["one with no scheme", "facilitator.test:4022"],
      ["an ftp:// one", "ftp://facilitator.test"],
      ["one that is not a URL", "not a url"],
    ])("%s is facilitatorUrl, not retryable, and nothing is sent", async (_what, facilitatorUrl) => {
      const fetch = answering(replyJson(200, ME));
      const e = await refused({ facilitatorUrl, fetch });
      expect(e).toMatchObject({ field: "facilitatorUrl", retryable: false });
      expect(fetch).not.toHaveBeenCalled();
    });

    it("a URL with a password is refused without repeating it", async () => {
      const fetch = answering(replyJson(200, ME));
      const e = await refused({ facilitatorUrl: "http://op:hunter2@facilitator.test:4022", fetch }, "hunter2");
      expect(e).toMatchObject({ field: "facilitatorUrl", retryable: false });
      expect(fetch).not.toHaveBeenCalled();
    });

    it("a timeoutMs that no timer takes is a bug of the caller and not a check failure", async () => {
      const fetch = answering(replyJson(200, ME));
      const err: unknown = await checkProvider({ ...base, fetch, timeoutMs: -1 }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RangeError);
      expect(err).not.toBeInstanceOf(ProviderCheckError);
      expect(fetch).not.toHaveBeenCalled();
    });
  });

  describe("what the error leaves out", () => {
    it("does not repeat a fetch error's message, which can quote the header it refused", async () => {
      const quoting = new TypeError(`Headers.append: "Bearer ${TOKEN}" is an invalid header value.`);
      const e = await refused({ fetch: vi.fn<Fetch>().mockRejectedValue(quoting) });
      expect(e).toMatchObject({ field: "facilitatorUrl", retryable: true });
    });

    it("names the facilitator by origin, never by a path, a query or a password in the URL", async () => {
      const facilitatorUrl = "https://facilitator.test:8443/secret-path/?apikey=hunter2";
      const e = await refused({ facilitatorUrl, fetch: answering(reply(503)) }, "hunter2");
      expect(e.message).toContain("https://facilitator.test:8443");
      expect(e.message).not.toContain("secret-path");
    });

    it("does not repeat a body the facilitator sent", async () => {
      const e = await refused({ fetch: answering(reply(503, `down for maintenance, key ${TOKEN}`)) });
      expect(e).toMatchObject({ field: "facilitatorUrl", retryable: true });
      expect(e.message).not.toContain("maintenance");
    });
  });
});

describe("checkProvider over a real connection", () => {
  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
            server.closeAllConnections();
          }),
      ),
    );
  });

  async function serving(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
    const server = createServer(handler);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  /** Answers as the facilitator does, the operator's key gets its provider and anything else a 401 */
  const operator = (req: IncomingMessage, res: ServerResponse): void => {
    res.setHeader("content-type", "application/json");
    if (req.url !== "/providers/me") {
      res.statusCode = 404;
      res.end('{"error":"not_found"}');
    } else if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.statusCode = 401;
      res.end('{"error":"unauthorized"}');
    } else {
      res.end(JSON.stringify(ME));
    }
  };

  /** Sends `total` copies of `chunk` while the client reads, then ends the body or leaves it open for `stall` */
  async function streaming(
    chunk: Buffer,
    total: number,
    over: { headers?: Record<string, string>; stall?: boolean } = {},
  ) {
    const seen = { written: 0, cut: false };
    let gone = () => {};
    const closed = new Promise<void>((resolve) => {
      gone = resolve;
    });
    const url = await serving((_req, res) => {
      res.writeHead(200, { "content-type": "application/json", ...over.headers });
      res.on("close", () => {
        seen.cut = !res.writableFinished;
        gone();
      });
      void (async () => {
        for (let i = 0; i < total && !res.destroyed; i++) {
          if (!res.write(chunk)) {
            await new Promise((resolve) => {
              res.once("drain", resolve);
              res.once("close", resolve);
            });
          }
          seen.written = i + 1;
        }
        if (over.stall !== true && !res.destroyed) res.end();
      })();
    });
    return { url, seen, closed };
  }

  it("passes for the key the server knows, with the trailing slash of the URL left off the route", async () => {
    const url = await serving(operator);
    await expect(checkProvider({ ...base, facilitatorUrl: `${url}/` })).resolves.toBeUndefined();
  });

  it("is facilitatorToken for a key the server does not know, and for none", async () => {
    const url = await serving(operator);
    for (const token of ["not-the-key", undefined]) {
      const e = await refused({ facilitatorUrl: url, token });
      expect(e).toMatchObject({ field: "facilitatorToken", retryable: false });
    }
  });

  it("is facilitatorUrl, not retryable, for a server without the route", async () => {
    const url = await serving((_req, res) => {
      res.statusCode = 404;
      res.end('{"error":"not_found"}');
    });
    expect(await refused({ facilitatorUrl: url })).toMatchObject({ field: "facilitatorUrl", retryable: false });
  });

  it("is facilitatorUrl, retryable, when the server accepts the request and never answers it", async () => {
    const url = await serving(() => undefined);
    const e = await refused({ facilitatorUrl: url, timeoutMs: 150 });
    expect(e).toMatchObject({ field: "facilitatorUrl", retryable: true });
    expect(e.message).toContain("within 150 ms");
  });

  it("is facilitatorUrl, retryable, when the server sends the headers and then stalls", async () => {
    const url = await serving((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"providerId":');
    });
    const e = await refused({ facilitatorUrl: url, timeoutMs: 150 });
    expect(e).toMatchObject({ field: "facilitatorUrl", retryable: true });
    expect(e.message).toContain("within 150 ms");
  });

  it("is facilitatorUrl, not retryable, for a body of megabytes, which is not read to its end", async () => {
    const stream = await streaming(Buffer.alloc(1024 * 1024, "a"), 64);
    const e = await refused({ facilitatorUrl: stream.url });
    expect(e).toMatchObject({ field: "facilitatorUrl", retryable: false });
    expect(e.message).toBe(`facilitatorUrl: the facilitator at ${stream.url} ${UNREADABLE}`);
    await stream.closed;
    expect(stream.seen.cut).toBe(true);
    expect(stream.seen.written).toBeLessThan(16);
  });

  it("is facilitatorUrl, not retryable, for a gzip body that decodes past the cap, before it ends", async () => {
    const member = gzipSync(Buffer.alloc(16 * 1024 * 1024, " "));
    const stream = await streaming(member, 1, { headers: { "content-encoding": "gzip" }, stall: true });
    const e = await refused({ facilitatorUrl: stream.url, timeoutMs: 2000 });
    expect(e).toMatchObject({ field: "facilitatorUrl", retryable: false });
    expect(e.message).toBe(`facilitatorUrl: the facilitator at ${stream.url} ${UNREADABLE}`);
    await stream.closed;
    expect(stream.seen.cut).toBe(true);
  });

  it("counts a gzip body by what it decodes to and not by what it weighs", async () => {
    const body = gzipSync(Buffer.concat([Buffer.from(JSON.stringify(ME)), Buffer.alloc(1024 * 1024, " ")]));
    expect(body.length).toBeLessThan(4096);
    const url = await serving((_req, res) => {
      const headers = { "content-type": "application/json", "content-encoding": "gzip", "content-length": body.length };
      res.writeHead(200, headers);
      res.end(body);
    });
    const e = await refused({ facilitatorUrl: url });
    expect(e).toMatchObject({ field: "facilitatorUrl", retryable: false });
    expect(e.message).toBe(`facilitatorUrl: the facilitator at ${url} ${UNREADABLE}`);
  });

  it("reads an answer that is sent gzip-encoded", async () => {
    const body = gzipSync(JSON.stringify(ME));
    const url = await serving((_req, res) => {
      res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" });
      res.end(body);
    });
    await expect(checkProvider({ ...base, facilitatorUrl: url })).resolves.toBeUndefined();
  });

  it("is facilitatorUrl, retryable, when the body trickles in under the cap and never ends", async () => {
    const url = await serving((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      const timer = setInterval(() => res.write(" "), 10);
      res.on("close", () => clearInterval(timer));
    });
    const e = await refused({ facilitatorUrl: url, timeoutMs: 200 });
    expect(e).toMatchObject({ field: "facilitatorUrl", retryable: true });
    expect(e.message).toContain("within 200 ms");
  });

  it("is facilitatorUrl, retryable, when nothing listens at the address", async () => {
    const url = await serving(operator);
    const [server] = servers.splice(0);
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    const e = await refused({ facilitatorUrl: url });
    expect(e).toMatchObject({ field: "facilitatorUrl", retryable: true });
    expect(e.message).toContain("ECONNREFUSED");
  });
});
