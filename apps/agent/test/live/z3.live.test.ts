/**
 * Opt-in: needs the local Z3 regtest stack (infra/z3/README.md) and spends about 125,000 zat of regtest money per run.
 *   Z3_LIVE=1 pnpm vitest run apps/agent/test/live
 * Z3_RECORD_FIXTURES=1 also rewrites test/live/fixtures/failed-op.json.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InsufficientFundsError, ZalletRpcWallet } from "@z402-net/client";
import { depositMemo, generateSeed, publicKeyFromSeed } from "@z402-net/protocol";
import { zainoTxStatus } from "../../src/chain.js";
import { loadZ3Rpc, pollUntil, Z3_DEFAULTS, type Z3Rpc } from "../../src/z3.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/failed-op.json", import.meta.url));
const DEPOSIT_ZAT = 100_000n;
const EXPIRY_DELTA = 41;
const WAIT_MS = 30_000;
const POLL_MS = 500;
const MORE_THAN_THE_WALLET_HOLDS = 10_000_000_000_000n;

type Status = ReturnType<typeof zainoTxStatus>["status"];
type Seen = Extract<Awaited<ReturnType<Status["status"]>>, { found: true }>;

function wallet(preBroadcastRetries?: number): ZalletRpcWallet {
  return new ZalletRpcWallet({
    url: Z3_DEFAULTS.zalletUrl,
    user: Z3_DEFAULTS.zalletUser,
    password: Z3_DEFAULTS.zalletPassword,
    ...(preBroadcastRetries === undefined ? {} : { preBroadcastRetries }),
  });
}

/** Vitest hides console output of passing tests, and this suite exists to leave a record of the live run */
function note(message: string): void {
  process.stdout.write(`${message}\n`);
}

/** One raw JSON-RPC call to Zallet, returning the whole response body so error shapes stay visible */
async function rawZallet(method: string, params: unknown[]): Promise<Record<string, unknown>> {
  const auth = Buffer.from(`${Z3_DEFAULTS.zalletUser}:${Z3_DEFAULTS.zalletPassword}`).toString("base64");
  const res = await fetch(Z3_DEFAULTS.zalletUrl, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Basic ${auth}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(30_000),
  });
  return (await res.json()) as Record<string, unknown>;
}

