import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import {
  bazaarResourceServerExtension,
  declareDiscoveryExtension,
  type DeclareDiscoveryExtensionInput,
} from "@x402/extensions/bazaar";
import { afterEach, describe, expect, it } from "vitest";
import { discoverMain, listLines, rankByIntent, runDiscover, type DiscoverIo, type Listed, type Ranked } from "../src/discover.js";
import { DISCOVER_USAGE, USAGE, type DiscoverFlags } from "../src/flags.js";

const PAY_TO = "uregtest1etwrjmjldyyet5pge876dfxerpgmsmarxg920s50y3dgc3wa36xmemqexfyw87jm3h0cttupk92qkrv8uafvjrl2j73d8nck7g35axkz";

interface Spec {
  name: string;
  port: number;
  method: "GET" | "POST" | "DELETE";
  path: string;
  description: string;
  unit: string;
  tags: string[];
  discovery: DeclareDiscoveryExtensionInput;
  amount?: string;
  asset?: string;
}

/** A resource the way the discovery service lists it, with the extensions a paid route puts in its 402 */
function resource(s: Spec): Listed {
  const declared = declareDiscoveryExtension(s.discovery).bazaar;
  const bazaar = bazaarResourceServerExtension.enrichDeclaration?.(declared, {
    method: s.method,
    adapter: { getPath: () => s.path },
  });
  return {
    resource: `http://127.0.0.1:${s.port}${s.path}`,
    type: "http",
    x402Version: 2,
    accepts: [
      {
        scheme: "prepaid-voucher",
        network: "zcash:regtest",
        amount: s.amount ?? "500",
        asset: s.asset ?? "ZEC",
        payTo: PAY_TO,
        maxTimeoutSeconds: 60,
        extra: {},
      },
    ],
    lastUpdated: "2026-10-27T12:00:00.000Z",
    description: s.description,
    mimeType: "application/json",
    serviceName: s.name,
    tags: s.tags,
    extensions: { bazaar, z402: { unit: s.unit } },
  };
}

const LLM = resource({
  name: "LLM",
  port: 4031,
  method: "POST",
  path: "/v1/generate",
  description: "Generate text with a language model, one chunk per call",
  unit: "output chunk",
  tags: ["llm", "inference", "text"],
  discovery: {
    bodyType: "json",
    input: { prompt: "Say hello" },
    inputSchema: {
      properties: { prompt: { type: "string" }, system: { type: "string" }, maxTokens: { type: "number" } },
      required: ["prompt"],
    },
  },
});

const MARKDOWN_SPEC: Spec = {
  name: "Markdown",
  port: 4032,
  method: "GET",
  path: "/v1/markdown",
  description: "Fetch a web page and return it as clean markdown",
  unit: "page",
  tags: ["web", "scraping"],
  discovery: { input: { url: "https://example.com" }, inputSchema: { properties: { url: { type: "string" } }, required: ["url"] } },
};
const MARKDOWN = resource(MARKDOWN_SPEC);

const EMBEDDINGS = resource({
  name: "Embeddings",
  port: 4033,
  method: "POST",
  path: "/v1/embeddings",
  description: "Turn text into embedding vectors",
  unit: "1k tokens",
  tags: ["embeddings", "vectors", "search"],
  discovery: {
    bodyType: "json",
    input: { input: "hello" },
    inputSchema: { properties: { input: { type: "string" } }, required: ["input"] },
  },
});

const DROPBOX = resource({
  name: "Dropbox",
  port: 4034,
  method: "POST",
  path: "/v1/drops",
  description: "Hold an age-encrypted file for a number of blocks",
  unit: "10 blocks",
  tags: ["storage", "encryption"],
  discovery: { bodyType: "text" },
});

const HOLD = resource({
  name: "Dropbox",
  port: 4034,
  method: "POST",
  path: "/v1/drops/:drop/hold",
  description: "Keep a stored file for 10 more blocks",
  unit: "10 blocks",
  tags: ["storage", "encryption"],
  discovery: {
    bodyType: "text",
    pathParams: { drop: "example" },
    pathParamsSchema: { properties: { drop: { type: "string" } } },
  },
});

