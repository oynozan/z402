import { createServer, get as httpGet, Agent as HttpAgent } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer as netServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { startFacilitator } from "@z402/facilitator";
import { DEMO_TERMS } from "@z402/protocol";
import { FakeChain } from "@z402/testkit";
import express, { type Request, type Response } from "express";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  CallStats,
  ConfigError,
  createPaidService,
  loadDotEnv,
  loadServiceEnv,
  onDelivered,
  serve,
  type Listening,
  type PaidRoute,
  type PaidService,
  type ServiceDefinition,
  type ServiceEnv,
} from "../src/index.js";
import {
  declarationRefusal,
  paymentRequiredOf,
  railOf,
  startTestStack,
  TEST_NETWORK,
  TEST_PAY_TO,
  TEST_PUBLIC_URL,
  TEST_TOKEN,
  type CatalogStub,
  type Declaration,
  type TestStack,
  type TestStackOptions,
} from "../src/testing.js";

const running: TestStack[] = [];
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const s of running.splice(0)) await s.close();
  for (const c of closers.splice(0).reverse()) await c();
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

const needsText = (req: Request, res: Response, next: () => void): void => {
  if (typeof req.body?.text !== "string") {
    res.status(400).json({ error: "text_required" });
    return;
  }
  next();
};

const DEFINITION: ServiceDefinition = {
  serviceName: "Echo",
  tags: ["test"],
  routes: [
    {
      method: "POST",
      path: "/v1/echo",
      description: "Echoes text back",
      unit: "echo",
      note: "Test note",
      discovery: {
        bodyType: "json",
        input: { text: "hello" },
        inputSchema: { properties: { text: { type: "string" } }, required: ["text"] },
        output: { example: { text: "hello" } },
      },
      prepare: [express.json(), needsText],
    },
    {
      method: "GET",
      path: "/v1/items/:id",
      probePath: "/v1/items/example",
      description: "Reads one item",
      unit: "item",
      discovery: { output: { example: { id: "example" } } },
    },
  ],
};

async function echoStack(
  o: {
    ready?: () => boolean;
    delivered?: string[];
    served?: string[];
    answerAfterMs?: number;
    log?: string[];
    stack?: Partial<TestStackOptions>;
  } = {},
): Promise<TestStack & { paid: PaidService }> {
  const built: { paid?: PaidService } = {};
  const stack = await startTestStack({
    ...o.stack,
    build: async (env: ServiceEnv) => {
      const paid = await createPaidService({
        env,
        service: DEFINITION,
        ready: o.ready,
        ...(o.log !== undefined && { log: (line: string) => o.log?.push(line) }),
      });
      built.paid = paid;
      const { app } = paid;
      app.post("/v1/echo", async (req, res) => {
        o.served?.push(req.body.text);
        onDelivered(res, { ok: () => o.delivered?.push("ok"), failed: () => o.delivered?.push("failed") });
        if (o.answerAfterMs !== undefined) await new Promise((resolve) => setTimeout(resolve, o.answerAfterMs));
        res.json({ text: req.body.text });
      });
      app.get("/v1/items/:id", (req, res) => {
        res.json({ id: req.params.id });
      });
      return { app, close: paid.close };
    },
  });
  running.push(stack);
  if (built.paid === undefined) throw new Error("the service was not built");
  return Object.assign(stack, { paid: built.paid });
}

const post = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe("loadServiceEnv", () => {
  const base = {
    Z402_FACILITATOR_URL: "http://127.0.0.1:4022/",
    Z402_PAY_TO: TEST_PAY_TO,
  };

  const own = { port: 1, priceZat: 200n };

  test("defaults", () => {
    const env = loadServiceEnv(base, { port: 4031, priceZat: 200n });
    expect(env).toMatchObject({
      network: "zcash:regtest",
      facilitatorUrl: "http://127.0.0.1:4022",
      facilitatorToken: undefined,
      payTo: TEST_PAY_TO,
      priceZat: 200n,
      publicUrl: "http://localhost:4031",
      host: "127.0.0.1",
      port: 4031,
      facilitatorWaitMs: 120_000,
    });
    expect(env.declareIntervalMs).toBeUndefined();
    expect(loadServiceEnv({ ...base, Z402_FACILITATOR_WAIT_MS: "0" }, own).facilitatorWaitMs).toBe(0);
  });

  test("Z402_PRICE_ZAT, when set, overrides the price the service gives", () => {
    expect(loadServiceEnv({ ...base, Z402_PRICE_ZAT: "750" }, own).priceZat).toBe(750n);
    expect(loadServiceEnv({ ...base, Z402_PRICE_ZAT: "" }, own).priceZat).toBe(200n);
    for (const wrong of ["0", "0500", "-1", "1.5", "5e2", "lots"]) {
      expect(() => loadServiceEnv({ ...base, Z402_PRICE_ZAT: wrong }, own), wrong).toThrow(/^Z402_PRICE_ZAT: /);
    }
  });

  test("names the variable at fault", () => {
    expect(() => loadServiceEnv({ ...base, Z402_FACILITATOR_URL: "" }, own)).toThrow(/^Z402_FACILITATOR_URL/);
    expect(() => loadServiceEnv({ ...base, Z402_PAY_TO: "utest1abc" }, own)).toThrow(/^Z402_PAY_TO/);
    expect(() => loadServiceEnv({ ...base, Z402_PRICE_ZAT: "0" }, own)).toThrow(/^Z402_PRICE_ZAT/);
    expect(() => loadServiceEnv({ ...base, PORT: "70000" }, own)).toThrow(/^PORT/);
    expect(() => loadServiceEnv({ ...base, PUBLIC_URL: "ftp://x" }, own)).toThrow(/^PUBLIC_URL/);
    expect(() => loadServiceEnv({ ...base, Z402_NETWORK: "devnet" }, own)).toThrow(ConfigError);
    expect(() => loadServiceEnv({ ...base, Z402_FACILITATOR_WAIT_MS: "2m" }, own)).toThrow(
      /^Z402_FACILITATOR_WAIT_MS/,
    );
  });

  test("reads the token and payTo from files", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "kit-env-"));
    writeFileSync(join(dir, "token"), "secret-token\n");
    writeFileSync(join(dir, "pay-to"), `${TEST_PAY_TO}\n`);
    const env = loadServiceEnv(
      {
        Z402_FACILITATOR_URL: "http://f",
        Z402_FACILITATOR_TOKEN_FILE: join(dir, "token"),
        Z402_PAY_TO_FILE: join(dir, "pay-to"),
      },
      { port: 1, priceZat: 500n },
    );
    expect(env.facilitatorToken).toBe("secret-token");
    expect(env.payTo).toBe(TEST_PAY_TO);
    expect(() =>
      loadServiceEnv({ Z402_FACILITATOR_URL: "http://f", Z402_PAY_TO_FILE: join(dir, "missing") }, own),
    ).toThrow(/^Z402_PAY_TO_FILE/);
  });
});

