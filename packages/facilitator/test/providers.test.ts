import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { connect, createServer, type AddressInfo } from "node:net";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { ASSET, DEMO_TERMS, NETWORK_REGTEST, NETWORK_TESTNET, REASON, SCHEME, type ChainView } from "@z402-net/protocol";
import { FakeChain } from "@z402/testkit";
import { afterAll, afterEach, describe, expect, test, vi } from "vitest";
import { startFacilitator, type FacilitatorHandle, type FacilitatorOptions } from "../src/app.js";
import { API_KEY_RE, keyDigest } from "../src/providers/apiKey.js";
import { providerId } from "../src/providers/id.js";
import { paymentFor, SESSION_KEY as K, voucherFor } from "./support/vouchers.js";

const NETWORK = NETWORK_REGTEST;
const OPERATOR = `uregtest1${"q".repeat(60)}`;
const TOKEN = "t-7c2e91-secret";
const REGISTRATION = "r-5d1b84-secret";
const A = { payTo: `uregtest1${"p".repeat(60)}`, uivk: `uivkregtest1${"sec3ret".repeat(10)}` };
const B = { payTo: `uregtest1${"z".repeat(60)}`, uivk: `uivkregtest1${"w3ak".repeat(10)}` };
const C = { payTo: `uregtest1${"r".repeat(60)}`, uivk: `uivkregtest1${"c0de".repeat(10)}` };
type Who = typeof A;
const ID_A = providerId(NETWORK, A.payTo);
const ID_B = providerId(NETWORK, B.payTo);
const ID_OPERATOR = providerId(NETWORK, OPERATOR);
const W = 100000n;

const scratch = mkdtempSync(join(tmpdir(), "z402-providers-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const running: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((h) => h.close()));
});

/** Everything one test's facilitators share, so that a restart finds the same chains, ledgers and registry */
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
    chains,
    chainOf,
    lines,
    log: (msg: string, err?: unknown) => lines.push(err === undefined ? msg : `${msg} ${inspect(err, { depth: 10 })}`),
    owns: vi.fn(async (_p: { payTo: string; uivk: string }) => true),
  };
}
type Rig = ReturnType<typeof newRig>;

/** A facilitator whose operator is OPERATOR, with providers over the rig's chains unless `providers` is null */
async function boot(
  rig: Rig,
  over: Partial<FacilitatorOptions> = {},
  providers: Partial<NonNullable<FacilitatorOptions["providers"]>> | null = {},
): Promise<FacilitatorHandle> {
  const handle = await startFacilitator({
    network: NETWORK,
    chain: rig.chainOf(OPERATOR).viewFor(OPERATOR),
    payTo: OPERATOR,
    terms: DEMO_TERMS,
    authToken: TOKEN,
    port: 0,
    depositWaitMs: 50,
    log: rig.log,
    ...(providers === null
      ? {}
      : {
          providers: {
            dir: rig.providers,
            chainFor: (p) => rig.chainOf(p.payTo).viewFor(p.payTo),
            owns: rig.owns,
            ...providers,
          },
        }),
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
  /** Sent as `Authorization: Bearer <token>`, and no header at all when it is left out */
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

const register = (url: string, who: Who, init: Init = {}, path = "/providers") =>
  call(url, path, { method: "POST", body: { payTo: who.payTo, uivk: who.uivk }, ...init });

/** Registers a provider that must be accepted, and returns its API key */
async function enroll(url: string, who: Who, init: Init = {}): Promise<string> {
  const res = await register(url, who, init);
  expect(res.status).toBe(201);
  return res.json.apiKey as string;
}

async function requirementsFor(url: string, payTo: string, amount = "500"): Promise<PaymentRequirements> {
  const supported = await call(url, "/supported");
  const { windowZat, creditRatioBps, creditCapZat, zeroConfMinExpiryBlocks, termsVersion } =
    supported.json.kinds[0].extra;
  return {
    scheme: SCHEME,
    network: NETWORK,
    asset: ASSET,
    amount,
    payTo,
    maxTimeoutSeconds: 60,
    extra: { windowZat, creditRatioBps, creditCapZat, zeroConfMinExpiryBlocks, termsVersion },
  };
}

const envelope = (payload: PaymentPayload, requirements: PaymentRequirements) => ({
  x402Version: 2,
  paymentPayload: payload,
  paymentRequirements: requirements,
});
const verify = (url: string, token: string, payload: PaymentPayload, r: PaymentRequirements) =>
  call(url, "/verify", { token, body: envelope(payload, r) });
const settle = (url: string, token: string, payload: PaymentPayload, r: PaymentRequirements) =>
  call(url, "/settle", { token, body: envelope(payload, r) });

const pay = (r: PaymentRequirements, c: bigint, txid?: string, seed?: Uint8Array): PaymentPayload =>
  paymentFor(r, voucherFor(r, c, { depositTxid: txid, seed }));

/** A deposit of one window to `payTo` for session K */
const deposit = (chain: FakeChain, payTo: string, value = W): string =>
  chain.broadcast({ outputs: [{ to: payTo, valueZat: value, memo: `${K}:1` }] });

/** The verify that makes a deposit known, then the settle that records the voucher */
async function paid(url: string, key: string, r: PaymentRequirements, c: bigint, txid?: string): Promise<Reply> {
  const payload = pay(r, c, txid);
  expect((await verify(url, key, payload, r)).json.isValid).toBe(true);
  return settle(url, key, payload, r);
}

const ledgerOf = (rig: Rig, who: { payTo: string }): string =>
  join(rig.providers, "ledgers", `${providerId(NETWORK, who.payTo)}.jsonl`);

const ledgerTypes = (path: string): string[] =>
  readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => (JSON.parse(l) as { t: string }).t)
    .filter((t) => t !== "ledger");

/** The deposits a ledger credited, in the order it recorded them */
const depositsIn = (path: string): Array<{ txid: string; valueZat: string }> =>
  readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.includes('"t":"deposit"'))
    .map((l) => JSON.parse(l));

/** The ledgers of the providers directory, without the locks beside them */
const ledgerFiles = (rig: Rig): string[] =>
  readdirSync(join(rig.providers, "ledgers")).filter((n) => n.endsWith(".jsonl"));

/** Every lock file below a directory, by path relative to it */
function locksUnder(dir: string): string[] {
  return existsSync(dir)
    ? readdirSync(dir, { recursive: true })
        .map(String)
        .filter((n) => n.endsWith(".lock"))
    : [];
}

/** Puts a directory where the ledger of a provider belongs, so that its next write fails with EISDIR */
function breakLedger(rig: Rig, who: { payTo: string }): void {
  rmSync(ledgerOf(rig, who));
  mkdirSync(ledgerOf(rig, who));
}

/** Writes the lock of `path` as a start does that took it over while this one was paused for more than 15 s */
function takeOver(path: string): void {
  rmSync(`${path}.lock`);
  const other = { pid: process.pid, host: hostname(), token: "f0f0f0f0f0f0f0f0", since: new Date().toISOString() };
  writeFileSync(`${path}.lock`, JSON.stringify(other));
}

/** A port that nothing listens on now */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** True when a connection to the port is refused, which is what nothing listening on it comes to */
function refuses(port: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = connect({ port, host: "127.0.0.1" });
    socket.once("connect", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", (e: NodeJS.ErrnoException) => (e.code === "ECONNREFUSED" ? resolve(true) : reject(e)));
  });
}

function writeRegistry(rig: Rig, providers: unknown[], network: string = NETWORK): string {
  mkdirSync(join(rig.providers, "ledgers"), { recursive: true, mode: 0o700 });
  const path = join(rig.providers, "registry.json");
  writeFileSync(path, `${JSON.stringify({ version: 1, network, providers })}\n`, { mode: 0o600 });
  return path;
}

const entry = (who: Who, key: string, over: Record<string, unknown> = {}) => ({
  id: providerId(NETWORK, who.payTo),
  payTo: who.payTo,
  uivk: who.uivk,
  keyHash: keyDigest(key),
  createdAt: "2026-10-28T10:00:00.000Z",
  keyIssuedAt: "2026-10-28T10:00:00.000Z",
  ...over,
});

const KEY_A = `z402_${"A".repeat(43)}`;
const KEY_B = `z402_${"B".repeat(43)}`;

