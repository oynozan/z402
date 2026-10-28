import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { x402Facilitator } from "@x402/core/facilitator";
import type { PaymentPayload, PaymentRequirements, SchemeNetworkFacilitator } from "@x402/core/types";
import { ASSET, DEMO_TERMS, encodeTerms, NETWORK_REGTEST, SCHEME, type Terms } from "@z402/protocol";
import { FakeChain } from "@z402/testkit";
import { afterAll, afterEach, describe, expect, test, vi } from "vitest";
import {
  createFacilitatorApp,
  startFacilitator,
  type FacilitatorHandle,
  type FacilitatorOptions,
  type Tenant,
} from "../src/app.js";
import { Catalog } from "../src/discovery/catalog.js";
import { providerId } from "../src/providers/id.js";
import { openRuntime } from "../src/runtime.js";
import { termsVersion } from "../src/termsVersion.js";
import { paymentFor, SESSION_KEY as K, voucherFor } from "./support/vouchers.js";

const NETWORK = NETWORK_REGTEST;
const OPERATOR = `uregtest1${"q".repeat(60)}`;
const TOKEN = "t-7c2e91-secret";
const A = { payTo: `uregtest1${"p".repeat(60)}`, uivk: `uivkregtest1${"sec3ret".repeat(10)}` };
const B = { payTo: `uregtest1${"z".repeat(60)}`, uivk: `uivkregtest1${"w3ak".repeat(10)}` };
const OP = { payTo: OPERATOR };
type Who = { payTo: string };
const W = 100000n;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const CHUNK = "http://127.0.0.1:4021/chunk";
const ECHO = "http://127.0.0.1:4021/echo";
const OTHER_CHUNK = "http://127.0.0.1:4023/chunk";
const BAZAAR_GET = { info: { input: { type: "http", method: "GET" } } };

const scratch = mkdtempSync(join(tmpdir(), "z402-discovery-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const running: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(running.splice(0).map((h) => h.close()));
});

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Everything one test's facilitators share, so that a restart finds the same chains, ledgers, registry and catalog */
function newRig() {
  const dir = mkdtempSync(join(scratch, "rig-"));
  const chains = new Map<string, FakeChain>();
  const lines: string[] = [];
  const chainOf = (payTo: string): FakeChain => {
    const chain = chains.get(payTo) ?? new FakeChain({ expiryDelta: 40 });
    chains.set(payTo, chain);
    return chain;
  };
  return {
    dir,
    providers: join(dir, "providers"),
    chainOf,
    lines,
    log: (msg: string, err?: unknown) => lines.push(err === undefined ? msg : `${msg} ${inspect(err, { depth: 10 })}`),
  };
}
type Rig = ReturnType<typeof newRig>;

/** A facilitator whose operator is OPERATOR, with a providers directory unless `providers` is left undefined */
async function boot(rig: Rig, over: Partial<FacilitatorOptions> = {}): Promise<FacilitatorHandle> {
  const handle = await startFacilitator({
    network: NETWORK,
    chain: rig.chainOf(OPERATOR).viewFor(OPERATOR),
    payTo: OPERATOR,
    priceZat: 500n,
    terms: DEMO_TERMS,
    authToken: TOKEN,
    port: 0,
    depositWaitMs: 50,
    log: rig.log,
    providers: {
      dir: rig.providers,
      chainFor: (p) => rig.chainOf(p.payTo).viewFor(p.payTo),
      owns: async () => true,
    },
    ...over,
  });
  running.push(handle);
  return handle;
}

interface Reply {
  status: number;
  headers: Headers;
  json: any;
}

interface Init {
  method?: string;
  /** Sent as a Bearer Authorization header, and no header at all when it is left out */
  token?: string;
  body?: unknown;
  raw?: string;
  headers?: Record<string, string>;
}

async function call(url: string, path: string, init: Init = {}): Promise<Reply> {
  const headers: Record<string, string> = { ...init.headers };
  if (init.token !== undefined) headers.authorization = `Bearer ${init.token}`;
  let body: string | undefined = init.raw;
  if (init.body !== undefined) body = JSON.stringify(init.body);
  if (body !== undefined && headers["content-type"] === undefined) headers["content-type"] = "application/json";
  const method = init.method ?? (body === undefined ? "GET" : "POST");
  const res = await fetch(`${url}${path}`, { method, headers, body });
  return { status: res.status, headers: res.headers, json: await res.json().catch(() => undefined) };
}

const register = (url: string, who: typeof A) =>
  call(url, "/providers", { method: "POST", body: { payTo: who.payTo, uivk: who.uivk } });

/** Registers a provider that must be accepted, and returns its API key */
async function enroll(url: string, who: typeof A): Promise<string> {
  const res = await register(url, who);
  expect(res.status).toBe(201);
  return res.json.apiKey as string;
}

/** Every lock file below a directory */
function locksUnder(dir: string): string[] {
  return existsSync(dir)
    ? readdirSync(dir, { recursive: true })
        .map(String)
        .filter((n) => n.endsWith(".lock"))
    : [];
}

/** What a provider's resource server sends, with the rail's terms and the version its runtime advertises */
const requirementsOf = (who: Who, extra: Record<string, unknown> = {}): PaymentRequirements => ({
  scheme: SCHEME,
  network: NETWORK,
  asset: ASSET,
  amount: "500",
  payTo: who.payTo,
  maxTimeoutSeconds: 60,
  extra: { ...encodeTerms(DEMO_TERMS), termsVersion: termsVersion(who.payTo, 500n, DEMO_TERMS), ...extra },
});

/** One declared resource, as the kit builds it from the 402 of a route */
const route = (who: Who, over: Record<string, unknown> = {}) => ({
  resource: CHUNK,
  type: "http",
  x402Version: 2,
  accepts: [requirementsOf(who)],
  description: "Demo chunks",
  mimeType: "application/json",
  serviceName: "chunks",
  tags: ["demo"],
  extensions: { bazaar: BAZAAR_GET, z402: { unit: "chunk" } },
  ...over,
});

const declare = (url: string, key: string | undefined, items: unknown[]) =>
  call(url, "/discovery/resources", { method: "POST", token: key, body: { items } });

const listing = async (url: string, query = ""): Promise<any[]> =>
  (await call(url, `/discovery/resources${query}`)).json.items;

const resources = (items: Array<{ resource: string }>): string[] => items.map((i) => i.resource);