describe("a paid service", () => {
  test("an unpaid call gets a 402 that declares the route for discovery", async () => {
    const stack = await echoStack();
    const res = await fetch(`${stack.url}/v1/echo`, post({ text: "hi" }));
    expect(res.status).toBe(402);
    const required = decodePaymentRequiredHeader(res.headers.get("payment-required") ?? "");
    expect(required.resource).toMatchObject({
      url: `${TEST_PUBLIC_URL}/v1/echo`,
      description: "Echoes text back",
      mimeType: "application/json",
      serviceName: "Echo",
    });
    expect(required.accepts[0]).toMatchObject({
      scheme: "prepaid-voucher",
      network: "zcash:regtest",
      amount: "500",
      asset: "ZEC",
      payTo: TEST_PAY_TO,
    });
    expect(required.accepts[0]?.extra).toMatchObject({ windowZat: "100000", creditRatioBps: 2500 });
    const bazaar = required.extensions?.bazaar as { info: { input: { method: string; type: string } } };
    expect(bazaar.info.input).toMatchObject({ type: "http", method: "POST" });
    expect(required.extensions?.z402).toEqual({ unit: "echo", note: "Test note" });
  });

  test("a paid call is served, settled, counted and delivered", async () => {
    const delivered: string[] = [];
    const stack = await echoStack({ delivered });
    const first = await stack.paidFetch(`${stack.url}/v1/echo`, post({ text: "one" }));
    expect(first.status).toBe(200);
    expect(first.headers.get("payment-response")).toBeTruthy();
    expect(await first.json()).toEqual({ text: "one" });
    const second = await stack.paidFetch(`${stack.url}/v1/echo`, post({ text: "two" }));
    expect(await second.json()).toEqual({ text: "two" });

    const health = await fetch(`${stack.url}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true, ready: true, service: "Echo", callsToday: 2, priceZat: "500" });
    expect(delivered).toEqual(["ok", "ok"]);
    expect(stack.scheme.session(TEST_PAY_TO)?.cumulativeZat).toBe(1000n);
  });

  test("a request that fails its checks is refused before any voucher exists", async () => {
    const stack = await echoStack();
    const res = await stack.paidFetch(`${stack.url}/v1/echo`, post({ nope: true }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "text_required" });
    expect(stack.scheme.session(TEST_PAY_TO)).toBeUndefined();
  });

  test("a discovery probe skips prepare and gets the 402, but a paid request never skips it", async () => {
    const stack = await echoStack();
    const probe = await fetch(`${stack.url}/v1/echo`, { method: "POST", headers: { "x-z402-probe": "1" } });
    expect(probe.status).toBe(402);
    const disguised = await fetch(`${stack.url}/v1/echo`, {
      method: "POST",
      headers: { "x-z402-probe": "1", "payment-signature": "e30=" },
    });
    expect(disguised.status).toBe(400);
  });

  test("a wrong method is refused before payment, and HEAD on a GET route must pay", async () => {
    const stack = await echoStack();
    const wrong = await fetch(`${stack.url}/v1/echo`);
    expect(wrong.status).toBe(405);
    expect(wrong.headers.get("allow")).toBe("POST");
    const head = await fetch(`${stack.url}/v1/items/abc`, { method: "HEAD" });
    expect(head.status).toBe(402);
    const paid = await stack.paidFetch(`${stack.url}/v1/items/abc`);
    expect(await paid.json()).toEqual({ id: "abc" });
  });

  test("a service that is not ready refuses before payment", async () => {
    const stack = await echoStack({ ready: () => false });
    const res = await fetch(`${stack.url}/v1/echo`, post({ text: "hi" }));
    expect(res.status).toBe(503);
    expect((await fetch(`${stack.url}/health`)).status).toBe(503);
  });

  // The payment middleware matches every spelling of a path, so each one must get the route's checks and handler
  test("another spelling of a paid path gets the same checks before payment and the same handler after", async () => {
    const stack = await echoStack();
    const spellings = ["//v1/echo", "/v1//echo", "/v1/echo//", "/v1/%65cho", "/V1/Echo/"];
    for (const path of spellings) {
      const refused = await stack.paidFetch(`${stack.url}${path}`, post({ nope: true }));
      expect([path, refused.status, await refused.json()]).toEqual([path, 400, { error: "text_required" }]);
      expect([path, (await fetch(`${stack.url}${path}`)).status]).toEqual([path, 405]);
    }
    expect(stack.scheme.session(TEST_PAY_TO)).toBeUndefined();

    for (const path of spellings) {
      const served = await stack.paidFetch(`${stack.url}${path}`, post({ text: path }));
      expect([path, served.status, await served.json()]).toEqual([path, 200, { text: path }]);
    }
    for (const path of ["//v1/items/abc", "/v1/items//abc", "/v1/items/abc//", "/v1/items/%61bc"]) {
      const served = await stack.paidFetch(`${stack.url}${path}`);
      expect([path, served.status, await served.json()]).toEqual([path, 200, { id: "abc" }]);
    }
    expect(stack.scheme.session(TEST_PAY_TO)?.cumulativeZat).toBe(500n * 9n);
  });

  test("a spelling the routes cannot match is refused before payment", async () => {
    const stack = await echoStack();
    // The middleware also reads %2F as a separator, which no route does
    const res = await stack.paidFetch(`${stack.url}/v1/echo%2F`, post({ text: "hi" }));
    expect([res.status, await res.json()]).toEqual([404, { error: "not_found" }]);
    expect(stack.scheme.session(TEST_PAY_TO)).toBeUndefined();
  });

  test("copies of one voucher sent together reach the handler once, the rest are refused before payment", async () => {
    const served: string[] = [];
    const stack = await echoStack({ served, answerAfterMs: 200 });
    const all: Promise<globalThis.Response>[] = [];
    // Sends the paid retry together with three byte-for-byte copies of it
    const copying: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      if (!request.headers.has("payment-signature")) return fetch(request);
      const copies = [1, 2, 3].map(() => request.clone());
      const first = fetch(request);
      all.push(first, ...copies.map((c) => fetch(c)));
      return first;
    };
    const paidFetch = wrapFetchWithPayment(copying, new x402Client().register(TEST_NETWORK, stack.scheme));
    await paidFetch(`${stack.url}/v1/echo`, post({ text: "once" }));
    const answers: [number, unknown][] = await Promise.all(
      all.map(async (pending) => {
        const res = await pending;
        return [res.status, await res.json()] as [number, unknown];
      }),
    );
    expect(answers.filter(([status]) => status === 200)).toEqual([[200, { text: "once" }]]);
    expect(answers.filter(([status]) => status === 409)).toEqual(
      Array.from({ length: 3 }, () => [409, { error: "payment_in_flight" }]),
    );
    expect(served).toEqual(["once"]);
  });
});

describe("a client that hangs up", () => {
  test("before its paid call reaches the payment step is neither verified nor served", async () => {
    const served: string[] = [];
    let checked = 0;
    const slowCheck = async (_req: Request, _res: Response, next: () => void): Promise<void> => {
      checked += 1;
      await new Promise((resolve) => setTimeout(resolve, 300));
      next();
    };
    const definition: ServiceDefinition = {
      ...DEFINITION,
      routes: DEFINITION.routes.map((r) =>
        r.path === "/v1/echo" ? { ...r, prepare: [express.json(), slowCheck] } : r,
      ),
    };
    const built: { stats?: CallStats } = {};
    const stack = await startTestStack({
      build: async (env) => {
        const { app, stats } = await createPaidService({ env, service: definition });
        app.post("/v1/echo", (req, res) => {
          served.push(req.body.text);
          res.json({ text: req.body.text });
        });
        built.stats = stats;
        return app;
      },
    });
    running.push(stack);
    // The paid retry is abandoned while the service still checks it
    let voucher: string | undefined;
    const abandoning: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      voucher = request.headers.get("payment-signature") ?? undefined;
      if (voucher === undefined) return fetch(request);
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 100);
      return fetch(request, { signal: controller.signal });
    };
    const paidFetch = wrapFetchWithPayment(abandoning, new x402Client().register(TEST_NETWORK, stack.scheme));
    await expect(paidFetch(`${stack.url}/v1/echo`, post({ text: "gone" }))).rejects.toThrow();
    await vi.waitFor(() => expect(checked).toBe(2));
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect([served, built.stats?.today()]).toEqual([[], 0]);
    // The voucher was never settled, so it still pays for one call
    const replayed = await fetch(`${stack.url}/v1/echo`, {
      ...post({ text: "replayed" }),
      headers: { "content-type": "application/json", "payment-signature": voucher ?? "" },
    });
    expect([replayed.status, await replayed.json()]).toEqual([200, { text: "replayed" }]);
  });
});

describe("start-up", () => {
  const quiet = (): void => undefined;
  const envAt = (facilitatorUrl: string): ServiceEnv => ({
    network: TEST_NETWORK,
    facilitatorUrl,
    facilitatorToken: TEST_TOKEN,
    payTo: TEST_PAY_TO,
    priceZat: 500n,
    publicUrl: TEST_PUBLIC_URL,
    host: "127.0.0.1",
    port: 0,
  });

  async function answering(handler: express.RequestHandler): Promise<Listening> {
    const app = express();
    app.use(handler);
    const listening = await serve(app, { host: "127.0.0.1", port: 0 });
    closers.push(async () => {
      listening.server.closeAllConnections();
      await listening.close();
    });
    return listening;
  }

  test("a URL that answers as something other than a facilitator fails at once, without waiting", async () => {
    const answers: [express.RequestHandler, RegExp][] = [
      [(_req, res) => void res.status(404).send("Cannot GET /supported"), /^Z402_FACILITATOR_URL: .*404/],
      [(_req, res) => void res.status(405).end(), /^Z402_FACILITATOR_URL: .*405/],
      [(_req, res) => void res.type("html").send("<!doctype html><p>hello"), /^Z402_FACILITATOR_URL: .*invalid JSON/],
      [(_req, res) => void res.json({ hello: "world" }), /^Z402_FACILITATOR_URL: .*invalid data/],
    ];
    for (const [handler, error] of answers) {
      const other = await answering(handler);
      const started = Date.now();
      const log: string[] = [];
      const starting = createPaidService({
        env: envAt(other.url),
        service: DEFINITION,
        facilitatorWaitMs: 10_000,
        log: (m) => log.push(m),
      });
      await expect(starting).rejects.toThrow(error);
      expect(Date.now() - started).toBeLessThan(1_500);
      expect(log).toEqual([]);
    }
  }, 60_000);

  test("a facilitator that is down or failing is waited for, up to the wait", async () => {
    const failing = await answering((_req, res) => void res.status(503).json({ error: "starting" }));
    const log: string[] = [];
    const started = Date.now();
    await expect(
      createPaidService({
        env: envAt(failing.url),
        service: DEFINITION,
        facilitatorWaitMs: 2_500,
        log: (m) => log.push(m),
      }),
    ).rejects.toThrow(/^Z402_FACILITATOR_URL: cannot read \/supported .*503/);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_900);
    expect(log).toEqual([expect.stringMatching(/503.*; waiting for it$/)]);

    // Nothing listens on the port yet, and the facilitator that starts there a moment later is used
    const port = await freePort();
    const waiting = createPaidService({
      env: envAt(`http://127.0.0.1:${port}`),
      service: DEFINITION,
      facilitatorWaitMs: 20_000,
      log: quiet,
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const chain = new FakeChain();
    const facilitator = await startFacilitator({
      network: TEST_NETWORK,
      chain: chain.viewFor(TEST_PAY_TO),
      payTo: TEST_PAY_TO,
      priceZat: 500n,
      terms: DEMO_TERMS,
      authToken: TEST_TOKEN,
      port,
      log: quiet,
    });
    closers.push(() => facilitator.close());
    const { app, close } = await waiting;
    closers.push(close);
    const listening = await serve(app, { host: "127.0.0.1", port: 0 });
    closers.push(async () => {
      listening.server.closeAllConnections();
      await listening.close();
    });
    expect((await fetch(`${listening.url}/v1/echo`, post({ text: "hi" }))).status).toBe(402);
  }, 30_000);

  test("a start that waits for the facilitator logs one line, and the SDK warns about no retry", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const failing = await answering((_req, res) => void res.status(503).json({ error: "starting" }));
      const down = `http://127.0.0.1:${await freePort()}`;
      for (const url of [failing.url, down]) {
        const log: string[] = [];
        const starting = createPaidService({
          env: envAt(url),
          service: DEFINITION,
          facilitatorWaitMs: 4_500,
          log: (m) => log.push(m),
        });
        await expect(starting).rejects.toThrow(/^Z402_FACILITATOR_URL: cannot read \/supported /);
        expect(log).toEqual([expect.stringMatching(/; waiting for it$/)]);
      }
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  }, 30_000);

  test("a facilitator that takes the connection but never answers does not hold the start past the wait", async () => {
    const silent = netServer((socket) => void socket.on("error", () => undefined));
    await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
    closers.push(async () => {
      silent.close();
    });
    const { port } = silent.address() as AddressInfo;
    const started = Date.now();
    await expect(
      createPaidService({
        env: envAt(`http://127.0.0.1:${port}`),
        service: DEFINITION,
        facilitatorWaitMs: 0,
        log: quiet,
      }),
    ).rejects.toThrow(/^Z402_FACILITATOR_URL: cannot read \/supported .*timed out/);
    expect(Date.now() - started).toBeLessThan(8_000);
  }, 20_000);

  test("a misconfiguration the facilitator reports fails at once", async () => {
    const stack = await echoStack();
    const started = Date.now();
    const wrong: Partial<ServiceEnv>[] = [{ facilitatorToken: "wrong-token" }, { payTo: `uregtest1${"p".repeat(60)}` }];
    for (const change of wrong) {
      await expect(
        createPaidService({
          env: { ...stack.env, ...change },
          service: DEFINITION,
          facilitatorWaitMs: 10_000,
          log: quiet,
        }),
      ).rejects.toThrow(/^Z402_(FACILITATOR_TOKEN|PAY_TO): /);
    }
    expect(Date.now() - started).toBeLessThan(1_500);
  });
});