describe("two providers on one facilitator", () => {
  test("have interleaved sessions and a state of their own", async () => {
    const rig = newRig();
    const { url } = await boot(rig);
    const keyA = await enroll(url, A);
    const keyB = await enroll(url, B);
    // B's first transaction is not A's, since a fresh FakeChain numbers its transactions the same way
    rig.chainOf(B.payTo).broadcast({ outputs: [] });
    const dA = deposit(rig.chainOf(A.payTo), A.payTo);
    const dB = deposit(rig.chainOf(B.payTo), B.payTo);
    expect(dA).not.toBe(dB);
    const rA = await requirementsFor(url, A.payTo);
    const rB = await requirementsFor(url, B.payTo);

    expect((await verify(url, keyA, pay(rA, 500n, dA), rA)).json).toMatchObject({ isValid: true, payer: K });
    expect((await verify(url, keyB, pay(rB, 500n, dB), rB)).json).toMatchObject({ isValid: true, payer: K });
    const b1 = await settle(url, keyB, pay(rB, 500n, dB), rB);
    const a1 = await settle(url, keyA, pay(rA, 500n, dA), rA);
    const a2 = await settle(url, keyA, pay(rA, 1000n), rA);
    const b2 = await settle(url, keyB, pay(rB, 1000n), rB);
    const a3 = await settle(url, keyA, pay(rA, 1500n), rA);

    expect(b1.json).toMatchObject({ success: true, transaction: dB, amount: "500" });
    expect(a1.json).toMatchObject({ success: true, transaction: dA, amount: "500" });
    expect(a2.json).toMatchObject({ success: true, amount: "500" });
    expect(b2.json).toMatchObject({ success: true, amount: "500" });
    expect(a3.json.extra.session).toMatchObject({ cumulativeZat: "1500" });
    expect(b2.json.extra.session).toMatchObject({ cumulativeZat: "1000" });

    // Each session is where its own provider left it, and the other's progress does not show
    const staleA = await verify(url, keyA, pay(rA, 1000n), rA);
    expect(staleA.json).toMatchObject({ invalidReason: REASON.cumulativeMismatch });
    expect(staleA.json.extra.session).toMatchObject({ cumulativeZat: "1500" });
    const staleB = await verify(url, keyB, pay(rB, 500n), rB);
    expect(staleB.json).toMatchObject({ invalidReason: REASON.cumulativeMismatch });
    expect(staleB.json.extra.session).toMatchObject({ cumulativeZat: "1000" });

    // A deposit of A is nothing to B, whose chain view shows no output of that transaction to B
    await verify(url, keyB, pay(rB, 1500n, dA), rB);
    const crossed = await settle(url, keyB, pay(rB, 1500n, dA), rB);
    expect(crossed.json).toMatchObject({ success: true, transaction: "" });
    expect(depositsIn(ledgerOf(rig, B)).map((d) => d.txid)).toEqual([dB]);
    expect(depositsIn(ledgerOf(rig, A)).map((d) => d.txid)).toEqual([dA]);
  });

  test("keep a ledger each, named by the provider and headed by its payTo", async () => {
    const rig = newRig();
    const { url } = await boot(rig, { ledgerPath: join(rig.dir, "operator.jsonl") });
    const keyA = await enroll(url, A);
    const keyB = await enroll(url, B);
    const rA = await requirementsFor(url, A.payTo);
    const rB = await requirementsFor(url, B.payTo);
    await paid(url, keyA, rA, 500n, deposit(rig.chainOf(A.payTo), A.payTo));
    await settle(url, keyA, pay(rA, 1000n), rA);
    await paid(url, keyB, rB, 500n, deposit(rig.chainOf(B.payTo), B.payTo));

    const header = (who: Who) => JSON.stringify({ t: "ledger", network: NETWORK, payTo: who.payTo });
    expect(readFileSync(ledgerOf(rig, A), "utf8").split("\n")[0]).toBe(header(A));
    expect(readFileSync(ledgerOf(rig, B), "utf8").split("\n")[0]).toBe(header(B));
    expect(ledgerTypes(ledgerOf(rig, A))).toEqual(["deposit", "voucher", "voucher"]);
    expect(ledgerTypes(ledgerOf(rig, B))).toEqual(["deposit", "voucher"]);
    expect(readFileSync(join(rig.dir, "operator.jsonl"), "utf8")).toBe(
      `${JSON.stringify({ t: "ledger", network: NETWORK, payTo: OPERATOR })}\n`,
    );
  });

  test("are told apart by their keys, which pick a runtime for /providers/me", async () => {
    const rig = newRig();
    const { url } = await boot(rig);
    const keyA = await enroll(url, A);
    const keyB = await enroll(url, B);

    expect((await call(url, "/providers/me", { token: keyA })).json).toEqual({
      providerId: ID_A,
      network: NETWORK,
      payTo: A.payTo,
    });
    expect((await call(url, "/providers/me", { token: keyB })).json).toEqual({
      providerId: ID_B,
      network: NETWORK,
      payTo: B.payTo,
    });
    expect((await call(url, "/providers/me", { token: TOKEN })).json).toEqual({
      providerId: ID_OPERATOR,
      network: NETWORK,
      payTo: OPERATOR,
    });
  });

  test("a key with another provider's payTo is invalid_payment_requirements and leaves that one alone", async () => {
    const rig = newRig();
    const { url } = await boot(rig, { ledgerPath: join(rig.dir, "operator.jsonl") });
    const keyA = await enroll(url, A);
    const keyB = await enroll(url, B);
    const rB = await requirementsFor(url, B.payTo);
    const dB = deposit(rig.chainOf(B.payTo), B.payTo);
    await paid(url, keyB, rB, 500n, dB);
    const before = { b: readFileSync(ledgerOf(rig, B)), a: readFileSync(ledgerOf(rig, A)) };

    // The voucher is signed over B's payTo, and A's key offers it to A's runtime
    const crossed = pay(rB, 1000n, dB);
    const v = await verify(url, keyA, crossed, rB);
    const s = await settle(url, keyA, crossed, rB);
    expect(v.status).toBe(200);
    expect(v.json).toMatchObject({ isValid: false, invalidReason: REASON.invalidPaymentRequirements });
    expect(v.json.payer).toBeUndefined();
    expect(v.json.extra).toBeUndefined();
    expect(s.status).toBe(200);
    expect(s.json).toMatchObject({ success: false, errorReason: REASON.invalidPaymentRequirements, transaction: "" });

    // The operator's key cannot reach B either, and B's key cannot reach the operator's payTo
    const viaOperator = await settle(url, TOKEN, crossed, rB);
    expect(viaOperator.json).toMatchObject({ success: false, errorReason: REASON.invalidPaymentRequirements });
    const rOperator = await requirementsFor(url, OPERATOR);
    const viaB = await verify(url, keyB, pay(rOperator, 500n), rOperator);
    expect(viaB.json).toMatchObject({ isValid: false, invalidReason: REASON.invalidPaymentRequirements });

    expect(readFileSync(ledgerOf(rig, B))).toEqual(before.b);
    expect(readFileSync(ledgerOf(rig, A))).toEqual(before.a);
    // B's session is where it was, and its own key still pays
    const next = await verify(url, keyB, pay(rB, 1000n), rB);
    expect(next.json).toMatchObject({ isValid: true, extra: { session: { cumulativeZat: "500" } } });
  });

  test("see only their own outputs of one transaction that pays them both", async () => {
    const rig = newRig();
    const shared = new FakeChain({ expiryDelta: 40 });
    rig.chains.set(A.payTo, shared);
    rig.chains.set(B.payTo, shared);
    const { url } = await boot(rig);
    const keyA = await enroll(url, A);
    const keyB = await enroll(url, B);
    const rA = await requirementsFor(url, A.payTo);
    const rB = await requirementsFor(url, B.payTo);
    const tx = shared.broadcast({
      outputs: [
        { to: A.payTo, valueZat: 100000n, memo: `${K}:1` },
        { to: B.payTo, valueZat: 150000n, memo: `${K}:1` },
      ],
    });

    const a = await verify(url, keyA, pay(rA, 500n, tx), rA);
    const b = await verify(url, keyB, pay(rB, 500n, tx), rB);
    expect(a.json.isValid).toBe(true);
    expect(b.json.isValid).toBe(true);
    await settle(url, keyA, pay(rA, 500n, tx), rA);
    await settle(url, keyB, pay(rB, 500n, tx), rB);

    expect(depositsIn(ledgerOf(rig, A))).toMatchObject([{ txid: tx, valueZat: "100000" }]);
    expect(depositsIn(ledgerOf(rig, B))).toMatchObject([{ txid: tx, valueZat: "150000" }]);
  });

  test("price their own routes: a registered provider's 800 is taken beside the operator's 500", async () => {
    const rig = newRig();
    const { url } = await boot(rig);
    const keyB = await enroll(url, B);
    const dear = await requirementsFor(url, B.payTo, "800");
    const res = await verify(url, keyB, pay(dear, 800n), dear);
    // Past the amount rule, the voucher stops at the missing deposit and not at the price
    expect(res.json).toMatchObject({ isValid: false, invalidReason: REASON.depositRequired });

    const paidAt800 = await paid(url, keyB, dear, 800n, deposit(rig.chainOf(B.payTo), B.payTo));
    expect(paidAt800.json).toMatchObject({ success: true, amount: "800", payer: K });
    const op = await requirementsFor(url, OPERATOR, "500");
    const operator = await paid(url, TOKEN, op, 500n, deposit(rig.chainOf(OPERATOR), OPERATOR));
    expect(operator.json).toMatchObject({ success: true, amount: "500", payer: K });
  });

  test("take two prices in one session of a provider, and refuse a voucher short of the call's own", async () => {
    const rig = newRig();
    const { url } = await boot(rig);
    const keyA = await enroll(url, A);
    const keyB = await enroll(url, B);
    const cheap = await requirementsFor(url, B.payTo, "500");
    const dear = await requirementsFor(url, B.payTo, "800");

    expect((await paid(url, keyB, cheap, 500n, deposit(rig.chainOf(B.payTo), B.payTo))).json).toMatchObject({
      success: true,
      amount: "500",
    });
    expect((await settle(url, keyB, pay(dear, 1300n), dear)).json).toMatchObject({ success: true, amount: "800" });
    expect((await settle(url, keyB, pay(cheap, 1800n), cheap)).json).toMatchObject({ success: true, amount: "500" });
    // 500 more than cLast is enough for the cheap route and 300 short for the dear one
    const short = await verify(url, keyB, pay(dear, 2300n), dear);
    expect(short.json).toMatchObject({
      isValid: false,
      invalidReason: REASON.cumulativeMismatch,
      invalidMessage: "cumulativeZat must be at least 2600",
    });
    expect((await verify(url, keyB, pay(cheap, 2300n), cheap)).json).toMatchObject({ isValid: true });

    // B's prices are B's own, so A's session is where it was and A has a price of its own
    const asA = await requirementsFor(url, A.payTo, "700");
    expect((await paid(url, keyA, asA, 700n, deposit(rig.chainOf(A.payTo), A.payTo))).json).toMatchObject({
      success: true,
      amount: "700",
    });
    expect(ledgerTypes(ledgerOf(rig, B))).toEqual(["deposit", "voucher", "voucher", "voucher"]);
    expect(ledgerTypes(ledgerOf(rig, A))).toEqual(["deposit", "voucher"]);
  });

  test("advertise one termsVersion, which every provider's resource server copies from /supported", async () => {
    const rig = newRig();
    const { url } = await boot(rig);
    const keyA = await enroll(url, A);
    const keyB = await enroll(url, B);
    const rA = await requirementsFor(url, A.payTo);
    const rB = await requirementsFor(url, B.payTo);
    const op = await requirementsFor(url, OPERATOR);

    expect(rA.extra.termsVersion).toBe(rB.extra.termsVersion);
    expect(rA.extra.termsVersion).toBe(op.extra.termsVersion);
    // The requirements the one /supported gives are taken by each provider's runtime
    expect((await verify(url, keyA, pay(rA, 500n), rA)).json.invalidReason).toBe(REASON.depositRequired);
    expect((await verify(url, keyB, pay(rB, 500n), rB)).json.invalidReason).toBe(REASON.depositRequired);
    expect((await verify(url, TOKEN, pay(op, 500n), op)).json.invalidReason).toBe(REASON.depositRequired);
  });

  test("are both brought up to date by the handle's pollNow", async () => {
    const rig = newRig();
    const handle = await boot(rig);
    const keyA = await enroll(handle.url, A);
    const keyB = await enroll(handle.url, B);
    const rA = await requirementsFor(handle.url, A.payTo);
    const rB = await requirementsFor(handle.url, B.payTo);
    await paid(handle.url, keyA, rA, 500n, deposit(rig.chainOf(A.payTo), A.payTo));
    await paid(handle.url, keyB, rB, 500n, deposit(rig.chainOf(B.payTo), B.payTo));

    rig.chainOf(A.payTo).mine(1);
    rig.chainOf(B.payTo).mine(1);
    await handle.pollNow();
    expect(ledgerTypes(ledgerOf(rig, A))).toEqual(["deposit", "voucher", "status"]);
    expect(ledgerTypes(ledgerOf(rig, B))).toEqual(["deposit", "voucher", "status"]);
  });

  test("are watched by themselves, a registered provider's watcher included", async () => {
    const rig = newRig();
    const handle = await boot(rig, { pollIntervalMs: 20 });
    const keyA = await enroll(handle.url, A);
    const rA = await requirementsFor(handle.url, A.payTo);
    await paid(handle.url, keyA, rA, 500n, deposit(rig.chainOf(A.payTo), A.payTo));

    rig.chainOf(A.payTo).mine(1);
    await vi.waitFor(() => expect(ledgerTypes(ledgerOf(rig, A))).toEqual(["deposit", "voucher", "status"]), {
      timeout: 3000,
      interval: 20,
    });
  });

  test("keep being served while another provider registers", async () => {
    const rig = newRig();
    const { url } = await boot(rig);
    const keyA = await enroll(url, A);
    const rA = await requirementsFor(url, A.payTo);
    await paid(url, keyA, rA, 500n, deposit(rig.chainOf(A.payTo), A.payTo));

    const [registration, s1, s2, v] = await Promise.all([
      register(url, B),
      settle(url, keyA, pay(rA, 1000n), rA),
      settle(url, keyA, pay(rA, 1500n), rA),
      verify(url, keyA, pay(rA, 2000n), rA),
    ]);
    expect(registration.status).toBe(201);
    expect(s1.json.success).toBe(true);
    expect(s2.json.success).toBe(true);
    expect(v.json.isValid).toBe(true);
    const rB = await requirementsFor(url, B.payTo);
    expect((await verify(url, registration.json.apiKey, pay(rB, 500n), rB)).json.invalidReason).toBe(
      REASON.depositRequired,
    );
  });
});