/** What the log holds besides request lines, which a request that is no failure of ours leaves empty */
const diagnostics = (rig: Rig): string[] => rig.lines.filter((line) => !/^[A-Z]+ \//.test(line));

/** A voucher payment that echoes the resource and the bazaar extension, as a stock client does from the 402 it paid */
function payment(
  r: PaymentRequirements,
  cumulative: bigint,
  o: { txid?: string; resource?: PaymentPayload["resource"]; bazaar?: unknown } = {},
): PaymentPayload {
  return {
    ...paymentFor(r, voucherFor(r, cumulative, { depositTxid: o.txid })),
    resource: o.resource ?? { url: `${CHUNK}?session=abc` },
    extensions: { bazaar: o.bazaar ?? BAZAAR_GET },
  };
}

const envelope = (payload: PaymentPayload, r: PaymentRequirements) => ({
  x402Version: 2,
  paymentPayload: payload,
  paymentRequirements: r,
});
const verify = (url: string, key: string, payload: PaymentPayload, r: PaymentRequirements) =>
  call(url, "/verify", { token: key, body: envelope(payload, r) });
const settle = (url: string, key: string, payload: PaymentPayload, r: PaymentRequirements) =>
  call(url, "/settle", { token: key, body: envelope(payload, r) });

type Echo = { resource?: PaymentPayload["resource"]; bazaar?: unknown };

/** A deposit of one window to the provider, the verify that makes it known and the settle of the first voucher */
async function firstSale(rig: Rig, url: string, key: string, who: Who, echo: Echo = {}): Promise<Reply> {
  const txid = rig.chainOf(who.payTo).broadcast({ outputs: [{ to: who.payTo, valueZat: W, memo: `${K}:1` }] });
  const r = requirementsOf(who);
  const payload = payment(r, 500n, { txid, ...echo });
  expect((await verify(url, key, payload, r)).json.isValid).toBe(true);
  const res = await settle(url, key, payload, r);
  expect(res.json.success).toBe(true);
  return res;
}

/** A later voucher of the session the first sale opened */
const sale = (url: string, key: string, who: Who, cumulative: bigint, echo: Echo = {}): Promise<Reply> => {
  const r = requirementsOf(who);
  return settle(url, key, payment(r, cumulative, echo), r);
};

/** Three providers' resources, each from a different service, in the order the list serves them */
async function crowd(url: string): Promise<void> {
  const keyA = await enroll(url, A);
  const keyB = await enroll(url, B);
  await declare(url, TOKEN, [route(OP)]);
  await declare(url, keyA, [
    route(A, {
      resource: ECHO,
      description: "Echoes input",
      serviceName: "echo",
      tags: ["echo", "demo"],
      extensions: { bazaar: BAZAAR_GET },
    }),
  ]);
  await declare(url, keyB, [route(B, { resource: OTHER_CHUNK, extensions: { bazaar: BAZAAR_GET } })]);
}

describe("POST /discovery/resources", () => {
  test("declares the items for the provider of the key and answers them as served", async () => {
    const rig = newRig();
    const { url } = await boot(rig);
    const keyA = await enroll(url, A);

    const res = await declare(url, keyA, [route(A)]);

    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      x402Version: 2,
      items: [
        {
          resource: CHUNK,
          type: "http",
          x402Version: 2,
          accepts: [requirementsOf(A)],
          lastUpdated: expect.stringMatching(ISO),
          description: "Demo chunks",
          mimeType: "application/json",
          serviceName: "chunks",
          tags: ["demo"],
          extensions: { bazaar: BAZAAR_GET, z402: { unit: "chunk" } },
          lastSeen: expect.stringMatching(ISO),
          paidCallsToday: 0,
        },
      ],
    });
    expect(res.json.items[0].lastUpdated).toBe(res.json.items[0].lastSeen);
    expect(await listing(url)).toEqual(res.json.items);
  });

  test("takes the operator's token too, with the rail copied from /supported as a resource server does", async () => {
    const rig = newRig();
    const { url } = await boot(rig);
    const { payTo: _payTo, ...extra } = (await call(url, "/supported")).json.kinds[0].extra;

    const res = await declare(url, TOKEN, [route(OP, { accepts: [{ ...requirementsOf(OP), extra }] })]);

    expect(res.status).toBe(200);
    expect(res.json.items[0].accepts[0]).toMatchObject({ payTo: OPERATOR, extra });
  });

  test("holds a declaration to the terms the facilitator is configured with", async () => {
    const terms: Terms = { windowZat: 250000n, creditRatioBps: 1000, creditCapZat: 5n, zeroConfMinExpiryBlocks: 3 };
    const rig = newRig();
    const { url } = await boot(rig, { terms });
    const { payTo: _payTo, ...extra } = (await call(url, "/supported")).json.kinds[0].extra;

    const demo = await declare(url, TOKEN, [route(OP)]);
    expect(demo).toMatchObject({ status: 400, json: { error: "invalid_request", index: 0 } });
    expect(demo.json.message).toMatch(/^items\[0\]\.accepts\[0\]\.extra: /);

    const configured = await declare(url, TOKEN, [route(OP, { accepts: [{ ...requirementsOf(OP), extra }] })]);
    expect(configured.status).toBe(200);
  });

  test("is refused with 401 and a Bearer challenge without a key of ours, and applies nothing", async () => {
    const rig = newRig();
    const { url } = await boot(rig);
    const keyA = await enroll(url, A);
    const keys: Array<Init> = [
      {},
      { token: "" },
      { token: "wrong" },
      { token: `${keyA}x` },
      { headers: { authorization: "Basic YTpi" } },
    ];

    for (const init of keys) {
      const res = await call(url, "/discovery/resources", { method: "POST", body: { items: [route(A)] }, ...init });
      expect(res).toMatchObject({ status: 401, json: { error: "unauthorized" } });
      expect(res.headers.get("www-authenticate")).toBe("Bearer");
    }
    const inQuery = await call(url, `/discovery/resources?token=${keyA}`, {
      method: "POST",
      body: { items: [route(A)] },
    });
    expect(inQuery.status).toBe(401);
    expect(await listing(url)).toEqual([]);
  });

  test("a missing key is refused even when the body cannot be read", async () => {
    const rig = newRig();
    const { url } = await boot(rig);
    const res = await call(url, "/discovery/resources", { method: "POST", raw: "{ this is not json" });
    expect(res).toMatchObject({ status: 401, json: { error: "unauthorized" } });
  });

  test("a rotated key is refused at the next declaration, and the new key works at once", async () => {
    const rig = newRig();
    const { url } = await boot(rig);
    const oldKey = await enroll(url, A);
    expect((await declare(url, oldKey, [route(A)])).status).toBe(200);

    const rotated = await register(url, A);
    expect(rotated.status).toBe(200);
    const newKey = rotated.json.apiKey as string;

    expect((await declare(url, oldKey, [route(A)])).status).toBe(401);
    expect((await declare(url, newKey, [route(A)])).status).toBe(200);
  });

  test.each([
    ["not JSON", { raw: "{ this is not json" }],
    ["over 64 KB", { body: { items: [], padding: "x".repeat(70_000) } }],
  ])("a body that is %s is a 400 invalid_request of ours and not the parser's status", async (_name, init) => {
    const rig = newRig();
    const { url } = await boot(rig);
    const keyA = await enroll(url, A);
    const declared = vi.spyOn(Catalog.prototype, "declare");
    rig.lines.length = 0;

    const res = await call(url, "/discovery/resources", { method: "POST", token: keyA, ...init });

    expect(res.status).toBe(400);
    expect(res.json).toEqual({ error: "invalid_request", message: expect.stringMatching(/not JSON or is over 64KB/) });
    expect(declared).not.toHaveBeenCalled();
    expect(diagnostics(rig)).toEqual([]);
  });

  test.each([
    ["no body at all", {}],
    ["JSON that is not an object", { raw: "[1]" }],
    ["JSON sent as text", { raw: '{"items":[]}', headers: { "content-type": "text/plain" } }],
  ])("%s is a 400 invalid_request naming the body or the items", async (_name, init) => {
    const rig = newRig();
    const { url } = await boot(rig);
    const keyA = await enroll(url, A);
    rig.lines.length = 0;

    const res = await call(url, "/discovery/resources", { method: "POST", token: keyA, ...init });

    expect(res.status).toBe(400);
    expect(res.json).toEqual({ error: "invalid_request", message: expect.stringMatching(/^(body|items): /) });
    expect(diagnostics(rig)).toEqual([]);
  });

  const refusals: Array<[string, (a: Who, b: Who) => unknown, number | undefined, RegExp]> = [
    ["no items", () => ({}), undefined, /^items: /],
    ["an empty list", () => ({ items: [] }), undefined, /^items: /],
    ["33 items", (a) => ({ items: Array.from({ length: 33 }, () => route(a)) }), undefined, /^items: /],
    ["an item that is no object", () => ({ items: ["chunk"] }), 0, /^items\[0\]: /],
    [
      "a bad URL in the second item",
      (a) => ({ items: [route(a), route(a, { resource: "ftp://127.0.0.1/chunk" })] }),
      1,
      /^items\[1\]\.resource: /,
    ],
    [
      "another provider's payTo",
      (a, b) => ({ items: [route(a, { accepts: [requirementsOf(b)] })] }),
      0,
      /^items\[0\]\.accepts\[0\]\.payTo: /,
    ],
    [
      "another network",
      (a) => ({ items: [route(a, { accepts: [{ ...requirementsOf(a), network: "zcash:mainnet" }] })] }),
      0,
      /^items\[0\]\.accepts\[0\]\.network: /,
    ],
    [
      "terms that are not the rail's",
      (a) => ({ items: [route(a, { accepts: [requirementsOf(a, { windowZat: "1" })] })] }),
      0,
      /^items\[0\]\.accepts\[0\]\.extra: /,
    ],
    [
      "a termsVersion that is not the rail's",
      (a) => ({ items: [route(a, { accepts: [requirementsOf(a, { termsVersion: "0000000000000000" })] })] }),
      0,
      /^items\[0\]\.accepts\[0\]\.extra\.termsVersion: /,
    ],
  ];

  test.each(refusals)("%s is a 400 invalid_request that applies nothing", async (_name, body, index, message) => {
    const rig = newRig();
    const { url } = await boot(rig);
    const keyA = await enroll(url, A);
    rig.lines.length = 0;

    const res = await call(url, "/discovery/resources", { method: "POST", token: keyA, body: body(A, B) });

    expect(res.status).toBe(400);
    expect(res.json).toEqual({
      error: "invalid_request",
      message: expect.stringMatching(message),
      ...(index === undefined ? {} : { index }),
    });
    expect(diagnostics(rig)).toEqual([]);
    expect(await listing(url)).toEqual([]);
  });

  test("a refusal never echoes what was sent", async () => {
    const rig = newRig();
    const { url } = await boot(rig);
    const keyA = await enroll(url, A);
    const bad = [
      route(A, { resource: "http://user:hunter2@127.0.0.1/chunk" }),
      route(A, { resource: "ftp://127.0.0.1/hunter2" }),
      route(A, { accepts: [requirementsOf({ payTo: "uregtest1hunter2" })] }),
      route(A, { serviceName: "hunter2 ".repeat(8) }),
      route(A, { iconUrl: "http://127.0.0.1/hunter2.png" }),
    ];

    for (const item of bad) {
      const res = await declare(url, keyA, [item]);
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.json)).not.toContain("hunter2");
    }
  });

  test("a failure that is no refusal is a 500 that says nothing of the cause, and is logged", async () => {
    const rig = newRig();
    const { url } = await boot(rig);
    const keyA = await enroll(url, A);
    vi.spyOn(Catalog.prototype, "declare").mockImplementation(() => {
      throw new Error("disk on fire");
    });

    const res = await declare(url, keyA, [route(A)]);

    expect(res.status).toBe(500);
    expect(res.json).toEqual({ error: "internal_error" });
    expect(rig.lines.some((line) => line.includes("disk on fire"))).toBe(true);
  });

  test("declaring again is a heartbeat, and declaring one service leaves the provider's others listed", async () => {
    const rig = newRig();
    const { url } = await boot(rig);
    const keyA = await enroll(url, A);

    const first = await declare(url, keyA, [route(A)]);
    await sleep(5);
    await declare(url, keyA, [route(A, { resource: ECHO })]);
    expect(resources(await listing(url))).toEqual([CHUNK, ECHO]);

    await sleep(5);
    const again = await declare(url, keyA, [route(A)]);
    expect(resources(await listing(url))).toEqual([CHUNK, ECHO]);
    expect(Date.parse(again.json.items[0].lastSeen)).toBeGreaterThan(Date.parse(first.json.items[0].lastSeen));
  });

  test("two providers that list the same URL get an item each, with their own payTo", async () => {
    const rig = newRig();
    const { url } = await boot(rig);
    const keyA = await enroll(url, A);
    const keyB = await enroll(url, B);

    await declare(url, keyA, [route(A)]);
    await declare(url, keyB, [route(B)]);

    const items = await listing(url);
    expect(resources(items)).toEqual([CHUNK, CHUNK]);
    expect(items.map((i) => i.accepts[0].payTo).sort()).toEqual([A.payTo, B.payTo].sort());
  });

  test("a key cannot declare for another provider, and the other provider's items stay as they were", async () => {
    const rig = newRig();
    const { url } = await boot(rig);
    const keyA = await enroll(url, A);
    const keyB = await enroll(url, B);
    await declare(url, keyB, [route(B)]);
    const before = await listing(url);

    const forgedByA = await declare(url, keyA, [route(A, { accepts: [requirementsOf(B)] })]);
    const forgedByOperator = await declare(url, TOKEN, [route(OP, { accepts: [requirementsOf(A)] })]);

    expect(forgedByA).toMatchObject({ status: 400, json: { index: 0 } });
    expect(forgedByA.json.message).toMatch(/^items\[0\]\.accepts\[0\]\.payTo: /);
    expect(forgedByOperator.status).toBe(400);
    expect(await listing(url)).toEqual(before);
  });
});

