import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { format } from "node:util";
import { x402Facilitator } from "@x402/core/facilitator";
import type { PaymentPayload, PaymentRequirements, SchemeNetworkFacilitator } from "@x402/core/types";
import {
  ASSET,
  DEMO_TERMS,
  NETWORK_MAINNET,
  NETWORK_REGTEST,
  REASON,
  SCHEME,
  type ChainView,
  type ZcashNetwork,
} from "@z402/protocol";
import { FakeChain } from "@z402/testkit";
import { afterAll, afterEach, describe, expect, test, vi } from "vitest";
import { createFacilitatorApp, startFacilitator, type FacilitatorHandle, type FacilitatorOptions } from "../src/app.js";
import { paymentFor, SESSION_KEY as K, voucherFor } from "./support/vouchers.js";

const NETWORK = NETWORK_REGTEST;
const PAY_TO = `uregtest1${"q".repeat(60)}`;
/** What a client that pays for mainnet would sign, which this regtest facilitator has no scheme for */
const MAINNET_PAY_TO = `u1${"q".repeat(60)}`;
const TOKEN = "t-7c2e91-secret";
const W = 100000n;

const scratch = mkdtempSync(join(tmpdir(), "z402-app-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const running: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((h) => h.close()));
});

const quiet = () => undefined;

/** A facilitator over a FakeChain, on a free port, closed after the test */
async function boot(over: Partial<FacilitatorOptions> = {}, chain = new FakeChain({ expiryDelta: 40 })) {
  const handle = await startFacilitator({
    network: NETWORK,
    chain: chain.viewFor(PAY_TO),
    payTo: PAY_TO,
    priceZat: 500n,
    terms: DEMO_TERMS,
    authToken: TOKEN,
    port: 0,
    log: quiet,
    ...over,
  });
  running.push(handle);
  return { handle, chain, url: handle.url };
}

interface Reply {
  status: number;
  headers: Headers;
  /** Whatever the body parsed to, left loose so a test can reach into it */
  json: any;
}

interface Init {
  method?: string;
  /** null sends no Authorization header at all */
  token?: string | null;
  body?: unknown;
  /** A body sent as it is, in place of `body` */
  raw?: string;
  headers?: Record<string, string>;
}

async function call(url: string, path: string, init: Init = {}): Promise<Reply> {
  const headers: Record<string, string> = { ...init.headers };
  if (init.token !== null) headers.authorization = `Bearer ${init.token ?? TOKEN}`;
  let body: string | undefined = init.raw;
  if (init.body !== undefined) body = JSON.stringify(init.body);
  if (body !== undefined && headers["content-type"] === undefined) headers["content-type"] = "application/json";
  const method = init.method ?? (body === undefined ? "GET" : "POST");
  const res = await fetch(`${url}${path}`, { method, headers, body });
  return { status: res.status, headers: res.headers, json: await res.json().catch(() => undefined) };
}

/** Requirements with fields the types would not allow, for the bodies a client should never send */
const loosely = (r: PaymentRequirements, over: Record<string, unknown>): PaymentRequirements =>
  ({ ...r, ...over }) as unknown as PaymentRequirements;

const envelope = (payload: PaymentPayload, requirements: PaymentRequirements) => ({
  x402Version: 2,
  paymentPayload: payload,
  paymentRequirements: requirements,
});
const verify = (url: string, payload: PaymentPayload, r: PaymentRequirements) =>
  call(url, "/verify", { body: envelope(payload, r) });
const settle = (url: string, payload: PaymentPayload, r: PaymentRequirements) =>
  call(url, "/settle", { body: envelope(payload, r) });

/** The requirements the API would send, built from /supported the way the server scheme copies the terms */
async function requirementsOf(url: string, over: Partial<PaymentRequirements> = {}): Promise<PaymentRequirements> {
  const supported = await call(url, "/supported");
  const { windowZat, creditRatioBps, creditCapZat, zeroConfMinExpiryBlocks, termsVersion } =
    supported.json.kinds[0].extra;
  return {
    scheme: SCHEME,
    network: NETWORK,
    asset: ASSET,
    amount: "500",
    payTo: PAY_TO,
    maxTimeoutSeconds: 60,
    extra: { windowZat, creditRatioBps, creditCapZat, zeroConfMinExpiryBlocks, termsVersion },
    ...over,
  };
}

/** Session K's voucher for cumulative `c`, optionally presenting a deposit */
const pay = (r: PaymentRequirements, c: bigint, txid?: string) =>
  paymentFor(r, voucherFor(r, c, { depositTxid: txid }));

/** A deposit of one window to the merchant for session K */
const deposit = (chain: FakeChain): string =>
  chain.broadcast({ outputs: [{ to: PAY_TO, valueZat: W, memo: `${K}:1` }] });

/** A ledger line that credits a deposit, for ledgers written by hand */
const creditEvent = () => ({
  t: "deposit",
  txid: "11".repeat(32),
  sessionKey: K,
  valueZat: "100000",
  zeroConf: true,
  expiryHeight: 2000,
  firstSeenTip: 1000,
  status: "pending",
  minedHeight: null,
  confirmations: 0,
});

/** The types of the ledger's events, after its header */
const ledgerTypes = (path: string): string[] =>
  readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => (JSON.parse(l) as { t: string }).t)
    .filter((t) => t !== "ledger");

/** A view whose inspect waits for open() once shut() is called, and `reached` settles when a read is waiting */
function gated(view: ChainView) {
  let shut = false;
  let open = () => {};
  let arrive = () => {};
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  const reached = new Promise<void>((resolve) => {
    arrive = resolve;
  });
  const gatedView: ChainView = {
    tip: () => view.tip(),
    inspect: async (txid) => {
      if (shut) {
        arrive();
        await opened;
      }
      return view.inspect(txid);
    },
  };
  return {
    view: gatedView,
    shut: () => {
      shut = true;
    },
    open,
    reached,
  };
}