describe("POST /providers", () => {
  test("answers 201 with the provider and a key, which is not to be cached and works at once", async () => {
    const rig = newRig();
    const { url } = await boot(rig);
    const res = await register(url, A);

    expect(res.status).toBe(201);
    expect(res.json).toEqual({
      providerId: ID_A,
      network: NETWORK,
      payTo: A.payTo,
      apiKey: expect.stringMatching(API_KEY_RE),
    });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(JSON.stringify(res.json)).not.toContain(A.uivk);
    expect(await call(url, "/providers/me", { token: res.json.apiKey })).toMatchObject({
      status: 200,
      json: { providerId: ID_A, payTo: A.payTo },
    });
  });

  test("asks the owns check about the key and payTo it was sent, once", async () => {
    const rig = newRig();
    const { url } = await boot(rig);
    await enroll(url, A);
    expect(rig.owns).toHaveBeenCalledTimes(1);
    expect(rig.owns).toHaveBeenCalledWith({ payTo: A.payTo, uivk: A.uivk });
  });

  test("keeps the key out of the registry, which holds its hash in a file only its owner reads", async () => {
    const rig = newRig();
    const { url } = await boot(rig);
    const key = await enroll(url, A);
    const path = join(rig.providers, "registry.json");

    const text = readFileSync(path, "utf8");
    expect(text).toContain(keyDigest(key));
    expect(text).not.toContain(key);
    expect(JSON.parse(text)).toMatchObject({ version: 1, network: NETWORK, providers: [{ id: ID_A, payTo: A.payTo }] });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(rig.providers).mode & 0o777).toBe(0o700);
  });

  test("rotates the key of a registered payTo: 200, a new key at once, and the old one dead at once", async () => {
    const rig = newRig();
    const { url } = await boot(rig);
    const first = await register(url, A);
    const second = await register(url, A);

    expect(second.status).toBe(200);
    expect(second.json).toEqual({
      providerId: ID_A,
      network: NETWORK,
      payTo: A.payTo,
      apiKey: expect.stringMatching(API_KEY_RE),
    });
    const [old, fresh] = [first.json.apiKey as string, second.json.apiKey as string];
    expect(fresh).not.toBe(old);

    // The very next request of each key, on every authenticated route
    const r = await requirementsFor(url, A.payTo);
    for (const [method, path, body] of [
      ["GET", "/providers/me", undefined],
      ["POST", "/verify", envelope(pay(r, 500n), r)],
      ["POST", "/settle", envelope(pay(r, 500n), r)],
    ] as const) {
      const refused = await call(url, path, { method, token: old, body });
      expect(refused).toMatchObject({ status: 401, json: { error: "unauthorized" } });
      expect(refused.headers.get("www-authenticate")).toBe("Bearer");
      expect((await call(url, path, { method, token: fresh, body })).status).toBe(200);
    }
    expect(await call(url, "/providers/me", { token: fresh })).toMatchObject({ json: { providerId: ID_A } });
    expect((await call(url, "/supported", { token: old })).status).toBe(401);
    expect((await call(url, "/supported", { token: fresh })).status).toBe(200);
  });

  test("a rotation stores the new hash and moves keyIssuedAt, and keeps the creation time and the ledger", async () => {
    const rig = newRig();
    const { url } = await boot(rig);
    const first = await register(url, A);
    const before = JSON.parse(readFileSync(join(rig.providers, "registry.json"), "utf8")).providers[0];
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await register(url, A);
    const after = JSON.parse(readFileSync(join(rig.providers, "registry.json"), "utf8")).providers;

    expect(after).toHaveLength(1);
    expect(after[0]).toEqual({
      ...before,
      keyHash: keyDigest(second.json.apiKey),
      keyIssuedAt: expect.not.stringMatching(before.keyIssuedAt),
    });
    expect(after[0].createdAt).toBe(before.createdAt);
    expect(readFileSync(join(rig.providers, "registry.json"), "utf8")).not.toContain(first.json.apiKey);
    expect(rig.owns).toHaveBeenCalledTimes(2);
    expect(ledgerFiles(rig)).toEqual([`${ID_A}.jsonl`]);
  });

  test("a rotated key keeps the session and the ledger of the provider", async () => {
    const rig = newRig();
    const { url } = await boot(rig);
    const first = await enroll(url, A);
    const r = await requirementsFor(url, A.payTo);
    await paid(url, first, r, 500n, deposit(rig.chainOf(A.payTo), A.payTo));

    const second = (await register(url, A)).json.apiKey as string;
    const next = await settle(url, second, pay(r, 1000n), r);
    expect(next.json).toMatchObject({ success: true, amount: "500", extra: { session: { cumulativeZat: "1000" } } });
    expect(ledgerTypes(ledgerOf(rig, A))).toEqual(["deposit", "voucher", "voucher"]);
  });

  describe("refuses", () => {
    test("a new provider past the cap with provider_limit, and a registered one may still rotate", async () => {
      const rig = newRig();
      const { url } = await boot(rig, {}, { max: 1 });
      await enroll(url, A);
      rig.owns.mockClear();

      const refused = await register(url, B);
      expect(refused).toMatchObject({ status: 403, json: { error: "provider_limit", message: expect.any(String) } });
      expect(rig.owns).not.toHaveBeenCalled();
      expect(ledgerFiles(rig)).toEqual([`${ID_A}.jsonl`]);
      expect((await register(url, A)).status).toBe(200);
    });

    test("every new provider when the cap is 0", async () => {
      const rig = newRig();
      const { url } = await boot(rig, {}, { max: 0 });
      expect(await register(url, A)).toMatchObject({ status: 403, json: { error: "provider_limit" } });
    });

    test("32 providers at most unless told otherwise, the operator not counted", async () => {
      const rig = newRig();
      const { url } = await boot(rig);
      // Two characters of the bech32 alphabet tell 33 payTo values apart
      const alphabet = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
      const payTos = Array.from(
        { length: 33 },
        (_, i) => `uregtest1${"p".repeat(58)}${alphabet[i % 32]}${alphabet[Math.floor(i / 32)]}`,
      );
      let accepted = 0;
      for (const payTo of payTos) {
        const res = await register(url, { payTo, uivk: A.uivk });
        if (res.status === 201) accepted++;
        else expect(res).toMatchObject({ status: 403, json: { error: "provider_limit" } });
      }
      expect(accepted).toBe(32);
    }, 60_000);

    test("the operator's payTo with 409 operator, and no proof is asked for", async () => {
      const rig = newRig();
      const { url } = await boot(rig);
      const res = await register(url, { payTo: OPERATOR, uivk: A.uivk });
      expect(res).toMatchObject({ status: 409, json: { error: "operator", message: expect.any(String) } });
      expect(rig.owns).not.toHaveBeenCalled();
      expect(existsSync(join(rig.providers, "registry.json"))).toBe(false);
    });

    test("a viewing key that does not own the payTo with 403 not_owner, and stores and opens nothing", async () => {
      const rig = newRig();
      rig.owns.mockResolvedValue(false);
      const { url } = await boot(rig);
      const res = await register(url, A);

      expect(res).toMatchObject({ status: 403, json: { error: "not_owner", message: expect.any(String) } });
      expect(existsSync(join(rig.providers, "registry.json"))).toBe(false);
      expect(readdirSync(join(rig.providers, "ledgers"))).toEqual([]);
      expect((await call(url, "/providers/me", { token: TOKEN })).status).toBe(200);
    });

    test("a proof that cannot be made with 500 internal_error, without a word of the viewing key", async () => {
      const rig = newRig();
      rig.owns.mockRejectedValue(new Error("zdecrypt could not be started (ENOENT)"));
      const { url } = await boot(rig);
      const res = await register(url, A);

      expect(res).toMatchObject({ status: 500, json: { error: "internal_error" } });
      expect(res.json).toEqual({ error: "internal_error" });
      expect(rig.lines.join("\n")).toContain("zdecrypt could not be started (ENOENT)");
      expect(rig.lines.join("\n")).not.toContain(A.uivk);
    });

    test.each([
      ["a body that is not JSON", { raw: "{ this is not json" }, /not JSON/],
      ["a body of JSON null", { raw: "null" }, /not JSON/],
      ["a body that is an array", { raw: "[]" }, /JSON object/],
      ["no body", { raw: "" }, /^payTo: /],
      ["a body over 64 KB", { body: { payTo: A.payTo, uivk: A.uivk, padding: "x".repeat(70_000) } }, /64KB/],
      ["a body not sent as JSON", { raw: '{"payTo":"x"}', headers: { "content-type": "text/plain" } }, /JSON object/],
      ["no payTo", { body: { uivk: A.uivk } }, /^payTo: /],
      ["a payTo that is no address", { body: { payTo: "nope", uivk: A.uivk } }, /^payTo: /],
      ["a payTo of another network", { body: { payTo: `utest1${"q".repeat(60)}`, uivk: A.uivk } }, /^payTo: /],
      [
        "a payTo of 1025 characters",
        { body: { payTo: `uregtest1${"q".repeat(1016)}`, uivk: A.uivk } },
        /^payTo: .*1024/,
      ],
      [
        "a payTo of 59000 characters",
        { body: { payTo: `uregtest1${"q".repeat(58_991)}`, uivk: A.uivk } },
        /^payTo: .*1024/,
      ],
      ["no uivk", { body: { payTo: A.payTo } }, /^uivk: /],
      ["a uivk of another network", { body: { payTo: A.payTo, uivk: `uivktest1${"q".repeat(90)}` } }, /^uivk: /],
      ["another network", { body: { payTo: A.payTo, uivk: A.uivk, network: NETWORK_TESTNET } }, /^network: /],
    ] as Array<[string, Init, RegExp]>)("%s is a 400 invalid_request, before any proof", async (_, init, message) => {
      const rig = newRig();
      const { url } = await boot(rig);
      const res = await call(url, "/providers", { method: "POST", ...init });

      expect(res).toMatchObject({ status: 400, json: { error: "invalid_request" } });
      expect(res.json.message).toMatch(message);
      expect(rig.owns).not.toHaveBeenCalled();
      expect(existsSync(join(rig.providers, "registry.json"))).toBe(false);
    });

    test("every provider with 403 registration_disabled where the facilitator has no providers directory", async () => {
      const rig = newRig();
      const { url } = await boot(rig, {}, null);
      const res = await register(url, A);
      expect(res).toMatchObject({ status: 403, json: { error: "registration_disabled", message: expect.any(String) } });
      expect(rig.owns).not.toHaveBeenCalled();
      expect(existsSync(rig.providers)).toBe(false);
      expect(await register(url, A, { token: "any" })).toMatchObject({ status: 403 });
    });
  });

  describe("with a registration token", () => {
    test("is a 401 with a Bearer challenge to a request without it, whatever else it carries", async () => {
      const rig = newRig();
      const { url } = await boot(rig, {}, { registrationToken: REGISTRATION });
      const keyA = KEY_A;
      for (const init of [
        {},
        { token: "" },
        { token: "wrong" },
        { token: `${REGISTRATION}x` },
        { token: TOKEN },
        { token: keyA },
        { headers: { authorization: `Basic ${Buffer.from(REGISTRATION).toString("base64")}` } },
        { headers: { authorization: REGISTRATION } },
      ] as Init[]) {
        const res = await register(url, A, init);
        expect(res).toMatchObject({ status: 401, json: { error: "unauthorized", message: expect.any(String) } });
        expect(res.headers.get("www-authenticate")).toBe("Bearer");
      }
      expect((await register(url, A, {}, `/providers?token=${REGISTRATION}`)).status).toBe(401);
      expect(rig.owns).not.toHaveBeenCalled();
      expect(existsSync(join(rig.providers, "registry.json"))).toBe(false);
    });

    test("is refused before the body is read", async () => {
      const rig = newRig();
      const { url } = await boot(rig, {}, { registrationToken: REGISTRATION });
      const res = await call(url, "/providers", { method: "POST", raw: "{ not json" });
      expect(res.status).toBe(401);
    });

    test("lets a request with it register, and rotate", async () => {
      const rig = newRig();
      const { url } = await boot(rig, {}, { registrationToken: REGISTRATION });
      expect((await register(url, A, { token: REGISTRATION })).status).toBe(201);
      expect((await register(url, A, { token: REGISTRATION })).status).toBe(200);
      expect((await register(url, A, { headers: { authorization: `bearer   ${REGISTRATION}` } })).status).toBe(200);
    });

    test("is not a key: it opens no authenticated route, and no API key opens registration", async () => {
      const rig = newRig();
      const { url } = await boot(rig, {}, { registrationToken: REGISTRATION });
      const key = await enroll(url, A, { token: REGISTRATION });

      expect((await call(url, "/providers/me", { token: REGISTRATION })).status).toBe(401);
      expect((await call(url, "/verify", { token: REGISTRATION, body: {} })).status).toBe(401);
      expect((await register(url, B, { token: key })).status).toBe(401);
      expect((await register(url, B, { token: TOKEN })).status).toBe(401);
    });

    test("is not asked of anything else", async () => {
      const rig = newRig();
      const { url } = await boot(rig, {}, { registrationToken: REGISTRATION });
      expect((await call(url, "/supported")).status).toBe(200);
      expect((await call(url, "/providers/me", { token: TOKEN })).status).toBe(200);
    });
  });

  describe("without a registration token", () => {
    test("is open to a request that carries no Authorization header, or any other", async () => {
      const rig = newRig();
      const { url } = await boot(rig);
      expect((await register(url, A)).status).toBe(201);
      expect((await register(url, A, { token: "anything" })).status).toBe(200);
      expect((await register(url, B, { token: TOKEN })).status).toBe(201);
    });
  });

  describe("with registrationEnabled false", () => {
    const closed = { registrationEnabled: false };

    test("is a 403 registration_disabled for every request, and asks for no proof and stores nothing", async () => {
      const rig = newRig();
      const { url } = await boot(rig, {}, closed);
      const res = await register(url, A);

      expect(res).toMatchObject({ status: 403, json: { error: "registration_disabled", message: expect.any(String) } });
      expect(res.json.message).toMatch(/closed/);
      expect(res.json.message).not.toMatch(/providers directory/);
      expect(rig.owns).not.toHaveBeenCalled();
      expect(existsSync(join(rig.providers, "registry.json"))).toBe(false);
      expect(readdirSync(join(rig.providers, "ledgers"))).toEqual([]);
    });

    test("answers before it reads the body or the token, so a bad one is no 400 and no 401", async () => {
      const rig = newRig();
      const { url } = await boot(rig, {}, { ...closed, registrationToken: REGISTRATION });
      for (const init of [
        { raw: "{ not json" },
        { token: "wrong" },
        { token: REGISTRATION },
        { raw: "" },
        { body: { payTo: "nope" } },
      ] as Init[]) {
        const res = await call(url, "/providers", { method: "POST", ...init });
        expect(res).toMatchObject({ status: 403, json: { error: "registration_disabled" } });
        expect(res.headers.get("www-authenticate")).toBeNull();
      }
      expect(rig.owns).not.toHaveBeenCalled();
    });

    test("leaves the operator serving", async () => {
      const rig = newRig();
      const { url } = await boot(rig, {}, closed);
      expect((await call(url, "/providers/me", { token: TOKEN })).json.providerId).toBe(ID_OPERATOR);
      expect((await call(url, "/supported")).status).toBe(200);
      expect((await call(url, "/discovery/resources")).status).toBe(200);
    });

    test("keeps serving the providers that registered before, and refuses their rotation like the rest", async () => {
      const rig = newRig();
      const first = await boot(rig);
      const key = await enroll(first.url, A);
      await first.close();

      const again = await boot(rig, {}, closed);
      expect(again.providerCount()).toBe(1);
      expect((await call(again.url, "/providers/me", { token: key })).json.providerId).toBe(ID_A);
      expect(await register(again.url, A)).toMatchObject({ status: 403, json: { error: "registration_disabled" } });
      expect(await register(again.url, B)).toMatchObject({ status: 403, json: { error: "registration_disabled" } });
      expect((await call(again.url, "/providers/me", { token: key })).status).toBe(200);
      expect(again.providerCount()).toBe(1);
    });

    test("is the default of true: registration is open when the option is true or left out", async () => {
      const rig = newRig();
      const { url } = await boot(rig, {}, { registrationEnabled: true });
      expect((await register(url, A)).status).toBe(201);
    });

    test("does not change the 403 of a facilitator with no providers directory", async () => {
      const rig = newRig();
      const { url } = await boot(rig, {}, null);
      const res = await register(url, A);
      expect(res).toMatchObject({ status: 403, json: { error: "registration_disabled" } });
      expect(res.json.message).toMatch(/providers directory/);
    });
  });

  describe("when it fails midway", () => {
    test("a registry that cannot be written leaves no provider, no lock and no key, and a retry succeeds", async () => {
      const rig = newRig();
      const handle = await boot(rig);
      // A directory where the registry belongs makes the rename of the new file fail
      mkdirSync(join(rig.providers, "registry.json"));

      const failed = await register(handle.url, A);
      expect(failed.status).toBe(500);
      expect(failed.json).toEqual({ error: "internal_error" });
      expect(handle.providerCount()).toBe(0);
      expect(locksUnder(join(rig.providers, "ledgers"))).toEqual([]);
      expect(readdirSync(rig.providers).filter((n) => n.endsWith(".tmp"))).toEqual([]);

      rmSync(join(rig.providers, "registry.json"), { recursive: true });
      const retried = await register(handle.url, A);
      expect(retried.status).toBe(201);
      expect(handle.providerCount()).toBe(1);
      expect((await call(handle.url, "/providers/me", { token: retried.json.apiKey })).status).toBe(200);
    });

    test("a ledger that cannot be opened leaves nothing in the registry, and the operator still serves", async () => {
      const rig = newRig();
      const handle = await boot(rig);
      mkdirSync(join(rig.providers, "ledgers", `${ID_A}.jsonl`));

      const failed = await register(handle.url, A);
      expect(failed).toMatchObject({ status: 500, json: { error: "internal_error" } });
      expect(existsSync(join(rig.providers, "registry.json"))).toBe(false);
      expect(handle.providerCount()).toBe(0);
      expect(rig.lines.join("\n")).toMatch(/not writable \(EISDIR\)/);
      expect((await call(handle.url, "/providers/me", { token: TOKEN })).status).toBe(200);

      rmSync(join(rig.providers, "ledgers", `${ID_A}.jsonl`), { recursive: true });
      expect((await register(handle.url, A)).status).toBe(201);
    });

    test("a chain view that cannot be made leaves nothing in the registry", async () => {
      const rig = newRig();
      const handle = await boot(
        rig,
        {},
        {
          chainFor: () => {
            throw new Error("no chain for this provider");
          },
        },
      );
      expect(await register(handle.url, A)).toMatchObject({ status: 500, json: { error: "internal_error" } });
      expect(existsSync(join(rig.providers, "registry.json"))).toBe(false);
      expect(locksUnder(join(rig.providers, "ledgers"))).toEqual([]);
    });

    test("an orphan ledger of an earlier failed registration is taken up again by the next", async () => {
      const rig = newRig();
      const handle = await boot(rig);
      mkdirSync(join(rig.providers, "registry.json"));
      expect((await register(handle.url, A)).status).toBe(500);
      expect(existsSync(ledgerOf(rig, A))).toBe(true);
      rmSync(join(rig.providers, "registry.json"), { recursive: true });

      const key = await enroll(handle.url, A);
      const r = await requirementsFor(handle.url, A.payTo);
      expect((await paid(handle.url, key, r, 500n, deposit(rig.chainOf(A.payTo), A.payTo))).json.success).toBe(true);
      expect(ledgerTypes(ledgerOf(rig, A))).toEqual(["deposit", "voucher"]);
    });
  });

  test("two registrations of one payTo at once end as a registration and a rotation", async () => {
    const rig = newRig();
    const { url } = await boot(rig);
    const both = await Promise.all([register(url, A), register(url, A)]);

    // Whichever request reached the server first registered, and the other one rotated its key
    expect(both.map((r) => r.status).sort()).toEqual([200, 201]);
    const registered = both.find((r) => r.status === 201);
    const rotated = both.find((r) => r.status === 200);
    expect((await call(url, "/providers/me", { token: registered?.json.apiKey })).status).toBe(401);
    expect((await call(url, "/providers/me", { token: rotated?.json.apiKey })).status).toBe(200);
  });
});