describe("GET /discovery/resources", () => {
  test("lists what the providers declared, in the order of resource, with the pagination", async () => {
    const rig = newRig();
    const { url } = await boot(rig);
    await crowd(url);

    const res = await call(url, "/discovery/resources");

    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      x402Version: 2,
      items: [
        expect.objectContaining({ resource: CHUNK, paidCallsToday: 0 }),
        expect.objectContaining({ resource: ECHO, serviceName: "echo" }),
        expect.objectContaining({ resource: OTHER_CHUNK }),
      ],
      pagination: { limit: 20, offset: 0, total: 3 },
    });
    expect(res.json.items.map((i: any) => i.accepts[0].payTo)).toEqual([OPERATOR, A.payTo, B.payTo]);
  });

  test("takes the filters and the page from the query string", async () => {
    const rig = newRig();
    const { url } = await boot(rig);
    await crowd(url);
    const found = async (query: string) => resources(await listing(url, query));

    expect(await found(`?payTo=${A.payTo}`)).toEqual([ECHO]);
    expect(await found("?extensions=z402")).toEqual([CHUNK]);
    expect(await found("?extensions=bazaar")).toEqual([CHUNK, ECHO, OTHER_CHUNK]);
    expect(await found("?scheme=prepaid-voucher")).toHaveLength(3);
    expect(await found("?scheme=exact")).toEqual([]);
    expect(await found("?network=zcash:regtest")).toHaveLength(3);
    expect(await found("?network=zcash:mainnet")).toEqual([]);
    expect(await found("?type=http")).toHaveLength(3);
    expect(await found("?type=mcp")).toEqual([]);
    expect(await found(`?type=http&payTo=${B.payTo}`)).toEqual([OTHER_CHUNK]);

    const page = await call(url, "/discovery/resources?limit=2&offset=1");
    expect(resources(page.json.items)).toEqual([ECHO, OTHER_CHUNK]);
    expect(page.json.pagination).toEqual({ limit: 2, offset: 1, total: 3 });
    expect((await call(url, "/discovery/resources?limit=1000")).json.pagination.limit).toBe(100);
    expect((await call(url, "/discovery/resources?limit=0")).json.pagination.limit).toBe(1);
    expect((await call(url, "/discovery/resources?offset=5")).json).toMatchObject({
      items: [],
      pagination: { offset: 5, total: 3 },
    });
  });

  test("answers the request the stock client makes: type and offset, a JSON content type and no key", async () => {
    const rig = newRig();
    const { url } = await boot(rig);
    await crowd(url);

    const res = await call(url, "/discovery/resources?type=http&offset=0", {
      headers: { "content-type": "application/json" },
    });

    expect(res.status).toBe(200);
    expect(res.json.x402Version).toBe(2);
    expect(Array.isArray(res.json.items)).toBe(true);
    expect(res.json.items).toHaveLength(3);
    const { limit, offset, total } = res.json.pagination;
    expect([typeof limit, typeof offset, typeof total]).toEqual(["number", "number", "number"]);
    expect({ limit, offset, total }).toEqual({ limit: 20, offset: 0, total: 3 });
  });

  test("a failure that is no refusal is a 500 that says nothing of the cause, and is logged", async () => {
    const rig = newRig();
    const { url } = await boot(rig);
    vi.spyOn(Catalog.prototype, "list").mockImplementation(() => {
      throw new Error("index on fire");
    });

    const res = await call(url, "/discovery/resources");

    expect(res).toMatchObject({ status: 500, json: { error: "internal_error" } });
    expect(rig.lines.some((line) => line.includes("index on fire"))).toBe(true);
  });
});