/** A facilitator whose credited deposit has been mined since, with its next pollNow() held inside the chain read */
async function heldPass(name: string) {
  const ledgerPath = join(scratch, `${name}.jsonl`);
  const chain = new FakeChain({ expiryDelta: 40 });
  const gate = gated(chain.viewFor(PAY_TO));
  const onFatal = vi.fn<(err: unknown) => void>();
  const log = vi.fn<(msg: string, err?: unknown) => void>();
  const { handle, url } = await boot({ chain: gate.view, ledgerPath, onFatal, log }, chain);
  const r = await requirementsOf(url);
  const d1 = deposit(chain);
  await verify(url, pay(r, 500n, d1), r);
  await settle(url, pay(r, 500n, d1), r);
  chain.mine(1);

  gate.shut();
  const pass = handle.pollNow();
  await gate.reached;
  return { handle, url, r, gate, pass, ledgerPath, onFatal, log };
}

/** Serves an app from createFacilitatorApp alone, for the tests that do not need a whole facilitator */
async function serve(app: ReturnType<typeof createFacilitatorApp>) {
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  running.push({
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  });
  return `http://127.0.0.1:${port}`;
}

describe("GET /supported", () => {
  test("lists the scheme with the terms, the terms version and payTo", async () => {
    const { url } = await boot();
    const res = await call(url, "/supported");
    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      kinds: [
        {
          x402Version: 2,
          scheme: "prepaid-voucher",
          network: "zcash:regtest",
          extra: {
            windowZat: "100000",
            creditRatioBps: 2500,
            creditCapZat: "200000",
            zeroConfMinExpiryBlocks: 20,
            termsVersion: expect.stringMatching(/^[0-9a-f]{16}$/),
            payTo: PAY_TO,
          },
        },
      ],
      extensions: [],
      signers: { "zcash:*": [] },
    });
  });

  test("the terms version is the one taken from payTo, price and terms", async () => {
    // sha256 of ["uregtest1q...q","500",{the demo terms}] taken with shasum, as in scheme.test.ts
    const { url } = await boot();
    const res = await call(url, "/supported");
    expect(res.json.kinds[0].extra.termsVersion).toBe("23e5935a1b39a198");
  });

  test("advertises the configured terms", async () => {
    const terms = { windowZat: 250000n, creditRatioBps: 1000, creditCapZat: 5n, zeroConfMinExpiryBlocks: 3 };
    const { url } = await boot({ terms });
    const res = await call(url, "/supported");
    expect(res.json.kinds[0].extra).toMatchObject({
      windowZat: "250000",
      creditRatioBps: 1000,
      creditCapZat: "5",
      zeroConfMinExpiryBlocks: 3,
    });
  });
});

describe("the bearer token", () => {
  const routes: Array<[string, string]> = [
    ["GET", "/supported"],
    ["POST", "/verify"],
    ["POST", "/settle"],
  ];

  test.each(routes)("%s %s is refused without the right token", async (method, path) => {
    const { url } = await boot({ authToken: "right-token" });
    const wrong: Array<string | null> = [null, "", "wrong", "right-toke", "right-token2", "RIGHT-TOKEN"];
    for (const token of wrong) {
      const res = await call(url, path, { method, token, body: method === "POST" ? {} : undefined });
      expect(res).toMatchObject({ status: 401, json: { error: "unauthorized" } });
    }
    const basic = await call(url, path, { method, token: null, headers: { authorization: "Basic cmlnaHQtdG9rZW4=" } });
    expect(basic.status).toBe(401);
    const query = await call(url, `${path}?token=right-token`, { method, token: null });
    expect(query.status).toBe(401);
  });

  test("the right token is accepted", async () => {
    const { url } = await boot({ authToken: "right-token" });
    expect((await call(url, "/supported", { token: "right-token" })).status).toBe(200);
  });

  test("a missing token is refused even when the body cannot be read", async () => {
    const { url } = await boot();
    const res = await call(url, "/verify", { token: null, raw: "{ this is not json" });
    expect(res).toMatchObject({ status: 401, json: { error: "unauthorized" } });
  });

  test("without a configured token nothing is checked", async () => {
    const { url } = await boot({ authToken: undefined });
    expect((await call(url, "/supported", { token: null })).status).toBe(200);
  });

  test("an empty token is refused at start instead of switching the check off", async () => {
    await expect(boot({ authToken: "" })).rejects.toThrow(/^authToken:/);
  });

  test("a token no header could carry is refused without quoting it", async () => {
    const attempt = boot({ authToken: "s3cret\nmore" });
    await expect(attempt).rejects.toThrow(
      "authToken: must be one token of letters, digits and -._~+/ (no spaces or control characters)",
    );
  });

  test("more than one space after Bearer is accepted", async () => {
    const { url } = await boot();
    const res = await call(url, "/supported", { token: null, headers: { authorization: `Bearer   ${TOKEN}` } });
    expect(res.status).toBe(200);
  });

  test("createFacilitatorApp refuses a token no header could carry", () => {
    const facilitator = new x402Facilitator();
    expect(() => createFacilitatorApp({ facilitator, authToken: "s3cret " })).toThrow(/^authToken:/);
  });
});