describe("start-up", () => {
  test("replays the ledger of every provider and keeps every key", async () => {
    const rig = newRig();
    const first = await boot(rig, { ledgerPath: join(rig.dir, "operator.jsonl") });
    const keyA = await enroll(first.url, A);
    const keyB = await enroll(first.url, B);
    const rA = await requirementsFor(first.url, A.payTo);
    const rB = await requirementsFor(first.url, B.payTo);
    const dA = deposit(rig.chainOf(A.payTo), A.payTo);
    const dB = deposit(rig.chainOf(B.payTo), B.payTo);
    await paid(first.url, keyA, rA, 500n, dA);
    await settle(first.url, keyA, pay(rA, 1000n), rA);
    await paid(first.url, keyB, rB, 500n, dB);
    await first.close();
    expect(ledgerTypes(ledgerOf(rig, A))).toEqual(["deposit", "voucher", "voucher"]);

    const second = await boot(rig, { ledgerPath: join(rig.dir, "operator.jsonl") });
    expect(second.providerCount()).toBe(2);
    expect(await call(second.url, "/providers/me", { token: keyA })).toMatchObject({ json: { providerId: ID_A } });
    expect(await call(second.url, "/providers/me", { token: keyB })).toMatchObject({ json: { providerId: ID_B } });

    const staleA = await verify(second.url, keyA, pay(rA, 500n), rA);
    expect(staleA.json).toMatchObject({ invalidReason: REASON.cumulativeMismatch });
    expect(staleA.json.extra.session).toMatchObject({ cumulativeZat: "1000" });
    const staleB = await verify(second.url, keyB, pay(rB, 500n), rB);
    expect(staleB.json.extra.session).toMatchObject({ cumulativeZat: "500" });
    // The deposit is acknowledged again without being credited twice
    const next = await settle(second.url, keyA, pay(rA, 1500n, dA), rA);
    expect(next.json).toMatchObject({ success: true, transaction: dA, amount: "500" });
    expect(ledgerTypes(ledgerOf(rig, A))).toEqual(["deposit", "voucher", "voucher", "voucher"]);
  });

  test("keeps a rotated key and drops the key it replaced", async () => {
    const rig = newRig();
    const first = await boot(rig);
    const old = await enroll(first.url, A);
    const fresh = (await register(first.url, A)).json.apiKey as string;
    await first.close();

    const second = await boot(rig);
    expect((await call(second.url, "/providers/me", { token: fresh })).status).toBe(200);
    expect((await call(second.url, "/providers/me", { token: old })).status).toBe(401);
  });

  test("rotates the key of a provider that an earlier start registered, as a lost key is recovered", async () => {
    const rig = newRig();
    const first = await boot(rig);
    const original = await enroll(first.url, A);
    const r = await requirementsFor(first.url, A.payTo);
    await paid(first.url, original, r, 500n, deposit(rig.chainOf(A.payTo), A.payTo));
    await first.close();

    const second = await boot(rig);
    const rotated = await register(second.url, A);
    expect(rotated.status).toBe(200);
    const fresh = rotated.json.apiKey as string;
    expect(fresh).not.toBe(original);
    expect((await call(second.url, "/providers/me", { token: original })).status).toBe(401);
    const me = await call(second.url, "/providers/me", { token: fresh });
    expect(me).toMatchObject({ status: 200, json: { providerId: ID_A } });

    // The session and the ledger are those the provider had before the restart, and it has no second runtime
    const next = await settle(second.url, fresh, pay(r, 1000n), r);
    expect(next.json).toMatchObject({ success: true, amount: "500", extra: { session: { cumulativeZat: "1000" } } });
    expect(ledgerTypes(ledgerOf(rig, A))).toEqual(["deposit", "voucher", "voucher"]);
    expect(second.providerCount()).toBe(1);

    // A second rotation takes out the key of the first, since the hash stored by then is that one
    const third = (await register(second.url, A)).json.apiKey as string;
    for (const dead of [original, fresh]) {
      expect((await call(second.url, "/providers/me", { token: dead })).status).toBe(401);
    }
    expect((await call(second.url, "/providers/me", { token: third })).status).toBe(200);
  });

  test("listens only once the registry and every runtime are loaded and polled, and then serves the keys", async () => {
    const rig = newRig();
    const first = await boot(rig);
    const keyA = await enroll(first.url, A);
    const keyB = await enroll(first.url, B);
    await first.close();

    // Each probe asks the port from inside a step of the start, and the answer must be that nothing listens yet
    const port = await freePort();
    const probes: Array<{ at: string; refused: boolean }> = [];
    const probe = async (at: string): Promise<void> => {
      probes.push({ at, refused: await refuses(port) });
    };
    const probing = (at: string, view: ChainView): ChainView => ({
      tip: async () => {
        await probe(at);
        return view.tip();
      },
      inspect: (txid) => view.inspect(txid),
    });
    rig.owns.mockImplementation(async () => {
      await probe("owns");
      return true;
    });

    const second = await boot(
      rig,
      { port, chain: probing("operator tip", rig.chainOf(OPERATOR).viewFor(OPERATOR)) },
      { chainFor: (p) => probing("provider tip", rig.chainOf(p.payTo).viewFor(p.payTo)) },
    );

    // No step is missing from the probes, so none of them can have been skipped
    expect(probes.map((p) => p.at).sort()).toEqual(["operator tip", "owns", "owns", "provider tip", "provider tip"]);
    expect(probes.filter((p) => !p.refused)).toEqual([]);
    expect(second.url).toBe(`http://127.0.0.1:${port}`);

    // Once it listens, the first request of a stored key is served
    expect(await refuses(port)).toBe(false);
    expect((await call(second.url, "/providers/me", { token: keyA })).status).toBe(200);
    expect((await call(second.url, "/providers/me", { token: keyB })).status).toBe(200);
  });

  test("has polled every provider by the time it resolves", async () => {
    const rig = newRig();
    const first = await boot(rig);
    const keyA = await enroll(first.url, A);
    const rA = await requirementsFor(first.url, A.payTo);
    await paid(first.url, keyA, rA, 500n, deposit(rig.chainOf(A.payTo), A.payTo));
    await first.close();

    // The deposit is mined while the facilitator is down, so only the poll at start can notice
    rig.chainOf(A.payTo).mine(1);
    const second = await boot(rig);
    const res = await verify(second.url, keyA, pay(rA, 1000n), rA);
    expect(res.json.extra.session).toMatchObject({ confirmedZat: "100000", pendingZat: "0" });
  });

  test("starts the watcher of every registered provider", async () => {
    const rig = newRig();
    const first = await boot(rig);
    const keyA = await enroll(first.url, A);
    const rA = await requirementsFor(first.url, A.payTo);
    await paid(first.url, keyA, rA, 500n, deposit(rig.chainOf(A.payTo), A.payTo));
    await first.close();

    await boot(rig, { pollIntervalMs: 20 });
    rig.chainOf(A.payTo).mine(1);
    await vi.waitFor(() => expect(ledgerTypes(ledgerOf(rig, A))).toEqual(["deposit", "voucher", "status"]), {
      timeout: 3000,
      interval: 20,
    });
  });

  test("with no registry yet makes the directory and starts with no provider", async () => {
    const rig = newRig();
    const handle = await boot(rig);
    expect(handle.providerCount()).toBe(0);
    expect(statSync(rig.providers).mode & 0o777).toBe(0o700);
    expect(statSync(join(rig.providers, "ledgers")).isDirectory()).toBe(true);
  });

  test("proves that the key of every entry still owns its payTo, and one that fails refuses the start", async () => {
    const rig = newRig();
    const first = await boot(rig);
    await enroll(first.url, A);
    await enroll(first.url, B);
    await first.close();

    rig.owns.mockClear();
    rig.owns.mockImplementation(async (p) => p.payTo !== B.payTo);
    await expect(boot(rig)).rejects.toThrow(
      `providersDir: provider ${ID_B}: the stored viewing key no longer owns its payTo`,
    );
    expect(rig.owns).toHaveBeenCalledTimes(2);
    expect(rig.owns).toHaveBeenCalledWith({ payTo: A.payTo, uivk: A.uivk });
    expect(rig.owns).toHaveBeenCalledWith({ payTo: B.payTo, uivk: B.uivk });
  });

  test("names the first entry that fails, whichever answers first", async () => {
    const rig = newRig();
    const first = await boot(rig);
    await enroll(first.url, A);
    await enroll(first.url, B);
    await first.close();

    rig.owns.mockImplementation(async (p) => {
      if (p.payTo === A.payTo) await new Promise((resolve) => setTimeout(resolve, 80));
      return false;
    });
    await expect(boot(rig)).rejects.toThrow(`provider ${ID_A}:`);
  });

  test("an owns check that cannot be made refuses the start, naming the provider and not its key", async () => {
    const rig = newRig();
    const first = await boot(rig);
    await enroll(first.url, A);
    await first.close();

    rig.owns.mockRejectedValue(new Error("zdecrypt could not be started (ENOENT)"));
    const error = await boot(rig).then(
      () => undefined,
      (e: Error) => e,
    );
    const cause = "zdecrypt could not be started (ENOENT)";
    expect(error?.message).toBe(
      `providersDir: provider ${ID_A}: cannot check that the stored viewing key owns its payTo (${cause})`,
    );
    expect(error?.message).not.toContain(A.uivk);
  });

  test("lets go of everything when it refuses, so the next start can take it all", async () => {
    const rig = newRig();
    const operatorLedger = join(rig.dir, "operator.jsonl");
    const first = await boot(rig, { ledgerPath: operatorLedger });
    await enroll(first.url, A);
    await first.close();

    rig.owns.mockResolvedValue(false);
    await expect(boot(rig, { ledgerPath: operatorLedger })).rejects.toThrow(/no longer owns its payTo/);
    expect(locksUnder(rig.dir)).toEqual([]);

    rig.owns.mockResolvedValue(true);
    const again = await boot(rig, { ledgerPath: operatorLedger });
    expect(again.providerCount()).toBe(1);
  });

  describe("refuses a registry that", () => {
    const refusal = async (rig: Rig, over: Partial<FacilitatorOptions> = {}) => {
      const error = await boot(rig, { ledgerPath: join(rig.dir, "operator.jsonl"), ...over }).then(
        () => undefined,
        (e: Error) => e,
      );
      // Nothing stays held, whether it is the registry, the operator's ledger or a provider's
      expect(locksUnder(rig.dir)).toEqual([]);
      expect(rig.owns).not.toHaveBeenCalled();
      return error;
    };

    test("is not valid JSON, without quoting it", async () => {
      const rig = newRig();
      mkdirSync(rig.providers, { recursive: true, mode: 0o700 });
      writeFileSync(join(rig.providers, "registry.json"), `{"version":1,"uivk":"${A.uivk}" this is not json`);
      const error = await refusal(rig);
      expect(error?.message).toMatch(/^providersDir: .*registry\.json is not a valid provider registry \(not JSON\)$/);
      expect(error?.message).not.toContain(A.uivk);
    });

    test("holds an entry that is malformed", async () => {
      const rig = newRig();
      writeRegistry(rig, [entry(A, KEY_A, { keyHash: "nope" })]);
      expect((await refusal(rig))?.message).toMatch(/^providersDir: .* \(entry 1: keyHash is not 64 lowercase hex\)$/);
    });

    test("is the registry of another network", async () => {
      const rig = newRig();
      writeRegistry(rig, [], NETWORK_TESTNET);
      expect((await refusal(rig))?.message).toMatch(/^providersDir: .* is the registry of zcash:testnet$/);
    });

    test("holds an entry whose id is not the one of its payTo", async () => {
      const rig = newRig();
      writeRegistry(rig, [entry(A, KEY_A, { id: "0123456789abcdef" })]);
      expect((await refusal(rig))?.message).toBe(
        "providersDir: registry entry 0123456789abcdef does not match its payTo",
      );
    });

    test("holds the id of one provider on the payTo of another", async () => {
      const rig = newRig();
      writeRegistry(rig, [entry(A, KEY_A, { id: ID_B })]);
      expect((await refusal(rig))?.message).toBe(`providersDir: registry entry ${ID_B} does not match its payTo`);
    });

    test("holds an entry whose payTo is over 1024 characters, before any viewing key is asked about it", async () => {
      const rig = newRig();
      writeRegistry(rig, [entry({ payTo: `uregtest1${"q".repeat(1016)}`, uivk: A.uivk }, KEY_A)]);
      const error = await refusal(rig);
      expect(error?.message).toMatch(/^providersDir: .*registry\.json is not a valid provider registry /);
      expect(error?.message).toMatch(/\(entry 1: payTo is over 1024 characters\)$/);
    });

    test("holds the operator's payTo", async () => {
      const rig = newRig();
      writeRegistry(rig, [entry({ payTo: OPERATOR, uivk: A.uivk }, KEY_A)]);
      const error = await refusal(rig);
      expect(error?.message).toBe(`providersDir: registry entry ${ID_OPERATOR} has the operator's payTo`);
    });

    test("holds one key for two providers", async () => {
      const rig = newRig();
      writeRegistry(rig, [entry(A, KEY_A), entry(B, KEY_A)]);
      const error = await refusal(rig);
      expect(error?.message).toBe(`providersDir: registry entry ${ID_B} shares its API key with another provider`);
    });

    test("holds the key of the operator", async () => {
      const rig = newRig();
      writeRegistry(rig, [entry(A, TOKEN)]);
      const error = await refusal(rig);
      expect(error?.message).toBe(`providersDir: registry entry ${ID_A} shares its API key with another provider`);
    });
  });

  test("a registry that holds the key of the operator is fine where the operator has no token", async () => {
    const rig = newRig();
    writeRegistry(rig, [entry(A, TOKEN)]);
    const handle = await boot(rig, { authToken: undefined });
    expect((await call(handle.url, "/providers/me", { token: TOKEN })).json.providerId).toBe(ID_A);
  });

  test("a provider whose ledger cannot be opened refuses the start, and the others are let go", async () => {
    const rig = newRig();
    const first = await boot(rig);
    await enroll(first.url, A);
    await enroll(first.url, B);
    await first.close();

    rmSync(ledgerOf(rig, A));
    mkdirSync(ledgerOf(rig, A));
    await expect(boot(rig)).rejects.toThrow(/^ledgerPath: .* is not writable \(EISDIR\)$/);
    expect(locksUnder(rig.dir)).toEqual([]);

    rmSync(ledgerOf(rig, A), { recursive: true });
    expect((await boot(rig)).providerCount()).toBe(2);
  });

  test("a provider whose ledger belongs to another payTo refuses the start", async () => {
    const rig = newRig();
    const first = await boot(rig);
    await enroll(first.url, A);
    await enroll(first.url, B);
    await first.close();

    writeFileSync(ledgerOf(rig, B), readFileSync(ledgerOf(rig, A)));
    await expect(boot(rig)).rejects.toThrow(/^ledgerPath: .* is the ledger of zcash:regtest u.*, not of this/);
    expect(locksUnder(rig.dir)).toEqual([]);
  });

  test("a registry that another start holds refuses it", async () => {
    const rig = newRig();
    await boot(rig);
    await expect(boot(rig, { port: 0 })).rejects.toThrow(/^providersDir: .*already open/);
  });

  test("a port in use refuses the start and lets every provider go", async () => {
    const rig = newRig();
    const first = await boot(rig);
    await enroll(first.url, A);
    await first.close();
    const other = await boot(newRig(), {}, null);

    await expect(boot(rig, { port: Number(new URL(other.url).port) })).rejects.toThrow(/^port:/);
    expect(locksUnder(rig.dir)).toEqual([]);
  });

  test("providers that are left out give a facilitator with the operator alone", async () => {
    const rig = newRig();
    const handle = await boot(rig, {}, null);
    expect(handle.providerCount()).toBe(0);
    expect(existsSync(rig.providers)).toBe(false);
    expect((await call(handle.url, "/providers/me", { token: TOKEN })).status).toBe(200);
  });

  test.each([
    ["providers.dir", { dir: "" }],
    ["providers.dir", { dir: "  " }],
    ["providers.max", { max: -1 }],
    ["providers.max", { max: 1001 }],
    ["providers.max", { max: 1.5 }],
    ["providers.registrationToken", { registrationToken: "" }],
    ["providers.registrationToken", { registrationToken: "two words" }],
    ["providers.registrationToken", { registrationToken: "s3cret\n" }],
    ["providers.registrationEnabled", { registrationEnabled: "no" }],
    ["providers.registrationEnabled", { registrationEnabled: 0 }],
    ["providers.chainFor", { chainFor: undefined }],
    ["providers.owns", { owns: undefined }],
  ] as Array<[string, Record<string, unknown>]>)(
    "a bad %s is refused by name, before anything opens",
    async (field, over) => {
      const rig = newRig();
      const ledgerPath = join(rig.dir, "never.jsonl");
      const named = new RegExp(`^${field.replace(".", "\\.")}:`);
      await expect(boot(rig, { ledgerPath }, over as never)).rejects.toThrow(named);
      expect(existsSync(ledgerPath)).toBe(false);
      expect(existsSync(rig.providers)).toBe(false);
    },
  );

  test("a registration token is never part of a message", async () => {
    const rig = newRig();
    const error = await boot(rig, {}, { registrationToken: "s3cret token" }).then(
      () => undefined,
      (e: Error) => e,
    );
    expect(error?.message).toBe(
      "providers.registrationToken: must be one token of letters, digits and -._~+/ (no spaces or control characters)",
    );
  });
});