describe("prices", () => {
  const priced = (priceZat: bigint): ServiceDefinition => ({
    ...DEFINITION,
    routes: DEFINITION.routes.map((r) => (r.method === "GET" ? { ...r, priceZat } : r)),
  });

  test("each route charges its own price, or else the service's, in its 402, /health and declaration", async () => {
    const stack = await startTestStack({
      catalog: true,
      build: async (env) => {
        const paid = await createPaidService({ env, service: priced(700n) });
        return { app: paid.app, close: paid.close };
      },
    });
    running.push(stack);
    const echo = await paymentRequiredOf(`${stack.url}/v1/echo`, "POST");
    const item = await paymentRequiredOf(`${stack.url}/v1/items/abc`, "GET");
    expect([echo.accepts[0]?.amount, item.accepts[0]?.amount]).toEqual(["500", "700"]);
    expect(await (await fetch(`${stack.url}/health`)).json()).toMatchObject({
      priceZat: "500",
      routes: [
        { method: "POST", path: "/v1/echo", priceZat: "500" },
        { method: "GET", path: "/v1/items/:id", probePath: "/v1/items/example", priceZat: "700" },
      ],
    });
    const catalog = catalogOf(stack);
    await vi.waitFor(() => expect(catalog.declarations).toHaveLength(1));
    expect(itemsOf(catalog.declarations[0]).map((i) => i.accepts[0]?.amount)).toEqual(["500", "700"]);
  });

  test("a price outside 1 to the facilitator's windowZat stops the start, naming Z402_PRICE_ZAT", async () => {
    const stack = await echoStack();
    const refused: [Partial<ServiceEnv>, ServiceDefinition, RegExp][] = [
      [
        { priceZat: 100_001n },
        DEFINITION,
        /^Z402_PRICE_ZAT: POST \/v1\/echo would cost 100001 zat, outside 1 to 100000, the facilitator's windowZat$/,
      ],
      [{ priceZat: 0n }, DEFINITION, /^Z402_PRICE_ZAT: POST \/v1\/echo would cost 0 zat/],
      [{}, priced(100_001n), /^Z402_PRICE_ZAT: GET \/v1\/items\/:id would cost 100001 zat/],
      [{}, priced(-5n), /^Z402_PRICE_ZAT: GET \/v1\/items\/:id would cost -5 zat/],
    ];
    for (const [change, service, error] of refused) {
      const starting = createPaidService({ env: { ...stack.env, ...change }, service, facilitatorWaitMs: 0 });
      await expect(starting).rejects.toThrow(error);
      await expect(starting).rejects.toBeInstanceOf(ConfigError);
    }
    // The whole window is still a price
    const atWindow = await createPaidService({ env: { ...stack.env, priceZat: 100_000n }, service: DEFINITION });
    await atWindow.close();
  });
});