/** The five routes of the starter services, in the order the discovery service lists them */
const ALL: Listed[] = [LLM, MARKDOWN, EMBEDDINGS, DROPBOX, HOLD];

const nameOf = (r: { item: Listed }): string | undefined => r.item.serviceName;

function top(intent: string, items: readonly Listed[] = ALL): Ranked {
  const [best] = rankByIntent(items, intent);
  if (best === undefined) throw new Error("nothing was ranked");
  return best;
}

describe("listLines", () => {
  it("prints one aligned line per resource: service, method, URL, price with its unit, description", () => {
    expect(listLines(ALL)).toEqual([
      "LLM         POST  http://127.0.0.1:4031/v1/generate          500 zat per output chunk  Generate text with a language model, one chunk per call",
      "Markdown    GET   http://127.0.0.1:4032/v1/markdown          500 zat per page          Fetch a web page and return it as clean markdown",
      "Embeddings  POST  http://127.0.0.1:4033/v1/embeddings        500 zat per 1k tokens     Turn text into embedding vectors",
      "Dropbox     POST  http://127.0.0.1:4034/v1/drops             500 zat per 10 blocks     Hold an age-encrypted file for a number of blocks",
      "Dropbox     POST  http://127.0.0.1:4034/v1/drops/:drop/hold  500 zat per 10 blocks     Keep a stored file for 10 more blocks",
    ]);
  });

  it("separates thousands, and names an asset that is not ZEC as the service gives it", () => {
    const dear = resource({ ...MARKDOWN_SPEC, amount: "100000" });
    const dollars = resource({ ...MARKDOWN_SPEC, amount: "10000", asset: "USDC" });
    expect(listLines([dear])[0]).toContain("  100,000 zat per page  ");
    expect(listLines([dollars])[0]).toContain("  10000 USDC per page  ");
  });

  it("puts a dash where the service left something out, and no unit where it names none", () => {
    expect(listLines([{ resource: "http://127.0.0.1:4032/v1/markdown" }])).toEqual(["-  -  http://127.0.0.1:4032/v1/markdown  -"]);
    const { extensions: _extensions, ...noExtensions } = MARKDOWN;
    expect(listLines([noExtensions])[0]).toBe("Markdown  -  http://127.0.0.1:4032/v1/markdown  500 zat  Fetch a web page and return it as clean markdown");
  });

  it("shows a price it cannot read as a dash", () => {
    expect(listLines([resource({ ...MARKDOWN_SPEC, amount: "0.5" })])[0]).toContain("  -  Fetch a web page");
  });

  it("keeps one line per resource whatever the text holds", () => {
    const rude: Listed = { ...MARKDOWN, serviceName: "Mark\ndown", description: "Line one\r\nline\ttwo \u001b[31mred" };
    const lines = listLines([rude]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toMatch(/[\u0000-\u001f]/);
    expect(lines[0]).toContain("Mark down  GET");
    expect(lines[0]).toMatch(/ {2}Line one line two \[31mred$/);
  });
});

describe("rankByIntent", () => {
  it.each([
    ["summarize this web page as markdown", "Markdown", ["web", "page", "markdown"]],
    ["store an encrypted file for later", "Dropbox", ["encrypted", "file"]],
    ["embeddings for semantic search", "Embeddings", ["embeddings", "search"]],
    ["let a language model write text", "LLM", ["language", "model", "text"]],
  ])("%s -> %s", (intent, pick, matched) => {
    expect(nameOf(top(intent))).toBe(pick);
    expect(top(intent).matched).toEqual(matched);
  });

  it("puts the best match first and leaves the rest in the order of the list", () => {
    expect(rankByIntent(ALL, "fetch a web page as markdown").map(nameOf)).toEqual([
      "Markdown",
      "LLM",
      "Embeddings",
      "Dropbox",
      "Dropbox",
    ]);
  });

  it("orders the others by how many words of the intent they carry", () => {
    const ranked = rankByIntent(ALL, "language model text vectors");
    expect(ranked.map(nameOf)).toEqual(["LLM", "Embeddings", "Markdown", "Dropbox", "Dropbox"]);
    expect(ranked.map((r) => r.matched.length)).toEqual([3, 2, 0, 0, 0]);
  });

  it("breaks a tie by the order of the list, whichever way the list is ordered", () => {
    expect(rankByIntent([LLM, EMBEDDINGS], "text").map(nameOf)).toEqual(["LLM", "Embeddings"]);
    expect(rankByIntent([EMBEDDINGS, LLM], "text").map(nameOf)).toEqual(["Embeddings", "LLM"]);
  });

  it("leaves the list it is given as it was", () => {
    const given = [...ALL];
    rankByIntent(given, "fetch a web page as markdown");
    expect(given).toEqual(ALL);
  });

  it("counts a word once however often the intent repeats it", () => {
    expect(top("text text text").matched).toEqual(["text"]);
  });

  it("matches on case and punctuation alike", () => {
    expect(top("MARKDOWN!!! (web-page)").matched).toEqual(["markdown", "web", "page"]);
  });

  it("keeps letters that are not ASCII inside their word", () => {
    const uebersetzer: Listed = { resource: "http://127.0.0.1:4035/v1/translate", serviceName: "Übersetzer" };
    expect(top("ÜBERSETZER", [MARKDOWN, uebersetzer]).matched).toEqual(["übersetzer"]);
    expect(nameOf(top("ÜBERSETZER", [MARKDOWN, uebersetzer]))).toBe("Übersetzer");
  });

  it("ignores words shorter than three letters and the stopwords", () => {
    const ranked = rankByIntent(ALL, "to be or not to be, the one for all of us");
    expect(ranked.map((r) => r.matched.length)).toEqual([0, 0, 0, 0, 0]);
    expect(ranked.map(nameOf)).toEqual(ALL.map((r) => r.serviceName));
  });

  it("matches the name of an input property, but not the schema keywords around it", () => {
    expect(nameOf(top("url"))).toBe("Markdown");
    expect(top("url").matched).toEqual(["url"]);
    expect(nameOf(top("prompt maxtokens"))).toBe("LLM");
    expect(top("prompt maxtokens").matched).toEqual(["prompt", "maxtokens"]);
    expect(top("drop").matched).toEqual(["drop"]);
    expect(top("method body queryparams type properties required").matched).toEqual([]);
  });

  it("matches the billing unit and the tags", () => {
    expect(nameOf(top("tokens"))).toBe("Embeddings");
    expect(nameOf(top("scraping"))).toBe("Markdown");
  });

  it("copes with entries that carry nothing but a URL", () => {
    const bare: Listed = { resource: "http://127.0.0.1:1/x" };
    expect(rankByIntent([bare, MARKDOWN], "markdown").map((r) => r.item.resource)).toEqual([MARKDOWN.resource, bare.resource]);
  });
});

/* A discovery endpoint on a free port */

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((done) => {
          server.closeAllConnections();
          server.close(() => done());
        }),
    ),
  );
});