describe("authentication", () => {
  test.each([
    ["GET", "/providers/me"],
    ["POST", "/verify"],
    ["POST", "/settle"],
  ])("%s %s is refused with a Bearer challenge unless a key of this facilitator is presented", async (method, path) => {
    const rig = newRig();
    const { url } = await boot(rig);
    const key = await enroll(url, A);
    const rotatedOut = key;
    await register(url, A);
    const refused: Init[] = [
      {},
      { token: "" },
      { token: "wrong" },
      { token: `${key}x` },
      { token: key.slice(0, -1) },
      { token: key.toLowerCase() },
      { token: keyDigest(key) },
      { token: rotatedOut },
      { token: REGISTRATION },
      { headers: { authorization: `Basic ${Buffer.from(TOKEN).toString("base64")}` } },
      { headers: { authorization: TOKEN } },
      { headers: { authorization: "Bearer" } },
      { headers: { authorization: "Bearer " } },
    ];
    for (const init of refused) {
      const res = await call(url, path, { method, body: method === "POST" ? {} : undefined, ...init });
      expect(res).toMatchObject({ status: 401, json: { error: "unauthorized" } });
      expect(res.headers.get("www-authenticate")).toBe("Bearer");
    }
    const queried = await call(url, `${path}?token=${TOKEN}`, { method, body: method === "POST" ? {} : undefined });
    expect(queried.status).toBe(401);
  });

  test("an unknown route is a 404 without a key, and so is a known path with another method", async () => {
    const rig = newRig();
    const { url } = await boot(rig);
    expect(await call(url, "/nope")).toMatchObject({ status: 404, json: { error: "not_found" } });
    expect(await call(url, "/nope", { method: "POST", body: {} })).toMatchObject({ status: 404 });
    expect(await call(url, "/verify")).toMatchObject({ status: 404 });
    expect(await call(url, "/providers")).toMatchObject({ status: 404 });
    expect(await call(url, "/providers/me", { method: "POST", body: {} })).toMatchObject({ status: 404 });
    expect(await call(url, "/supported", { method: "POST", body: {} })).toMatchObject({ status: 404 });
  });

  test("GET /supported needs no key, and the operator's runtime answers every key of the facilitator", async () => {
    const rig = newRig();
    const { url } = await boot(rig);
    const key = await enroll(url, A);
    const without = await call(url, "/supported");
    expect(without.status).toBe(200);
    expect(without.json.kinds).toMatchObject([{ x402Version: 2, scheme: SCHEME, network: NETWORK }]);
    expect(without.json.kinds[0].extra).not.toHaveProperty("payTo");
    for (const token of [TOKEN, key]) {
      expect(await call(url, "/supported", { token })).toMatchObject({ status: 200, json: without.json });
    }
    expect(await call(url, "/supported?token=wrong")).toMatchObject({ status: 200, json: without.json });
  });

  test("GET /supported refuses a key that names no provider, a rotated-out key included", async () => {
    const rig = newRig();
    const { url } = await boot(rig);
    const old = await enroll(url, A);
    await register(url, A);
    for (const token of ["wrong", REGISTRATION, old, keyDigest(old)]) {
      const res = await call(url, "/supported", { token });
      expect(res).toMatchObject({ status: 401, json: { error: "unauthorized" } });
      expect(res.headers.get("www-authenticate")).toBe("Bearer");
    }
    const basic = await call(url, "/supported", { headers: { authorization: "Basic abc" } });
    expect(basic.status).toBe(401);
  });

  test("a facilitator without a token serves a request with no header as the operator", async () => {
    const rig = newRig();
    const { url } = await boot(rig, { authToken: undefined });
    const keyA = await enroll(url, A);

    expect(await call(url, "/providers/me")).toMatchObject({ status: 200, json: { providerId: ID_OPERATOR } });
    const asA = await call(url, "/providers/me", { token: keyA });
    expect(asA).toMatchObject({ status: 200, json: { providerId: ID_A } });
    const r = await requirementsFor(url, OPERATOR);
    expect((await call(url, "/verify", { body: envelope(pay(r, 500n), r) })).json).toMatchObject({
      invalidReason: REASON.depositRequired,
    });
  });

  test("a facilitator without a token still refuses a header that names no provider", async () => {
    const rig = newRig();
    const { url } = await boot(rig, { authToken: undefined });
    await enroll(url, A);
    const headersOf = ["Bearer nobody", "Basic abc", "x"].map((authorization) => ({ authorization }));
    for (const headers of headersOf) {
      const res = await call(url, "/providers/me", { headers });
      expect(res).toMatchObject({ status: 401, json: { error: "unauthorized" } });
      expect(res.headers.get("www-authenticate")).toBe("Bearer");
    }
  });

  test("the operator's token is the operator's key and no registered provider's", async () => {
    const rig = newRig();
    const { url } = await boot(rig);
    await enroll(url, A);
    const rA = await requirementsFor(url, A.payTo);
    const viaOperator = await verify(url, TOKEN, pay(rA, 500n), rA);
    expect(viaOperator.json).toMatchObject({ invalidReason: REASON.invalidPaymentRequirements });
  });

  test("the scheme in any letter case, and one or more spaces after it, are accepted", async () => {
    const rig = newRig();
    const { url } = await boot(rig);
    const key = await enroll(url, A);
    for (const authorization of [`bearer ${key}`, `BEARER ${key}`, `Bearer    ${key}`]) {
      expect(await call(url, "/providers/me", { headers: { authorization } })).toMatchObject({ status: 200 });
    }
  });
});