describe("GET /discovery/search", () => {
  test("finds a substring of the resource, the description, the service name or a tag, whatever its case", async () => {
    const rig = newRig();
    const { url } = await boot(rig);
    await crowd(url);
    const found = async (query: string) => resources((await call(url, `/discovery/search?${query}`)).json.resources);

    expect(await found("query=ECHO")).toEqual([ECHO]);
    expect(await found("query=Demo")).toEqual([CHUNK, ECHO, OTHER_CHUNK]);
    expect(await found("query=chunks")).toEqual([CHUNK, OTHER_CHUNK]);
    expect(await found("query=4023")).toEqual([OTHER_CHUNK]);
    expect(await found("query=nothing-matches")).toEqual([]);
    expect(await found(`query=chunk&payTo=${B.payTo}`)).toEqual([OTHER_CHUNK]);
    expect(await found("query=chunk&type=mcp")).toEqual([]);
  });

  test("pages by cursor until it is null", async () => {
    const rig = newRig();
    const { url } = await boot(rig);
    await crowd(url);

    const first = await call(url, "/discovery/search?query=127.0.0.1&limit=2");
    expect(first.status).toBe(200);
    expect(first.json).toEqual({
      x402Version: 2,
      resources: [expect.objectContaining({ resource: CHUNK }), expect.objectContaining({ resource: ECHO })],
      partialResults: false,
      pagination: { limit: 2, cursor: "2" },
    });

    const last = await call(url, "/discovery/search?query=127.0.0.1&limit=2&cursor=2");
    expect(resources(last.json.resources)).toEqual([OTHER_CHUNK]);
    expect(last.json.pagination).toEqual({ limit: 2, cursor: null });
  });

  test("answers the request the stock client makes, a JSON content type and no key", async () => {
    const rig = newRig();
    const { url } = await boot(rig);
    await crowd(url);

    const res = await call(url, "/discovery/search?query=chunk&type=http&limit=5", {
      headers: { "content-type": "application/json" },
    });

    expect(res.status).toBe(200);
    expect(res.json.x402Version).toBe(2);
    expect(Array.isArray(res.json.resources)).toBe(true);
    expect(res.json.partialResults).toBe(false);
    expect(typeof res.json.pagination.limit).toBe("number");
  });

  test("a failure that is no refusal is a 500 that says nothing of the cause, and is logged", async () => {
    const rig = newRig();
    const { url } = await boot(rig);
    vi.spyOn(Catalog.prototype, "search").mockImplementation(() => {
      throw new Error("index on fire");
    });

    const res = await call(url, "/discovery/search?query=chunk");

    expect(res).toMatchObject({ status: 500, json: { error: "internal_error" } });
    expect(rig.lines.some((line) => line.includes("index on fire"))).toBe(true);
  });
});