interface Fake {
  url: string;
  requests: Array<{ method: string; url: string; headers: IncomingMessage["headers"] }>;
}

async function fake(respond: (req: IncomingMessage, res: ServerResponse) => void): Promise<Fake> {
  const requests: Fake["requests"] = [];
  const server = createServer((req, res) => {
    requests.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers });
    respond(req, res);
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests };
}

function reply(res: ServerResponse, status: number, body: string, type = "application/json"): void {
  res.writeHead(status, { "content-type": type });
  res.end(body);
}

/** GET /discovery/resources the way the discovery service answers it, paged by offset */
function serving(all: readonly unknown[], pageSize = 100): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    const url = new URL(req.url ?? "/", "http://fake");
    if (url.pathname !== "/discovery/resources") return reply(res, 404, '{"error":"not_found"}');
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const body = { x402Version: 2, items: all.slice(offset, offset + pageSize), pagination: { limit: pageSize, offset, total: all.length } };
    return reply(res, 200, JSON.stringify(body));
  };
}

/** A port that was listening a moment ago and is not now */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((done) => server.close(() => done()));
  return port;
}

function capture(): { io: DiscoverIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { print: (line) => out.push(line), warn: (line) => err.push(line) } };
}

const flags = (over: Partial<DiscoverFlags>): DiscoverFlags => ({ discovery: "http://127.0.0.1:1", intent: undefined, json: false, ...over });