describe("shutdown", () => {
  test("close() frees every lock, and may be called twice", async () => {
    const rig = newRig();
    const handle = await boot(rig, { ledgerPath: join(rig.dir, "operator.jsonl") });
    await enroll(handle.url, A);
    await enroll(handle.url, B);
    expect(locksUnder(rig.dir).length).toBe(4);

    await handle.close();
    await handle.close();
    expect(locksUnder(rig.dir)).toEqual([]);
    await expect(fetch(`${handle.url}/supported`)).rejects.toThrow();
  });

  test("close() stops the watchers of the registered providers", async () => {
    const rig = newRig();
    const handle = await boot(rig, { pollIntervalMs: 20 });
    const key = await enroll(handle.url, A);
    const r = await requirementsFor(handle.url, A.payTo);
    await paid(handle.url, key, r, 500n, deposit(rig.chainOf(A.payTo), A.payTo));
    await handle.close();

    const written = readFileSync(ledgerOf(rig, A), "utf8");
    rig.chainOf(A.payTo).mine(1);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(readFileSync(ledgerOf(rig, A), "utf8")).toBe(written);
  });

  test("close() waits for a registration under way, which finishes and is let go", async () => {
    const rig = newRig();
    let proven = () => {};
    rig.owns.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          proven = () => resolve(true);
        }),
    );
    const handle = await boot(rig);
    const registering = register(handle.url, A);
    await vi.waitFor(() => expect(rig.owns).toHaveBeenCalledTimes(1));

    const closing = handle.close();
    proven();
    const res = await registering;
    await closing;

    expect(res.status).toBe(201);
    expect(locksUnder(rig.dir)).toEqual([]);
    rig.owns.mockResolvedValue(true);
    const again = await boot(rig);
    expect(again.providerCount()).toBe(1);
    expect((await call(again.url, "/providers/me", { token: res.json.apiKey })).status).toBe(200);
  });

  test("pollNow() after close() reads nothing", async () => {
    const rig = newRig();
    const reads = { tip: 0 };
    const handle = await boot(
      rig,
      {},
      {
        chainFor: (p) => {
          const view = rig.chainOf(p.payTo).viewFor(p.payTo);
          return { tip: () => (reads.tip++, view.tip()), inspect: (txid) => view.inspect(txid) };
        },
      },
    );
    await enroll(handle.url, A);
    await handle.close();

    const before = reads.tip;
    await handle.pollNow();
    expect(reads.tip).toBe(before);
  });
});