interface Bazaar {
  info: { input: Record<string, unknown> };
  routeTemplate?: string;
}

/** A declared item as the stub catalog received it */
interface Item {
  resource: string;
  accepts: { amount: string }[];
  extensions: { bazaar: Bazaar };
}

const itemsOf = (d: Declaration | undefined): Item[] => (d?.body as { items?: Item[] } | undefined)?.items ?? [];

function catalogOf(stack: TestStack): CatalogStub {
  if (stack.catalog === undefined) throw new Error("the stack has no catalog");
  return stack.catalog;
}

describe("the declaration heartbeat", () => {
  const quiet = (): void => undefined;
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  /** Waits until the catalog has taken `more` declarations beyond those it has now */
  async function declared(catalog: CatalogStub, more: number): Promise<void> {
    const target = catalog.declarations.length + more;
    await vi.waitFor(() => expect(catalog.declarations.length).toBeGreaterThanOrEqual(target), { timeout: 5_000 });
  }

  test("declares each route with the accepts and extensions of its own 402, within the catalog's limits", async () => {
    const stack = await echoStack({ stack: { catalog: true } });
    const catalog = catalogOf(stack);
    await declared(catalog, 1);
    const [declaration] = catalog.declarations;
    expect(declaration?.authorization).toBe(`Bearer ${TEST_TOKEN}`);
    expect(declaration && declarationRefusal(declaration, await railOf(stack))).toBeUndefined();

    const echo = await paymentRequiredOf(`${stack.url}/v1/echo`, "POST");
    const item = await paymentRequiredOf(`${stack.url}/v1/items/example`, "GET");
    const bazaar = item.extensions?.["bazaar"] as Bazaar;
    // The 402 names the id of the request it answers, which says nothing about the route
    const { pathParams, ...input } = bazaar.info.input;
    expect(pathParams).toEqual({ id: "example" });
    const common = { type: "http", x402Version: 2, mimeType: "application/json", serviceName: "Echo", tags: ["test"] };
    expect(itemsOf(declaration)).toEqual([
      {
        ...common,
        resource: `${TEST_PUBLIC_URL}/v1/echo`,
        description: "Echoes text back",
        accepts: echo.accepts,
        extensions: echo.extensions,
      },
      {
        ...common,
        resource: `${TEST_PUBLIC_URL}/v1/items/:id`,
        description: "Reads one item",
        accepts: item.accepts,
        extensions: { ...item.extensions, bazaar: { ...bazaar, info: { ...bazaar.info, input } } },
      },
    ]);
    const [first, second] = itemsOf(declaration);
    expect(first?.extensions.bazaar.info.input["method"]).toBe("POST");
    expect(first?.extensions.bazaar.routeTemplate).toBeUndefined();
    expect(second?.extensions.bazaar).toMatchObject({
      routeTemplate: "/v1/items/:id",
      info: { input: { method: "GET" } },
    });
  });

  test("the test stack's catalog rules refuse what the facilitator's catalog would", async () => {
    const stack = await echoStack({ stack: { catalog: true } });
    const catalog = catalogOf(stack);
    await declared(catalog, 1);
    const rail = await railOf(stack);
    const [good] = catalog.declarations;
    const [item] = itemsOf(good) as unknown as Record<string, unknown>[];
    if (good === undefined || item === undefined) throw new Error("no declaration");
    expect(declarationRefusal(good, rail)).toBeUndefined();
    const [accept] = item["accepts"] as Record<string, unknown>[];
    const terms = accept?.["extra"] as Record<string, unknown>;
    const withItem = (change: Record<string, unknown>): Declaration => ({
      ...good,
      body: { items: [{ ...item, ...change }] },
    });
    const withAccept = (change: Record<string, unknown>): Declaration =>
      withItem({ accepts: [{ ...accept, ...change }] });
    const refused: [Declaration, RegExp][] = [
      [{ ...good, body: { items: [] } }, /^items: /],
      [{ ...good, body: { items: Array.from({ length: 33 }, () => item) } }, /^items: /],
      [{ ...good, bytes: 64 * 1024 + 1 }, /over 64 KB/],
      [withItem({ lastUpdated: "2026-10-28T00:00:00Z" }), /^items\[0\]\.lastUpdated: /],
      [withItem({ resource: "ftp://service.test/v1/echo" }), /\.resource: /],
      [withItem({ resource: "http://agent:pw@service.test/v1/echo" }), /\.resource: has userinfo/],
      [withItem({ resource: `http://service.test/${"r".repeat(2048)}` }), /\.resource: /],
      [withItem({ type: "mcp" }), /\.type$/],
      [withItem({ x402Version: 1 }), /\.x402Version$/],
      [withItem({ accepts: [] }), /\.accepts: /],
      [withItem({ accepts: Array.from({ length: 5 }, () => accept) }), /\.accepts: /],
      [withAccept({ scheme: "exact" }), /\.accepts\[0\]\.scheme$/],
      [withAccept({ network: "zcash:testnet" }), /\.accepts\[0\]\.network$/],
      [withAccept({ asset: "USDC" }), /\.accepts\[0\]\.asset$/],
      [withAccept({ payTo: `uregtest1${"p".repeat(60)}` }), /\.accepts\[0\]\.payTo$/],
      [withAccept({ amount: "0" }), /\.accepts\[0\]\.amount: /],
      [withAccept({ amount: "0500" }), /\.accepts\[0\]\.amount: /],
      [withAccept({ amount: "100001" }), /\.accepts\[0\]\.amount: /],
      [withAccept({ extra: { ...terms, windowZat: "1000" } }), /\.accepts\[0\]\.extra: /],
      [withAccept({ extra: { ...terms, termsVersion: "0".repeat(16) } }), /\.accepts\[0\]\.extra\.termsVersion$/],
      [withItem({ description: "d".repeat(513) }), /\.description$/],
      [withItem({ mimeType: "m".repeat(129) }), /\.mimeType$/],
      [withItem({ serviceName: "s".repeat(33) }), /\.serviceName$/],
      [withItem({ tags: ["a", "b", "c", "d", "e", "f"] }), /\.tags: /],
      [withItem({ tags: ["paid", "Paid"] }), /\.tags: repeated/],
      [withItem({ tags: ["t".repeat(33)] }), /\.tags: /],
      [withItem({ iconUrl: "http://127.0.0.1/icon.png" }), /\.iconUrl$/],
      [withItem({ extensions: { padding: "x".repeat(8192) } }), /\.extensions: /],
      [
        withItem({ extensions: { bazaar: { info: { input: { method: "TRACE" } } } } }),
        /\.extensions\.bazaar\.info\.input\.method$/,
      ],
    ];
    for (const [declaration, why] of refused) expect(declarationRefusal(declaration, rail)).toMatch(why);
  });

  test("keeps the path parameters a route gives as its example in place of those of a request", async () => {
    const service: ServiceDefinition = {
      ...DEFINITION,
      routes: DEFINITION.routes.map((r) =>
        r.method === "GET"
          ? {
              ...r,
              discovery: { ...r.discovery, pathParams: { id: "<item id>" }, pathParamsSchema: { required: ["id"] } },
            }
          : r,
      ),
    };
    const stack = await startTestStack({
      catalog: true,
      build: async (env) => {
        const paid = await createPaidService({ env, service });
        return { app: paid.app, close: paid.close };
      },
    });
    running.push(stack);
    const catalog = catalogOf(stack);
    await declared(catalog, 1);
    const item = await paymentRequiredOf(`${stack.url}/v1/items/example`, "GET");
    const bazaar = item.extensions?.["bazaar"] as Bazaar;
    expect(bazaar.info.input["pathParams"]).toEqual({ id: "example" });
    const input = { ...bazaar.info.input, pathParams: { id: "<item id>" } };
    expect(itemsOf(catalog.declarations[0])[1]?.extensions).toEqual({
      ...item.extensions,
      bazaar: { ...bazaar, info: { ...bazaar.info, input } },
    });
  });

  test("declares again an interval after the last declaration ended, so two never overlap", async () => {
    const stack = await echoStack({ stack: { catalog: true, env: { declareIntervalMs: 100 } } });
    const catalog = catalogOf(stack);
    const gaps = (list: Declaration[]): number[] => list.slice(1).map((d, i) => d.at - (list[i]?.at ?? 0));
    await declared(catalog, 4);
    expect(Math.min(...gaps(catalog.declarations))).toBeGreaterThanOrEqual(95);

    // A catalog that is slow to answer holds the next declaration back until it has answered
    catalog.delayMs = 300;
    const from = catalog.declarations.length;
    await declared(catalog, 3);
    expect(Math.min(...gaps(catalog.declarations.slice(from)))).toBeGreaterThanOrEqual(395);
    expect(catalog.mostAtOnce).toBe(1);
  });

  test("declares nothing while the service is not ready, and soon after it is", async () => {
    let ready = false;
    const stack = await echoStack({ ready: () => ready, stack: { catalog: true, env: { declareIntervalMs: 100 } } });
    const catalog = catalogOf(stack);
    await sleep(500);
    expect(catalog.declarations).toEqual([]);

    ready = true;
    const since = Date.now();
    await declared(catalog, 1);
    expect(Date.now() - since).toBeLessThan(1_000);

    ready = false;
    await sleep(250);
    const count = catalog.declarations.length;
    await sleep(500);
    expect(catalog.declarations).toHaveLength(count);
  });

  test("logs each change of outcome once, keeps the service up, and never logs the token", async () => {
    const log: string[] = [];
    const stack = await echoStack({ log, stack: { catalog: true, env: { declareIntervalMs: 50 } } });
    const catalog = catalogOf(stack);
    await declared(catalog, 2);
    const answers: [number | "drop", unknown][] = [
      [404, { error: "not_found" }],
      [401, { error: "unauthorized" }],
      [403, { error: "forbidden" }],
      [400, { error: "invalid_request", index: 1, message: `accepts[0].amount: not for ${TEST_TOKEN}\u001b[2J` }],
      [503, undefined],
      ["drop", undefined],
      [200, undefined],
    ];
    for (const [how, body] of answers) {
      catalog.answer(how, body);
      await declared(catalog, 3);
    }

    const at = String.raw`the facilitator at http://127\.0\.0\.1:\d+`;
    const again = String.raw`; trying again every 0\.05 s$`;
    const listed = new RegExp(String.raw`^discovery: 2 paid routes listed by ${at}, declared again every 0\.05 s$`);
    expect(log).toEqual(
      [
        listed,
        new RegExp(
          String.raw`^discovery: ${at} has no Bazaar to declare to \(404\), ` +
            String.raw`so the routes are not listed${again}`,
        ),
        new RegExp(String.raw`^discovery: Z402_FACILITATOR_TOKEN: ${at} refused the declaration \(401\)${again}`),
        new RegExp(String.raw`^discovery: Z402_FACILITATOR_TOKEN: ${at} refused the declaration \(403\)${again}`),
        new RegExp(
          String.raw`^discovery: ${at} refused the declaration ` +
            String.raw`\(400, item 1: accepts\[0\]\.amount: not for <token> \[2J\)${again}`,
        ),
        new RegExp(String.raw`^discovery: ${at} answered the declaration with 503${again}`),
        new RegExp(String.raw`^discovery: cannot reach ${at} \(\S+\)${again}`),
        listed,
      ].map((line) => expect.stringMatching(line)),
    );
    expect(log.join("\n")).not.toContain(TEST_TOKEN);
    expect((await fetch(`${stack.url}/health`)).status).toBe(200);
  });

  test("stops once the service closes, ending a declaration in flight at once", async () => {
    const stack = await echoStack({ stack: { catalog: true, env: { declareIntervalMs: 50 } } });
    const catalog = catalogOf(stack);
    await declared(catalog, 2);
    catalog.delayMs = 2_000;
    await declared(catalog, 1);
    const started = Date.now();
    await stack.paid.close();
    expect(Date.now() - started).toBeLessThan(1_000);
    const count = catalog.declarations.length;
    await sleep(300);
    expect(catalog.declarations).toHaveLength(count);
  });

  test("splits many routes into calls of at most 32 items, each under the facilitator's body limit", async () => {
    const route = (i: number, padding: number): PaidRoute => ({
      method: "GET",
      path: `/v1/r${i}`,
      description: `Route ${i}`,
      unit: "call",
      discovery: { output: { example: { padding: "p".repeat(padding) } } },
    });
    const calls: number[][] = [];
    const small = Array.from({ length: 40 }, (_, i) => route(i, 0));
    const large = Array.from({ length: 12 }, (_, i) => route(i, 7_000));
    for (const routes of [small, large]) {
      const stack = await startTestStack({
        catalog: true,
        build: async (env) => {
          const paid = await createPaidService({ env, service: { serviceName: "Many", routes } });
          return { app: paid.app, close: paid.close };
        },
      });
      running.push(stack);
      const catalog = catalogOf(stack);
      await vi.waitFor(() => expect(catalog.declarations.flatMap(itemsOf)).toHaveLength(routes.length));
      const rail = await railOf(stack);
      for (const d of catalog.declarations) expect(declarationRefusal(d, rail)).toBeUndefined();
      expect(catalog.declarations.flatMap(itemsOf).map((i) => i.resource)).toEqual(
        routes.map((r) => `${TEST_PUBLIC_URL}${r.path}`),
      );
      calls.push(catalog.declarations.map((d) => itemsOf(d).length));
    }
    expect(calls[0]).toEqual([32, 8]);
    expect(calls[1]?.length).toBeGreaterThan(1);
  });

  test("a route the catalog would refuse stops the start, and says what to change", async () => {
    const stack = await echoStack();
    const [echo] = DEFINITION.routes;
    if (echo === undefined) throw new Error("no echo route");
    const bulky = { ...echo.discovery, output: { example: { text: "x".repeat(8_192) } } };
    const only = (change: Partial<PaidRoute>): ServiceDefinition => ({
      ...DEFINITION,
      routes: [{ ...echo, ...change }],
    });
    const many = Array.from({ length: 129 }, (_, i) => ({ ...echo, path: `/v1/e${i}` }));
    const long = `http://service.test/${"p".repeat(2_040)}`;
    const refused: [ServiceDefinition, Partial<ServiceEnv>, RegExp][] = [
      [only({ description: "d".repeat(513) }), {}, /^routes: the description of "\/v1\/echo" is over 512 characters$/],
      [only({ mimeType: `text/${"x".repeat(124)}` }), {}, /^routes: the mimeType of "\/v1\/echo" is over 128/],
      [only({ discovery: bulky }), {}, /^routes: the 402 of "\/v1\/echo" has \d+ bytes of extensions, over 8192$/],
      [{ ...DEFINITION, routes: many }, {}, /^routes: at most 128,/],
      [DEFINITION, { publicUrl: "http://agent:hunter2@service.test" }, /^PUBLIC_URL: must not contain credentials$/],
      [DEFINITION, { publicUrl: long }, /^PUBLIC_URL: with \/v1\/echo it makes a resource URL over 2048 characters$/],
    ];
    for (const [service, change, error] of refused) {
      await expect(createPaidService({ env: { ...stack.env, ...change }, service, log: quiet })).rejects.toThrow(error);
    }
  });
});