/** What the service was asked for, one object of query parameters per request */
const queries = (server: Fake): Array<Record<string, string>> =>
  server.requests.map((r) => Object.fromEntries(new URL(r.url, server.url).searchParams));

describe("runDiscover", () => {
  it("asks the way the stock Bazaar client does, with one GET /discovery/resources?type=http", async () => {
    const server = await fake(serving(ALL));
    const { io } = capture();

    await runDiscover(flags({ discovery: server.url }), io);

    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]?.method).toBe("GET");
    expect(new URL(server.requests[0]?.url ?? "", server.url).pathname).toBe("/discovery/resources");
    expect(queries(server)).toEqual([{ type: "http" }]);
  });

  it("prints one line per resource in the order the service lists them", async () => {
    const server = await fake(serving(ALL));
    const { io, out, err } = capture();

    await runDiscover(flags({ discovery: server.url }), io);

    expect(out).toEqual(listLines(ALL));
    expect(out).toHaveLength(5);
    expect(err).toEqual([]);
  });

  it("--json prints the list as the service sent it", async () => {
    const server = await fake(serving(ALL));
    const { io, out } = capture();

    await runDiscover(flags({ discovery: server.url, json: true }), io);

    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0] ?? "")).toEqual(ALL);
  });

  it("--intent ranks the list here and names the pick, and the service never hears the intent", async () => {
    const server = await fake(serving(ALL));
    const { io, out } = capture();
    const intent = "summarize this web page as markdown";

    await runDiscover(flags({ discovery: server.url, intent }), io);

    expect(queries(server)).toEqual([{ type: "http" }]);
    const wire = JSON.stringify(server.requests);
    expect(wire).not.toContain("summarize");
    expect(wire).not.toContain("markdown");

    expect(out[0]).toBe(`ranked locally by word overlap with "${intent}", only the list request left this process`);
    expect(out.slice(1, 6)).toEqual(listLines([MARKDOWN, LLM, EMBEDDINGS, DROPBOX, HOLD]));
    expect(out[6]).toBe("pick: Markdown GET http://127.0.0.1:4032/v1/markdown (matched web, page, markdown)");
    expect(out).toHaveLength(7);
  });

  it("--intent says so when nothing in the list matches", async () => {
    const server = await fake(serving(ALL));
    const { io, out } = capture();

    await runDiscover(flags({ discovery: server.url, intent: "write a poem about the sea" }), io);

    expect(out.slice(1, 6)).toEqual(listLines(ALL));
    expect(out[6]).toBe("pick: none, no word of the intent matches a resource");
  });

  it("quotes the intent, so that a newline in it cannot add a line", async () => {
    const server = await fake(serving(ALL));
    const { io, out } = capture();

    await runDiscover(flags({ discovery: server.url, intent: "store\na file" }), io);

    expect(out[0]).toContain('"store\\na file"');
    expect(out).toHaveLength(7);
  });

  it("pages through a list longer than one page, with the stock client's offset", async () => {
    const server = await fake(serving(ALL, 2));
    const { io, out } = capture();

    await runDiscover(flags({ discovery: server.url }), io);

    expect(queries(server)).toEqual([{ type: "http" }, { type: "http", offset: "2" }, { type: "http", offset: "4" }]);
    expect(out).toEqual(listLines(ALL));
  });

  it("stops at a page it has seen, as a service that ignores offset sends it", async () => {
    const firstPage = ALL.slice(0, 2);
    const server = await fake((_req, res) =>
      reply(res, 200, JSON.stringify({ x402Version: 2, items: firstPage, pagination: { limit: 2, offset: 0, total: 5 } })),
    );
    const { io, out } = capture();

    await runDiscover(flags({ discovery: server.url }), io);

    expect(server.requests).toHaveLength(2);
    expect(out).toEqual(listLines(firstPage));
  });

  it("keeps the entries of one URL that carry a call for each method, across a page boundary", async () => {
    const calls = (["GET", "POST", "DELETE"] as const).map((method) => resource({ ...MARKDOWN_SPEC, method }));
    const server = await fake(serving(calls, 2));
    const { io, out } = capture();

    await runDiscover(flags({ discovery: server.url }), io);

    expect(server.requests).toHaveLength(2);
    expect(out).toEqual(listLines(calls));
    expect(out).toHaveLength(3);
  });

  it("stops when a page comes back empty although the total says there is more", async () => {
    const server = await fake((req, res) => {
      const offset = Number(new URL(req.url ?? "/", "http://fake").searchParams.get("offset") ?? 0);
      const items = offset === 0 ? ALL.slice(0, 2) : [];
      return reply(res, 200, JSON.stringify({ x402Version: 2, items, pagination: { limit: 2, offset, total: 9 } }));
    });
    const { io, out } = capture();

    await runDiscover(flags({ discovery: server.url }), io);

    expect(server.requests).toHaveLength(2);
    expect(out).toHaveLength(2);
  });

  it("reads a list that carries no pagination as the whole list", async () => {
    const server = await fake((_req, res) => reply(res, 200, JSON.stringify({ x402Version: 2, items: ALL })));
    const { io, out } = capture();

    await runDiscover(flags({ discovery: server.url }), io);

    expect(server.requests).toHaveLength(1);
    expect(out).toEqual(listLines(ALL));
  });

  it("cuts a very long list at 1,000 resources and says so on the warning channel", async () => {
    const many = Array.from({ length: 1500 }, (_, i) => ({ resource: `http://127.0.0.1:4040/v1/r${i}` }));
    const server = await fake(serving(many, 250));
    const { io, out, err } = capture();

    await runDiscover(flags({ discovery: server.url }), io);

    expect(server.requests).toHaveLength(4);
    expect(out).toHaveLength(1000);
    expect(err).toEqual(["showing the first 1000 of 1500 resources"]);
  });

  it("says so when the list is empty, and --json prints an empty array", async () => {
    const server = await fake(serving([]));
    const plain = capture();
    const json = capture();

    await runDiscover(flags({ discovery: server.url }), plain.io);
    await runDiscover(flags({ discovery: server.url, json: true }), json.io);

    expect(plain.out).toEqual([`no resources listed at ${server.url}`]);
    expect(json.out).toEqual(["[]"]);
  });
});

