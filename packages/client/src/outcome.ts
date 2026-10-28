import type { PaymentResponseContext } from "@x402/core/client";
import { parseSessionSnapshot, REASON, type SessionSnapshot } from "@z402-net/protocol";

export type Outcome =
  | { kind: "paid"; snapshot?: SessionSnapshot; transaction: string }
  | { kind: "refused"; code: string; snapshot?: SessionSnapshot; via: "verify" | "settle" }
  | { kind: "ambiguous" };

export type Action =
  | "wait_confirmation"
  | "deposit"
  | "resync"
  | "redeposit"
  | "check_deposit"
  | "backoff"
  | "reject_txid"
  | "fatal"
  | "stop";

/** The validated `extra.session` of a verify or settle response, or `undefined`. */
export function snapshotFromExtra(extra: unknown): SessionSnapshot | undefined {
  if (typeof extra !== "object" || extra === null) return undefined;
  return parseSessionSnapshot((extra as { session?: unknown }).session) ?? undefined;
}

function withSnapshot<T extends object>(
  base: T,
  snapshot: SessionSnapshot | undefined,
): T & { snapshot?: SessionSnapshot } {
  return snapshot === undefined ? base : { ...base, snapshot };
}

function reasonOr(v: unknown, fallback: string): string {
  return typeof v === "string" && v !== "" ? v : fallback;
}

/**
 * Reads the outcome of one paid call (design §3.3). `settleResponse` wins over `paymentRequired`;
 * with neither, the call's result is unknown.
 */
export function classifyOutcome(ctx: PaymentResponseContext): Outcome {
  const settle = ctx.settleResponse;
  if (settle !== undefined) {
    const snapshot = snapshotFromExtra(settle.extra);
    if (settle.success === true) {
      const transaction = typeof settle.transaction === "string" ? settle.transaction : "";
      return withSnapshot({ kind: "paid" as const, transaction }, snapshot);
    }
    return withSnapshot(
      {
        kind: "refused" as const,
        code: reasonOr(settle.errorReason, "unexpected_settle_error"),
        via: "settle" as const,
      },
      snapshot,
    );
  }

  const required = ctx.paymentRequired;
  if (required !== undefined) {
    const want = ctx.requirements;
    const accepts: unknown = required.accepts;
    const ours = Array.isArray(accepts)
      ? accepts.find(
          (a) =>
            typeof a === "object" &&
            a !== null &&
            a.scheme === want.scheme &&
            a.network === want.network &&
            a.payTo === want.payTo,
        )
      : undefined;
    return withSnapshot(
      { kind: "refused" as const, code: reasonOr(required.error, "unknown"), via: "verify" as const },
      snapshotFromExtra(ours?.extra),
    );
  }

  return { kind: "ambiguous" };
}

/**
 * Maps a refusal code to what the client does about it (design §3.3, protocol.md §8). A final attempt never
 * waits and never pays inline, so every action but `reject_txid` and `fatal` collapses to `stop`. `canDeposit`
 * is false once `maxDeposits` is reached.
 */
export function actionFor(code: string, o: { isFinal: boolean; canDeposit: boolean }): Action {
  switch (code) {
    case REASON.depositNotToMerchant:
    case REASON.depositMemoMismatch:
    case REASON.depositTransparent:
    case REASON.depositOtherSession:
      return "reject_txid";

    case REASON.awaitingConfirmation:
      return o.isFinal ? "stop" : "wait_confirmation";

    case REASON.depositRequired:
      return o.isFinal || !o.canDeposit ? "stop" : "deposit";

    case REASON.depositDead:
      return o.isFinal || !o.canDeposit ? "stop" : "redeposit";

    case REASON.cumulativeMismatch:
      return o.isFinal ? "stop" : "resync";

    case REASON.depositNotFound:
      return o.isFinal ? "stop" : "check_deposit";

    case REASON.chainUnavailable:
    case REASON.unexpectedVerifyError:
    case REASON.unexpectedSettleError:
      return o.isFinal ? "stop" : "backoff";

    default:
      return "fatal";
  }
}