describe("serve", () => {
  test("bounds the time a client may take to send its request", async () => {
    const listening = await serve(express(), { host: "127.0.0.1", port: 0 });
    try {
      expect(listening.server.headersTimeout).toBe(15_000);
      expect(listening.server.requestTimeout).toBe(30_000);
    } finally {
      await listening.close();
    }
  });
});

describe("onDelivered", () => {
  test("runs one handler once, whenever it is registered and however the response ends", async () => {
    const seen: string[] = [];
    const watch = (res: Response, name: string): void =>
      onDelivered(res, { ok: () => seen.push(`${name} ok`), failed: () => seen.push(`${name} failed`) });
    const app = express();
    // After "finish", which Node does not emit again, but before "close"
    app.get("/finished", (_req, res) => {
      res.once("finish", () => watch(res, "finished"));
      res.json({});
    });
    // "close" without "finish" when the client hangs up first, with the status still the default 200
    app.get("/hung-up", (_req, res) => watch(res, "hung-up"));
    // After "close", which Node does not emit again either
    app.get("/late", (_req, res) => {
      res.once("close", () => watch(res, "late"));
    });
    // A handler that throws does not stop the response
    app.get("/throws", (_req, res) => {
      onDelivered(res, {
        ok: () => {
          throw new Error("boom");
        },
      });
      res.json({});
    });
    const listening = await serve(app, { host: "127.0.0.1", port: 0 });
    closers.push(async () => {
      listening.server.closeAllConnections();
      await listening.close();
    });
    const hangUp = async (path: string): Promise<void> => {
      const controller = new AbortController();
      const pending = fetch(`${listening.url}${path}`, { signal: controller.signal }).catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 50));
      controller.abort();
      await pending;
    };
    const quietError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect((await fetch(`${listening.url}/finished`)).status).toBe(200);
      await hangUp("/hung-up");
      await hangUp("/late");
      expect((await fetch(`${listening.url}/throws`)).status).toBe(200);
      await vi.waitFor(() => expect(seen).toEqual(["finished ok", "hung-up failed", "late failed"]));
    } finally {
      quietError.mockRestore();
    }
  });

  test("ok on a 2xx, failed otherwise", async () => {
    const seen: string[] = [];
    const app = express();
    app.get("/:code", (req, res) => {
      onDelivered(res, { ok: () => seen.push(`ok ${req.params.code}`), failed: () => seen.push(`failed ${req.params.code}`) });
      res.status(Number(req.params.code)).json({});
    });
    const listening = await serve(app, { host: "127.0.0.1", port: 0 });
    try {
      await (await fetch(`${listening.url}/200`)).text();
      await (await fetch(`${listening.url}/404`)).text();
    } finally {
      listening.server.closeAllConnections();
      await listening.close();
    }
    expect(seen).toEqual(["ok 200", "failed 404"]);
  });
});

