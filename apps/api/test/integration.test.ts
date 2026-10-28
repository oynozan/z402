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
  decodePaymentSignatureHeader,
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
/** The facilitator's terms version for the demo terms, sha256 over ["z402-terms-v2",{the terms}] taken with shasum */
const TERMS_VERSION = "cb7f148af0fda19a";
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

/** The bazaar extension a 402 to a GET carries, written out and not built, with the first price in its example */
/** The resource GET /chunk's 402 names at `url`, with the names the catalog shows */
const resourceAt = (url: string) => ({
  url,
  description: "One numbered chunk of demo data per paid call",
  mimeType: "application/json",
  serviceName: "Demo API",
  tags: ["demo"],
});
/** The extensions GET /chunk's 402 carries: the bazaar extension, and the unit the catalog sells by */
const extensionsOf = (price: string) => ({ bazaar: bazaarOf(price), z402: { unit: "chunk" } });
const bazaarOf = (price: string) => ({
  info: {
    input: { type: "http", method: "GET" },
    output: { type: "json", example: { chunk: 1, cumulativeZat: price, data: "chunk-1" } },
  },
  schema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
      input: {
        type: "object",
        properties: {
          type: { type: "string", const: "http" },
          method: { type: "string", enum: ["GET"] },
          queryParams: { type: "object", properties: {} },
        },
        required: ["type", "method"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: { type: { type: "string" }, example: { type: "object" } },
        required: ["type"],
      },
    },
    required: ["input"],
  },
});

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
      resource: resourceAt(`${s.api.url}/chunk`),
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
      extensions: extensionsOf("500"),
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
    const facilitator = await facilitatorOn(chain);
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