describe.each([
  ["GET /discovery/resources", "/discovery/resources"],
  ["GET /discovery/search", "/discovery/search?query=chunk"],
])("%s needs no key, but a key that names no provider is refused", (_name, path) => {
  test("answers a request with no key", async () => {
    const rig = newRig();
    const { url } = await boot(rig);
    expect((await call(url, path)).status).toBe(200);
  });

  test("answers a request with the key of a provider or the operator's token", async () => {
    const rig = newRig();
    const { url } = await boot(rig);
    const keyA = await enroll(url, A);
    expect((await call(url, path, { token: keyA })).status).toBe(200);
    expect((await call(url, path, { token: TOKEN })).status).toBe(200);
  });

  test("refuses a key that names nobody with 401 and a Bearer challenge", async () => {
    const rig = newRig();
    const { url } = await boot(rig);
    const keyA = await enroll(url, A);
    const strangers: Array<Init> = [
      { token: "" },
      { token: "wrong" },
      { token: `${keyA}x` },
      { headers: { authorization: "Basic YTpi" } },
      { headers: { authorization: "Bearer" } },
    ];

    for (const init of strangers) {
      const res = await call(url, path, init);
      expect(res).toMatchObject({ status: 401, json: { error: "unauthorized" } });
      expect(res.headers.get("www-authenticate")).toBe("Bearer");
    }
  });

  test("refuses the key that a rotation replaced, and answers the new one", async () => {
    const rig = newRig();
    const { url } = await boot(rig);
    const oldKey = await enroll(url, A);
    const newKey = (await register(url, A)).json.apiKey as string;

    expect((await call(url, path, { token: oldKey })).status).toBe(401);
    expect((await call(url, path, { token: newKey })).status).toBe(200);
  });

  test("with no token configured, answers no header and refuses a header that names nobody", async () => {
    const rig = newRig();
    const { url } = await boot(rig, { authToken: undefined });
    expect((await call(url, path)).status).toBe(200);
    expect((await call(url, path, { token: "anybody" })).status).toBe(401);
  });
});

describe("a query the catalog refuses is a 400 invalid_request that names the field and keeps the value out", () => {
  test.each([
    ["a limit that is no number", "/discovery/resources?limit=secretword", /^limit: /],
    ["an empty limit", "/discovery/resources?limit=", /^limit: /],
    ["a negative offset", "/discovery/resources?offset=-1", /^offset: /],
    ["an offset that is no number", "/discovery/resources?offset=secretword", /^offset: /],
    ["an offset of 16 digits", `/discovery/resources?offset=${"9".repeat(16)}`, /^offset: /],
    ["an offset given twice", "/discovery/resources?offset=1&offset=secretword", /^offset: /],
    ["a type given twice", "/discovery/resources?type=http&type=secretword", /^type: /],
    ["no query", "/discovery/search", /^query: /],
    ["an empty query", "/discovery/search?query=", /^query: /],
    ["a query of 257 characters", `/discovery/search?query=${"secretword".repeat(25)}xxxxxxx`, /^query: /],
    ["a query given twice", "/discovery/search?query=secretword&query=secretword", /^query: /],
    ["a cursor that is no number", "/discovery/search?query=a&cursor=secretword", /^cursor: /],
    ["a limit that is no number", "/discovery/search?query=secretword&limit=secretword", /^limit: /],
  ])("%s", async (_name, path, message) => {
    const rig = newRig();
    const { url } = await boot(rig);

    const res = await call(url, path);

    expect(res.status).toBe(400);
    expect(res.json).toEqual({ error: "invalid_request", message: expect.stringMatching(message) });
    expect(JSON.stringify(res.json)).not.toContain("secretword");
  });
});