describe("discoverMain", () => {
  it("returns 0 after printing the list", async () => {
    const server = await fake(serving(ALL));
    const { io, out } = capture();

    expect(await discoverMain(["--discovery", server.url], io)).toBe(0);

    expect(out).toEqual(listLines(ALL));
  });

  it("takes the discovery URL with a trailing slash, and the lone -- of pnpm", async () => {
    const server = await fake(serving(ALL));
    const { io, out } = capture();

    expect(await discoverMain(["--", "--discovery", `${server.url}/`, "--json"], io)).toBe(0);

    expect(new URL(server.requests[0]?.url ?? "", server.url).pathname).toBe("/discovery/resources");
    expect(JSON.parse(out[0] ?? "")).toEqual(ALL);
  });

  it("prints its own usage for --help and asks nobody", async () => {
    const server = await fake(serving(ALL));
    const { io, out } = capture();

    expect(await discoverMain(["--discovery", server.url, "--help"], io)).toBe(0);
    expect(await discoverMain(["-h"], io)).toBe(0);

    expect(out).toEqual([DISCOVER_USAGE, DISCOVER_USAGE]);
    expect(server.requests).toEqual([]);
  });

  it("returns 2 with the usage on a flag error, before any request", async () => {
    const server = await fake(serving(ALL));
    const { io, out, err } = capture();

    expect(await discoverMain(["--discovery", server.url, "--bogus"], io)).toBe(2);
    expect(await discoverMain(["--discovery", server.url, "--intent", "x", "--json"], io)).toBe(2);
    expect(await discoverMain(["--discovery", "ftp://nope"], io)).toBe(2);

    expect(out).toEqual([]);
    expect(err).toHaveLength(3);
    expect(err[0]).toBe(`Unknown option '--bogus'\n\n${DISCOVER_USAGE}`);
    expect(err[1]).toMatch(/^--intent: cannot be combined with --json/);
    expect(err[2]).toMatch(/^--discovery: expected an http\(s\) URL/);
    expect(server.requests).toEqual([]);
  });

  describe("returns 1 with one clear line", () => {
    it("when nothing listens at the endpoint", async () => {
      const port = await closedPort();
      const { io, out, err } = capture();

      expect(await discoverMain(["--discovery", `http://127.0.0.1:${port}`], io)).toBe(1);

      expect(out).toEqual([]);
      expect(err).toEqual([`cannot reach http://127.0.0.1:${port}/discovery/resources: connect ECONNREFUSED 127.0.0.1:${port}`]);
    });

    it("when localhost refuses on every address it has", async () => {
      const port = await closedPort();
      const { io, err } = capture();

      expect(await discoverMain(["--discovery", `http://localhost:${port}`], io)).toBe(1);

      expect(err).toHaveLength(1);
      expect(err[0]).toMatch(new RegExp(`^cannot reach http://localhost:${port}/discovery/resources: .*ECONNREFUSED`));
      expect(err[0]).not.toContain("\n");
    });

    it("when the service drops the connection, naming the cause rather than fetch failed", async () => {
      const server = await fake((req) => req.socket.destroy());
      const { io, out, err } = capture();

      expect(await discoverMain(["--discovery", server.url], io)).toBe(1);

      expect(out).toEqual([]);
      expect(err).toHaveLength(1);
      expect(err[0]).toMatch(new RegExp(`^cannot reach ${server.url}/discovery/resources: .+`));
      expect(err[0]).not.toMatch(/: fetch failed$/);
    });

    it("when the service answers with an error status", async () => {
      const server = await fake((_req, res) => reply(res, 503, '{"error":"not_ready"}'));
      const { io, out, err } = capture();

      expect(await discoverMain(["--discovery", server.url], io)).toBe(1);

      expect(out).toEqual([]);
      expect(err).toEqual([`${server.url}/discovery/resources answered 503: {"error":"not_ready"}`]);
    });

    it("when the website answers with a page, cut to one short line", async () => {
      const page = `<!doctype html>\n<html>\n  <body>\n    <h1>404</h1>\n    <p>${"This page could not be found. ".repeat(20)}</p>\n  </body>\n</html>`;
      const server = await fake((_req, res) => reply(res, 404, page, "text/html"));
      const { io, err } = capture();

      expect(await discoverMain(["--discovery", server.url], io)).toBe(1);

      expect(err).toHaveLength(1);
      expect(err[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/discovery\/resources answered 404: <!doctype html> <html> <body> <h1>404<\/h1> /);
      expect(err[0]).toMatch(/…$/);
      expect(err[0]).not.toContain("\n");
      expect(err[0]?.length).toBeLessThan(250);
    });

    it("when the error status comes with no body", async () => {
      const server = await fake((_req, res) => reply(res, 500, ""));
      const { io, err } = capture();

      expect(await discoverMain(["--discovery", server.url], io)).toBe(1);

      expect(err).toEqual([`${server.url}/discovery/resources answered 500`]);
    });

    it("when the answer is not JSON", async () => {
      const server = await fake((_req, res) => reply(res, 200, "<!doctype html><title>Welcome</title>", "text/html"));
      const { io, out, err } = capture();

      expect(await discoverMain(["--discovery", server.url], io)).toBe(1);

      expect(out).toEqual([]);
      expect(err).toHaveLength(1);
      expect(err[0]?.startsWith(`${server.url}/discovery/resources did not return JSON: `)).toBe(true);
      expect(err[0]).not.toContain("\n");
    });

    it("when the JSON is cut off", async () => {
      const server = await fake((_req, res) => reply(res, 200, '{"x402Version":2,"items":[{"resource":'));
      const { io, err } = capture();

      expect(await discoverMain(["--discovery", server.url], io)).toBe(1);

      expect(err[0]).toContain("/discovery/resources did not return JSON: ");
    });

    it.each([
      ["an object with no items", "{}", /did not return a list of resources \(no items array\)/],
      ["a bare array", "[]", /did not return a list of resources/],
      ["null", "null", /did not return a list of resources/],
      ["items that is not an array", '{"items":"nope"}', /did not return a list of resources/],
      ["an entry with no resource URL", '{"items":[{"serviceName":"x"}]}', /returned a list with no resource URL in entry 1$/],
      ["an entry that is not an object", `{"items":[${JSON.stringify(ALL[0])},7]}`, /returned a list with no resource URL in entry 2$/],
    ])("when the list is %s", async (_label, body, message) => {
      const server = await fake((_req, res) => reply(res, 200, body));
      const { io, out, err } = capture();

      expect(await discoverMain(["--discovery", server.url], io)).toBe(1);

      expect(out).toEqual([]);
      expect(err).toHaveLength(1);
      expect(err[0]).toMatch(message);
    });

    it("on page two of a list, without printing page one", async () => {
      const server = await fake((req, res) => {
        const paged = new URL(req.url ?? "/", "http://fake").searchParams.has("offset");
        if (paged) return reply(res, 502, "bad gateway");
        return reply(res, 200, JSON.stringify({ x402Version: 2, items: ALL.slice(0, 2), pagination: { limit: 2, offset: 0, total: 5 } }));
      });
      const { io, out, err } = capture();

      expect(await discoverMain(["--discovery", server.url], io)).toBe(1);

      expect(out).toEqual([]);
      expect(err).toEqual([`${server.url}/discovery/resources answered 502: bad gateway`]);
    });
  });
});

/* The real process, to prove the wiring in main.ts and package.json */

const AGENT_DIR = fileURLToPath(new URL("..", import.meta.url));

function cli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, ["--import", "tsx", "src/main.ts", ...args], { cwd: AGENT_DIR, timeout: 60_000 }, (error, stdout, stderr) => {
      resolve({ code: error === null ? 0 : typeof error.code === "number" ? error.code : null, stdout, stderr });
    });
  });
}