describe.skipIf(!process.env.Z3_LIVE)("live Z3 regtest deposit through our own client code", () => {
  const { status, close } = zainoTxStatus(Z3_DEFAULTS.lightwalletdUrl);
  let z3: Z3Rpc;
  const agent = wallet();
  const memo = depositMemo(publicKeyFromSeed(generateSeed()), 1);
  let txid = "";
  let tipBeforeSend = 0;
  let tipAfterSend = 0;
  let mempoolSighting: Seen;
  let minedAt = 0;

  beforeAll(async () => {
    z3 = await loadZ3Rpc();
  });

  afterAll(() => close());

  it("(a) ZalletRpcWallet.sendDeposit pays the merchant and returns a txid", { timeout: 120_000 }, async () => {
    tipBeforeSend = Number(await z3.zebraRpc("getblockcount"));
    const t0 = Date.now();
    const sent = await agent.sendDeposit({ to: Z3_DEFAULTS.merchantPayTo, amountZat: DEPOSIT_ZAT, memo });
    tipAfterSend = Number(await z3.zebraRpc("getblockcount"));
    txid = sent.txid;
    note(`(a) memo ${memo}\n    txid ${txid}, sent in ${Date.now() - t0} ms, Zebra tip ${tipBeforeSend} -> ${tipAfterSend}`);

    expect(txid).toMatch(/^[0-9a-f]{64}$/);
  });

  it("(b) Zaino shows it in the mempool, then mined after one block, with expiry = tip + 41", { timeout: 120_000 }, async () => {
    expect(txid).not.toBe("");
    const t0 = Date.now();

    mempoolSighting = await pollUntil(
      "the deposit in Zaino",
      async () => {
        const s = await status.status(txid);
        return s.found ? s : undefined;
      },
      { timeoutMs: WAIT_MS, intervalMs: POLL_MS },
    );
    note(`(b) mempool sighting after ${Date.now() - t0} ms: ${JSON.stringify(mempoolSighting)}`);
    expect(mempoolSighting.location).toBe("mempool");
    expect(mempoolSighting.minedHeight).toBeNull();
    // The send itself can straddle a block when someone else mines, so only an unmoved tip pins the expiry exactly
    expect(mempoolSighting.expiryHeight).toBeGreaterThanOrEqual(tipBeforeSend + EXPIRY_DELTA);
    expect(mempoolSighting.expiryHeight).toBeLessThanOrEqual(tipAfterSend + EXPIRY_DELTA);
    if (tipBeforeSend === tipAfterSend) expect(mempoolSighting.expiryHeight).toBe(tipBeforeSend + EXPIRY_DELTA);

    const t1 = Date.now();
    const tip = await z3.mineNow(1);
    const mined = await pollUntil(
      "the deposit to be mined in Zaino",
      async () => {
        const s = await status.status(txid);
        return s.found && s.location === "mined" ? s : undefined;
      },
      { timeoutMs: WAIT_MS, intervalMs: POLL_MS },
    );
    note(`(b) mineNow(1) -> tip ${tip}, Zaino shows it mined after ${Date.now() - t1} ms: ${JSON.stringify(mined)}`);
    expect(mined.minedHeight).not.toBeNull();
    minedAt = mined.minedHeight ?? 0;
    expect(minedAt).toBeGreaterThan(tipAfterSend);
    expect(minedAt).toBeLessThanOrEqual(tip);
    expect(mined.expiryHeight).toBe(mempoolSighting.expiryHeight);
  });

  it("(c) findSentByMemo returns the same txid with a mined height", { timeout: 120_000 }, async () => {
    expect(minedAt).toBeGreaterThan(0);
    const t0 = Date.now();
    const found = await pollUntil(
      "Zallet to list the mined deposit",
      async () => {
        const f = await agent.findSentByMemo(memo);
        return f !== undefined && f.minedHeight !== null ? f : undefined;
      },
      { timeoutMs: WAIT_MS, intervalMs: POLL_MS },
    );
    note(`(c) findSentByMemo after ${Date.now() - t0} ms: ${JSON.stringify(found)}`);

    expect(found.txid).toBe(txid);
    expect(found.minedHeight).toBe(minedAt);
    expect(found.expired).toBe(false);
  });

  it("(d) a send of more than the wallet holds throws InsufficientFundsError, and Zallet refuses it synchronously", { timeout: 120_000 }, async () => {
    // The raw probe repeats the exact z_sendmany the adapter builds, to record what Zallet really answers
    const accounts = (await rawZallet("z_listaccounts", [])).result as { account_uuid: string }[];
    const account = accounts[0]!.account_uuid;
    const from = ((await rawZallet("z_getaddressforaccount", [account, ["orchard"], 1])).result as { address: string }).address;
    const params = [
      from,
      [{ address: Z3_DEFAULTS.merchantPayTo, amount: "100000", memo: Buffer.from(memo, "utf8").toString("hex") }],
      1,
      null,
      "FullPrivacy",
    ];
    const response = await rawZallet("z_sendmany", params);
    note(`(d) raw z_sendmany response: ${JSON.stringify(response)}`);

    if (process.env.Z3_RECORD_FIXTURES) {
      mkdirSync(dirname(FIXTURE), { recursive: true });
      const capture = { request: { method: "z_sendmany", params }, response };
      writeFileSync(FIXTURE, JSON.stringify(capture, null, 2) + "\n");
    }

    // Observed on Zallet beta.1: no operation is created, the proposal itself fails with JSON-RPC error -4
    expect(response).not.toHaveProperty("result");
    expect(response.error).toMatchObject({
      code: -4,
      message: expect.stringMatching(/^Failed to propose transaction: Insufficient balance \(have \d+, need \d+ including fee\)$/),
    });

    const failure = await wallet(0)
      .sendDeposit({ to: Z3_DEFAULTS.merchantPayTo, amountZat: MORE_THAN_THE_WALLET_HOLDS, memo })
      .catch((e: unknown) => e);
    note(`(d) adapter threw ${failure instanceof Error ? `${failure.name}: ${failure.message}` : String(failure)}`);
    expect(failure).toBeInstanceOf(InsufficientFundsError);
    expect((failure as Error).message).toMatch(/insufficient balance/i);
  });

  it("(e) a txid that does not exist is not found", { timeout: 30_000 }, async () => {
    const unknown = randomBytes(32).toString("hex");
    await expect(status.status(unknown)).resolves.toEqual({ found: false });
  });
});
