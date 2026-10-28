/**
 * The whole server side end to end. A stock x402 client (`wrapFetchWithPayment` and `x402Client`) pays through the
 * API's payment middleware, which asks a real facilitator, which reads a FakeChain. Each test starts its own chain,
 * facilitator and API and closes them afterwards.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  encodePaymentSignatureHeader,
} from "@x402/core/http";
import { FacilitatorCapabilityError } from "@x402/core/server";
import type { PaymentRequired } from "@x402/core/types";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { startFacilitator, type FacilitatorOptions } from "@z402/facilitator";
import {
  DEMO_TERMS,
  depositMemo,
  NETWORK_MAINNET,
  NETWORK_REGTEST,
  NETWORK_TESTNET,
  parseSessionSnapshot,
  publicKeyFromSeed,
  REASON,
  SCHEME,
  signVoucher,
  type ZcashNetwork,
} from "@z402/protocol";
import { FakeChain } from "@z402/testkit";
import { afterAll, afterEach, describe, expect, test, vi } from "vitest";
import { createApiApp, startApi, type ApiOptions } from "../src/index.js";
import { TestClientScheme } from "./support/testClientScheme.js";

const NETWORK = NETWORK_REGTEST;
const PAY_TO = `uregtest1${"q".repeat(60)}`;
const OTHER_PAY_TO = `uregtest1${"p".repeat(60)}`;
const TESTNET_PAY_TO = `utest1${"q".repeat(60)}`;
const MAINNET_PAY_TO = `u1${"q".repeat(60)}`;
const TOKEN = "t-api-4c9a1e-secret";
/** The facilitator's terms version for PAY_TO, price 500 and the demo terms, as packages/facilitator/test/app.test.ts pins it */
const TERMS_VERSION = "23e5935a1b39a198";
/** Generous for the long runs, which take well under a second each on a laptop */
const LONG = 30_000;

const scratch = mkdtempSync(join(tmpdir(), "z402-api-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const running: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const handle of running.splice(0).reverse()) await handle.close();
});

const quiet = (): void => undefined;

function facilitatorOptions(chain: FakeChain, over: Partial<FacilitatorOptions> = {}): FacilitatorOptions {
  return {
    network: NETWORK,
    chain: chain.viewFor(PAY_TO),
    payTo: PAY_TO,
    priceZat: 500n,
    terms: DEMO_TERMS,
    authToken: TOKEN,
    port: 0,
    log: quiet,
    ...over,
  };
}

async function facilitatorOn(chain: FakeChain, over: Partial<FacilitatorOptions> = {}) {
  const handle = await startFacilitator(facilitatorOptions(chain, over));
  running.push(handle);
  return handle;
}

function apiOptions(facilitatorUrl: string, over: Partial<ApiOptions> = {}): ApiOptions {
  return { network: NETWORK, facilitatorUrl, facilitatorToken: TOKEN, payTo: PAY_TO, priceZat: 500n, port: 0, ...over };
}

async function apiOn(facilitatorUrl: string, over: Partial<ApiOptions> = {}) {
  const handle = await startApi(apiOptions(facilitatorUrl, over));
  running.push(handle);
  return handle;
}

/** A stock x402 fetch paying with its own TestClientScheme, which counts hops and keeps every PAYMENT-SIGNATURE sent */
function payer(apiUrl: string) {
  const client = new TestClientScheme();
  const sent: string[] = [];
  let hops = 0;
  const counting = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    hops += 1;
    const request = new Request(input, init);
    const signature = request.headers.get("payment-signature");
    if (signature !== null) sent.push(signature);
    return fetch(request);
  };
  const paidFetch = wrapFetchWithPayment(counting, new x402Client().register(NETWORK, client));
  return { client, sent, hops: () => hops, chunk: () => paidFetch(`${apiUrl}/chunk`) };
}

/** A chain, a facilitator on it, an API in front of it and a paying client */
async function fullStack(over: Partial<FacilitatorOptions> = {}) {
  const chain = new FakeChain({ expiryDelta: 40 });
  const facilitator = await facilitatorOn(chain, over);
  const api = await apiOn(facilitator.url);
  return { chain, facilitator, api, ...payer(api.url) };
}

/** One window to the merchant, with the memo of the session's deposit `index` */
const deposit = (chain: FakeChain, sessionKey: string, index: number): string =>
  chain.broadcast({ outputs: [{ to: PAY_TO, valueZat: 100000n, memo: depositMemo(sessionKey, index) }] });