describe("tsx src/main.ts discover", { timeout: 60_000 }, () => {
  it("is what `pnpm discover` runs", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts.discover).toBe("tsx src/main.ts discover");
    expect(pkg.scripts.demo).toBe("tsx src/main.ts");
  });

  it("prints the list and exits 0", async () => {
    const server = await fake(serving(ALL));

    const run = await cli(["discover", "--discovery", server.url]);

    expect(run).toEqual({ code: 0, stdout: `${listLines(ALL).join("\n")}\n`, stderr: "" });
  });

  it("exits 1 with one line on stderr when the endpoint is unreachable", async () => {
    const dead = `http://127.0.0.1:${await closedPort()}`;

    const run = await cli(["discover", "--discovery", dead]);

    expect(run.code).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr.trimEnd().split("\n")).toHaveLength(1);
    expect(run.stderr).toContain(`cannot reach ${dead}/discovery/resources`);
  });

  it("exits 2 with the usage on a flag error", async () => {
    const run = await cli(["discover", "--bogus"]);

    expect(run).toEqual({ code: 2, stdout: "", stderr: `Unknown option '--bogus'\n\n${DISCOVER_USAGE}\n` });
  });

  it("prints its own usage for --help, while --help alone still prints the demo's", async () => {
    expect(await cli(["discover", "--help"])).toEqual({ code: 0, stdout: `${DISCOVER_USAGE}\n`, stderr: "" });
    expect(await cli(["--help"])).toEqual({ code: 0, stdout: `${USAGE}\n`, stderr: "" });
  });
});