describe("invalid bodies answer invalid_payload with HTTP 200", () => {
  test("POST /verify {}", async () => {
    const { url } = await boot();
    const res = await call(url, "/verify", { body: {} });
    expect(res.status).toBe(200);
    // Pre-parse answers carry neither payer nor session (protocol.md 7.1)
    expect(res.json).toEqual({ isValid: false, invalidReason: "invalid_payload", invalidMessage: expect.any(String) });
  });

  test("POST /settle {}", async () => {
    const { url } = await boot();
    const res = await call(url, "/settle", { body: {} });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      success: false,
      errorReason: "invalid_payload",
      errorMessage: expect.any(String),
      transaction: "",
      network: "zcash:regtest",
    });
  });

  test("settle names the network of the requirements when they carry one", async () => {
    const { url } = await boot();
    const res = await call(url, "/settle", {
      body: { paymentPayload: {}, paymentRequirements: { network: "zcash:mainnet" } },
    });
    expect(res.json).toMatchObject({ errorReason: "invalid_payload", transaction: "", network: "zcash:mainnet" });
  });

  describe.each(["/verify", "/settle"])("%s", (path) => {
    const reason = (json: Record<string, unknown>) => json.invalidReason ?? json.errorReason;

    async function valid() {
      const { url } = await boot();
      const r = await requirementsOf(url);
      return { url, r, payload: pay(r, 500n) };
    }

    test.each([
      ["a JSON array", () => "[]"],
      ["JSON null", () => "null"],
      ["a JSON string", () => '"text"'],
      ["malformed JSON", () => '{"paymentPayload": '],
      ["an empty body", () => ""],
    ])("%s", async (_, raw) => {
      const { url } = await boot();
      const res = await call(url, path, { raw: raw() });
      expect(res.status).toBe(200);
      expect(reason(res.json)).toBe("invalid_payload");
      if (path === "/settle") expect(res.json).toMatchObject({ success: false, transaction: "", network: NETWORK });
    });

    test("a body over 64 KB", async () => {
      const { url, r, payload } = await valid();
      const padded = { ...envelope(payload, r), padding: "x".repeat(70_000) };
      const res = await call(url, path, { body: padded });
      expect(res.status).toBe(200);
      expect(reason(res.json)).toBe("invalid_payload");
      if (path === "/settle") expect(res.json).toMatchObject({ success: false, transaction: "", network: NETWORK });
    });

    test("a valid body that is not sent as JSON", async () => {
      const { url, r, payload } = await valid();
      const res = await call(url, path, {
        raw: JSON.stringify(envelope(payload, r)),
        headers: { "content-type": "text/plain" },
      });
      expect(res.status).toBe(200);
      expect(reason(res.json)).toBe("invalid_payload");
    });

    test.each([
      ["no paymentRequirements", (p: PaymentPayload) => ({ paymentPayload: p })],
      ["no paymentPayload", (_: PaymentPayload, r: PaymentRequirements) => ({ paymentRequirements: r })],
      [
        "a payload without an x402Version",
        (p: PaymentPayload, r: PaymentRequirements) => {
          const { x402Version: _version, ...rest } = p;
          return envelope(rest as PaymentPayload, r);
        },
      ],
      [
        "a payload without accepted",
        (p: PaymentPayload, r: PaymentRequirements) => {
          const { accepted: _accepted, ...rest } = p;
          return envelope(rest as PaymentPayload, r);
        },
      ],
      [
        "requirements without an amount",
        (p: PaymentPayload, r: PaymentRequirements) => {
          const { amount: _amount, ...rest } = r;
          return envelope(p, rest as PaymentRequirements);
        },
      ],
      [
        "a network that is no CAIP-2 id",
        (p: PaymentPayload, r: PaymentRequirements) => envelope(p, loosely(r, { network: "zcash" })),
      ],
      [
        "a non-positive timeout",
        (p: PaymentPayload, r: PaymentRequirements) => envelope(p, { ...r, maxTimeoutSeconds: 0 }),
      ],
    ])("%s", async (_, shape) => {
      const { url, r, payload } = await valid();
      const res = await call(url, path, { body: shape(payload, r) });
      expect(res.status).toBe(200);
      expect(reason(res.json)).toBe("invalid_payload");
      if (path === "/settle") expect(res.json).toMatchObject({ success: false, transaction: "" });
    });
  });

  test("the message names the field and never echoes the value", async () => {
    const { url } = await boot();
    const r = await requirementsOf(url);
    const secret = "do-not-echo-this-value";
    const res = await call(url, "/verify", { body: envelope(pay(r, 500n), loosely(r, { network: secret })) });
    expect(res.json.invalidMessage).toMatch(/^paymentRequirements\.network/);
    expect(res.json.invalidMessage).not.toContain(secret);
  });
});

describe("a payload of another x402 version answers invalid_x402_version with HTTP 200", () => {
  // The SDK's facilitator throws before it reaches the scheme when no scheme is registered for a version
  test("verify", async () => {
    const { url } = await boot();
    const r = await requirementsOf(url);
    const res = await verify(url, { ...pay(r, 500n), x402Version: 1 }, r);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      isValid: false,
      invalidReason: "invalid_x402_version",
      invalidMessage: expect.any(String),
    });
  });

  test("settle carries an empty transaction and the network of the requirements", async () => {
    const { url } = await boot();
    const r = await requirementsOf(url);
    const res = await settle(url, { ...pay(r, 500n), x402Version: 1 }, r);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      success: false,
      errorReason: "invalid_x402_version",
      errorMessage: expect.any(String),
      transaction: "",
      network: "zcash:regtest",
    });
  });

  describe.each(["/verify", "/settle"])("%s", (path) => {
    test.each([
      [
        "a payload in the version 1 shape",
        (p: PaymentPayload) => ({ x402Version: 1, scheme: SCHEME, network: NETWORK, payload: p.payload }),
      ],
      ["version 3", (p: PaymentPayload) => ({ ...p, x402Version: 3 })],
      ["version 0", (p: PaymentPayload) => ({ ...p, x402Version: 0 })],
      ["a version that is a string", (p: PaymentPayload) => ({ ...p, x402Version: "2" })],
      ["a version that is null", (p: PaymentPayload) => ({ ...p, x402Version: null })],
    ])("%s", async (_, change) => {
      const { url } = await boot();
      const r = await requirementsOf(url);
      const res = await call(url, path, { body: envelope(change(pay(r, 500n)) as PaymentPayload, r) });
      expect(res.status).toBe(200);
      expect(res.json.invalidReason ?? res.json.errorReason).toBe("invalid_x402_version");
      expect(res.json.payer).toBeUndefined();
      expect(res.json.extra).toBeUndefined();
    });
  });

  test("a message that does not echo what was sent", async () => {
    const { url } = await boot();
    const r = await requirementsOf(url);
    const res = await verify(url, { ...pay(r, 500n), x402Version: "echo-this-version" as unknown as number }, r);
    expect(res.json.invalidMessage).not.toContain("echo-this-version");
  });
});

