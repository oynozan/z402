import type { PaymentRequirements } from "@x402/core/types";
import { DEMO_TERMS, encodeTerms, NETWORK_REGTEST, SCHEME } from "@z402/protocol";
import { FakeChain } from "@z402/testkit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DepositStatusUnknownError, ZalletRpcError } from "../src/errors.js";
import { PrepaidVoucherScheme, type ClientEvent } from "../src/index.js";
import {
  InsufficientFundsError,
  ZalletRpcWallet,
  zatToZecString,
  type ZalletRpcWalletOptions,
} from "../src/wallet/zallet-rpc.js";
import { PAY_TO, SEED, txid } from "./fixtures.js";
import {
  ACCOUNT,
  AGENT_UA,
  OPID,
  opFailed,
  opRunning,
  opSuccess,
  PASSWORD,
  startFakeZallet,
  txRow,
  USER,
  type FakeZallet,
  type Reply,
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
      fake.runOperation({ runningPolls: 2, finish: opSuccess(txid(7)) });

      const sent = await send(make());

      expect(sent).toEqual({ txid: txid(7) });
      const calls = fake.calls("z_sendmany");
      expect(calls).toHaveLength(1);
      expect(calls[0]!.params).toEqual([AGENT_UA, [{ address: TO, amount: "0.001", memo: Buffer.from(MEMO).toString("hex") }], 1, null, "FullPrivacy"]);
      expect(calls[0]!.authorization).toBe("Basic " + Buffer.from(`${USER}:${PASSWORD}`).toString("base64"));
      expect(fake.calls("z_getoperationresult")).toHaveLength(3);
      expect(fake.calls("z_getoperationresult")[0]!.params).toEqual([[OPID]]);
      expect(fake.calls("z_getoperationstatus")).toHaveLength(2);
      expect(fake.calls("z_getoperationstatus")[0]!.params).toEqual([[OPID]]);
      expect(fake.calls("z_listtransactions")).toHaveLength(0);
      expect(clock.sleeps).toEqual([POLL, POLL]);
    });

    it("waits while z_getoperationresult is empty and z_getoperationstatus lists the op as queued, then executing", async () => {
      fake.on("z_getoperationresult", { result: [] }, { result: [] }, { result: [opSuccess(txid(8))] });
      fake.on("z_getoperationstatus", { result: [opRunning("queued")] }, { result: [opRunning("executing")] });

      await expect(send(make())).resolves.toEqual({ txid: txid(8) });
      expect(fake.calls("z_sendmany")).toHaveLength(1);
      expect(fake.calls("z_getoperationstatus")).toHaveLength(2);
      expect(fake.calls("z_listtransactions")).toHaveLength(0);
    });

    it("an operation that finished between the two calls is read on the next poll", async () => {
      fake.on("z_getoperationresult", { result: [] }, { result: [opSuccess(txid(8))] });
      fake.on("z_getoperationstatus", { result: [opSuccess(txid(8))] });

      await expect(send(make())).resolves.toEqual({ txid: txid(8) });
      expect(fake.calls("z_listtransactions")).toHaveLength(0);
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

    it("a failed operation that is not about funds and left no ledger row throws ZalletRpcError without resending", async () => {
      fake.on("z_getoperationresult", { result: [opFailed(-8, "Invalid recipient address")] });

      const error = await send(make()).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ZalletRpcError);
      expect(error).not.toBeInstanceOf(InsufficientFundsError);
      expect(error).not.toBeInstanceOf(DepositStatusUnknownError);
      expect((error as ZalletRpcError).code).toBe(-8);
      expect((error as ZalletRpcError).message).toBe("Zallet operation failed: Invalid recipient address");
      expect(fake.calls("z_sendmany")).toHaveLength(1);
      expect(fake.calls("z_listtransactions")).toHaveLength(1);
      expect(clock.sleeps).toEqual([]);
    });

    it("a failed operation whose transaction the wallet stored anyway returns that txid without resending", async () => {
      fake.on("z_getoperationresult", { result: [opFailed(-26, "Failed to broadcast transaction: connection reset")] });
      fake.on("z_listtransactions", { result: [txRow({ txid: txid(5), minedHeight: null, outputs: [{ memo: MEMO }] })] });

      await expect(send(make())).resolves.toEqual({ txid: txid(5) });

      expect(fake.calls("z_sendmany")).toHaveLength(1);
      expect(fake.calls("z_listtransactions")).toHaveLength(1);
      expect(clock.sleeps).toEqual([]);
    });

    describe("a failed operation whose ledger lookup cannot answer", () => {
      const failed = { result: [opFailed(-26, "Failed to broadcast transaction: connection reset")] };

      it("ends in DepositStatusUnknownError, never in a definite failure, after one z_sendmany", async () => {
        fake.on("z_getoperationresult", failed);
        fake.on("z_listtransactions", { drop: true });

        const error = await send(make()).catch((e: unknown) => e);

        expect(error).toBeInstanceOf(DepositStatusUnknownError);
        expect((error as Error).cause).toBeDefined();
        expect(fake.calls("z_sendmany")).toHaveLength(1);
        expect(fake.calls("z_listtransactions")).toHaveLength(5);
        expect(clock.sleeps).toEqual([POLL, POLL, POLL, POLL]);
      });

      it("keeps asking the ledger, and a later answer with the row returns its txid", async () => {
        fake.on("z_getoperationresult", failed);
        fake.on("z_listtransactions", { status: 502, body: "Bad Gateway" }, { result: [txRow({ txid: txid(5), outputs: [{ memo: MEMO }] })] });

        await expect(send(make())).resolves.toEqual({ txid: txid(5) });
        expect(fake.calls("z_sendmany")).toHaveLength(1);
      });

      it("keeps asking the ledger, and a later answer without the row is the operation's own failure", async () => {
        fake.on("z_getoperationresult", failed);
        fake.on("z_listtransactions", { drop: true }, { result: [] });

        const error = await send(make()).catch((e: unknown) => e);

        expect(error).toBeInstanceOf(ZalletRpcError);
        expect(error).not.toBeInstanceOf(DepositStatusUnknownError);
        expect((error as ZalletRpcError).code).toBe(-26);
        expect(fake.calls("z_listtransactions")).toHaveLength(2);
      });

      it("through PrepaidVoucherScheme, halts the session instead of paying again under a new memo", async () => {
        fake.on("z_getoperationresult", failed);
        fake.on("z_listtransactions", { drop: true });
        const events: ClientEvent[] = [];
        const scheme = new PrepaidVoucherScheme({
          wallet: make(),
          chain: new FakeChain().statusSource(),
          seed: SEED,
          clock: new ManualClock(),
          onEvent: (e) => events.push(e),
        });
        const req = (): PaymentRequirements => ({
          scheme: SCHEME,
          network: NETWORK_REGTEST,
          amount: "500",
          asset: "ZEC",
          payTo: PAY_TO,
          maxTimeoutSeconds: 60,
          extra: { ...encodeTerms(DEMO_TERMS), termsVersion: "0123456789abcdef" },
        });

        await expect(drive(clock, scheme.createPaymentPayload(2, req()))).rejects.toBeInstanceOf(DepositStatusUnknownError);
        await expect(scheme.createPaymentPayload(2, req())).rejects.toThrow("deposit_status_unknown");

        expect(fake.calls("z_sendmany")).toHaveLength(1);
        expect(events.filter((e) => e.type === "fatal").map((e) => (e as { code: string }).code)).toEqual([
          "deposit_status_unknown",
        ]);
      });
    });

    it("an insufficient-funds failure never looks in the ledger", async () => {
      fake.on("z_getoperationresult", { result: [opFailed(-6, "Insufficient balance")] });

      await expect(send(make({ preBroadcastRetries: 0 }))).rejects.toBeInstanceOf(InsufficientFundsError);
      expect(fake.calls("z_listtransactions")).toHaveLength(0);
    });

    describe("operation tracking against Zallet's real z_getoperationresult", () => {
      it("a normal 5 s operation is only waited for, with no ledger lookup", async () => {
        fake.runOperation({ runningPolls: 20, finish: opSuccess(txid(4)) });

        await expect(send(make({ opTimeoutMs: 10_000 }))).resolves.toEqual({ txid: txid(4) });

        expect(fake.calls("z_sendmany")).toHaveLength(1);
        expect(fake.calls("z_getoperationresult")).toHaveLength(21);
        expect(fake.calls("z_getoperationstatus")).toHaveLength(20);
        expect(fake.calls("z_listtransactions")).toHaveLength(0);
        expect(clock.sleeps).toEqual(Array<number>(20).fill(POLL));
      });

      it("an opid gone from both methods reconciles by memo at once and returns that txid", async () => {
        fake.on("z_getoperationresult", { result: [] });
        fake.on("z_getoperationstatus", { result: [] });
        fake.on("z_listtransactions", { result: [txRow({ txid: txid(4), minedHeight: null, outputs: [{ memo: MEMO }] })] });

        await expect(send(make())).resolves.toEqual({ txid: txid(4) });

        expect(fake.calls("z_sendmany")).toHaveLength(1);
        expect(fake.calls("z_getoperationresult")).toHaveLength(1);
        expect(fake.calls("z_getoperationstatus")).toHaveLength(1);
        expect(fake.calls("z_listtransactions")).toHaveLength(1);
        expect(clock.sleeps).toEqual([]);
      });

      it("a lost opid with no ledger row throws DepositStatusUnknownError on the first lookup, without waiting", async () => {
        fake.on("z_getoperationresult", { result: [] });
        fake.on("z_getoperationstatus", { result: [] });

        const error = await send(make({ opTimeoutMs: 300_000 })).catch((e: unknown) => e);

        expect(error).toBeInstanceOf(DepositStatusUnknownError);
        expect((error as Error).cause).toBeInstanceOf(ZalletRpcError);
        expect((error as Error & { cause: Error }).cause.message).toContain(OPID);
        expect(fake.calls("z_sendmany")).toHaveLength(1);
        expect(fake.calls("z_getoperationresult")).toHaveLength(1);
        expect(fake.calls("z_listtransactions")).toHaveLength(1);
        expect(clock.sleeps).toEqual([]);
      });

      it("a lost opid whose ledger lookup errors keeps asking until the deadline", async () => {
        fake.on("z_getoperationresult", { result: [] });
        fake.on("z_getoperationstatus", { result: [] });
        fake.on("z_listtransactions", { drop: true });

        const error = await send(make()).catch((e: unknown) => e);

        expect(error).toBeInstanceOf(DepositStatusUnknownError);
        expect(fake.calls("z_sendmany")).toHaveLength(1);
        expect(fake.calls("z_listtransactions")).toHaveLength(5);
        expect(clock.sleeps).toEqual([POLL, POLL, POLL, POLL]);
      });

      it("a lost opid whose lookup errors and then answers without the row throws at that answer", async () => {
        fake.on("z_getoperationresult", { result: [] });
        fake.on("z_getoperationstatus", { result: [] });
        fake.on("z_listtransactions", { drop: true }, { result: [] });

        await expect(send(make())).rejects.toBeInstanceOf(DepositStatusUnknownError);
        expect(fake.calls("z_listtransactions")).toHaveLength(2);
        expect(clock.sleeps).toEqual([POLL]);
      });

      it("a result reply lost in transport, after which the op is gone from both, reconciles by memo", async () => {
        fake.on("z_getoperationresult", { drop: true }, { result: [] });
        fake.on("z_getoperationstatus", { result: [] });
        fake.on("z_listtransactions", { result: [] }, { result: [txRow({ txid: txid(3), outputs: [{ memo: MEMO }] })] });

        await expect(send(make())).resolves.toEqual({ txid: txid(3) });

        expect(fake.calls("z_sendmany")).toHaveLength(1);
        expect(fake.calls("z_getoperationresult")).toHaveLength(2);
        expect(fake.calls("z_getoperationstatus")).toHaveLength(1);
        expect(fake.calls("z_listtransactions")).toHaveLength(2);
      });
    });

    it("op timeout reconciles by memo and never resends", async () => {
      fake.on("z_getoperationresult", { result: [] });
      fake.on("z_getoperationstatus", { result: [opRunning()] });
      fake.on("z_listtransactions", { result: [txRow({ txid: txid(5), minedHeight: null, outputs: [{ memo: MEMO }] })] });

      await expect(send(make())).resolves.toEqual({ txid: txid(5) });

      expect(fake.calls("z_sendmany")).toHaveLength(1);
      expect(fake.calls("z_listtransactions")).toHaveLength(1);
      expect(clock.sleeps).toEqual([POLL, POLL, POLL, POLL]);
      expect(fake.calls("z_getoperationresult")).toHaveLength(5);
    });

    it("op timeout with no matching transaction throws DepositStatusUnknownError naming the memo", async () => {
      fake.on("z_getoperationresult", { result: [] });
      fake.on("z_getoperationstatus", { result: [opRunning()] });

      const error = await send(make()).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(DepositStatusUnknownError);
      expect(error).toBeInstanceOf(ZalletRpcError);
      expect((error as DepositStatusUnknownError).message).toContain(MEMO);
      expect((error as DepositStatusUnknownError).memo).toBe(MEMO);
      expect(fake.calls("z_sendmany")).toHaveLength(1);
      expect(fake.calls("z_listtransactions")).toHaveLength(1);
    });

    it("a cancelled operation throws at once without resending or reconciling", async () => {
      fake.on("z_getoperationresult", { result: [{ id: OPID, status: "cancelled" }] });

      const error = await send(make()).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ZalletRpcError);
      expect(error).not.toBeInstanceOf(DepositStatusUnknownError);
      expect(error).not.toBeInstanceOf(InsufficientFundsError);
      expect((error as Error).message).toContain("cancelled");
      expect(fake.calls("z_sendmany")).toHaveLength(1);
      expect(fake.calls("z_listtransactions")).toHaveLength(0);
      expect(clock.sleeps).toEqual([]);
    });

    describe("a poll that fails after the opid", () => {
      it("the first poll drops while the op is still building and the second poll succeeds", async () => {
        fake.on("z_getoperationresult", { drop: true }, { result: [opSuccess(txid(7))] });

        await expect(send(make())).resolves.toEqual({ txid: txid(7) });

        expect(fake.calls("z_sendmany")).toHaveLength(1);
        expect(fake.calls("z_getoperationresult")).toHaveLength(2);
        expect(clock.sleeps).toEqual([POLL]);
      });

      it("one poll error reads the ledger once, then the op seen running again is only waited for", async () => {
        const empty: Reply = { result: [] };
        fake.on(
          "z_getoperationresult",
          { error: { code: -32603, message: "internal error" } },
          ...Array<Reply>(5).fill(empty),
          { result: [opSuccess(txid(6))] },
        );
        fake.on("z_getoperationstatus", { result: [opRunning()] });

        await expect(send(make({ opTimeoutMs: 10_000 }))).resolves.toEqual({ txid: txid(6) });

        expect(fake.calls("z_sendmany")).toHaveLength(1);
        expect(fake.calls("z_getoperationresult")).toHaveLength(7);
        expect(fake.calls("z_getoperationstatus")).toHaveLength(5);
        expect(fake.calls("z_listtransactions")).toHaveLength(1);
        expect(clock.sleeps).toEqual(Array<number>(6).fill(POLL));
      });

      it("after a poll error, an op that runs past the deadline still gets the final ledger lookup", async () => {
        fake.on("z_getoperationresult", { drop: true }, { result: [] });
        fake.on("z_getoperationstatus", { result: [opRunning()] });
        fake.on("z_listtransactions", { result: [] }, { result: [txRow({ txid: txid(6), outputs: [{ memo: MEMO }] })] });

        await expect(send(make())).resolves.toEqual({ txid: txid(6) });

        expect(fake.calls("z_sendmany")).toHaveLength(1);
        expect(fake.calls("z_getoperationresult")).toHaveLength(5);
        expect(fake.calls("z_listtransactions")).toHaveLength(2);
      });

      it("a failed operation after a dropped poll still throws without resending", async () => {
        fake.on("z_getoperationresult", { drop: true }, { result: [opFailed(-8, "Invalid recipient address")] });

        const error = await send(make()).catch((e: unknown) => e);

        expect(error).toBeInstanceOf(ZalletRpcError);
        expect((error as ZalletRpcError).code).toBe(-8);
        expect(fake.calls("z_sendmany")).toHaveLength(1);
      });

      it("a poll error that never clears ends in DepositStatusUnknownError at the same deadline", async () => {
        fake.on("z_getoperationresult", { drop: true });

        await expect(send(make())).rejects.toBeInstanceOf(DepositStatusUnknownError);

        expect(fake.calls("z_sendmany")).toHaveLength(1);
        expect(fake.calls("z_getoperationresult")).toHaveLength(5);
        expect(fake.calls("z_listtransactions")).toHaveLength(5);
        expect(clock.sleeps).toEqual([POLL, POLL, POLL, POLL]);
      });

      it("an unreadable success result stops polling the operation and reconciles by memo", async () => {
        fake.on("z_getoperationresult", { result: [{ id: OPID, status: "success", result: { txid: "not-a-txid" } }] });
        fake.on("z_listtransactions", { result: [] }, { result: [txRow({ txid: txid(2), outputs: [{ memo: MEMO }] })] });

        await expect(send(make())).resolves.toEqual({ txid: txid(2) });

        expect(fake.calls("z_sendmany")).toHaveLength(1);
        expect(fake.calls("z_getoperationresult")).toHaveLength(1);
      });

      it("a ledger lookup that fails is retried until the deadline", async () => {
        fake.on("z_getoperationresult", { drop: true });
        fake.on("z_listtransactions", { drop: true }, { result: [txRow({ txid: txid(6), outputs: [{ memo: MEMO }] })] });

        await expect(send(make())).resolves.toEqual({ txid: txid(6) });
        expect(fake.calls("z_sendmany")).toHaveLength(1);
      });

      it("a ledger lookup that always fails ends in DepositStatusUnknownError", async () => {
        fake.on("z_getoperationresult", { drop: true });
        fake.on("z_listtransactions", { drop: true });

        const error = await send(make()).catch((e: unknown) => e);

        expect(error).toBeInstanceOf(DepositStatusUnknownError);
        expect((error as Error).cause).toBeDefined();
        expect(fake.calls("z_sendmany")).toHaveLength(1);
      });
    });

    describe("an ambiguous z_sendmany outcome", () => {
      const AMBIGUOUS: [string, Reply, Partial<ZalletRpcWalletOptions>][] = [
        ["a dropped socket", { drop: true }, {}],
        ["a 502 with no JSON body", { status: 502, body: "Bad Gateway" }, {}],
        ["a 500 with a JSON body that has no error", { status: 500, body: "{}" }, {}],
        ["a 200 with a non-JSON body", { status: 200, body: "<html></html>" }, {}],
        ["a 200 with no result", { status: 200, body: JSON.stringify({ jsonrpc: "2.0", id: 1 }) }, {}],
        ["a result that is not an opid", { result: 42 }, {}],
        ["an empty opid", { result: "" }, {}],
        ["a request that times out", { hang: true }, { requestTimeoutMs: 50 }],
        ["a proxy body whose error is a string", { status: 502, body: JSON.stringify({ error: "Bad Gateway" }) }, {}],
        ["an error object without a numeric code", { status: 200, body: JSON.stringify({ jsonrpc: "2.0", id: 1, error: { message: "boom" } }) }, {}],
        ["an error object with a string code", { status: 500, body: JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: "-4", message: "boom" } }) }, {}],
      ];
      const row = () => txRow({ txid: txid(5), minedHeight: null, outputs: [{ memo: MEMO }] });

      it.each(AMBIGUOUS)("%s: the late ledger row is returned with exactly one z_sendmany", async (_name, reply, extra) => {
        fake.on("z_sendmany", reply);
        fake.on("z_listtransactions", { result: [] }, { result: [] }, { result: [row()] });

        await expect(send(make(extra))).resolves.toEqual({ txid: txid(5) });

        expect(fake.calls("z_sendmany")).toHaveLength(1);
        expect(fake.calls("z_listtransactions")).toHaveLength(3);
        expect(fake.calls("z_getoperationresult")).toHaveLength(0);
        expect(clock.sleeps).toEqual([POLL, POLL]);
      });

      it.each(AMBIGUOUS)("%s: with no row ever, DepositStatusUnknownError at the deadline and one z_sendmany", async (_name, reply, extra) => {
        fake.on("z_sendmany", reply);

        const error = await send(make(extra)).catch((e: unknown) => e);

        expect(error).toBeInstanceOf(DepositStatusUnknownError);
        expect((error as Error).message).toContain(MEMO);
        expect(fake.calls("z_sendmany")).toHaveLength(1);
        expect(fake.calls("z_listtransactions")).toHaveLength(5);
        expect(clock.sleeps).toEqual([POLL, POLL, POLL, POLL]);
      });

      it("never retries the insufficient-funds path for an ambiguous send", async () => {
        fake.on("z_sendmany", { drop: true });
        fake.on("z_listtransactions", { result: [row()] });

        await expect(send(make({ preBroadcastRetries: 3 }))).resolves.toEqual({ txid: txid(5) });
        expect(fake.calls("z_sendmany")).toHaveLength(1);
        expect(clock.sleeps).toEqual([]);
      });
    });

    describe("a definite refusal from z_sendmany", () => {
      const REFUSALS: [string, Reply][] = [
        ["a JSON-RPC error body", { error: { code: -8, message: "Invalid parameter, unknown address" } }],
        ["a JSON-RPC error body on a 500", { status: 500, body: JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -4, message: "bad" } }) }],
        ["HTTP 401", { status: 401, body: "" }],
      ];

      it.each(REFUSALS)("%s throws at once with no reconcile polling", async (_name, reply) => {
        fake.on("z_sendmany", reply);

        const error = await send(make()).catch((e: unknown) => e);

        expect(error).toBeInstanceOf(ZalletRpcError);
        expect(error).not.toBeInstanceOf(DepositStatusUnknownError);
        expect(error).not.toBeInstanceOf(InsufficientFundsError);
        expect(fake.calls("z_sendmany")).toHaveLength(1);
        expect(fake.calls("z_listtransactions")).toHaveLength(0);
        expect(fake.calls("z_getoperationresult")).toHaveLength(0);
        expect(clock.sleeps).toEqual([]);
      });

      it("ECONNREFUSED throws at once with no reconcile polling", async () => {
        await fake.close();

        const error = await send(make()).catch((e: unknown) => e);

        expect(error).toBeInstanceOf(ZalletRpcError);
        expect(error).not.toBeInstanceOf(DepositStatusUnknownError);
        expect(clock.sleeps).toEqual([]);
        fake = await startFakeZallet();
      });
    });

    describe("two deposits at once from one wallet", () => {
      const MEMO_2 = "cd".repeat(32) + ":1";
      const MEMO_2_HEX = Buffer.from(MEMO_2).toString("hex");

      function sendBoth(wallet: ZalletRpcWallet): Promise<[unknown, unknown]> {
        const settle = (p: Promise<{ txid: string }>): Promise<unknown> => p.catch((e: unknown) => e);
        return drive(
          clock,
          Promise.all([
            settle(wallet.sendDeposit({ to: TO, amountZat: 100_000n, memo: MEMO })),
            settle(wallet.sendDeposit({ to: TO, amountZat: 100_000n, memo: MEMO_2 })),
          ]),
        );
      }

      function sentMemos(): string[] {
        return fake.calls("z_sendmany").map((c) => (c.params as [string, { memo: string }[]])[1][0]!.memo);
      }

      function finishEach(txidOf: Record<string, string>): void {
        fake.on("z_getoperationresult", (params) => ({ result: [opSuccess(txidOf[opIdOf(params)]!, opIdOf(params))] }));
      }

      it("the second z_sendmany waits until the first operation has finished, not just until it started", async () => {
        fake.on("z_sendmany", { result: "opid-1" }, { result: "opid-2" });
        let firstRunning = 3;
        fake.on("z_getoperationresult", (params) => {
          const id = opIdOf(params);
          if (id === "opid-1" && firstRunning > 0) {
            firstRunning -= 1;
            return { result: [] };
          }
          return { result: [opSuccess(id === "opid-1" ? txid(1) : txid(2), id)] };
        });
        fake.on("z_getoperationstatus", (params) => ({ result: [opRunning("executing", opIdOf(params))] }));

        await expect(sendBoth(make())).resolves.toEqual([{ txid: txid(1) }, { txid: txid(2) }]);

        const firstPolls = fake.requests.flatMap((r, i) => (r.method === "z_getoperationresult" && opIdOf(r.params) === "opid-1" ? [i] : []));
        expect(firstPolls).toHaveLength(4);
        expect(fake.requests.map((r) => r.method).lastIndexOf("z_sendmany")).toBeGreaterThan(firstPolls[firstPolls.length - 1]!);
        expect(sentMemos()).toEqual([MEMO_HEX, MEMO_2_HEX]);
      });

      it("a refused first send lets the second one through", async () => {
        fake.on("z_sendmany", { error: { code: -8, message: "Invalid parameter, unknown address" } }, { result: "opid-2" });
        finishEach({ "opid-2": txid(2) });

        const [first, second] = await sendBoth(make());

        expect(first).toBeInstanceOf(ZalletRpcError);
        expect(second).toEqual({ txid: txid(2) });
        expect(sentMemos()).toEqual([MEMO_HEX, MEMO_2_HEX]);
      });

      it("the wait before an insufficient-funds retry does not hold the wallet", async () => {
        fake.on("z_sendmany", { error: { code: -6, message: "Insufficient funds" } }, { result: "opid-2" }, { result: "opid-3" });
        finishEach({ "opid-2": txid(2), "opid-3": txid(3) });

        await expect(sendBoth(make())).resolves.toEqual([{ txid: txid(3) }, { txid: txid(2) }]);

        expect(sentMemos()).toEqual([MEMO_HEX, MEMO_2_HEX, MEMO_HEX]);
        expect(clock.sleeps).toEqual([RETRY_WAIT]);
      });
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

    describe("agent address diversifier index", () => {
      const reuse = (index: number): Reply => ({
        error: { code: -4, message: `Error: address at diversifier index ${index} was already generated with different receiver types.` },
      });
      const UA_2 = "uregtest1" + "2".repeat(60);
      const accepted = (index: number, address: string): Reply => ({
        result: { account_uuid: ACCOUNT, diversifier_index: index, receiver_types: ["orchard"], address },
      });
      const indices = (): unknown[] => fake.calls("z_getaddressforaccount").map((c) => (c.params as unknown[])[2]);

      it("uses index 1 with one call when it accepts an Orchard-only address", async () => {
        fake.on("z_getoperationresult", { result: [opSuccess(txid(7))] });

        await send(make({ account: undefined, fromAddress: undefined }));

        expect(indices()).toEqual([1]);
        expect((fake.calls("z_sendmany")[0]!.params as unknown[])[0]).toBe(AGENT_UA);
      });

      it("moves to index 2 when index 1 already holds an address with other receivers", async () => {
        fake.on("z_getaddressforaccount", (params) => ((params as unknown[])[2] === 1 ? reuse(1) : accepted(2, UA_2)));
        fake.on("z_getoperationresult", { result: [opSuccess(txid(7))] });
        const wallet = make({ account: undefined, fromAddress: undefined });

        await send(wallet);
        await send(wallet);

        expect(fake.calls("z_getaddressforaccount").map((c) => c.params)).toEqual([
          [ACCOUNT, ["orchard"], 1],
          [ACCOUNT, ["orchard"], 2],
        ]);
        expect((fake.calls("z_sendmany")[0]!.params as unknown[])[0]).toBe(UA_2);
        expect((fake.calls("z_sendmany")[1]!.params as unknown[])[0]).toBe(UA_2);
      });

      it("stops at once on any other -4 error", async () => {
        fake.on("z_getaddressforaccount", { error: { code: -4, message: "Error: cannot generate an address with a Sapling receiver" } });

        const failure = send(make({ account: undefined, fromAddress: undefined }));

        await expect(failure).rejects.toBeInstanceOf(ZalletRpcError);
        await expect(failure).rejects.toMatchObject({ code: -4 });
        expect(indices()).toEqual([1]);
      });

      it("stops at once on a non -4 code even when the message mentions reuse", async () => {
        fake.on("z_getaddressforaccount", {
          error: { code: -1, message: "Error: address at diversifier index 1 was already generated with different receiver types." },
        });

        await expect(send(make({ account: undefined, fromAddress: undefined }))).rejects.toMatchObject({ code: -1 });
        expect(indices()).toEqual([1]);
      });

      it("fails with a clear ZalletRpcError after 16 indices that all hold other receivers", async () => {
        fake.on("z_getaddressforaccount", (params) => reuse((params as unknown[])[2] as number));

        const failure = send(make({ account: undefined, fromAddress: undefined }));

        await expect(failure).rejects.toBeInstanceOf(ZalletRpcError);
        await expect(failure).rejects.toThrow(/no Orchard-only address.*1.*16/);
        expect(indices()).toEqual(Array.from({ length: 16 }, (_, i) => i + 1));
      });

      it("finds an address on the 16th index", async () => {
        fake.on("z_getaddressforaccount", (params) => {
          const index = (params as unknown[])[2] as number;
          return index < 16 ? reuse(index) : accepted(16, UA_2);
        });
        fake.on("z_getoperationresult", { result: [opSuccess(txid(7))] });

        await send(make({ account: undefined, fromAddress: undefined }));

        expect(fake.calls("z_getaddressforaccount")).toHaveLength(16);
        expect((fake.calls("z_sendmany")[0]!.params as unknown[])[0]).toBe(UA_2);
      });
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