describe("a failure that exits the host", () => {
  /** A deposit presented to a provider and recorded as a voucher, so that the provider's next settle writes */
  async function ready(url: string, key: string, rig: Rig, who: Who) {
    const r = await requirementsFor(url, who.payTo);
    const d1 = deposit(rig.chainOf(who.payTo), who.payTo);
    expect((await verify(url, key, pay(r, 500n, d1), r)).json.isValid).toBe(true);
    return { r, d1 };
  }

  const failedSettle = (reply: Reply) =>
    expect(reply.json).toMatchObject({ success: false, errorReason: REASON.unexpectedSettleError, transaction: "" });

  test("a ledger write that fails in a provider loaded at start calls onFatal once", async () => {
    const rig = newRig();
    const first = await boot(rig);
    const key = await enroll(first.url, A);
    await first.close();

    const onFatal = vi.fn<(err: unknown) => void>();
    const { url } = await boot(rig, { onFatal });
    const { r, d1 } = await ready(url, key, rig, A);
    expect(onFatal).not.toHaveBeenCalled();

    breakLedger(rig, A);
    failedSettle(await settle(url, key, pay(r, 500n, d1), r));
    expect(onFatal).toHaveBeenCalledTimes(1);
    expect(onFatal.mock.calls[0]?.[0]).toMatchObject({ code: "EISDIR" });
  });

  test("a ledger write that fails in a provider registered while running calls onFatal once", async () => {
    const rig = newRig();
    const onFatal = vi.fn<(err: unknown) => void>();
    const { url } = await boot(rig, { onFatal });
    const key = await enroll(url, B);
    const { r, d1 } = await ready(url, key, rig, B);
    expect(onFatal).not.toHaveBeenCalled();

    breakLedger(rig, B);
    failedSettle(await settle(url, key, pay(r, 500n, d1), r));
    expect(onFatal).toHaveBeenCalledTimes(1);
    expect(onFatal.mock.calls[0]?.[0]).toMatchObject({ code: "EISDIR" });
  });

  test("the operator and two providers whose ledgers fail call onFatal once between them", async () => {
    const rig = newRig();
    const first = await boot(rig, { ledgerPath: join(rig.dir, "operator.jsonl") });
    const keyA = await enroll(first.url, A);
    await first.close();

    // A is loaded from the registry, B registers while running, and the operator is the third runtime
    const onFatal = vi.fn<(err: unknown) => void>();
    const { url, pollNow } = await boot(rig, { onFatal, ledgerPath: join(rig.dir, "operator.jsonl") });
    const keyB = await enroll(url, B);
    const a = await ready(url, keyA, rig, A);
    const b = await ready(url, keyB, rig, B);
    const operator = await ready(url, TOKEN, rig, { payTo: OPERATOR, uivk: "" });

    breakLedger(rig, A);
    breakLedger(rig, B);
    rmSync(join(rig.dir, "operator.jsonl"));
    mkdirSync(join(rig.dir, "operator.jsonl"));

    // The first runtime to fail tells the host at once, and the failures of the others add nothing to it
    const told: number[] = [];
    for (const [key, ready] of [
      [keyA, a],
      [keyB, b],
      [TOKEN, operator],
    ] as const) {
      failedSettle(await settle(url, key, pay(ready.r, 500n, ready.d1), ready.r));
      told.push(onFatal.mock.calls.length);
    }
    expect(told).toEqual([1, 1, 1]);

    // A watcher pass that cannot write the status of a deposit it saw mined reports the same failure again
    for (const who of [A, B, { payTo: OPERATOR }]) rig.chainOf(who.payTo).mine(1);
    await pollNow();
    expect(onFatal).toHaveBeenCalledTimes(1);
  });

  test("a ledger lock another start took in a registered provider calls onFatal once", async () => {
    const rig = newRig();
    const onFatal = vi.fn<(err: unknown) => void>();
    const { url } = await boot(rig, { onFatal });
    const key = await enroll(url, A);
    const { r, d1 } = await ready(url, key, rig, A);

    takeOver(ledgerOf(rig, A));
    const before = readFileSync(ledgerOf(rig, A));
    failedSettle(await settle(url, key, pay(r, 500n, d1), r));
    expect(readFileSync(ledgerOf(rig, A))).toEqual(before);
    expect(onFatal).toHaveBeenCalledTimes(1);
    expect(String(onFatal.mock.calls[0]?.[0])).toMatch(/is no longer locked by this facilitator/);
  });

  test("a registry lock another start took calls onFatal at the next write to it, which is refused", async () => {
    const rig = newRig();
    const onFatal = vi.fn<(err: unknown) => void>();
    const { url } = await boot(rig, { onFatal });
    const key = await enroll(url, A);
    const registry = join(rig.providers, "registry.json");
    const stored = readFileSync(registry);
    expect(onFatal).not.toHaveBeenCalled();

    takeOver(registry);
    const refused = await register(url, B);
    expect(refused).toMatchObject({ status: 500, json: { error: "internal_error" } });
    expect(onFatal).toHaveBeenCalledTimes(1);
    expect(String(onFatal.mock.calls[0]?.[0])).toMatch(/is no longer locked by this facilitator/);

    // The start that lost the lock wrote nothing, and the runtime it had opened for B was let go
    expect(readFileSync(registry)).toEqual(stored);
    expect(locksUnder(join(rig.providers, "ledgers")).filter((n) => n.startsWith(ID_B))).toEqual([]);
    expect((await call(url, "/providers/me", { token: key })).status).toBe(200);

    // A later write is refused the same way, and the host is told only once
    expect((await register(url, A)).status).toBe(500);
    expect(onFatal).toHaveBeenCalledTimes(1);
  });
});