describe("a settled payment", () => {
  test("counts for the declared item the payment names, whatever query string it carries", async () => {
    const rig = newRig();
    const { url } = await boot(rig);
    const keyA = await enroll(url, A);
    const declared = (await declare(url, keyA, [route(A)])).json.items[0];
    expect(declared.paidCallsToday).toBe(0);
    await sleep(5);

    await firstSale(rig, url, keyA, A);
    const [once] = await listing(url);
    await sale(url, keyA, A, 1000n);
    const [twice] = await listing(url);

    expect(once.paidCallsToday).toBe(1);
    expect(twice.paidCallsToday).toBe(2);
    expect(once.lastSeen).toBe(declared.lastSeen);
    expect(Date.parse(once.lastUpdated)).toBeGreaterThan(Date.parse(declared.lastUpdated));
    expect(await listing(url)).toHaveLength(1);
  });

  test("counts for its own provider's item when two providers list the same URL", async () => {
    const rig = newRig();
    const { url } = await boot(rig);
    const keyA = await enroll(url, A);
    const keyB = await enroll(url, B);
    await declare(url, keyA, [route(A)]);
    await declare(url, keyB, [route(B)]);

    await firstSale(rig, url, keyA, A);

    const items = await listing(url);
    const countOf = (who: Who) => items.find((i) => i.accepts[0].payTo === who.payTo).paidCallsToday;
    expect([countOf(A), countOf(B)]).toEqual([1, 0]);
  });

  test("counts only a settle that succeeded", async () => {
    const rig = newRig();
    const { url } = await boot(rig);
    const keyA = await enroll(url, A);
    const keyB = await enroll(url, B);
    await declare(url, keyA, [route(A)]);
    await declare(url, keyB, [route(B)]);
    const rA = requirementsOf(A);
    const rB = requirementsOf(B);
    const txid = rig.chainOf(A.payTo).broadcast({ outputs: [{ to: A.payTo, valueZat: W, memo: `${K}:1` }] });
    const first = payment(rA, 500n, { txid });
    const countsOf = async () => (await listing(url)).map((i) => i.paidCallsToday);

    // A verify records nothing
    expect((await verify(url, keyA, first, rA)).json.isValid).toBe(true);
    expect(await countsOf()).toEqual([0, 0]);

    expect((await settle(url, keyA, first, rA)).json.success).toBe(true);
    const counted = await countsOf();
    expect(counted.slice().sort()).toEqual([0, 1]);

    // The same voucher again is behind the session, and a payment to another payTo is refused
    const stale = await settle(url, keyA, first, rA);
    const crossed = await settle(url, keyA, payment(rB, 500n), rB);
    const unreadable = await call(url, "/settle", { token: keyA, body: {} });

    expect(stale.json).toMatchObject({ success: false, errorReason: "z402_cumulative_mismatch" });
    expect(crossed.json).toMatchObject({ success: false, errorReason: "invalid_payment_requirements" });
    expect(unreadable.json).toMatchObject({ success: false, errorReason: "invalid_payload" });
    expect(await countsOf()).toEqual(counted);
  });

  test("is reported to the catalog with the provider, and the payload and requirements as they were sent", async () => {
    const rig = newRig();
    const { url } = await boot(rig);
    const keyA = await enroll(url, A);
    const me = await call(url, "/providers/me", { token: keyA });
    const paid = vi.spyOn(Catalog.prototype, "recordPaid");
    const txid = rig.chainOf(A.payTo).broadcast({ outputs: [{ to: A.payTo, valueZat: W, memo: `${K}:1` }] });
    const r = requirementsOf(A);
    const sent = {
      ...payment(r, 500n, { txid }),
      accepted: { ...r, amount: "1", maxTimeoutSeconds: 999 },
      note: "a field no schema knows",
    } as PaymentPayload;
    expect((await verify(url, keyA, sent, r)).json.isValid).toBe(true);
    expect(paid).not.toHaveBeenCalled();

    expect((await settle(url, keyA, sent, r)).json.success).toBe(true);

    expect(paid).toHaveBeenCalledTimes(1);
    const [provider, payload, requirements] = paid.mock.calls[0] ?? [];
    expect(provider).toEqual({
      id: me.json.providerId,
      network: NETWORK,
      payTo: A.payTo,
      terms: DEMO_TERMS,
      termsVersion: termsVersion(A.payTo, 500n, DEMO_TERMS),
    });
    expect(payload).toEqual(sent);
    expect(requirements).toEqual(r);
  });

  test("leaves the answer as it was when the catalog cannot record it, and logs the failure", async () => {
    const rig = newRig();
    const { url } = await boot(rig);
    const keyA = await enroll(url, A);
    await declare(url, keyA, [route(A)]);
    vi.spyOn(Catalog.prototype, "recordPaid").mockImplementation(() => {
      throw new Error("catalog on fire");
    });

    const res = await firstSale(rig, url, keyA, A);
    const next = await sale(url, keyA, A, 1000n);

    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ success: true, network: NETWORK, amount: "500" });
    expect(next.json).toMatchObject({ success: true, extra: { session: { cumulativeZat: "1000" } } });
    expect(rig.lines.some((l) => l.startsWith("catalog:") && l.includes("catalog on fire"))).toBe(true);
  });

  test("leaves the answer as it was when the log that should report the failure fails too", async () => {
    const rig = newRig();
    const log = (msg: string, err?: unknown) => {
      if (msg.startsWith("catalog:")) throw new Error("log is down");
      rig.log(msg, err);
    };
    const { url } = await boot(rig, { log });
    const keyA = await enroll(url, A);
    const record = vi.spyOn(Catalog.prototype, "recordPaid").mockImplementation(() => {
      throw new Error("catalog on fire");
    });

    const res = await firstSale(rig, url, keyA, A);

    expect(record).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ success: true });
  });

  test("lists a provider that never declared from its payments, as the server and the payer give it", async () => {
    const rig = newRig();
    const { url } = await boot(rig);
    const keyB = await enroll(url, B);

    await firstSale(rig, url, keyB, B, {
      resource: { url: `${CHUNK}?session=abc`, description: "Echoed description", mimeType: "text/plain" },
    });

    const [item, ...others] = await listing(url);
    expect(others).toEqual([]);
    expect(item).toEqual({
      resource: CHUNK,
      type: "http",
      x402Version: 2,
      accepts: [requirementsOf(B)],
      lastUpdated: expect.stringMatching(ISO),
      description: "Echoed description",
      mimeType: "text/plain",
      extensions: { bazaar: BAZAAR_GET },
      paidCallsToday: 1,
    });
  });

  test("lists a provider that never declared from the server's requirements, not the payer's accepted", async () => {
    const rig = newRig();
    const { url } = await boot(rig);
    const keyB = await enroll(url, B);
    const txid = rig.chainOf(B.payTo).broadcast({ outputs: [{ to: B.payTo, valueZat: W, memo: `${K}:1` }] });
    const r = requirementsOf(B);
    // The scheme compares only accepted.scheme and accepted.network, so a payer may echo the rest as it likes
    const echoed: PaymentPayload = {
      ...payment(r, 500n, { txid }),
      accepted: { ...r, amount: "1", maxTimeoutSeconds: 999 },
    };
    expect((await verify(url, keyB, echoed, r)).json.isValid).toBe(true);
    expect((await settle(url, keyB, echoed, r)).json.success).toBe(true);

    const [item] = await listing(url);
    expect(item.accepts).toEqual([r]);
  });

  test("never lists a payment of a provider that declared, and never rewrites what it declared", async () => {
    const rig = newRig();
    const { url } = await boot(rig);
    const keyB = await enroll(url, B);
    const declared = (await declare(url, keyB, [route(B)])).json.items[0];

    await firstSale(rig, url, keyB, B, {
      resource: { url: `${CHUNK}?session=abc`, description: "Overwritten by a payer", mimeType: "text/html" },
    });
    await sale(url, keyB, B, 1000n, { resource: { url: ECHO, description: "A listing made up by a payer" } });
    await sale(url, keyB, B, 1500n, { resource: { url: "http://evil.example/steal" } });

    const items = await listing(url);
    expect(resources(items)).toEqual([CHUNK]);
    expect(items[0]).toMatchObject({
      description: declared.description,
      mimeType: declared.mimeType,
      paidCallsToday: 1,
    });
  });

  test("keeps a provider that declared closed to payment listings across a restart", async () => {
    const rig = newRig();
    const first = await boot(rig);
    const keyB = await enroll(first.url, B);
    await declare(first.url, keyB, [route(B, { resource: ECHO })]);
    await first.close();

    const again = await boot(rig);
    await firstSale(rig, again.url, keyB, B);

    expect(resources(await listing(again.url))).toEqual([ECHO]);
  });

  test("lists a provider from a payment only until it declares, and then removes that listing for good", async () => {
    const rig = newRig();
    const { url } = await boot(rig);
    const keyB = await enroll(url, B);
    await firstSale(rig, url, keyB, B);
    expect(resources(await listing(url))).toEqual([CHUNK]);

    await declare(url, keyB, [route(B, { resource: ECHO })]);
    expect(resources(await listing(url))).toEqual([ECHO]);

    await sale(url, keyB, B, 1000n);
    expect(resources(await listing(url))).toEqual([ECHO]);
  });
});

