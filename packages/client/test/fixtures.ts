import type { PaymentResponseContext } from "@x402/core/client";
import type { PaymentRequirements } from "@x402/core/types";
import {
  depositMemo,
  NETWORK_REGTEST,
  SCHEME,
  type DepositStatus,
  type SessionSnapshot,
  type SnapshotDeposit,
} from "@z402/protocol";
import type { LocalDeposit } from "../src/session.js";

export const PAY_TO = "uregtest1" + "q".repeat(60);
export const NETWORK = NETWORK_REGTEST;
export const SEED = new Uint8Array(32).fill(7);

export function txid(n: number): string {
  return n.toString(16).padStart(2, "0").repeat(32);
}

export function snapshotDeposit(id: string, status: DepositStatus = "confirmed"): SnapshotDeposit {
  return { txid: id, valueZat: "100000", status, confirmations: 2, expiryHeight: 4_547_450, zeroConf: true };
}

export function snapshot(o: {
  cumulative?: bigint;
  limit?: bigint;
  deposits?: SnapshotDeposit[];
  sessionKey?: string;
}): SessionSnapshot {
  const cumulative = o.cumulative ?? 0n;
  const limit = o.limit ?? 125_000n;
  return {
    sessionKey: o.sessionKey ?? "ab".repeat(32),
    cumulativeZat: cumulative.toString(),
    limitZat: limit.toString(),
    headroomZat: (limit - cumulative).toString(),
    confirmedZat: "100000",
    pendingZat: "0",
    creditZat: "25000",
    tip: 4_547_331,
    deposits: o.deposits ?? [],
  };
}

export function localDeposit(
  sessionKey: string,
  index: number,
  state: LocalDeposit["state"],
  id?: string,
): LocalDeposit {
  return { index, memo: depositMemo(sessionKey, index), state, ...(id === undefined ? {} : { txid: id }) };
}

export const requirements: PaymentRequirements = {
  scheme: SCHEME,
  network: NETWORK,
  asset: "ZEC",
  amount: "500",
  payTo: PAY_TO,
  maxTimeoutSeconds: 60,
  extra: {},
};

export function context(o: Partial<PaymentResponseContext>): PaymentResponseContext {
  return {
    paymentPayload: { x402Version: 2, accepted: requirements, payload: {} },
    requirements,
    ...o,
  };
}