describe("the bazaar extension of GET /chunk", () => {
  /** What GET /discovery/resources answers, the items only */
  const listed = async (facilitatorUrl: string): Promise<any[]> =>
    ((await (await fetch(`${facilitatorUrl}/discovery/resources`)).json()) as { items: any[] }).items;

  test("an unpaid GET /chunk declares a GET with an example of its answer and a schema that checks both", async () => {
    const s = await fullStack();
    const required = await refusalOf(await fetch(`${s.api.url}/chunk`));
    const bazaar = (required.extensions as { bazaar: { info: any; schema: any } }).bazaar;

    expect(bazaar.info.input.method).toBe("GET");
    expect(bazaar.info.input).toEqual({ type: "http", method: "GET" });
    expect(bazaar.info.output).toEqual({ type: "json", example: { chunk: 1, cumulativeZat: "500", data: "chunk-1" } });
    expect(bazaar.schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(bazaar.schema.required).toEqual(["input"]);
    expect(bazaar.schema.properties.input.properties.method).toEqual({ type: "string", enum: ["GET"] });
    expect(bazaar.schema.properties.input.properties.type).toEqual({ type: "string", const: "http" });
    expect(Object.keys(bazaar.schema.properties.output.properties)).toEqual(["type", "example"]);
    expect(required.extensions).toEqual(extensionsOf("500"));
  });

  test("the stock validator of @x402/extensions finds nothing wrong with it", async () => {
    // @x402/express validates the extension of each route against its schema when the first request comes, and warns
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const s = await fullStack();

    await refusalOf(await fetch(`${s.api.url}/chunk`));

    const printed = [...warn.mock.calls, ...error.mock.calls].flat().map(String).join(" ");
    expect(printed).not.toMatch(/bazaar/i);
    expect(printed).not.toMatch(/x402:/);
  });

  test("the example is the answer to the first paid call, and it follows the price", async () => {
    const chain = new FakeChain({ expiryDelta: 40 });
    const facilitator = await facilitatorOn(chain);
    const api = await apiOn(facilitator.url, { priceZat: 800n });
    const required = await refusalOf(await fetch(`${api.url}/chunk`));
    const example = (required.extensions as any).bazaar.info.output.example;

    const p = payer(api.url);
    p.client.pendingTxid = deposit(chain, p.client.sessionKey, 1);

    expect(example).toEqual({ chunk: 1, cumulativeZat: "800", data: "chunk-1" });
    expect(await paidChunk(await p.chunk())).toEqual(example);
    expect(required.extensions).toEqual(extensionsOf("800"));
  });

  test("a stock client echoes the extension in its payment, and the paid flow works as before", async () => {
    const s = await fullStack();
    s.client.pendingTxid = deposit(s.chain, s.client.sessionKey, 1);

    for (let i = 1; i <= 3; i++) {
      expect(await paidChunk(await s.chunk())).toEqual({
        chunk: i,
        cumulativeZat: String(500 * i),
        data: `chunk-${i}`,
      });
    }

    expect(s.sent).toHaveLength(3);
    for (const header of s.sent) {
      const payment = decodePaymentSignatureHeader(header);
      expect(payment.extensions).toEqual(extensionsOf("500"));
      expect(payment.resource?.url).toBe(`${s.api.url}/chunk`);
    }
    expect(s.client.refusals).toEqual([]);
  });

  test("the facilitator lists /chunk from its paid calls, which is what the extension is for", async () => {
    const s = await fullStack();
    expect(await listed(s.facilitator.url)).toEqual([]);
    s.client.pendingTxid = deposit(s.chain, s.client.sessionKey, 1);

    for (let i = 1; i <= 3; i++) await paidChunk(await s.chunk());

    expect(await listed(s.facilitator.url)).toMatchObject([
      {
        resource: `${s.api.url}/chunk`,
        type: "http",
        x402Version: 2,
        accepts: [{ scheme: SCHEME, network: NETWORK, amount: "500", payTo: PAY_TO }],
        extensions: { bazaar: bazaarOf("500") },
        paidCallsToday: 3,
      },
    ]);
  });

  test("a payment that echoes no extension lists nothing, so the extension is what lists /chunk", async () => {
    const s = await fullStack();
    const seed = seedOf(3);
    const d1 = deposit(s.chain, publicKeyFromSeed(seed), 1);
    // voucherHeader builds the payment by hand and echoes no extensions, as a client that drops them would
    const header = await voucherHeader(s.api.url, seed, "500", d1);
    expect(decodePaymentSignatureHeader(header).extensions).toBeUndefined();

    expect(await paidChunk(await fetch(`${s.api.url}/chunk`, { headers: { "payment-signature": header } }))).toEqual({
      chunk: 1,
      cumulativeZat: "500",
      data: "chunk-1",
    });

    expect(await listed(s.facilitator.url)).toEqual([]);
  });
});

describe("a second provider on the operator's facilitator", () => {
  const PAY_TO_2 = `uregtest1${"p".repeat(60)}`;
  const UIVK_2 = `uivkregtest1${"sec3ret".repeat(10)}`;

  test("registers, runs its own API at 800 zat beside the operator's at 500, and both are listed", async () => {
    const chain = new FakeChain({ expiryDelta: 40 });
    const chain2 = new FakeChain({ expiryDelta: 40 });
    const facilitator = await facilitatorOn(chain, {
      providers: {
        dir: join(scratch, "providers-two"),
        chainFor: () => chain2.viewFor(PAY_TO_2),
        owns: async () => true,
      },
    });
    const registered = await fetch(`${facilitator.url}/providers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ payTo: PAY_TO_2, uivk: UIVK_2 }),
    });
    expect(registered.status).toBe(201);
    const { apiKey } = (await registered.json()) as { apiKey: string };

    // The second API starts with its own key, payTo and price, against a /supported that names none of them
    const operatorApi = await apiOn(facilitator.url);
    const providerApi = await apiOn(facilitator.url, { facilitatorToken: apiKey, payTo: PAY_TO_2, priceZat: 800n });
    const accepted = async (url: string) => (await refusalOf(await fetch(`${url}/chunk`))).accepts[0];
    expect(await accepted(operatorApi.url)).toMatchObject({ payTo: PAY_TO, amount: "500" });
    expect(await accepted(providerApi.url)).toMatchObject({ payTo: PAY_TO_2, amount: "800" });
    expect((await accepted(providerApi.url))?.extra.termsVersion).toBe(TERMS_VERSION);
    expect((await accepted(operatorApi.url))?.extra.termsVersion).toBe(TERMS_VERSION);

    const first = payer(operatorApi.url);
    const second = payer(providerApi.url);
    first.client.pendingTxid = deposit(chain, first.client.sessionKey, 1);
    second.client.pendingTxid = chain2.broadcast({
      outputs: [{ to: PAY_TO_2, valueZat: 100000n, memo: depositMemo(second.client.sessionKey, 1) }],
    });
    expect(await paidChunk(await first.chunk())).toEqual({ chunk: 1, cumulativeZat: "500", data: "chunk-1" });
    expect(await paidChunk(await second.chunk())).toEqual({ chunk: 1, cumulativeZat: "800", data: "chunk-1" });
    expect(await paidChunk(await second.chunk())).toEqual({ chunk: 2, cumulativeZat: "1600", data: "chunk-2" });
    expect(await paidChunk(await first.chunk())).toEqual({ chunk: 2, cumulativeZat: "1000", data: "chunk-2" });
    expect(first.client.refusals).toEqual([]);
    expect(second.client.refusals).toEqual([]);

    const items = ((await (await fetch(`${facilitator.url}/discovery/resources`)).json()) as { items: any[] }).items;
    expect(items).toHaveLength(2);
    const byAmount = Object.fromEntries(items.map((i) => [i.accepts[0].amount, i]));
    expect(byAmount["500"]).toMatchObject({
      resource: `${operatorApi.url}/chunk`,
      accepts: [{ payTo: PAY_TO }],
      extensions: { bazaar: bazaarOf("500") },
      paidCallsToday: 2,
    });
    expect(byAmount["800"]).toMatchObject({
      resource: `${providerApi.url}/chunk`,
      accepts: [{ payTo: PAY_TO_2 }],
      extensions: { bazaar: bazaarOf("800") },
      paidCallsToday: 2,
    });
  });
});

/** The facilitator's answer at /providers/me to the operator's key, with the providerId its app.test.ts pins */
const ME = { providerId: "f93eeecbf393ea04", network: NETWORK, payTo: PAY_TO };

/** The terms of an accepts entry as /supported advertises them, with no payTo since protocol v2.0 */
const ADVERTISED = {
  windowZat: "100000",
  creditRatioBps: 2500,
  creditCapZat: "200000",
  zeroConfMinExpiryBlocks: 20,
  termsVersion: TERMS_VERSION,
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
    ["publicUrl", { publicUrl: "" }],
    ["publicUrl", { publicUrl: "api.example.com" }],
    ["publicUrl", { publicUrl: "ftp://api.example.com" }],
    ["publicUrl", { publicUrl: "https://api.example.com/a b" }],
    ["publicUrl", { publicUrl: "https://agent:pw@api.example.com" }],
    ["publicUrl", { publicUrl: "https://agent@api.example.com" }],
    ["publicUrl", { publicUrl: "https://api.example.com?x=1" }],
    ["publicUrl", { publicUrl: "https://api.example.com/?" }],
    ["publicUrl", { publicUrl: "https://api.example.com#top" }],
    ["publicUrl", { publicUrl: `https://api.example.com/${"a".repeat(2048)}` }],
    ["declareIntervalMs", { declareIntervalMs: 0 }],
    ["declareIntervalMs", { declareIntervalMs: 1.5 }],
    ["declareIntervalMs", { declareIntervalMs: 2 ** 31 }],
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
    ["publicUrl", { publicUrl: "https://agent:hunter2@api.example.com" }, "hunter2"],
    ["publicUrl", { publicUrl: "https://api.example.com/?key=hunter2" }, "hunter2"],
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
    // A /supported that offers the scheme and no terms at all
    const stub = await stubFacilitator({}, supportedOn(NETWORK, {}));
    const err = await startFailure(stub.url);
    expect(err.message).toMatch(/^facilitatorUrl:/);
    expect(err.message).toMatch(/terms/);
    expect(err.cause).toBeInstanceOf(FacilitatorCapabilityError);
  });

  test("a /supported that still carries a payTo does not fail the start, since /providers/me binds it", async () => {
    for (const payTo of [PAY_TO, OTHER_PAY_TO]) {
      const stub = await stubFacilitator({}, supportedOn(NETWORK, { ...ADVERTISED, payTo }));
      const api = await apiOn(stub.url);
      expect((await refusalOf(await fetch(`${api.url}/chunk`))).accepts[0]).toMatchObject({ payTo: PAY_TO });
      expect(stub.paths.slice(0, 2)).toEqual(["/providers/me", "/supported"]);
    }
  });

  test("a /supported without a payTo starts the API at the payTo /providers/me agreed to", async () => {
    const stub = await stubFacilitator({}, supportedOn(NETWORK, ADVERTISED));
    const api = await apiOn(stub.url);
    const accepted = (await refusalOf(await fetch(`${api.url}/chunk`))).accepts[0];
    expect(accepted).toMatchObject({ payTo: PAY_TO, amount: "500", extra: ADVERTISED });
  });

  test("a /supported that offers another network still fails naming network, once /providers/me agrees", async () => {
    const stub = await stubFacilitator({}, supportedOn(NETWORK_TESTNET, ADVERTISED));
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

/** Where the operator says the API is reached, which nothing needs to serve since the facilitator never fetches it */
const PUBLIC_URL = "https://demo.example.test";

/** One POST /discovery/resources that a stub catalog took */
interface Declaration {
  authorization: string | undefined;
  contentType: string | undefined;
  /** The body, parsed, or undefined when it is not JSON */
  body: unknown;
  /** When it arrived, as Date.now() */
  at: number;
}

/** A facilitator stand-in that takes the API's start and keeps what is declared to it, answering as told */
async function stubCatalog() {
  let how: number | "drop" = 200;
  let refusal: unknown;
  let atOnce = 0;
  const stub = {
    /** Every request it took, as "METHOD /path", in order */
    requests: [] as string[],
    declarations: [] as Declaration[],
    /** The most declarations it was answering at one time */
    mostAtOnce: 0,
    /** The declarations whose sender went away before the answer */
    abandoned: 0,
    /** How long it holds each answer */
    delayMs: 0,
    /** How it answers declarations from now on, 200 by default, another status and body, or "drop" to cut them off */
    answer(next: number | "drop", body?: unknown): void {
      how = next;
      refusal = body;
    },
  };
  const server = createServer((req, res) => {
    stub.requests.push(`${req.method} ${req.url}`);
    res.setHeader("content-type", "application/json");
    if (req.method === "GET" && req.url === "/providers/me") {
      res.end(JSON.stringify(ME));
    } else if (req.method === "GET" && req.url === "/supported") {
      res.end(JSON.stringify(supportedOn(NETWORK, ADVERTISED)));
    } else if (req.method === "POST" && req.url === "/discovery/resources") {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("close", () => {
        if (!res.writableFinished) stub.abandoned += 1;
      });
      req.on("end", () => {
        void (async () => {
          atOnce += 1;
          stub.mostAtOnce = Math.max(stub.mostAtOnce, atOnce);
          try {
            let body: unknown;
            try {
              body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            } catch {
              body = undefined;
            }
            const { authorization } = req.headers;
            const contentType = req.headers["content-type"];
            stub.declarations.push({ authorization, contentType, body, at: Date.now() });
            if (stub.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, stub.delayMs));
            if (req.socket.destroyed) return;
            if (how === "drop") {
              req.socket.destroy();
            } else if (how === 200) {
              const items = typeof body === "object" && body !== null ? (body as { items?: unknown }).items : [];
              res.end(JSON.stringify({ x402Version: 2, items }));
            } else {
              res.statusCode = how;
              res.end(JSON.stringify(refusal ?? { error: "refused_by_the_stub" }));
            }
          } finally {
            atOnce -= 1;
          }
        })();
      });
    } else {
      res.statusCode = 404;
      res.end('{"error":"not_found"}');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  running.push({
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  });
  return Object.assign(stub, { url: `http://127.0.0.1:${(server.address() as { port: number }).port}` });
}

describe("declaring GET /chunk to the facilitator's Bazaar", { timeout: LONG }, () => {
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  /** Waits until the stub has taken `more` declarations beyond those it has now */
  async function declared(stub: Awaited<ReturnType<typeof stubCatalog>>, more: number): Promise<void> {
    const target = stub.declarations.length + more;
    await vi.waitFor(() => expect(stub.declarations.length).toBeGreaterThanOrEqual(target), { timeout: 5_000 });
  }

  /** What GET /discovery/resources answers for the API's payTo, the items only */
  const listedFor = async (facilitatorUrl: string, payTo = PAY_TO): Promise<any[]> =>
    ((await (await fetch(`${facilitatorUrl}/discovery/resources?payTo=${payTo}`)).json()) as { items: any[] }).items;

  /** An API that declares under PUBLIC_URL and keeps its log to itself, unless the test reads it */
  const declaring = (facilitatorUrl: string, over: Partial<ApiOptions> = {}) =>
    apiOn(facilitatorUrl, { publicUrl: PUBLIC_URL, log: quiet, ...over });

  test("lists /chunk under the public URL and the API's payTo within one beat, with a fresh lastSeen", async () => {
    const facilitator = await facilitatorOn(new FakeChain({ expiryDelta: 40 }));
    expect(await listedFor(facilitator.url)).toEqual([]);

    const before = Date.now();
    const api = await declaring(facilitator.url);
    await vi.waitFor(async () => expect(await listedFor(facilitator.url)).toHaveLength(1), { timeout: 5_000 });

    const [item] = await listedFor(facilitator.url);
    const required = await refusalOf(await fetch(`${api.url}/chunk`));
    expect(item).toMatchObject({
      resource: `${PUBLIC_URL}/chunk`,
      type: "http",
      x402Version: 2,
      mimeType: "application/json",
      accepts: [{ scheme: SCHEME, network: NETWORK, amount: "500", asset: "ZEC", payTo: PAY_TO }],
      extensions: { bazaar: bazaarOf("500") },
      paidCallsToday: 0,
    });
    // What the 402 asks, which is also what the catalog offers
    expect(item.accepts).toEqual(required.accepts);
    expect(item.extensions).toEqual(required.extensions);
    const seen = Date.parse(item.lastSeen);
    expect(seen).toBeGreaterThanOrEqual(before);
    expect(seen).toBeLessThanOrEqual(Date.now());
  });

  test("the 402 names the declared resource, a trailing slash of the public URL dropped", async () => {
    const facilitator = await facilitatorOn(new FakeChain({ expiryDelta: 40 }));
    const api = await declaring(facilitator.url, { publicUrl: `${PUBLIC_URL}/` });
    const required = await refusalOf(await fetch(`${api.url}/chunk`));
    expect(required.resource).toEqual(resourceAt(`${PUBLIC_URL}/chunk`));

    // Without a public URL it is the URL the request came to, as it was
    const bare = await apiOn(facilitator.url);
    expect((await refusalOf(await fetch(`${bare.url}/chunk`))).resource.url).toBe(`${bare.url}/chunk`);
  });

  test("a path in the public URL is kept in the resource", async () => {
    const facilitator = await facilitatorOn(new FakeChain({ expiryDelta: 40 }));
    const api = await declaring(facilitator.url, { publicUrl: `${PUBLIC_URL}/z402/` });
    expect((await refusalOf(await fetch(`${api.url}/chunk`))).resource.url).toBe(`${PUBLIC_URL}/z402/chunk`);
    await vi.waitFor(
      async () => expect((await listedFor(facilitator.url))[0]?.resource).toBe(`${PUBLIC_URL}/z402/chunk`),
      { timeout: 5_000 },
    );
  });

  test("createApiApp only names the resource, since declaring belongs to the API that runs", async () => {
    const stub = await stubCatalog();
    const app = await createApiApp(apiOptions(stub.url, { publicUrl: PUBLIC_URL, declareIntervalMs: 20 }));
    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    running.push({
      close: () =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    });
    const { port } = server.address() as { port: number };
    expect((await refusalOf(await fetch(`http://127.0.0.1:${port}/chunk`))).resource.url).toBe(`${PUBLIC_URL}/chunk`);
    await sleep(200);
    expect(stub.requests).toEqual(["GET /providers/me", "GET /supported"]);
  });

  test("settled payments count on the declared item and create no other", async () => {
    const chain = new FakeChain({ expiryDelta: 40 });
    const facilitator = await facilitatorOn(chain);
    const api = await declaring(facilitator.url);
    await vi.waitFor(async () => expect(await listedFor(facilitator.url)).toHaveLength(1), { timeout: 5_000 });

    // The client pays at the URL it reached, and echoes the resource the 402 named
    const p = payer(api.url);
    p.client.pendingTxid = deposit(chain, p.client.sessionKey, 1);
    for (let i = 1; i <= 3; i++) await paidChunk(await p.chunk());

    expect(decodePaymentSignatureHeader(p.sent[0] ?? "").resource?.url).toBe(`${PUBLIC_URL}/chunk`);
    const items = await listedFor(facilitator.url);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ resource: `${PUBLIC_URL}/chunk`, paidCallsToday: 3 });
    expect(items[0].lastSeen).toBeDefined();
  });

  test("declares again every interval, so lastSeen keeps moving", async () => {
    const facilitator = await facilitatorOn(new FakeChain({ expiryDelta: 40 }));
    await declaring(facilitator.url, { declareIntervalMs: 40 });
    let first = 0;
    await vi.waitFor(
      async () => {
        const [item] = await listedFor(facilitator.url);
        expect(item).toBeDefined();
        first = Date.parse(item.lastSeen);
      },
      { timeout: 5_000 },
    );
    await vi.waitFor(
      async () => expect(Date.parse((await listedFor(facilitator.url))[0].lastSeen)).toBeGreaterThan(first),
      { timeout: 5_000 },
    );
    expect(await listedFor(facilitator.url)).toHaveLength(1);
  });

  test("sends one item made of the 402 of an unpaid request, with its accepts and extensions as they are", async () => {
    const stub = await stubCatalog();
    const api = await declaring(stub.url, { priceZat: 700n });
    await declared(stub, 1);

    const required = await refusalOf(await fetch(`${api.url}/chunk`));
    expect(required.accepts[0]).toMatchObject({ payTo: PAY_TO, amount: "700" });
    // Exactly what the 402 carries, and no key it does not
    expect(stub.declarations[0]?.body).toStrictEqual({
      items: [
        {
          resource: `${PUBLIC_URL}/chunk`,
          type: "http",
          x402Version: 2,
          accepts: required.accepts,
          mimeType: "application/json",
          description: "One numbered chunk of demo data per paid call",
          serviceName: "Demo API",
          tags: ["demo"],
          extensions: extensionsOf("700"),
        },
      ],
    });
    expect(stub.requests.slice(0, 3)).toEqual(["GET /providers/me", "GET /supported", "POST /discovery/resources"]);
  });

  test("the key goes as a bearer token, and no header is sent without one", async () => {
    const withKey = await stubCatalog();
    await declaring(withKey.url);
    await declared(withKey, 1);
    expect(withKey.declarations[0]).toMatchObject({
      authorization: `Bearer ${TOKEN}`,
      contentType: "application/json",
    });

    const without = await stubCatalog();
    await declaring(without.url, { facilitatorToken: undefined });
    await declared(without, 1);
    expect(without.declarations[0]?.authorization).toBeUndefined();
  });

  test("without a public URL nothing is ever declared, whatever the interval", async () => {
    const stub = await stubCatalog();
    const api = await apiOn(stub.url, { declareIntervalMs: 20, log: quiet });
    await refusalOf(await fetch(`${api.url}/chunk`));
    await sleep(400);
    await api.close();
    await sleep(100);
    // The start was all it asked, so no declaration and no other request ever arrived
    expect(stub.requests).toEqual(["GET /providers/me", "GET /supported"]);
  });

  test("close() stops the beat", async () => {
    const stub = await stubCatalog();
    const api = await declaring(stub.url, { declareIntervalMs: 30 });
    await declared(stub, 3);

    await api.close();
    // A declaration sent just before the close may still be on its way to the stub
    await sleep(100);
    const count = stub.declarations.length;
    await sleep(400);
    expect(stub.declarations).toHaveLength(count);
  });

  test("close() ends a declaration in flight at once, and says nothing of it", async () => {
    const log: string[] = [];
    const stub = await stubCatalog();
    stub.delayMs = 5_000;
    const api = await declaring(stub.url, { log: (line) => log.push(line) });
    await declared(stub, 1);

    const started = Date.now();
    await api.close();
    expect(Date.now() - started).toBeLessThan(2_000);
    // The request is gone from the stub long before the 5 s it holds the answer for
    await vi.waitFor(() => expect(stub.abandoned).toBe(1), { timeout: 3_000 });
    expect(log).toEqual([]);
  });

  test("the next beat is 30 s after the last declaration, on a timer that never holds the process open", async () => {
    const timers = vi.spyOn(globalThis, "setTimeout");
    const stub = await stubCatalog();
    await declaring(stub.url);
    await declared(stub, 1);

    const thirty = (): number => timers.mock.calls.findIndex(([, ms]) => ms === 30_000);
    await vi.waitFor(() => expect(thirty()).toBeGreaterThanOrEqual(0), { timeout: 5_000 });
    expect((timers.mock.results[thirty()]?.value as NodeJS.Timeout).hasRef()).toBe(false);
    expect(stub.declarations).toHaveLength(1);
  });

  test("declares again an interval after the last declaration ended, so two never overlap", async () => {
    const stub = await stubCatalog();
    await declaring(stub.url, { declareIntervalMs: 100 });
    const gaps = (list: Declaration[]): number[] => list.slice(1).map((d, i) => d.at - (list[i]?.at ?? 0));
    await declared(stub, 4);
    expect(Math.min(...gaps(stub.declarations))).toBeGreaterThanOrEqual(95);

    // A catalog that is slow to answer holds the next declaration back until it has answered
    stub.delayMs = 300;
    const from = stub.declarations.length;
    await declared(stub, 3);
    expect(Math.min(...gaps(stub.declarations.slice(from)))).toBeGreaterThanOrEqual(395);
    expect(stub.mostAtOnce).toBe(1);
  });

  test("a 400 is logged once, without the token, and the next beat tries again", async () => {
    const log: string[] = [];
    const stub = await stubCatalog();
    stub.answer(400, { error: "invalid_request", index: 0, message: `accepts[0].extra: not for ${TOKEN}` });
    const api = await declaring(stub.url, { declareIntervalMs: 30, log: (line) => log.push(line) });

    await declared(stub, 5);
    expect(log).toEqual([
      expect.stringMatching(
        new RegExp(
          String.raw`^discovery: the facilitator at http://127\.0\.0\.1:\d+ refused the declaration ` +
            String.raw`\(400, item 0: accepts\[0\]\.extra: not for <token>\); trying again every 0\.03 s$`,
        ),
      ),
    ]);
    expect(log.join("\n")).not.toContain(TOKEN);
    // The API is up all the while
    expect((await fetch(`${api.url}/chunk`)).status).toBe(402);
  });

  test("a price the facilitator's window cannot take is refused by its catalog and logged once", async () => {
    const log: string[] = [];
    const facilitator = await facilitatorOn(new FakeChain({ expiryDelta: 40 }));
    // Nothing checks the price against the window at start (the README says so), but the catalog does
    await declaring(facilitator.url, { priceZat: 100_001n, declareIntervalMs: 30, log: (line) => log.push(line) });

    await vi.waitFor(() => expect(log).toHaveLength(1), { timeout: 5_000 });
    await sleep(200);
    expect(log).toEqual([
      expect.stringMatching(
        new RegExp(
          String.raw`^discovery: the facilitator at http://127\.0\.0\.1:\d+ refused the declaration ` +
            String.raw`\(400, item 0: items\[0\]\.accepts\[0\]\.amount: ` +
            String.raw`must be a canonical zat amount from 1 to 100000\); trying again every 0\.03 s$`,
        ),
      ),
    ]);
    expect(log.join("\n")).not.toContain(TOKEN);
    expect(await listedFor(facilitator.url)).toEqual([]);
  });

  test("logs each change of outcome once, keeps the API up, and never logs the token", async () => {
    const log: string[] = [];
    const stub = await stubCatalog();
    const api = await declaring(stub.url, { declareIntervalMs: 30, log: (line) => log.push(line) });
    await declared(stub, 2);
    const answers: Array<[number | "drop", unknown]> = [
      [404, { error: "not_found" }],
      [401, { error: "unauthorized" }],
      [403, { error: "forbidden" }],
      [400, { error: "invalid_request", index: 0, message: `accepts[0].amount: not for ${TOKEN}\u001b[2J` }],
      [503, undefined],
      [301, undefined],
      ["drop", undefined],
      [200, undefined],
    ];
    for (const [how, body] of answers) {
      stub.answer(how, body);
      await declared(stub, 3);
    }

    const at = String.raw`the facilitator at http://127\.0\.0\.1:\d+`;
    const again = String.raw`; trying again every 0\.03 s$`;
    const listed = new RegExp(String.raw`^discovery: 1 paid route listed by ${at}, declared again every 0\.03 s$`);
    expect(log).toEqual(
      [
        listed,
        new RegExp(
          String.raw`^discovery: ${at} has no Bazaar to declare to \(404\), ` +
            String.raw`so the route is not listed${again}`,
        ),
        new RegExp(String.raw`^discovery: Z402_FACILITATOR_TOKEN: ${at} refused the declaration \(401\)${again}`),
        new RegExp(String.raw`^discovery: Z402_FACILITATOR_TOKEN: ${at} refused the declaration \(403\)${again}`),
        new RegExp(
          String.raw`^discovery: ${at} refused the declaration ` +
            String.raw`\(400, item 0: accepts\[0\]\.amount: not for <token> \[2J\)${again}`,
        ),
        new RegExp(String.raw`^discovery: ${at} answered the declaration with 503${again}`),
        new RegExp(String.raw`^discovery: ${at} answered the declaration with 301${again}`),
        new RegExp(String.raw`^discovery: cannot reach ${at} \(\S+\)${again}`),
        listed,
      ].map((line) => expect.stringMatching(line)),
    );
    expect(log.join("\n")).not.toContain(TOKEN);
    expect((await fetch(`${api.url}/chunk`)).status).toBe(402);
  });

  test("a declaration that gets no answer in time is reported as that, once", async () => {
    const log: string[] = [];
    const stub = await stubCatalog();
    // Only the declarations time out, since the start has to reach the stub
    const real = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) =>
      init?.method === "POST"
        ? Promise.reject(new DOMException("The operation timed out.", "TimeoutError"))
        : real(input, init),
    );
    await declaring(stub.url, { declareIntervalMs: 30, log: (line) => log.push(line) });

    await vi.waitFor(() => expect(log).toHaveLength(1), { timeout: 5_000 });
    await sleep(200);
    expect(log).toEqual([
      expect.stringMatching(
        new RegExp(
          String.raw`^discovery: cannot reach the facilitator at http://127\.0\.0\.1:\d+ ` +
            String.raw`\(no answer within 10 s\); trying again every 0\.03 s$`,
        ),
      ),
    ]);
    expect(stub.declarations).toEqual([]);
  });

  test("keeps trying while the facilitator is down, and lists again once it is back", async () => {
    const log: string[] = [];
    const chain = new FakeChain({ expiryDelta: 40 });
    const first = await facilitatorOn(chain);
    await declaring(first.url, { declareIntervalMs: 30, log: (line) => log.push(line) });
    await vi.waitFor(async () => expect(await listedFor(first.url)).toHaveLength(1), { timeout: 5_000 });

    await first.close();
    await vi.waitFor(() => expect(log.length).toBeGreaterThanOrEqual(2), { timeout: 5_000 });
    await sleep(200);
    const second = await facilitatorOn(chain, { port: Number(new URL(first.url).port) });
    await vi.waitFor(async () => expect(await listedFor(second.url)).toHaveLength(1), { timeout: 5_000 });
    await vi.waitFor(() => expect(log.at(-1)).toMatch(/^discovery: 1 paid route listed by /), { timeout: 5_000 });

    // Each line is a change, so listed comes first and last with only the outage between
    expect(log[0]).toMatch(/^discovery: 1 paid route listed by /);
    const unreachable = /^discovery: cannot reach the facilitator at \S+ \(\S+\); /;
    for (const line of log.slice(1, -1)) expect(line).toMatch(unreachable);
    log.slice(1).forEach((line, i) => expect(line).not.toBe(log[i]));
    expect(log.join("\n")).not.toContain(TOKEN);
  });

  describe("beside a second provider", () => {
    const PAY_TO_2 = `uregtest1${"p".repeat(60)}`;

    test("a bare API stays silent and is listed from its payments, beside one that declares", async () => {
      const chain = new FakeChain({ expiryDelta: 40 });
      const chain2 = new FakeChain({ expiryDelta: 40 });
      const facilitator = await facilitatorOn(chain, {
        providers: {
          dir: join(scratch, "providers-declare"),
          chainFor: () => chain2.viewFor(PAY_TO_2),
          owns: async () => true,
        },
      });
      const registered = await fetch(`${facilitator.url}/providers`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ payTo: PAY_TO_2, uivk: `uivkregtest1${"sec3ret".repeat(10)}` }),
      });
      expect(registered.status).toBe(201);
      const { apiKey } = (await registered.json()) as { apiKey: string };

      const operatorApi = await declaring(facilitator.url);
      const providerApi = await apiOn(facilitator.url, {
        facilitatorToken: apiKey,
        payTo: PAY_TO_2,
        priceZat: 800n,
        declareIntervalMs: 30,
      });
      await vi.waitFor(async () => expect(await listedFor(facilitator.url)).toHaveLength(1), { timeout: 5_000 });

      const first = payer(operatorApi.url);
      const second = payer(providerApi.url);
      first.client.pendingTxid = deposit(chain, first.client.sessionKey, 1);
      second.client.pendingTxid = chain2.broadcast({
        outputs: [{ to: PAY_TO_2, valueZat: 100000n, memo: depositMemo(second.client.sessionKey, 1) }],
      });
      for (let i = 0; i < 2; i++) {
        await paidChunk(await first.chunk());
        await paidChunk(await second.chunk());
      }

      const operator = await listedFor(facilitator.url, PAY_TO);
      const provider = await listedFor(facilitator.url, PAY_TO_2);
      expect(operator).toMatchObject([{ resource: `${PUBLIC_URL}/chunk`, paidCallsToday: 2 }]);
      expect(operator[0].lastSeen).toBeDefined();
      expect(provider).toMatchObject([{ resource: `${providerApi.url}/chunk`, paidCallsToday: 2 }]);
      expect(provider[0].lastSeen).toBeUndefined();
    });
  });
});
