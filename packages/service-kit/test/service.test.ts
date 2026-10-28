import { decodePaymentRequiredHeader } from "@x402/core/http";
import express, { type Request, type Response } from "express";
import { afterEach, describe, expect, test } from "vitest";
import {
  ConfigError,
  createPaidService,
  loadServiceEnv,
  onDelivered,
  serve,
  type ServiceDefinition,
  type ServiceEnv,
} from "../src/index.js";
import { startTestStack, TEST_PAY_TO, TEST_PUBLIC_URL, type TestStack } from "../src/testing.js";

const running: TestStack[] = [];
afterEach(async () => {
  for (const s of running.splice(0)) await s.close();
});

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

async function echoStack(o: { ready?: () => boolean; delivered?: string[] } = {}): Promise<TestStack> {
  const stack = await startTestStack({
    build: async (env: ServiceEnv) => {
      const { app } = await createPaidService({ env, service: DEFINITION, ready: o.ready });
      app.post("/v1/echo", (req, res) => {
        onDelivered(res, { ok: () => o.delivered?.push("ok"), failed: () => o.delivered?.push("failed") });
        res.json({ text: req.body.text });
      });
      app.get("/v1/items/:id", (req, res) => {
        res.json({ id: req.params.id });
      });
      return app;
    },
  });
  running.push(stack);
  return stack;
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

  test("defaults", () => {
    const env = loadServiceEnv(base, { port: 4031 });
    expect(env).toMatchObject({
      network: "zcash:regtest",
      facilitatorUrl: "http://127.0.0.1:4022",
      facilitatorToken: undefined,
      payTo: TEST_PAY_TO,
      priceZat: 500n,
      publicUrl: "http://localhost:4031",
      host: "127.0.0.1",
      port: 4031,
    });
  });

  test("names the variable at fault", () => {
    expect(() => loadServiceEnv({ ...base, Z402_FACILITATOR_URL: "" }, { port: 1 })).toThrow(/^Z402_FACILITATOR_URL/);
    expect(() => loadServiceEnv({ ...base, Z402_PAY_TO: "utest1abc" }, { port: 1 })).toThrow(/^Z402_PAY_TO/);
    expect(() => loadServiceEnv({ ...base, Z402_PRICE_ZAT: "0" }, { port: 1 })).toThrow(/^Z402_PRICE_ZAT/);
    expect(() => loadServiceEnv({ ...base, PORT: "70000" }, { port: 1 })).toThrow(/^PORT/);
    expect(() => loadServiceEnv({ ...base, PUBLIC_URL: "ftp://x" }, { port: 1 })).toThrow(/^PUBLIC_URL/);
    expect(() => loadServiceEnv({ ...base, Z402_NETWORK: "devnet" }, { port: 1 })).toThrow(ConfigError);
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
      { port: 1 },
    );
    expect(env.facilitatorToken).toBe("secret-token");
    expect(env.payTo).toBe(TEST_PAY_TO);
    expect(() =>
      loadServiceEnv({ Z402_FACILITATOR_URL: "http://f", Z402_PAY_TO_FILE: join(dir, "missing") }, { port: 1 }),
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
});

describe("onDelivered", () => {
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