describe("what the log lets out", () => {
  test("names the provider of an authenticated request and nobody else, and no query string", async () => {
    const rig = newRig();
    const { url } = await boot(rig, {}, { registrationToken: REGISTRATION });
    const key = await enroll(url, A, { token: REGISTRATION });
    const r = await requirementsFor(url, A.payTo);
    const d1 = deposit(rig.chainOf(A.payTo), A.payTo);
    rig.lines.length = 0;

    await call(url, "/supported?apikey=hunter2");
    await call(url, "/providers/me?apikey=hunter2", { token: key });
    await call(url, "/providers/me", { token: "nope" });
    await verify(url, key, pay(r, 500n, d1), r);
    await settle(url, key, pay(r, 500n, d1), r);
    await settle(url, key, pay(r, 500n), r);
    await call(url, "/verify", { token: TOKEN, body: {} });
    await register(url, A, { token: REGISTRATION }, "/providers?uivk=hunter2");
    await register(url, A, { token: "nope" });
    await call(url, "/nowhere?apikey=hunter2");

    expect(rig.lines).toEqual([
      "GET /supported 200",
      `GET /providers/me 200 ${ID_A}`,
      "GET /providers/me 401",
      `POST /verify 200 ${ID_A}`,
      `POST /settle 200 ${ID_A}`,
      `POST /settle 200 ${REASON.cumulativeMismatch} ${ID_A}`,
      `POST /verify 200 invalid_payload ${ID_OPERATOR}`,
      `facilitator: rotated the key of provider ${ID_A}`,
      "POST /providers 200",
      "POST /providers 401",
      "GET /nowhere 404",
    ]);
  });

  test("never carries a key, a viewing key, a token or a payment, whatever registration does", async () => {
    const rig = newRig();
    const { url } = await boot(rig, {}, { registrationToken: REGISTRATION });
    const first = await enroll(url, A, { token: REGISTRATION });
    const second = (await register(url, A, { token: REGISTRATION })).json.apiKey as string;
    const keyB = await enroll(url, B, { token: REGISTRATION });
    rig.owns.mockRejectedValueOnce(new Error("zdecrypt could not be started (ENOENT)"));
    await register(url, C, { token: REGISTRATION });
    mkdirSync(ledgerOf(rig, { payTo: `uregtest1${"s".repeat(60)}` }));
    await register(url, { payTo: `uregtest1${"s".repeat(60)}`, uivk: C.uivk }, { token: REGISTRATION });

    const rA = await requirementsFor(url, A.payTo);
    const payload = pay(rA, 500n, deposit(rig.chainOf(A.payTo), A.payTo));
    await verify(url, second, payload, rA);
    await settle(url, second, payload, rA);
    await verify(url, first, payload, rA);
    await call(url, "/providers/me", { token: keyB });
    await call(url, "/providers/me", { token: "wrong" });
    await register(url, A, { token: "wrong" });
    await register(url, { payTo: "nope", uivk: "nope" }, { token: REGISTRATION });
    await call(url, "/providers?uivk=hunter2&token=hunter2", { method: "POST", token: REGISTRATION, body: {} });

    const signature = String((payload.payload as Record<string, unknown>).sig);
    const logged = rig.lines.join("\n");
    expect(logged).toContain(`facilitator: registered provider ${ID_A} payTo=${A.payTo}`);
    const secrets = [
      A.uivk,
      B.uivk,
      C.uivk,
      first,
      second,
      keyB,
      keyDigest(first),
      keyDigest(second),
      keyDigest(keyB),
      TOKEN,
      REGISTRATION,
      "hunter2",
      signature,
      K,
    ];
    for (const secret of secrets) expect(logged).not.toContain(secret.slice(0, 20));
    for (const line of rig.lines.filter((l) => /^(GET|POST) /.test(l))) expect(line).not.toContain("?");
  });
});