describe("the catalog file and shutdown", () => {
  test("a restart finds the catalog in the providers directory, with a change made just before close()", async () => {
    const rig = newRig();
    const first = await boot(rig);
    const keyA = await enroll(first.url, A);
    await declare(first.url, keyA, [route(A)]);
    await firstSale(rig, first.url, keyA, A);
    await first.close();

    expect(existsSync(join(rig.providers, "discovery.json"))).toBe(true);
    const again = await boot(rig);
    const [item, ...others] = await listing(again.url);
    expect(others).toEqual([]);
    expect(item).toMatchObject({ resource: CHUNK, paidCallsToday: 1 });
  });

  test("without a providers directory the catalog lives in memory only", async () => {
    const rig = newRig();
    const first = await boot(rig, { providers: undefined });
    expect((await declare(first.url, TOKEN, [route(OP)])).status).toBe(200);
    expect(resources(await listing(first.url))).toEqual([CHUNK]);
    await first.close();

    const again = await boot(rig, { providers: undefined });
    expect(await listing(again.url)).toEqual([]);
    expect(readdirSync(rig.dir)).toEqual([]);
  });

  test("a declaration in flight when close() runs is answered and is in the file when close() resolves", async () => {
    const rig = newRig();
    const handle = await boot(rig);
    const keyA = await enroll(handle.url, A);
    await declare(handle.url, keyA, [route(A)]);
    const original = Catalog.prototype.declare;
    let closing: Promise<void> | undefined;
    vi.spyOn(Catalog.prototype, "declare").mockImplementation(function (this: Catalog, p, body) {
      closing = handle.close();
      return original.call(this, p, body);
    });

    // The connection ends with the answer, so the server has nothing left to wait for
    const res = await call(handle.url, "/discovery/resources", {
      method: "POST",
      token: keyA,
      body: { items: [route(A, { description: "Changed while closing" })] },
      headers: { connection: "close" },
    });
    await closing;
    vi.restoreAllMocks();

    expect(res.status).toBe(200);
    const again = await boot(rig);
    expect((await listing(again.url))[0]).toMatchObject({ resource: CHUNK, description: "Changed while closing" });
  });

  test("the catalog is closed once the server has stopped, and while every lock is still held", async () => {
    const rig = newRig();
    const handle = await boot(rig, { ledgerPath: join(rig.dir, "operator.jsonl") });
    await enroll(handle.url, A);
    const original = Catalog.prototype.close;
    const seen: Array<{ locks: number; serving: boolean }> = [];
    vi.spyOn(Catalog.prototype, "close").mockImplementation(async function (this: Catalog) {
      const serving = await fetch(`${handle.url}/supported`).then(
        () => true,
        () => false,
      );
      seen.push({ locks: locksUnder(rig.dir).length, serving });
      return original.call(this);
    });

    await handle.close();
    await handle.close();

    // The registry, the operator's ledger and the ledger of provider A
    expect(seen).toEqual([{ locks: 3, serving: false }]);
    expect(locksUnder(rig.dir)).toEqual([]);
  });

  test("still lets every lock go when the catalog cannot be closed", async () => {
    const rig = newRig();
    const handle = await boot(rig, { ledgerPath: join(rig.dir, "operator.jsonl") });
    // Its close() is what is tested and it rejects, so the hook after the test must not call it again
    running.splice(running.indexOf(handle), 1);
    await enroll(handle.url, A);
    vi.spyOn(Catalog.prototype, "close").mockRejectedValue(new Error("catalog on fire"));

    await expect(handle.close()).rejects.toThrow("catalog on fire");

    expect(locksUnder(rig.dir)).toEqual([]);
  });

  test("a catalog file that cannot be read is set aside and the facilitator still starts", async () => {
    const rig = newRig();
    mkdirSync(rig.providers, { recursive: true, mode: 0o700 });
    writeFileSync(join(rig.providers, "discovery.json"), "{ this is not a catalog");

    const handle = await boot(rig);

    expect(await listing(handle.url)).toEqual([]);
    expect(readdirSync(rig.providers).some((name) => name.startsWith("discovery.json.bad-"))).toBe(true);
    expect(rig.lines.some((line) => line.startsWith("catalog:") && line.includes("discovery.json"))).toBe(true);
  });
});