async function paidChunk(res: Response): Promise<unknown> {
  expect(res.status).toBe(200);
  return res.json();
}

/** The decoded PAYMENT-REQUIRED of a 402 */
async function refusalOf(res: Response): Promise<PaymentRequired> {
  expect(res.status).toBe(402);
  await res.text();
  const header = res.headers.get("payment-required");
  if (header === null) throw new Error("a 402 without PAYMENT-REQUIRED");
  return decodePaymentRequiredHeader(header);
}

const sessionOf = (required: PaymentRequired) => parseSessionSnapshot(required.accepts[0]?.extra.session);

/** A PAYMENT-SIGNATURE for one voucher of the session of `seed`, built from the API's own requirements */
async function voucherHeader(apiUrl: string, seed: Uint8Array, cumulativeZat: string, depositTxid?: string) {
  const unpaid = await refusalOf(await fetch(`${apiUrl}/chunk`));
  const accepted = unpaid.accepts[0];
  if (accepted === undefined) throw new Error("no accepts entry");
  const sessionKey = publicKeyFromSeed(seed);
  const { scheme, network, payTo } = accepted;
  const sig = signVoucher(seed, { scheme, network, payTo, sessionKey, cumulativeZat });
  const payload = { sessionKey, cumulativeZat, sig, ...(depositTxid === undefined ? {} : { depositTxid }) };
  return encodePaymentSignatureHeader({ x402Version: 2, resource: unpaid.resource, accepted, payload });
}

/** A seed of its own for each test that pays by hand */
const seedOf = (n: number): Uint8Array => Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + n) % 256);

/** The values in order with repeats collapsed */
const runs = (values: string[]): string[] => values.filter((v, i) => i === 0 || values[i - 1] !== v);