describe("a scheme or network nobody registered answers unsupported_scheme", () => {
  test("verify", async () => {
    const { url } = await boot();
    const r = await requirementsOf(url, { network: NETWORK_MAINNET, payTo: MAINNET_PAY_TO });
    const res = await verify(url, pay(r, 500n), r);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      isValid: false,
      invalidReason: "unsupported_scheme",
      invalidMessage: expect.any(String),
    });
  });

  test("settle carries an empty transaction and the network of the requirements", async () => {
    const { url } = await boot();
    const r = await requirementsOf(url, { network: NETWORK_MAINNET, payTo: MAINNET_PAY_TO });
    const res = await settle(url, pay(r, 500n), r);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      success: false,
      errorReason: "unsupported_scheme",
      errorMessage: expect.any(String),
      transaction: "",
      network: "zcash:mainnet",
    });
  });

  test("another scheme on the right network", async () => {
    const { url } = await boot();
    const r = await requirementsOf(url, { scheme: "exact" });
    expect((await verify(url, pay(r, 500n), r)).json).toMatchObject({ invalidReason: "unsupported_scheme" });
    expect((await settle(url, pay(r, 500n), r)).json).toMatchObject({ errorReason: "unsupported_scheme" });
  });

  test("the message does not echo what the client sent", async () => {
    const { url } = await boot();
    const r = await requirementsOf(url, { scheme: "echo-this-scheme-name" });
    const res = await verify(url, pay(r, 500n), r);
    expect(res.json.invalidMessage).not.toContain("echo-this-scheme-name");
  });
});