describe("what the log and the answers keep to themselves", () => {
  test("a request line holds the method, the path and the status, and no query string", async () => {
    const rig = newRig();
    const { url } = await boot(rig);
    const keyA = await enroll(url, A);
    const me = (await call(url, "/providers/me", { token: keyA })).json.providerId as string;
    await declare(url, keyA, [route(A)]);
    rig.lines.length = 0;

    await call(url, "/discovery/search?query=secretword");
    await call(url, `/discovery/resources?payTo=${A.payTo}&extensions=secretword`);
    await call(url, "/discovery/search?query=secretword&limit=secretword");
    await call(url, "/discovery/resources?limit=secretword");
    await call(url, "/discovery/search?query=secretword", { token: "nope" });
    await call(url, "/discovery/resources", { token: keyA });
    await declare(url, keyA, [route(A, { resource: "http://127.0.0.1:4021/chunk?apikey=hunter2" })]);
    await call(url, "/discovery/resources?apikey=hunter2", { method: "POST", token: "nope", body: {} });

    expect(rig.lines).toEqual([
      "GET /discovery/search 200",
      "GET /discovery/resources 200",
      "GET /discovery/search 400",
      "GET /discovery/resources 400",
      "GET /discovery/search 401",
      "GET /discovery/resources 200",
      `POST /discovery/resources 200 ${me}`,
      "POST /discovery/resources 401",
    ]);
    for (const line of rig.lines) {
      for (const leak of ["secretword", "hunter2", "?", keyA, A.uivk, TOKEN]) expect(line).not.toContain(leak);
    }
  });

  test("a declared URL keeps its query string out of the answers, the list and the log", async () => {
    const rig = newRig();
    const { url } = await boot(rig);
    const keyA = await enroll(url, A);
    rig.lines.length = 0;

    const declared = await declare(url, keyA, [route(A, { resource: `${CHUNK}?session=abc&apikey=hunter2#frag` })]);
    const listed = await call(url, "/discovery/resources");
    const found = await call(url, "/discovery/search?query=chunk");

    expect(declared.json.items[0].resource).toBe(CHUNK);
    const everything = JSON.stringify([declared.json, listed.json, found.json]) + rig.lines.join("\n");
    for (const leak of ["hunter2", "session=abc", "#frag", keyA, A.uivk]) expect(everything).not.toContain(leak);
  });
});

describe("GET /supported", () => {
  test("lists the bazaar extension and leaves the rest of the answer as it was", async () => {
    const rig = newRig();
    const { url } = await boot(rig);

    const res = await call(url, "/supported");

    expect(res.json.extensions).toEqual(["bazaar"]);
    expect(res.json.kinds).toHaveLength(1);
    expect(res.json.signers).toEqual({ "zcash:*": [] });
  });

  test("every runtime registers the bazaar extension on its facilitator", async () => {
    const runtime = await openRuntime({
      network: NETWORK,
      payTo: A.payTo,
      chain: new FakeChain().viewFor(A.payTo),
      priceZat: 500n,
      terms: DEMO_TERMS,
      onFatal: () => undefined,
      log: () => undefined,
    });
    try {
      expect(runtime.facilitator.getSupported().extensions).toEqual(["bazaar"]);
    } finally {
      runtime.stop();
      runtime.release();
    }
  });
});

describe("createFacilitatorApp", () => {
  const operator: Tenant = {
    id: providerId(NETWORK, OPERATOR),
    network: NETWORK,
    payTo: OPERATOR,
    facilitator: new x402Facilitator(),
    extra: () => ({ ...encodeTerms(DEMO_TERMS), termsVersion: "0123456789abcdef" }),
  };

  /** Serves an app from createFacilitatorApp alone, for the tests that do not need a whole facilitator */
  async function serve(app: ReturnType<typeof createFacilitatorApp>): Promise<string> {
    const server: Server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    running.push({
      close: () =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    });
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  test("serves the discovery routes from the catalog it is given, for the rail its provider advertises", async () => {
    const url = await serve(createFacilitatorApp({ operator, tenantOf: () => operator, catalog: Catalog.load() }));
    const accepts = [requirementsOf(OP, { termsVersion: "0123456789abcdef" })];

    const declared = await declare(url, undefined, [route(OP, { accepts })]);
    const refused = await declare(url, undefined, [route(OP)]);

    expect(declared.status).toBe(200);
    expect(refused).toMatchObject({ status: 400, json: { index: 0 } });
    expect(refused.json.message).toMatch(/^items\[0\]\.accepts\[0\]\.extra\.termsVersion: /);
    expect(resources(await listing(url))).toEqual([CHUNK]);
    expect((await call(url, "/discovery/search?query=chunk")).json.resources).toHaveLength(1);
  });

  test("counts a payment that settled even when its answer cannot be sent", async () => {
    // JSON has no BigInt, so the answer of this scheme cannot go out
    const unsendable: SchemeNetworkFacilitator = {
      scheme: SCHEME,
      caipFamily: "zcash:*",
      getExtra: () => undefined,
      getSigners: () => [],
      verify: async () => ({ isValid: true }),
      settle: async () => ({ success: true, transaction: "t", network: NETWORK, extra: { n: 1n } }),
    };
    const tenant: Tenant = { ...operator, facilitator: new x402Facilitator().register(NETWORK, unsendable) };
    const log = vi.fn<(msg: string, err?: unknown) => void>();
    const url = await serve(
      createFacilitatorApp({ operator: tenant, tenantOf: () => tenant, catalog: Catalog.load(), log }),
    );
    const r = requirementsOf(OP, { termsVersion: "0123456789abcdef" });
    await declare(url, undefined, [route(OP, { accepts: [r] })]);

    const res = await settle(url, "any", payment(r, 500n), r);

    expect(res).toMatchObject({ status: 500, json: { error: "internal_error" } });
    expect(log).toHaveBeenCalledWith(expect.any(String), expect.any(TypeError));
    expect((await listing(url))[0]).toMatchObject({ resource: CHUNK, paidCallsToday: 1 });
  });

  test("has no discovery routes without a catalog", async () => {
    const url = await serve(createFacilitatorApp({ operator, tenantOf: () => operator }));

    for (const [method, path] of [
      ["POST", "/discovery/resources"],
      ["GET", "/discovery/resources"],
      ["GET", "/discovery/search?query=chunk"],
    ] as const) {
      const res = await call(url, path, { method });
      expect(res).toMatchObject({ status: 404, json: { error: "not_found" } });
    }
  });
});