describe("paid /chunk through the whole stack", () => {
  test(
    "streams 150 calls, credit appears after mining and D2 is acked",
    async () => {
      const s = await fullStack();
      const d1 = deposit(s.chain, s.client.sessionKey, 1);
      s.client.pendingTxid = d1;
      let d2 = "";
      for (let i = 1; i <= 150; i++) {
        if (i === 51) {
          d2 = deposit(s.chain, s.client.sessionKey, 2);
          s.client.pendingTxid = d2;
        }
        expect(await paidChunk(await s.chunk())).toEqual({
          chunk: i,
          cumulativeZat: String(500 * i),
          data: `chunk-${i}`,
        });
        if (i === 30) {
          s.chain.mine(1);
          await s.facilitator.pollNow();
        }
      }

      const limits = s.client.settled.map((x) => x.session.limitZat);
      expect(limits).toHaveLength(150);
      expect(new Set(limits.slice(0, 30))).toEqual(new Set(["100000"]));
      expect(limits[30]).toBe("125000");
      expect(runs(limits)).toEqual(["100000", "125000", "225000"]);
      expect(s.client.settled[0]?.transaction).toBe(d1);
      expect(s.client.acked).toEqual([d1, d2]);
      expect(s.client.pendingTxid).toBeUndefined();
      expect(s.client.refusals).toEqual([]);
      expect(s.client.settled.at(-1)?.session).toMatchObject({
        cumulativeZat: "75000",
        confirmedZat: "100000",
        pendingZat: "100000",
        creditZat: "25000",
        limitZat: "225000",
        headroomZat: "150000",
      });
    },
    LONG,
  );

  test("an unpaid GET /chunk gets the requirements of protocol.md section 2", async () => {
    const s = await fullStack();
    const res = await fetch(`${s.api.url}/chunk`);
    expect(res.headers.get("payment-response")).toBeNull();
    expect(await refusalOf(res)).toEqual({
      x402Version: 2,
      error: "Payment required",
      resource: { url: `${s.api.url}/chunk`, description: "", mimeType: "application/json" },
      accepts: [
        {
          scheme: "prepaid-voucher",
          network: "zcash:regtest",
          amount: "500",
          asset: "ZEC",
          payTo: PAY_TO,
          maxTimeoutSeconds: 60,
          extra: {
            windowZat: "100000",
            creditRatioBps: 2500,
            creditCapZat: "200000",
            zeroConfMinExpiryBlocks: 20,
            termsVersion: TERMS_VERSION,
          },
        },
      ],
    });
  });

  test("an unpaid HEAD /chunk is refused", async () => {
    const s = await fullStack();
    const res = await fetch(`${s.api.url}/chunk`, { method: "HEAD" });
    expect(res.status).toBe(402);
    expect(res.headers.get("payment-required")).not.toBeNull();
  });

  test("a paid request by another method than GET gets 405 and is not charged, so the voucher buys a GET", async () => {
    const s = await fullStack();
    const seed = seedOf(1);
    const d1 = deposit(s.chain, publicKeyFromSeed(seed), 1);
    const header = await voucherHeader(s.api.url, seed, "500", d1);

    for (const method of ["HEAD", "OPTIONS", "POST"]) {
      const res = await fetch(`${s.api.url}/chunk`, { method, headers: { "payment-signature": header } });
      await res.text();
      expect(res.status, method).toBe(405);
      expect(res.headers.get("allow"), method).toBe("GET");
      const settled = res.headers.get("payment-response");
      expect(settled === null || decodePaymentResponseHeader(settled).success === false, method).toBe(true);
    }

    const res = await fetch(`${s.api.url}/chunk`, { headers: { "payment-signature": header } });
    expect(await paidChunk(res)).toEqual({ chunk: 1, cumulativeZat: "500", data: "chunk-1" });
  });

  test("concurrent requests that carry one voucher get the chunk exactly once", async () => {
    const s = await fullStack();
    const seed = seedOf(2);
    const d1 = deposit(s.chain, publicKeyFromSeed(seed), 1);
    const first = await voucherHeader(s.api.url, seed, "500", d1);
    await paidChunk(await fetch(`${s.api.url}/chunk`, { headers: { "payment-signature": first } }));
    const header = await voucherHeader(s.api.url, seed, "1000");

    const results = await Promise.all(
      Array.from({ length: 4 }, async () => {
        const res = await fetch(`${s.api.url}/chunk`, { headers: { "payment-signature": header } });
        const body = await res.text();
        const settled = res.headers.get("payment-response");
        return {
          status: res.status,
          body,
          refusedSettle: settled !== null && decodePaymentResponseHeader(settled).success === false,
          corrective: res.headers.get("payment-required") !== null,
        };
      }),
    );

    const served = results.filter((r) => r.status === 200);
    expect(served).toHaveLength(1);
    expect(JSON.parse(served[0]?.body ?? "")).toEqual({ chunk: 2, cumulativeZat: "1000", data: "chunk-2" });
    for (const other of results.filter((r) => r.status !== 200)) {
      expect(other.status).toBe(402);
      expect(other.body).not.toMatch(/"data":"chunk-/);
      expect(other.refusedSettle || other.corrective).toBe(true);
    }
  });

  test("the requirements and the chunk number follow priceZat", async () => {
    const chain = new FakeChain({ expiryDelta: 40 });
    const facilitator = await facilitatorOn(chain, { priceZat: 700n });
    const api = await apiOn(facilitator.url, { priceZat: 700n });
    expect((await refusalOf(await fetch(`${api.url}/chunk`))).accepts[0]?.amount).toBe("700");

    const p = payer(api.url);
    p.client.pendingTxid = deposit(chain, p.client.sessionKey, 1);
    expect(await paidChunk(await p.chunk())).toEqual({ chunk: 1, cumulativeZat: "700", data: "chunk-1" });
    expect(await paidChunk(await p.chunk())).toEqual({ chunk: 2, cumulativeZat: "1400", data: "chunk-2" });
  });

  test("each session's chunk number comes from its own voucher", async () => {
    const s = await fullStack();
    s.client.pendingTxid = deposit(s.chain, s.client.sessionKey, 1);
    await paidChunk(await s.chunk());
    await paidChunk(await s.chunk());

    const other = payer(s.api.url);
    other.client.pendingTxid = deposit(s.chain, other.client.sessionKey, 1);
    expect(await paidChunk(await other.chunk())).toEqual({ chunk: 1, cumulativeZat: "500", data: "chunk-1" });
    expect(await paidChunk(await s.chunk())).toEqual({ chunk: 3, cumulativeZat: "1500", data: "chunk-3" });
  });

  test("the facilitator's /supported is read once, at start", async () => {
    const lines: string[] = [];
    const chain = new FakeChain({ expiryDelta: 40 });
    const facilitator = await facilitatorOn(chain, { log: (line) => lines.push(line) });
    const api = await apiOn(facilitator.url);
    const p = payer(api.url);
    p.client.pendingTxid = deposit(chain, p.client.sessionKey, 1);
    for (let i = 1; i <= 3; i++) await paidChunk(await p.chunk());

    expect(lines.filter((l) => l.startsWith("GET /supported"))).toEqual(["GET /supported 200"]);
    expect(lines.filter((l) => l.startsWith("POST /verify"))).toHaveLength(3);
    expect(lines.filter((l) => l.startsWith("POST /settle"))).toHaveLength(3);
  });

  test(
    "awaiting_confirmation while D1 is pending",
    async () => {
      const s = await fullStack();
      const d1 = deposit(s.chain, s.client.sessionKey, 1);
      s.client.pendingTxid = d1;
      for (let i = 1; i <= 200; i++) await paidChunk(await s.chunk());
      expect(s.client.settled.at(-1)?.session.cumulativeZat).toBe("100000");

      const refusal = await refusalOf(await s.chunk());
      expect(refusal.error).toBe(REASON.awaitingConfirmation);
      expect(sessionOf(refusal)).toMatchObject({ cumulativeZat: "100000", limitZat: "100000", pendingZat: "100000" });

      // A second pending deposit adds nothing to the window, and the refusal lists it as if credited
      const d2 = deposit(s.chain, s.client.sessionKey, 2);
      s.client.pendingTxid = d2;
      const projected = await refusalOf(await s.chunk());
      expect(projected.error).toBe(REASON.awaitingConfirmation);
      expect(sessionOf(projected)?.deposits.map((d) => d.txid)).toEqual([d1, d2]);
      expect(s.client.pendingTxid).toBe(d2);
      expect(s.client.acked).toEqual([d1]);

      s.chain.mine(1);
      await s.facilitator.pollNow();
      expect(await paidChunk(await s.chunk())).toEqual({ chunk: 201, cumulativeZat: "100500", data: "chunk-201" });
      expect(s.client.acked).toEqual([d1, d2]);
    },
    LONG,
  );

  test(
    "a cheat run is refused at 125000 after D1 confirms",
    async () => {
      const s = await fullStack();
      s.client.pendingTxid = deposit(s.chain, s.client.sessionKey, 1);
      await paidChunk(await s.chunk());
      s.chain.mine(1);
      await s.facilitator.pollNow();

      let last: unknown;
      for (let i = 2; i <= 250; i++) last = await paidChunk(await s.chunk());
      expect(last).toEqual({ chunk: 250, cumulativeZat: "125000", data: "chunk-250" });

      const refusal = await refusalOf(await s.chunk());
      expect(refusal.error).toBe(REASON.depositRequired);
      expect(refusal.accepts[0]?.extra.session).toMatchObject({ limitZat: "125000", cumulativeZat: "125000" });
    },
    LONG,
  );

  test("a corrective 402 resyncs a client that lost its counter", async () => {
    const s = await fullStack();
    s.client.pendingTxid = deposit(s.chain, s.client.sessionKey, 1);
    for (let i = 1; i <= 5; i++) await paidChunk(await s.chunk());

    s.client.synced = 0n;
    const before = s.hops();
    expect(await paidChunk(await s.chunk())).toEqual({ chunk: 6, cumulativeZat: "3000", data: "chunk-6" });
    expect(s.hops() - before).toBe(3);
    expect(s.client.refusals).toEqual([REASON.cumulativeMismatch]);
  });

  test("a voucher refused at verify gets a 402 that carries the session snapshot", async () => {
    const s = await fullStack();
    const unpaid = await refusalOf(await fetch(`${s.api.url}/chunk`));
    const accepted = unpaid.accepts[0];
    if (accepted === undefined) throw new Error("no accepts entry");

    // A first voucher with no deposit, which a session with no credit cannot pay
    const seed = Uint8Array.from({ length: 32 }, (_, i) => i);
    const sessionKey = publicKeyFromSeed(seed);
    const cumulativeZat = "500";
    const sig = signVoucher(seed, {
      scheme: accepted.scheme,
      network: accepted.network,
      payTo: accepted.payTo,
      sessionKey,
      cumulativeZat,
    });
    const signature = encodePaymentSignatureHeader({
      x402Version: 2,
      resource: unpaid.resource,
      accepted,
      payload: { sessionKey, cumulativeZat, sig },
    });

    const res = await fetch(`${s.api.url}/chunk`, { headers: { "payment-signature": signature } });
    expect(res.headers.get("payment-response")).toBeNull();
    const refusal = await refusalOf(res);
    expect(refusal.error).toBe(REASON.depositRequired);
    expect(refusal.accepts).toHaveLength(1);
    expect(refusal.accepts[0]?.extra).toMatchObject({
      windowZat: "100000",
      creditRatioBps: 2500,
      creditCapZat: "200000",
      zeroConfMinExpiryBlocks: 20,
      termsVersion: TERMS_VERSION,
    });
    expect(sessionOf(refusal)).toEqual({
      sessionKey,
      cumulativeZat: "0",
      limitZat: "0",
      headroomZat: "0",
      confirmedZat: "0",
      pendingZat: "0",
      creditZat: "0",
      tip: 1000,
      deposits: [],
    });
  });

  test("a facilitator restart replays the ledger while the API keeps serving", async () => {
    const chain = new FakeChain({ expiryDelta: 40 });
    const ledgerPath = join(scratch, "restart.jsonl");
    const first = await facilitatorOn(chain, { ledgerPath });
    const api = await apiOn(first.url);
    const p = payer(api.url);
    const d1 = deposit(chain, p.client.sessionKey, 1);
    p.client.pendingTxid = d1;
    for (let i = 1; i <= 10; i++) await paidChunk(await p.chunk());
    expect(p.client.acked).toEqual([d1]);
    const oldVoucher = p.sent.at(-1);
    if (oldVoucher === undefined) throw new Error("no voucher was sent");

    await first.close();
    // Mined while nobody watches, so only the poll at start can see it
    chain.mine(1);
    await facilitatorOn(chain, { ledgerPath, port: Number(new URL(first.url).port) });

    const replay = await refusalOf(await fetch(`${api.url}/chunk`, { headers: { "payment-signature": oldVoucher } }));
    expect(replay.error).toBe(REASON.cumulativeMismatch);
    expect(sessionOf(replay)).toMatchObject({
      cumulativeZat: "5000",
      confirmedZat: "100000",
      pendingZat: "0",
      limitZat: "125000",
    });

    p.client.pendingTxid = d1;
    expect(await paidChunk(await p.chunk())).toEqual({ chunk: 11, cumulativeZat: "5500", data: "chunk-11" });
    expect(p.client.settled.at(-1)?.transaction).toBe(d1);
    expect(p.client.settled.at(-1)?.session).toMatchObject({
      cumulativeZat: "5500",
      confirmedZat: "100000",
      pendingZat: "0",
      limitZat: "125000",
    });
    expect(p.client.acked).toEqual([d1, d1]);
  });

  test(
    "a chain outage keeps voucher-only calls working",
    async () => {
      // depositWaitMs 0 makes the lookup of a deposit the outage hides give up at once
      const s = await fullStack({ depositWaitMs: 0 });
      const d1 = deposit(s.chain, s.client.sessionKey, 1);
      s.client.pendingTxid = d1;
      await paidChunk(await s.chunk());
      // Confirmed, so that D2 can raise the limit, which two pending deposits never do
      s.chain.mine(1);
      await s.facilitator.pollNow();

      s.chain.setUnavailable(true);
      for (let i = 2; i <= 250; i++) await paidChunk(await s.chunk());
      const d2 = deposit(s.chain, s.client.sessionKey, 2);
      s.client.pendingTxid = d2;
      expect((await refusalOf(await s.chunk())).error).toBe(REASON.chainUnavailable);
      expect(s.client.pendingTxid).toBe(d2);

      s.chain.setUnavailable(false);
      expect(await paidChunk(await s.chunk())).toEqual({ chunk: 251, cumulativeZat: "125500", data: "chunk-251" });
      expect(s.client.acked).toEqual([d1, d2]);
      expect(s.client.settled.at(-1)?.session.limitZat).toBe("225000");
    },
    LONG,
  );
});

/** The facilitator's answer at /providers/me to the operator's key, with the providerId its app.test.ts pins */
const ME = { providerId: "f93eeecbf393ea04", network: NETWORK, payTo: PAY_TO };

/** The terms and payTo of an `accepts` entry, as /supported advertises them */
const ADVERTISED = {
  windowZat: "100000",
  creditRatioBps: 2500,
  creditCapZat: "200000",
  zeroConfMinExpiryBlocks: 20,
  termsVersion: TERMS_VERSION,
  payTo: PAY_TO,
};

/** A /supported body that offers prepaid-voucher on `network` with `extra` */
const supportedOn = (network: string, extra: Record<string, unknown>) => ({
  kinds: [{ x402Version: 2, scheme: SCHEME, network, extra }],
  extensions: [],
  signers: {},
});

/** A facilitator stand-in that answers /providers/me with `me`, /supported with `supported` and the rest with a 404 */
async function stubFacilitator(me: { status?: number; body?: string }, supported?: unknown) {
  // Every path asked of it and the Authorization header that came with each, in order
  const paths: string[] = [];
  const authorizations: Array<string | undefined> = [];
  const stub = createServer((req, res) => {
    paths.push(req.url ?? "");
    authorizations.push(req.headers.authorization);
    res.setHeader("content-type", "application/json");
    if (req.url === "/providers/me") {
      res.statusCode = me.status ?? 200;
      res.end(me.body ?? JSON.stringify(ME));
    } else if (req.url === "/supported" && supported !== undefined) {
      res.end(JSON.stringify(supported));
    } else {
      res.statusCode = 404;
      res.end('{"error":"not_found"}');
    }
  });
  await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
  running.push({
    close: () =>
      new Promise<void>((resolve) => {
        stub.close(() => resolve());
        stub.closeAllConnections();
      }),
  });
  return { url: `http://127.0.0.1:${(stub.address() as { port: number }).port}`, paths, authorizations };
}

/** What startApi rejects with, or an error that says it did not */
const startFailure = (url: string, over: Partial<ApiOptions> = {}): Promise<Error> =>
  startApi(apiOptions(url, over)).then(
    () => new Error("expected startApi to reject"),
    (e: unknown) => e as Error,
  );

describe("startApi", () => {
  test.each([
    ["facilitatorUrl", { facilitatorUrl: "" }],
    ["facilitatorUrl", { facilitatorUrl: "127.0.0.1:4022" }],
    ["facilitatorUrl", { facilitatorUrl: "localhost:4022" }],
    ["facilitatorUrl", { facilitatorUrl: "ftp://127.0.0.1:4022" }],
    ["network", { network: "zcash:nope" as ZcashNetwork }],
    ["network", { network: "regtest" as ZcashNetwork }],
    ["payTo", { payTo: TESTNET_PAY_TO }],
    ["payTo", { payTo: `turegtest1${"q".repeat(60)}` }],
    ["priceZat", { priceZat: 0n }],
    ["priceZat", { priceZat: -500n }],
    ["priceZat", { priceZat: 500 as unknown as bigint }],
    ["facilitatorToken", { facilitatorToken: "" }],
    ["facilitatorUrl", { facilitatorUrl: "http://op:pw@127.0.0.1:9" }],
    ["facilitatorUrl", { facilitatorUrl: "http://op@127.0.0.1:9" }],
    ["facilitatorToken", { facilitatorToken: "abc\nSECRET" }],
    ["facilitatorToken", { facilitatorToken: "two words" }],
    ["facilitatorUrl", { network: NETWORK_TESTNET, payTo: TESTNET_PAY_TO, facilitatorUrl: "http://192.0.2.1:9" }],
    ["facilitatorUrl", { network: NETWORK_MAINNET, payTo: MAINNET_PAY_TO, facilitatorUrl: "http://f.example:4022" }],
    ["host", { host: " " }],
    ["port", { port: 70000 }],
    ["port", { port: 1.5 }],
  ] as Array<[string, Partial<ApiOptions>]>)("a bad %s rejects naming the field before any request", async (field, over) => {
    const requests = vi.spyOn(globalThis, "fetch");
    await expect(startApi(apiOptions("http://127.0.0.1:9", over))).rejects.toThrow(new RegExp(`^${field}:`));
    expect(requests).not.toHaveBeenCalled();
  });

  test("plaintext http:// to a host that is not loopback is refused off regtest with the rule it broke", async () => {
    const over: Partial<ApiOptions> = { network: NETWORK_TESTNET, payTo: TESTNET_PAY_TO };
    await expect(startApi(apiOptions("http://192.0.2.1:9", over))).rejects.toThrow(
      new Error("facilitatorUrl: plaintext http:// is allowed only to a loopback host on zcash:testnet; use https://"),
    );
  });

  test.each<[string, Partial<ApiOptions>]>([
    ["http://127.0.0.1:9", { network: NETWORK_TESTNET, payTo: TESTNET_PAY_TO }],
    ["http://localhost:9", { network: NETWORK_TESTNET, payTo: TESTNET_PAY_TO }],
    ["http://[::1]:9", { network: NETWORK_MAINNET, payTo: MAINNET_PAY_TO }],
    ["https://f.example:8443", { network: NETWORK_MAINNET, payTo: MAINNET_PAY_TO }],
    ["http://facilitator:4022", {}],
  ])("%s passes the option check and is asked for /providers/me", async (url, over) => {
    const requests = vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("fetch failed"));
    await expect(startApi(apiOptions(url, over))).rejects.toThrow(/^facilitatorUrl: /);
    expect(requests).toHaveBeenCalled();
  });

  test.each<[string, Partial<ApiOptions>, string]>([
    ["facilitatorUrl", { facilitatorUrl: "http://op:pw@127.0.0.1:9" }, "pw@"],
    ["facilitatorToken", { facilitatorToken: "abc\nSECRET" }, "SECRET"],
  ])("a %s that carries a secret is refused without quoting it anywhere", async (field, over, secret) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = await startApi(apiOptions("http://127.0.0.1:9", over)).then(
      () => new Error("expected startApi to reject"),
      (e: unknown) => e as Error,
    );
    expect(error.message).toMatch(new RegExp(`^${field}:`));
    expect(error.message).not.toContain(secret);
    expect(String(error.cause ?? "")).not.toContain(secret);
    expect(warn.mock.calls.flat().map(String).join(" ")).not.toContain(secret);
  });

  test("a facilitator that pays another address fails naming payTo", async () => {
    const facilitator = await facilitatorOn(new FakeChain());
    const err = await startFailure(facilitator.url, { payTo: OTHER_PAY_TO });
    expect(err.message).toMatch(/^payTo:/);
    expect(err.cause).toMatchObject({ name: "ProviderCheckError", field: "payTo", retryable: false });
  });

  test("a facilitator whose terms the API cannot use fails naming facilitatorUrl", async () => {
    // A /supported with the right payTo and no terms at all
    const stub = await stubFacilitator({}, supportedOn(NETWORK, { payTo: PAY_TO }));
    const err = await startFailure(stub.url);
    expect(err.message).toMatch(/^facilitatorUrl:/);
    expect(err.cause).toBeInstanceOf(FacilitatorCapabilityError);
  });

  test("a /supported that advertises another payTo still fails naming payTo, once /providers/me agrees", async () => {
    const stub = await stubFacilitator({}, supportedOn(NETWORK, { ...ADVERTISED, payTo: OTHER_PAY_TO }));
    const err = await startFailure(stub.url);
    expect(err.message).toMatch(/^payTo:/);
    expect(err.cause).toBeInstanceOf(FacilitatorCapabilityError);
    expect(stub.paths).toEqual(["/providers/me", "/supported"]);
  });

  test("a /supported that offers another network still fails naming network, once /providers/me agrees", async () => {
    const stub = await stubFacilitator({}, supportedOn(NETWORK_TESTNET, { ...ADVERTISED, payTo: TESTNET_PAY_TO }));
    const err = await startFailure(stub.url);
    expect(err.message).toMatch(/^network:/);
    expect(stub.paths).toEqual(["/providers/me", "/supported"]);
  });

  test("a facilitator on another network fails naming payTo, as the provider check puts it", async () => {
    const chain = new FakeChain();
    const facilitator = await facilitatorOn(chain, {
      network: NETWORK_TESTNET,
      payTo: TESTNET_PAY_TO,
      chain: chain.viewFor(TESTNET_PAY_TO),
    });
    const err = await startFailure(facilitator.url);
    expect(err.message).toMatch(/^payTo:/);
    expect(err.cause).toMatchObject({ name: "ProviderCheckError", field: "payTo", retryable: false });
  });

  // The check runs before the first /supported, so each of these is refused on /providers/me alone
  test.each([
    { what: "a 401", me: { status: 401, body: '{"error":"unauthorized"}' }, field: "facilitatorToken" },
    { what: "a 403", me: { status: 403, body: '{"error":"forbidden"}' }, field: "facilitatorToken" },
    {
      what: "a 404 from a facilitator without the route",
      me: { status: 404, body: '{"error":"not_found"}' },
      field: "facilitatorUrl",
    },
    { what: "a 200 that is no provider", me: { body: '{"kinds":[]}' }, field: "facilitatorUrl" },
    { what: "a 200 that is not JSON", me: { body: "<html>hello</html>" }, field: "facilitatorUrl" },
    {
      what: "a provider with another payTo",
      me: { body: JSON.stringify({ ...ME, payTo: OTHER_PAY_TO }) },
      field: "payTo",
    },
    {
      what: "a provider on another network",
      me: { body: JSON.stringify({ ...ME, network: NETWORK_TESTNET }) },
      field: "payTo",
    },
    // The API does not wait out a facilitator that is down, since whatever starts it holds it back
    { what: "a 503", me: { status: 503, body: "{}" }, field: "facilitatorUrl" },
  ])("$what from /providers/me fails naming $field before /supported is asked", async ({ me, field }) => {
    const stub = await stubFacilitator(me);
    const err = await startFailure(stub.url);
    expect(err.message).toMatch(new RegExp(`^${field}: `));
    expect(err.message).not.toContain(TOKEN);
    expect(err.cause).toMatchObject({ name: "ProviderCheckError", field });
    expect(stub.paths).toEqual(["/providers/me"]);
  });

  test("the key goes to /providers/me as a bearer token, and no header is sent without one", async () => {
    const stub = await stubFacilitator({ status: 401 });
    await startFailure(stub.url);
    await startFailure(stub.url, { facilitatorToken: undefined });
    expect(stub.authorizations).toEqual([`Bearer ${TOKEN}`, undefined]);
  });

  test("a facilitator that refuses the token fails naming facilitatorToken", async () => {
    const facilitator = await facilitatorOn(new FakeChain());
    await expect(startApi(apiOptions(facilitator.url, { facilitatorToken: "wrong" }))).rejects.toThrow(
      /^facilitatorToken:/,
    );
    await expect(startApi(apiOptions(facilitator.url, { facilitatorToken: undefined }))).rejects.toThrow(
      /^facilitatorToken:/,
    );
  });

  test("a facilitator that does not answer fails naming facilitatorUrl", async () => {
    const gone = await startFacilitator(facilitatorOptions(new FakeChain()));
    await gone.close();
    await expect(startApi(apiOptions(gone.url))).rejects.toThrow(/^facilitatorUrl:/);
  });

  test("listens on the loopback address by default and close() stops it", async () => {
    const facilitator = await facilitatorOn(new FakeChain());
    const api = await apiOn(facilitator.url);
    expect(api.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    await refusalOf(await fetch(`${api.url}/chunk`));

    await api.close();
    await api.close();
    await expect(fetch(`${api.url}/chunk`)).rejects.toThrow();
  });

  test("a port in use fails naming the port", async () => {
    const facilitator = await facilitatorOn(new FakeChain());
    const api = await apiOn(facilitator.url);
    const port = Number(new URL(api.url).port);
    await expect(startApi(apiOptions(facilitator.url, { port }))).rejects.toThrow(/^port:/);
  });

  test("a host this machine does not have fails naming the host", async () => {
    const facilitator = await facilitatorOn(new FakeChain());
    // TEST-NET-1, reserved for documentation, so no interface carries it
    await expect(startApi(apiOptions(facilitator.url, { host: "192.0.2.1" }))).rejects.toThrow(/^host:/);
  });

  test("createApiApp waits for the facilitator and serves the route once mounted", async () => {
    const facilitator = await facilitatorOn(new FakeChain());
    await expect(createApiApp(apiOptions(facilitator.url, { payTo: OTHER_PAY_TO }))).rejects.toThrow(/^payTo:/);

    const server = createServer(await createApiApp(apiOptions(facilitator.url)));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    running.push({
      close: () =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    });
    const { port } = server.address() as { port: number };
    const refusal = await refusalOf(await fetch(`http://127.0.0.1:${port}/chunk`));
    expect(refusal.accepts[0]).toMatchObject({ scheme: SCHEME, payTo: PAY_TO, amount: "500" });
  });
});