describe("failures inside the facilitator answer unexpected_* with HTTP 200", () => {
  test("verify: a chain that throws a plain TypeError on a needed lookup", async () => {
    const view = new FakeChain().viewFor(PAY_TO);
    const broken: ChainView = {
      tip: () => view.tip(),
      inspect: async () => {
        throw new TypeError("boom");
      },
    };
    const log = vi.fn<(msg: string, err?: unknown) => void>();
    const { url } = await boot({ chain: broken, log });
    const r = await requirementsOf(url);

    const res = await verify(url, pay(r, 500n, "ab".repeat(32)), r);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      isValid: false,
      invalidReason: "unexpected_verify_error",
      invalidMessage: expect.any(String),
    });
    // The failure is logged through the log option, which reaches the scheme
    expect(log).toHaveBeenCalledWith(expect.stringContaining("verify failed"), expect.any(TypeError));
  });

  test("settle: a ledger write that fails, which also calls onFatal once and poisons the facilitator", async () => {
    const ledgerPath = join(scratch, "settle-fails.jsonl");
    const onFatal = vi.fn<(err: unknown) => void>();
    const { url, chain } = await boot({ ledgerPath, onFatal });
    const r = await requirementsOf(url);
    const d1 = deposit(chain);
    expect((await verify(url, pay(r, 500n, d1), r)).json.isValid).toBe(true);

    // A directory where the file belongs makes the next append fail with EISDIR
    rmSync(ledgerPath);
    mkdirSync(ledgerPath);
    const res = await settle(url, pay(r, 500n, d1), r);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      success: false,
      errorReason: "unexpected_settle_error",
      errorMessage: expect.any(String),
      transaction: "",
      network: "zcash:regtest",
    });
    expect(onFatal).toHaveBeenCalledTimes(1);
    expect(onFatal.mock.calls[0]?.[0]).toMatchObject({ code: "EISDIR" });

    // Nothing is trusted until a restart replays the file
    expect((await verify(url, pay(r, 500n, d1), r)).json).toMatchObject({
      isValid: false,
      invalidReason: "unexpected_verify_error",
    });
  });

  test("the watcher's failed commit reaches onFatal as well", async () => {
    const ledgerPath = join(scratch, "watcher-fails.jsonl");
    const onFatal = vi.fn<(err: unknown) => void>();
    const { handle, url, chain } = await boot({ ledgerPath, onFatal });
    const r = await requirementsOf(url);
    const d1 = deposit(chain);
    expect((await verify(url, pay(r, 500n, d1), r)).json.isValid).toBe(true);
    expect((await settle(url, pay(r, 500n, d1), r)).json.success).toBe(true);
    expect(onFatal).not.toHaveBeenCalled();

    rmSync(ledgerPath);
    mkdirSync(ledgerPath);
    chain.mine(1);
    await handle.pollNow();
    expect(onFatal).toHaveBeenCalledTimes(1);
    expect(onFatal.mock.calls[0]?.[0]).toMatchObject({ code: "EISDIR" });
  });

  test("after the watcher's write fails, a settle writes nothing either", async () => {
    const held = await heldPass("latched");
    const before = readFileSync(held.ledgerPath);
    rmSync(held.ledgerPath);
    mkdirSync(held.ledgerPath);
    held.gate.open();
    await held.pass;
    expect(held.onFatal).toHaveBeenCalledTimes(1);

    // The disk is back, yet the file may hold a torn prefix the live state never saw
    rmSync(held.ledgerPath, { recursive: true });
    writeFileSync(held.ledgerPath, before);
    const res = await settle(held.url, pay(held.r, 1000n), held.r);

    expect(res.json).toMatchObject({ success: false, errorReason: "unexpected_settle_error", transaction: "" });
    expect(readFileSync(held.ledgerPath)).toEqual(before);
    expect(held.onFatal).toHaveBeenCalledTimes(1);
  });

  test("a status batch the ledger refuses is not fatal and writes nothing", async () => {
    const ledgerPath = join(scratch, "refused-status.jsonl");
    const chain = new FakeChain({ expiryDelta: 40 });
    const view = chain.viewFor(PAY_TO);
    let tip: number | undefined;
    const misreporting: ChainView = { tip: async () => tip ?? view.tip(), inspect: (txid) => view.inspect(txid) };
    const onFatal = vi.fn<(err: unknown) => void>();
    const { handle, url } = await boot({ chain: misreporting, ledgerPath, onFatal }, chain);
    const r = await requirementsOf(url);
    const d1 = deposit(chain);
    await verify(url, pay(r, 500n, d1), r);
    expect((await settle(url, pay(r, 500n, d1), r)).json.success).toBe(true);
    const before = readFileSync(ledgerPath, "utf8");

    // Past 2^53 the dead deposit's deadAtTip is no safe integer, so the shape check refuses the batch
    tip = 2 ** 53 + 10;
    await handle.pollNow();

    expect(onFatal).not.toHaveBeenCalled();
    expect(readFileSync(ledgerPath, "utf8")).toBe(before);
  });

  test("two failed watcher commits and a failed settle call onFatal once between them", async () => {
    const ledgerPath = join(scratch, "fatal-once.jsonl");
    const onFatal = vi.fn<(err: unknown) => void>();
    const log = vi.fn<(msg: string, err?: unknown) => void>();
    const { handle, url, chain } = await boot({ ledgerPath, onFatal, log });
    const r = await requirementsOf(url);
    const d1 = deposit(chain);
    expect((await verify(url, pay(r, 500n, d1), r)).json.isValid).toBe(true);
    expect((await settle(url, pay(r, 500n, d1), r)).json.success).toBe(true);

    rmSync(ledgerPath);
    mkdirSync(ledgerPath);
    chain.mine(1);
    await handle.pollNow();
    await handle.pollNow();
    const failed = await settle(url, pay(r, 1000n, d1), r);

    expect(log.mock.calls.filter(([msg]) => msg === "ledger commit failed")).toHaveLength(2);
    expect(log.mock.calls.filter(([msg]) => msg === "chain poll failed")).toEqual([]);
    expect(failed.json).toMatchObject({ success: false, errorReason: "unexpected_settle_error" });
    expect(onFatal).toHaveBeenCalledTimes(1);
    expect(onFatal.mock.calls[0]?.[0]).toMatchObject({ code: "EISDIR" });
  });

  describe("createFacilitatorApp", () => {
    const throwing: SchemeNetworkFacilitator = {
      scheme: SCHEME,
      caipFamily: "zcash:*",
      getExtra: () => undefined,
      getSigners: () => [],
      verify: async () => {
        throw new Error("boom");
      },
      settle: async () => {
        throw new Error("boom");
      },
    };
    const r: PaymentRequirements = {
      scheme: SCHEME,
      network: NETWORK,
      asset: ASSET,
      amount: "500",
      payTo: PAY_TO,
      maxTimeoutSeconds: 60,
      extra: {},
    };

    test("a scheme that throws is answered with unexpected_* and the network of the requirements", async () => {
      const facilitator = new x402Facilitator().register(NETWORK, throwing);
      const log = vi.fn<(msg: string, err?: unknown) => void>();
      const url = await serve(createFacilitatorApp({ facilitator, authToken: TOKEN, log }));

      const v = await verify(url, paymentFor(r, {}), r);
      expect(v.status).toBe(200);
      expect(v.json).toEqual({
        isValid: false,
        invalidReason: "unexpected_verify_error",
        invalidMessage: expect.any(String),
      });
      expect(v.json.invalidMessage).not.toContain("boom");

      const s = await settle(url, paymentFor(r, {}), r);
      expect(s.status).toBe(200);
      expect(s.json).toEqual({
        success: false,
        errorReason: "unexpected_settle_error",
        errorMessage: expect.any(String),
        transaction: "",
        network: "zcash:regtest",
      });
      expect(log).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ message: "boom" }));
    });

    test("serves /supported from the facilitator it is given", async () => {
      const facilitator = new x402Facilitator().register(NETWORK, throwing);
      const url = await serve(createFacilitatorApp({ facilitator }));
      const res = await call(url, "/supported", { token: null });
      expect(res.json).toMatchObject({ kinds: [{ x402Version: 2, scheme: SCHEME, network: NETWORK }] });
    });

    describe("with no log option", () => {
      afterEach(() => {
        vi.restoreAllMocks();
      });

      /** A scheme whose answer cannot be sent, since JSON has no BigInt */
      const unsendable: SchemeNetworkFacilitator = {
        ...throwing,
        verify: async () => ({ isValid: true, extra: { n: 1n } }),
      };
      const quietStderr = () => vi.spyOn(console, "error").mockImplementation(() => undefined);
      const printed = (spy: ReturnType<typeof quietStderr>): string =>
        spy.mock.calls.map((a) => format(...a)).join("\n");
      const payload = paymentFor(r, voucherFor(r, 500n));
      const leaks = [TOKEN, K, String(payload.payload.sig)];

      test.each([
        ["/verify", "unexpected_verify_error"],
        ["/settle", "unexpected_settle_error"],
      ])("an unexpected %s error goes to console.error without the token or the payload", async (path, reason) => {
        const stderr = quietStderr();
        const facilitator = new x402Facilitator().register(NETWORK, throwing);
        const url = await serve(createFacilitatorApp({ facilitator, authToken: TOKEN }));

        const res = await call(url, path, { body: envelope(payload, r) });
        expect(res.json.invalidReason ?? res.json.errorReason).toBe(reason);

        expect(stderr).toHaveBeenCalledTimes(1);
        expect(stderr).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ message: "boom" }));
        for (const leak of leaks) expect(printed(stderr)).not.toContain(leak);
      });

      test("a failure no route caught goes to console.error, and the client sees only internal_error", async () => {
        const stderr = quietStderr();
        const facilitator = new x402Facilitator().register(NETWORK, unsendable);
        const url = await serve(createFacilitatorApp({ facilitator, authToken: TOKEN }));

        const res = await verify(url, payload, r);
        expect(res).toMatchObject({ status: 500, json: { error: "internal_error" } });

        expect(stderr).toHaveBeenCalledTimes(1);
        expect(stderr).toHaveBeenCalledWith(expect.any(String), expect.any(TypeError));
        for (const leak of leaks) expect(printed(stderr)).not.toContain(leak);
      });

      test("request lines stay off", async () => {
        const stderr = quietStderr();
        const facilitator = new x402Facilitator().register(NETWORK, throwing);
        const url = await serve(createFacilitatorApp({ facilitator, authToken: TOKEN }));

        await call(url, "/supported");
        await call(url, "/supported", { token: "nope" });
        await call(url, "/nowhere");
        await call(url, "/verify", { body: {} });

        expect(stderr).not.toHaveBeenCalled();
      });
    });
  });
});