describe("serve", () => {
  test("close waits for a call in flight, then closes its kept-alive connection at once", async () => {
    let answer: (() => void) | undefined;
    const app = express();
    app.get("/slow", (_req, res) => {
      answer = () => void res.json({ ok: true });
    });
    const listening = await serve(app, { host: "127.0.0.1", port: 0 });
    // A kept-alive connection that the client would hold open for a minute
    const agent = new HttpAgent({ keepAlive: true, timeout: 60_000 });
    closers.push(async () => {
      agent.destroy();
      listening.server.closeAllConnections();
      await listening.close();
    });
    const call = new Promise<number>((resolve, reject) => {
      httpGet(`${listening.url}/slow`, { agent }, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      }).on("error", reject);
    });
    await vi.waitFor(() => expect(answer).toBeDefined());

    let closed = false;
    const closing = listening.close().then(() => {
      closed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(closed).toBe(false);
    const answered = Date.now();
    answer?.();
    expect(await call).toBe(200);
    await closing;
    expect(Date.now() - answered).toBeLessThan(1_000);
  });
});

describe("loadDotEnv", () => {
  test("fills in only what the environment leaves unset; a variable set empty there stays empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-dotenv-"));
    const file = join(dir, ".env");
    writeFileSync(file, "KIT_DOTENV_SET=file\nKIT_DOTENV_EMPTY=file\nKIT_DOTENV_NEW=file\n");
    process.env["KIT_DOTENV_SET"] = "env";
    process.env["KIT_DOTENV_EMPTY"] = "";
    try {
      loadDotEnv(pathToFileURL(file));
      loadDotEnv(pathToFileURL(join(dir, "missing.env")));
      expect([process.env["KIT_DOTENV_SET"], process.env["KIT_DOTENV_EMPTY"], process.env["KIT_DOTENV_NEW"]]).toEqual([
        "env",
        "",
        "file",
      ]);
      expect(() => loadDotEnv(pathToFileURL(dir))).toThrow(ConfigError);
    } finally {
      for (const name of ["KIT_DOTENV_SET", "KIT_DOTENV_EMPTY", "KIT_DOTENV_NEW"]) delete process.env[name];
    }
  });
});
