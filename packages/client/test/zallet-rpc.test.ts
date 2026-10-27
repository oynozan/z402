import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  InsufficientFundsError,
  ZalletRpcError,
  ZalletRpcWallet,
  zatToZecString,
  type ZalletRpcWalletOptions,
} from "../src/wallet/zallet-rpc.js";
import { txid } from "./fixtures.js";
import {
  ACCOUNT,
  AGENT_UA,
  OPID,
  opFailed,
  opPending,
  opSuccess,
  PASSWORD,
  startFakeZallet,
  txRow,
  USER,
  type FakeZallet,
} from "./helpers/fake-zallet.js";
import { ManualClock } from "./manual-clock.js";

const TO = "uregtest1" + "q".repeat(60);
const MEMO = "ab".repeat(32) + ":1";
const MEMO_HEX = Buffer.from(MEMO).toString("hex");
const POLL = 250;
const TIMEOUT = 1_000;
const RETRY_WAIT = 25_000;

/** A manual clock that records each sleep so a test can see the wallet's cadence */
class StepClock extends ManualClock {
  readonly sleeps: number[] = [];

  override sleep(ms: number): Promise<void> {
    this.sleeps.push(ms);
    return super.sleep(ms);
  }
}

/** Runs a wallet call to completion by advancing the clock by exactly each sleep the wallet asks for */
async function drive<T>(clock: StepClock, call: Promise<T>): Promise<T> {
  let settled = false;
  void call.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  let seen = 0;
  while (!settled) {
    if (clock.sleeps.length > seen) {
      await clock.advance(clock.sleeps[seen++]!);
    } else {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  }
  return call;
}

function opIdOf(params: unknown): string {
  return (params as string[][])[0]![0]!;
}

describe("zatToZecString", () => {
  it.each([
    [100_000n, "0.001"],
    [1n, "0.00000001"],
    [100_000_000n, "1"],
    [123_456_789n, "1.23456789"],
    [0n, "0"],
    [2_100_000_000_000_000n, "21000000"],
    [6_249_805_000n, "62.49805"],
  ])("%s zat is %s ZEC", (zat, zec) => {
    expect(zatToZecString(zat)).toBe(zec);
  });

  it("rejects a negative amount", () => {
    expect(() => zatToZecString(-1n)).toThrow(RangeError);
  });
});

describe("ZalletRpcWallet", () => {
  let fake: FakeZallet;
  let clock: StepClock;

  beforeEach(async () => {
    fake = await startFakeZallet();
    clock = new StepClock();
  });

  afterEach(async () => {
    await fake.close();
  });

  function make(extra: Partial<ZalletRpcWalletOptions> = {}): ZalletRpcWallet {
    return new ZalletRpcWallet({
      url: fake.url,
      user: USER,
      password: PASSWORD,
      account: ACCOUNT,
      fromAddress: AGENT_UA,
      clock,
      opPollMs: POLL,
      opTimeoutMs: TIMEOUT,
      retryWaitMs: RETRY_WAIT,
      ...extra,
    });
  }

  function send(wallet: ZalletRpcWallet): Promise<{ txid: string }> {
    return drive(clock, wallet.sendDeposit({ to: TO, amountZat: 100_000n, memo: MEMO }));
  }

  describe("sendDeposit", () => {
    it("sends one z_sendmany with the hex memo and exact amount", async () => {
      fake.on("z_getoperationresult", { result: [opPending()] }, { result: [opPending()] }, { result: [opSuccess(txid(7))] });

      const sent = await send(make());

      expect(sent).toEqual({ txid: txid(7) });
      const calls = fake.calls("z_sendmany");
      expect(calls).toHaveLength(1);
      expect(calls[0]!.params).toEqual([AGENT_UA, [{ address: TO, amount: "0.001", memo: Buffer.from(MEMO).toString("hex") }], 1, null, "FullPrivacy"]);
      expect(calls[0]!.authorization).toBe("Basic " + Buffer.from(`${USER}:${PASSWORD}`).toString("base64"));
      expect(fake.calls("z_getoperationresult")).toHaveLength(3);
      expect(fake.calls("z_getoperationresult")[0]!.params).toEqual([[OPID]]);
      expect(clock.sleeps).toEqual([POLL, POLL]);
    });

    it("keeps polling through an empty result and a queued operation", async () => {
      fake.on("z_getoperationresult", { result: [] }, { result: [opPending("queued")] }, { result: [opSuccess(txid(8))] });

      await expect(send(make())).resolves.toEqual({ txid: txid(8) });
      expect(fake.calls("z_sendmany")).toHaveLength(1);
    });

    it("falls back to txids[0] when the result has no txid", async () => {
      fake.on("z_getoperationresult", { result: [{ id: OPID, status: "success", result: { txids: [txid(9)] } }] });

      await expect(send(make())).resolves.toEqual({ txid: txid(9) });
    });

    it("sends the multi-byte UTF-8 bytes of the memo as hex", async () => {
      fake.on("z_getoperationresult", { result: [opSuccess(txid(7))] });

      await drive(clock, make().sendDeposit({ to: TO, amountZat: 1n, memo: "é:1" }));

      const params = fake.calls("z_sendmany")[0]!.params as [string, { memo: string; amount: string }[]];
      expect(params[1][0]!.memo).toBe("c3a9" + "3a31");
      expect(params[1][0]!.amount).toBe("0.00000001");
    });

    it("retries insufficient funds after a block, then gives up", async () => {
      fake.on("z_getoperationresult", { result: [opFailed(-6, "Insufficient balance: have 0, need 125000")] });

      const failure = send(make({ preBroadcastRetries: 3 })).catch((e: unknown) => e);

      const error = await failure;
      expect(error).toBeInstanceOf(InsufficientFundsError);
      expect(fake.calls("z_sendmany")).toHaveLength(4);
      expect(clock.sleeps.filter((ms) => ms === RETRY_WAIT)).toHaveLength(3);
    });

    it("succeeds when the funds arrive before the retries run out", async () => {
      fake.on("z_sendmany", { result: "opid-1" }, { result: "opid-2" });
      fake.on("z_getoperationresult", (params) =>
        opIdOf(params) === "opid-1"
          ? { result: [opFailed(-6, "Insufficient balance", "opid-1")] }
          : { result: [opSuccess(txid(3), "opid-2")] },
      );

      await expect(send(make())).resolves.toEqual({ txid: txid(3) });
      expect(fake.calls("z_sendmany")).toHaveLength(2);
      expect(clock.sleeps).toContain(RETRY_WAIT);
    });

    it("does not retry at all when preBroadcastRetries is 0", async () => {
      fake.on("z_getoperationresult", { result: [opFailed(-6, "Insufficient balance")] });

      await expect(send(make({ preBroadcastRetries: 0 }))).rejects.toBeInstanceOf(InsufficientFundsError);
      expect(fake.calls("z_sendmany")).toHaveLength(1);
    });

    it("retries when z_sendmany itself refuses for insufficient funds", async () => {
      fake.on("z_sendmany", { error: { code: -6, message: "Insufficient funds" } }, { result: OPID });
      fake.on("z_getoperationresult", { result: [opSuccess(txid(4))] });

      await expect(send(make())).resolves.toEqual({ txid: txid(4) });
      expect(fake.calls("z_sendmany")).toHaveLength(2);
    });

    it("a failed operation that is not about funds throws ZalletRpcError without resending", async () => {
      fake.on("z_getoperationresult", { result: [opFailed(-8, "Invalid recipient address")] });

      const error = await send(make()).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ZalletRpcError);
      expect(error).not.toBeInstanceOf(InsufficientFundsError);
      expect((error as ZalletRpcError).code).toBe(-8);
      expect((error as ZalletRpcError).message).toContain("Invalid recipient address");
      expect(fake.calls("z_sendmany")).toHaveLength(1);
      expect(clock.sleeps).toEqual([]);
    });

    it("op timeout reconciles by memo and never resends", async () => {
      fake.on("z_getoperationresult", { result: [opPending()] });
      fake.on("z_listtransactions", { result: [txRow({ txid: txid(5), minedHeight: null, outputs: [{ memo: MEMO }] })] });

      await expect(send(make())).resolves.toEqual({ txid: txid(5) });

      expect(fake.calls("z_sendmany")).toHaveLength(1);
      expect(fake.calls("z_listtransactions")).toHaveLength(1);
      expect(clock.sleeps).toEqual([POLL, POLL, POLL, POLL]);
      expect(fake.calls("z_getoperationresult")).toHaveLength(5);
    });

    it("op timeout with no matching transaction throws deposit status unknown", async () => {
      fake.on("z_getoperationresult", { result: [] });

      const error = await send(make()).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ZalletRpcError);
      expect((error as Error).message).toBe("deposit status unknown");
      expect(fake.calls("z_sendmany")).toHaveLength(1);
    });

    it("a transport error after the opid reconciles by memo and never resends", async () => {
      fake.on("z_getoperationresult", { drop: true });
      fake.on("z_listtransactions", { result: [txRow({ txid: txid(6), outputs: [{ memo: MEMO }] })] });

      await expect(send(make())).resolves.toEqual({ txid: txid(6) });
      expect(fake.calls("z_sendmany")).toHaveLength(1);
    });

    it("a poll answered with an error body after the opid reconciles by memo", async () => {
      fake.on("z_getoperationresult", { error: { code: -32603, message: "internal error" } });
      fake.on("z_listtransactions", { result: [txRow({ txid: txid(6), outputs: [{ memo: MEMO }] })] });

      await expect(send(make())).resolves.toEqual({ txid: txid(6) });
      expect(fake.calls("z_sendmany")).toHaveLength(1);
    });

    it("an unreadable success result reconciles by memo", async () => {
      fake.on("z_getoperationresult", { result: [{ id: OPID, status: "success", result: { txid: "not-a-txid" } }] });
      fake.on("z_listtransactions", { result: [txRow({ txid: txid(2), outputs: [{ memo: MEMO }] })] });

      await expect(send(make())).resolves.toEqual({ txid: txid(2) });
      expect(fake.calls("z_sendmany")).toHaveLength(1);
    });

    it("throws status unknown when the reconcile lookup also fails", async () => {
      fake.on("z_getoperationresult", { drop: true });
      fake.on("z_listtransactions", { drop: true });

      const error = await send(make()).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ZalletRpcError);
      expect((error as Error).message).toBe("deposit status unknown");
      expect(fake.calls("z_sendmany")).toHaveLength(1);
    });

    it("a transport error from z_sendmany itself surfaces as ZalletRpcError and is not resent", async () => {
      fake.on("z_sendmany", { drop: true });

      await expect(send(make())).rejects.toBeInstanceOf(ZalletRpcError);
      expect(fake.calls("z_sendmany")).toHaveLength(1);
      expect(fake.calls("z_getoperationresult")).toHaveLength(0);
    });

    it("rejects a z_sendmany answer that is not an opid", async () => {
      fake.on("z_sendmany", { result: 42 });

      await expect(send(make())).rejects.toBeInstanceOf(ZalletRpcError);
      expect(fake.calls("z_getoperationresult")).toHaveLength(0);
    });
  });

  describe("findSentByMemo", () => {
    it("ignores a memo that only matches as a substring", async () => {
      fake.on("z_listtransactions", {
        result: [
          txRow({ txid: txid(1), outputs: [{ memo: MEMO + "0" }] }),
          txRow({ txid: txid(2), outputs: [{ memo: "x" + MEMO }] }),
          txRow({ txid: txid(3), outputs: [{ memo: MEMO.slice(0, -1) }] }),
          txRow({ txid: txid(4), outputs: [{ memo: null }] }),
        ],
      });

      await expect(make().findSentByMemo(MEMO)).resolves.toBeUndefined();
      expect(fake.calls("z_listtransactions")[0]!.params).toEqual([ACCOUNT]);
    });

    it("matches the decoded text memo exactly and reports a pending row", async () => {
      fake.on("z_listtransactions", {
        result: [txRow({ txid: txid(1), minedHeight: null, outputs: [{ memo: "other" }, { memo: MEMO }] })],
      });

      await expect(make().findSentByMemo(MEMO)).resolves.toEqual({ txid: txid(1), minedHeight: null, expired: false });
    });

    it("also matches a hex memo, in either case", async () => {
      fake.on("z_listtransactions", { result: [txRow({ txid: txid(1), outputs: [{ memo: MEMO_HEX.toUpperCase() }] })] });

      await expect(make().findSentByMemo(MEMO)).resolves.toEqual({ txid: txid(1), minedHeight: 114, expired: false });
    });

    it("does not filter on is_change", async () => {
      fake.on("z_listtransactions", { result: [txRow({ txid: txid(1), outputs: [{ memo: MEMO, isChange: true }] })] });

      await expect(make().findSentByMemo(MEMO)).resolves.toMatchObject({ txid: txid(1) });
    });

    it("maps expired_unmined to expired", async () => {
      fake.on("z_listtransactions", {
        result: [txRow({ txid: txid(1), minedHeight: null, expiredUnmined: true, outputs: [{ memo: MEMO }] })],
      });

      await expect(make().findSentByMemo(MEMO)).resolves.toEqual({ txid: txid(1), minedHeight: null, expired: true });
    });

    it("picks the highest mined height, and a pending row beats any mined one", async () => {
      const row = (n: number, minedHeight: number | null) => txRow({ txid: txid(n), minedHeight, outputs: [{ memo: MEMO }] });
      fake.on("z_listtransactions", { result: [row(1, 120), row(2, 100), row(3, 110)] }, { result: [row(1, 120), row(2, null), row(3, 110)] });

      await expect(make().findSentByMemo(MEMO)).resolves.toMatchObject({ txid: txid(1), minedHeight: 120 });
      await expect(make().findSentByMemo(MEMO)).resolves.toMatchObject({ txid: txid(2), minedHeight: null });
    });

    it("an expired row never outranks a live one", async () => {
      fake.on("z_listtransactions", {
        result: [
          txRow({ txid: txid(1), minedHeight: 100, outputs: [{ memo: MEMO }] }),
          txRow({ txid: txid(2), minedHeight: null, expiredUnmined: true, outputs: [{ memo: MEMO }] }),
        ],
      });

      await expect(make().findSentByMemo(MEMO)).resolves.toMatchObject({ txid: txid(1), expired: false });
    });

    it("skips rows without outputs or with an unusable txid", async () => {
      fake.on("z_listtransactions", {
        result: [{ txid: txid(1), mined_height: 5 }, txRow({ txid: "short", outputs: [{ memo: MEMO }] }), txRow({ txid: txid(2), outputs: [{ memo: MEMO }] })],
      });

      await expect(make().findSentByMemo(MEMO)).resolves.toMatchObject({ txid: txid(2) });
    });
  });

  describe("spendableBalance", () => {
    it("sums ironwood + orchard valueZat and ignores transparent", async () => {
      fake.on("z_getbalanceforaccount", {
        result: {
          pools: { transparent: { valueZat: 62_500_000_000 }, ironwood: { valueZat: 6_249_805_000 }, orchard: { valueZat: 195_000 } },
          minimum_confirmations: 1,
        },
      });

      await expect(make().spendableBalance()).resolves.toBe(6_250_000_000n);
      expect(fake.calls("z_getbalanceforaccount")[0]!.params).toEqual([ACCOUNT, 1]);
    });

    it("counts a missing pool as zero", async () => {
      fake.on(
        "z_getbalanceforaccount",
        { result: { pools: { ironwood: { valueZat: 7 } }, minimum_confirmations: 1 } },
        { result: { pools: { transparent: { valueZat: 5 } }, minimum_confirmations: 1 } },
        { result: { pools: {}, minimum_confirmations: 1 } },
      );
      const wallet = make();

      await expect(wallet.spendableBalance()).resolves.toBe(7n);
      await expect(wallet.spendableBalance()).resolves.toBe(0n);
      await expect(wallet.spendableBalance()).resolves.toBe(0n);
    });

    it("rejects a balance that is not an integer", async () => {
      fake.on("z_getbalanceforaccount", { result: { pools: { ironwood: { valueZat: 1.5 } } } });

      await expect(make().spendableBalance()).rejects.toBeInstanceOf(ZalletRpcError);
    });
  });

  describe("defaults", () => {
    it("defaults account and fromAddress from z_listaccounts / z_getaddressforaccount", async () => {
      fake.on("z_getoperationresult", { result: [opSuccess(txid(7))] });
      const wallet = make({ account: undefined, fromAddress: undefined });

      await send(wallet);
      await send(wallet);
      await wallet.spendableBalance();

      expect(fake.calls("z_listaccounts")).toHaveLength(1);
      expect(fake.calls("z_getaddressforaccount")).toHaveLength(1);
      expect(fake.calls("z_getaddressforaccount")[0]!.params).toEqual([ACCOUNT, ["orchard"], 1]);
      expect((fake.calls("z_sendmany")[0]!.params as unknown[])[0]).toBe(AGENT_UA);
      expect(fake.calls("z_getbalanceforaccount")[0]!.params).toEqual([ACCOUNT, 1]);
    });

    it("reads the account from uuid when account_uuid is absent", async () => {
      fake.on("z_listaccounts", { result: [{ uuid: "11111111-2222-3333-4444-555555555555" }, { uuid: "other" }] });
      fake.on("z_getbalanceforaccount", { result: { pools: {} } });

      await make({ account: undefined }).spendableBalance();

      expect(fake.calls("z_getbalanceforaccount")[0]!.params).toEqual(["11111111-2222-3333-4444-555555555555", 1]);
    });

    it("asks nothing when account and fromAddress are given", async () => {
      fake.on("z_getoperationresult", { result: [opSuccess(txid(7))] });

      await send(make());

      expect(fake.calls("z_listaccounts")).toHaveLength(0);
      expect(fake.calls("z_getaddressforaccount")).toHaveLength(0);
    });

    it("throws when the wallet has no account", async () => {
      fake.on("z_listaccounts", { result: [] });

      await expect(make({ account: undefined }).spendableBalance()).rejects.toBeInstanceOf(ZalletRpcError);
    });

    it("looks the account up again after a failed lookup", async () => {
      fake.on("z_listaccounts", { drop: true }, { result: [{ account_uuid: ACCOUNT }] });
      fake.on("z_getbalanceforaccount", { result: { pools: { orchard: { valueZat: 9 } } } });
      const wallet = make({ account: undefined });

      await expect(wallet.spendableBalance()).rejects.toBeInstanceOf(ZalletRpcError);
      await expect(wallet.spendableBalance()).resolves.toBe(9n);
    });
  });

  describe("transport", () => {
    it("HTTP 401 throws ZalletRpcError", async () => {
      fake.on("z_getbalanceforaccount", { status: 401, body: "" });

      const error = await make().spendableBalance().catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ZalletRpcError);
      expect((error as Error).message).toContain("401");
    });

    it("a JSON-RPC error body throws ZalletRpcError carrying the code", async () => {
      fake.on("z_getbalanceforaccount", { error: { code: -4, message: "Invalid account" } });

      const error = await make().spendableBalance().catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ZalletRpcError);
      expect((error as ZalletRpcError).code).toBe(-4);
      expect((error as Error).message).toContain("Invalid account");
    });

    it("a JSON-RPC error body on a non-200 status still carries its code", async () => {
      fake.on("z_getbalanceforaccount", { status: 500, body: JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -5, message: "boom" } }) });

      const error = await make().spendableBalance().catch((e: unknown) => e);

      expect((error as ZalletRpcError).code).toBe(-5);
    });

    it("a non-JSON body throws ZalletRpcError with no code", async () => {
      fake.on("z_getbalanceforaccount", { status: 200, body: "<html>nope</html>" });

      const error = await make().spendableBalance().catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ZalletRpcError);
      expect((error as ZalletRpcError).code).toBeUndefined();
    });

    it("an unknown method answers with the JSON-RPC error", async () => {
      fake.on("z_getbalanceforaccount");

      await expect(make().spendableBalance()).rejects.toMatchObject({ code: -32601 });
    });

    it("an unreachable server throws ZalletRpcError", async () => {
      await fake.close();

      await expect(make().spendableBalance()).rejects.toBeInstanceOf(ZalletRpcError);
      fake = await startFakeZallet();
    });

    it("a server that never answers throws ZalletRpcError after requestTimeoutMs", async () => {
      fake.on("z_getbalanceforaccount", { hang: true });

      await expect(make({ requestTimeoutMs: 50 }).spendableBalance()).rejects.toBeInstanceOf(ZalletRpcError);
    });
  });
});