describe("what the HTTP layer exposes", () => {
  test("an unknown route is a JSON 404, behind the token", async () => {
    const { url } = await boot();
    expect(await call(url, "/nope")).toMatchObject({ status: 404, json: { error: "not_found" } });
    expect((await call(url, "/nope", { token: null })).status).toBe(401);
  });

  test("the server does not announce what it is", async () => {
    const { url } = await boot();
    const res = await call(url, "/supported");
    expect(res.headers.get("x-powered-by")).toBeNull();
  });

  test("the default host is the loopback address", async () => {
    const { url } = await boot();
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  test("requests are logged as method, path, status and reason code and nothing else", async () => {
    const lines: string[] = [];
    const { url, chain } = await boot({ log: (line) => lines.push(line) });
    const r = await requirementsOf(url);
    const d1 = deposit(chain);
    const signature = "PAYMENT-SIGNATURE-VALUE";

    await call(url, "/supported?apikey=hunter2", { headers: { "payment-signature": signature } });
    await call(url, "/supported", { token: "nope" });
    await call(url, "/verify", { body: {} });
    await verify(url, pay(r, 500n, d1), r);
    await settle(url, pay(r, 500n, d1), r);
    await settle(url, pay(r, 500n), r);

    expect(lines).toEqual([
      "GET /supported 200",
      "GET /supported 200",
      "GET /supported 401",
      "POST /verify 200 invalid_payload",
      "POST /verify 200",
      "POST /settle 200",
      "POST /settle 200 z402_cumulative_mismatch",
    ]);
    for (const line of lines) {
      for (const leak of [TOKEN, signature, "hunter2", K, d1]) expect(line).not.toContain(leak);
    }
  });

  test("a long path is cut short in the log", async () => {
    const lines: string[] = [];
    const { url } = await boot({ log: (line) => lines.push(line) });
    await call(url, `/${"a".repeat(5000)}`);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^GET \/aaaa/);
    expect(lines[0]?.length).toBeLessThan(200);
  });
});

describe("startFacilitator", () => {
  test.each([
    ["network", { network: "zcash:nope" as ZcashNetwork }],
    ["payTo", { payTo: `utest1${"q".repeat(60)}` }],
    ["payTo", { payTo: `tutest1${"q".repeat(60)}` }],
    ["priceZat", { priceZat: 0n }],
    ["priceZat", { priceZat: 500 as unknown as bigint }],
    ["terms", { terms: { ...DEMO_TERMS, creditRatioBps: 20000 } }],
    ["terms", { terms: { ...DEMO_TERMS, windowZat: 0n } }],
    ["authToken", { authToken: "" }],
    ["authToken", { authToken: "s3cret " }],
    ["authToken", { authToken: "two words" }],
    ["port", { port: 70000 }],
    ["pollIntervalMs", { pollIntervalMs: 0 }],
    ["pollIntervalMs", { pollIntervalMs: 2 ** 31 }],
    ["depositWaitMs", { depositWaitMs: -1 }],
    ["depositWaitMs", { depositWaitMs: 30_001 }],
    ["host", { host: "" }],
    ["host", { host: " " }],
    ["ledgerPath", { ledgerPath: "" }],
  ] as Array<[string, Partial<FacilitatorOptions>]>)(
    "a bad %s rejects naming the field before anything is written",
    async (field, over) => {
      const dir = join(scratch, `never-${field}`);
      await expect(boot({ ledgerPath: join(dir, "ledger.jsonl"), ...over })).rejects.toThrow(new RegExp(`^${field}:`));
      expect(existsSync(dir)).toBe(false);
    },
  );

  test.each([
    ["a line that is no ledger event", '{"t":"nonsense"}\n{"t":"voucher","sessionKey":"a","cumulativeZat":"1"}\n'],
    ["a line that is no JSON", 'not json\n{"t":"voucher","sessionKey":"a","cumulativeZat":"1"}\n'],
    ["events that break the state", `${JSON.stringify(creditEvent())}\n${JSON.stringify(creditEvent())}\n`],
  ])("a ledger with %s rejects naming ledgerPath", async (_, content) => {
    const ledgerPath = join(scratch, `corrupt-${Math.random().toString(36).slice(2)}.jsonl`);
    writeFileSync(ledgerPath, content);
    await expect(boot({ ledgerPath })).rejects.toThrow(/^ledgerPath:/);
  });

  test("a ledgerPath that is a directory rejects naming ledgerPath", async () => {
    const dir = join(scratch, "a-directory");
    mkdirSync(dir);
    await expect(boot({ ledgerPath: dir })).rejects.toThrow(/^ledgerPath:/);
  });

  test("a port in use rejects naming the port", async () => {
    const { handle } = await boot();
    const port = Number(new URL(handle.url).port);
    await expect(boot({ port })).rejects.toThrow(/^port:/);
  });

  test("a host this machine does not have rejects naming the host", async () => {
    // TEST-NET-1, reserved for documentation, so no interface carries it
    await expect(boot({ host: "192.0.2.1" })).rejects.toThrow(/^host:/);
  });

  test("a second facilitator on a ledger that another one holds is refused, and the ledger is untouched", async () => {
    const ledgerPath = join(scratch, "one-writer.jsonl");
    const first = await boot({ ledgerPath });
    const r = await requirementsOf(first.url);
    const d1 = deposit(first.chain);
    await verify(first.url, pay(r, 500n, d1), r);
    await settle(first.url, pay(r, 500n, d1), r);
    const before = readFileSync(ledgerPath);

    // A start that got past the lock would write the confirmation in its first poll
    first.chain.mine(1);
    await expect(boot({ ledgerPath }, first.chain)).rejects.toThrow(/^ledgerPath: .*already open/);

    expect(readFileSync(ledgerPath)).toEqual(before);
  });

  test("a fresh ledger starts with a header naming the network and payTo", async () => {
    const ledgerPath = join(scratch, "header-fresh.jsonl");
    await boot({ ledgerPath });
    const header = { t: "ledger", network: NETWORK, payTo: PAY_TO };
    expect(readFileSync(ledgerPath, "utf8")).toBe(`${JSON.stringify(header)}\n`);
  });

  test("a ledger of another payTo is refused and left byte for byte as it was", async () => {
    const ledgerPath = join(scratch, "header-other.jsonl");
    const first = await boot({ ledgerPath });
    await first.handle.close();
    const before = readFileSync(ledgerPath);
    const other = `uregtest1${"p".repeat(60)}`;

    await expect(boot({ ledgerPath, payTo: other, chain: first.chain.viewFor(other) })).rejects.toThrow(
      new RegExp(`^ledgerPath: .* is the ledger of ${NETWORK} ${PAY_TO}, not of this facilitator$`),
    );
    expect(readFileSync(ledgerPath)).toEqual(before);
  });

  test("a ledger written before the header existed still replays on regtest", async () => {
    const ledgerPath = join(scratch, "header-less.jsonl");
    writeFileSync(ledgerPath, `${JSON.stringify(creditEvent())}\n`);
    const { url } = await boot({ ledgerPath });
    const r = await requirementsOf(url);
    const res = await verify(url, pay(r, 500n), r);
    expect(res.json.extra.session).toMatchObject({ pendingZat: "100000", limitZat: "100000" });
    expect(ledgerTypes(ledgerPath)).toEqual(["deposit"]);
  });

  test("a refused start never touches the ledger it finds held, not even to cut a torn tail", async () => {
    const ledgerPath = join(scratch, "held-torn.jsonl");
    await boot({ ledgerPath });
    appendFileSync(ledgerPath, '{"t":"voucher","sessionK');
    const before = readFileSync(ledgerPath);

    await expect(boot({ ledgerPath })).rejects.toThrow(/^ledgerPath: .*already open/);

    expect(readFileSync(ledgerPath)).toEqual(before);
  });

  test("a closed facilitator frees its ledger, and no lock file is left behind", async () => {
    const ledgerPath = join(scratch, "reopened.jsonl");
    const first = await boot({ ledgerPath });
    expect(existsSync(`${ledgerPath}.lock`)).toBe(true);
    await first.handle.close();
    expect(existsSync(`${ledgerPath}.lock`)).toBe(false);

    const second = await boot({ ledgerPath }, first.chain);
    await second.handle.close();
    expect(existsSync(`${ledgerPath}.lock`)).toBe(false);
  });

  test("a start that cannot listen leaves the ledger free for the next one", async () => {
    const ledgerPath = join(scratch, "busy-port.jsonl");
    const { handle } = await boot();
    const port = Number(new URL(handle.url).port);

    await expect(boot({ ledgerPath, port })).rejects.toThrow(/^port:/);
    expect(existsSync(`${ledgerPath}.lock`)).toBe(false);
    await expect(boot({ ledgerPath })).resolves.toMatchObject({ url: expect.any(String) });
  });

  test.skipIf(process.getuid?.() === 0)("a ledger nobody may write is refused before the first poll", async () => {
    const ledgerPath = join(scratch, "read-only.jsonl");
    writeFileSync(ledgerPath, "");
    chmodSync(ledgerPath, 0o444);
    const view = new FakeChain().viewFor(PAY_TO);
    const reads = { tip: 0 };
    const counting: ChainView = { tip: () => (reads.tip++, view.tip()), inspect: (txid) => view.inspect(txid) };

    await expect(boot({ ledgerPath, chain: counting })).rejects.toThrow(/^ledgerPath: .*is not writable \(EACCES\)$/);
    expect(reads.tip).toBe(0);
    expect(existsSync(`${ledgerPath}.lock`)).toBe(false);
  });

  test("a deposit, a voucher and a restart: the ledger is written and replayed", async () => {
    const ledgerPath = join(scratch, "replay.jsonl");
    const first = await boot({ ledgerPath });
    const r = await requirementsOf(first.url);
    const d1 = deposit(first.chain);

    expect((await verify(first.url, pay(r, 500n, d1), r)).json).toMatchObject({ isValid: true, payer: K });
    expect((await settle(first.url, pay(r, 500n, d1), r)).json).toMatchObject({
      success: true,
      transaction: d1,
      network: NETWORK,
      payer: K,
      amount: "500",
    });
    await first.handle.close();
    expect(ledgerTypes(ledgerPath)).toEqual(["deposit", "voucher"]);

    const second = await boot({ ledgerPath }, first.chain);
    const stale = await verify(second.url, pay(r, 500n), r);
    expect(stale.json).toMatchObject({
      isValid: false,
      invalidReason: REASON.cumulativeMismatch,
      extra: { session: { cumulativeZat: "500" } },
    });
    // The deposit is acknowledged again without being credited twice
    const next = await settle(second.url, pay(r, 1000n, d1), r);
    expect(next.json).toMatchObject({ success: true, transaction: d1, amount: "500" });
    expect(ledgerTypes(ledgerPath)).toEqual(["deposit", "voucher", "voucher"]);
  });

  test("without a ledgerPath the ledger lives in memory and a restart starts empty", async () => {
    const first = await boot();
    const r = await requirementsOf(first.url);
    const d1 = deposit(first.chain);
    await verify(first.url, pay(r, 500n, d1), r);
    expect((await settle(first.url, pay(r, 500n, d1), r)).json.success).toBe(true);
    await first.handle.close();

    const second = await boot({}, first.chain);
    const again = await verify(second.url, pay(r, 500n, d1), r);
    expect(again.json).toMatchObject({ isValid: true, extra: { session: { cumulativeZat: "0" } } });
  });

  test("polls once before it listens", async () => {
    const ledgerPath = join(scratch, "poll-once.jsonl");
    const first = await boot({ ledgerPath });
    const r = await requirementsOf(first.url);
    const d1 = deposit(first.chain);
    await verify(first.url, pay(r, 500n, d1), r);
    await settle(first.url, pay(r, 500n, d1), r);
    await first.handle.close();

    // The deposit is mined while the facilitator is down, so only the poll at start can notice
    first.chain.mine(1);
    const second = await boot({ ledgerPath }, first.chain);
    const res = await verify(second.url, pay(r, 1000n, d1), r);
    expect(res.json.isValid).toBe(true);
    expect(res.json.extra.session).toMatchObject({ confirmedZat: "100000", pendingZat: "0" });
  });

  test("a poll at start that cannot reach the chain does not stop it from listening", async () => {
    const chain = new FakeChain();
    chain.setUnavailable(true);
    const { url } = await boot({}, chain);
    expect((await call(url, "/supported")).status).toBe(200);
  });

  test("handle.pollNow() brings deposits up to date", async () => {
    const { handle, url, chain } = await boot();
    const r = await requirementsOf(url);
    const d1 = deposit(chain);
    await verify(url, pay(r, 500n, d1), r);
    await settle(url, pay(r, 500n, d1), r);

    chain.mine(1);
    await handle.pollNow();
    const res = await verify(url, pay(r, 1000n, d1), r);
    expect(res.json.extra.session).toMatchObject({ confirmedZat: "100000" });
  });

  test("the watcher runs on pollIntervalMs by itself", async () => {
    const { url, chain } = await boot({ pollIntervalMs: 20 });
    const r = await requirementsOf(url);
    const d1 = deposit(chain);
    await verify(url, pay(r, 500n, d1), r);
    await settle(url, pay(r, 500n, d1), r);

    chain.mine(1);
    await vi.waitFor(
      async () => {
        const res = await verify(url, pay(r, 1000n, d1), r);
        expect(res.json.extra.session).toMatchObject({ confirmedZat: "100000" });
      },
      { timeout: 3000, interval: 25 },
    );
  });

  test("depositWaitMs bounds how long verify waits for a deposit the chain does not know", async () => {
    const { url } = await boot({ depositWaitMs: 50 });
    const r = await requirementsOf(url);
    const started = Date.now();
    const res = await verify(url, pay(r, 500n, "cd".repeat(32)), r);
    expect(res.json).toMatchObject({ isValid: false, invalidReason: REASON.depositNotFound });
    expect(Date.now() - started).toBeLessThan(4000);
  });

  test("the configured price is enforced", async () => {
    const { url } = await boot({ priceZat: 700n });
    const r = await requirementsOf(url);
    const res = await verify(url, pay(r, 700n), r);
    expect(res.json).toMatchObject({ invalidReason: REASON.invalidPaymentRequirements });
    const ok = await verify(url, pay({ ...r, amount: "700" }, 700n), { ...r, amount: "700" });
    expect(ok.json.invalidReason).not.toBe(REASON.invalidPaymentRequirements);
  });

  test("pollNow() after close() reads nothing and writes nothing", async () => {
    const view = new FakeChain({ expiryDelta: 40 }).viewFor(PAY_TO);
    const reads = { tip: 0, inspect: 0 };
    const counting: ChainView = {
      tip: () => (reads.tip++, view.tip()),
      inspect: (txid) => (reads.inspect++, view.inspect(txid)),
    };
    const { handle } = await boot({ chain: counting });
    await handle.close();

    const before = { ...reads };
    await handle.pollNow();
    expect(reads).toEqual(before);
  });

  test("close() stops the server and the watcher, and may be called twice", async () => {
    const ledgerPath = join(scratch, "close.jsonl");
    const { handle, url, chain } = await boot({ ledgerPath, pollIntervalMs: 20 });
    const r = await requirementsOf(url);
    const d1 = deposit(chain);
    await verify(url, pay(r, 500n, d1), r);
    await settle(url, pay(r, 500n, d1), r);

    await handle.close();
    await handle.close();
    await expect(fetch(`${url}/supported`)).rejects.toThrow();

    const written = readFileSync(ledgerPath, "utf8");
    chain.mine(1);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(readFileSync(ledgerPath, "utf8")).toBe(written);
  });

  test("a pass in flight when close() runs writes nothing when it resumes", async () => {
    const held = await heldPass("close-in-flight");
    expect(ledgerTypes(held.ledgerPath)).toEqual(["deposit", "voucher"]);
    const logged = held.log.mock.calls.length;

    const closing = held.handle.close();
    held.gate.open();
    await Promise.all([held.pass, closing]);

    expect(ledgerTypes(held.ledgerPath)).toEqual(["deposit", "voucher"]);
    expect(held.onFatal).not.toHaveBeenCalled();
    expect(held.log.mock.calls.slice(logged)).toEqual([]);
  });

  test("the same pass writes the status line when the facilitator stays open", async () => {
    const held = await heldPass("open-in-flight");
    held.gate.open();
    await held.pass;
    expect(ledgerTypes(held.ledgerPath)).toEqual(["deposit", "voucher", "status"]);
  });
});
