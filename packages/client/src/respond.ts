import type { PaymentResponseContext } from "@x402/core/client";
import type { SettleResponse } from "@x402/core/types";
import { REASON, type SessionSnapshot, type Terms, type TxStatusSource } from "@z402/protocol";
import type { Clock } from "./clock.js";
import type { ClientEvent } from "./events.js";
import type { Mutex } from "./mutex.js";
import { actionFor, classifyOutcome, type Action, type Outcome } from "./outcome.js";
import type { Session } from "./session.js";
import { watchTx, type TxWatch, type WatchResult } from "./wait.js";

export type Recovery = void | { recovered: true };

/** One signed voucher whose outcome is not known yet */
export interface Attempt {
  readonly cumulative: bigint;
  readonly depositTxid: string | undefined;
  readonly sig: string;
  readonly release: () => void;
  cancelTimer: () => void;
}

export interface SessionState {
  readonly session: Session;
  readonly seed: Uint8Array;
  readonly mutex: Mutex;
  terms: Terms;
  price: bigint;
  attempt: Attempt | undefined;
  inflightDeposit: Promise<string> | undefined;
  readonly uncertain: Map<string, { nextCheckAt: number; watch: TxWatch }>;
  /** Set by a deposit rejection, after which the session never deposits or signs again */
  halted: { code: string; txid: string | undefined } | undefined;
}

/** What the response handlers need from the scheme */
export interface SchemeCore {
  readonly chain: TxStatusSource;
  readonly clock: Clock;
  readonly confirmationWaitMs: number;
  readonly pollIntervalMs: number;
  readonly facilitatorLagMs: number;
  emit(e: ClientEvent): void;
  canDeposit(state: SessionState): boolean;
  decision(state: SessionState): "inline" | "background" | "none";
  /** Joins any deposit in flight, and rejects after reporting a wallet failure */
  deposit(state: SessionState, inline: boolean): Promise<string>;
  /** Fire and forget, only while deposits are still allowed */
  background(state: SessionState): void;
  /** Runs `change` and reports each deposit it moved to acked or dead */
  tracked(state: SessionState, change: () => void): void;
}

/** Pause after seeing a not-found deposit ourselves, before the retry */
const NOT_FOUND_RECOVER_MS = 2_000;
const CHAIN_UNAVAILABLE_BACKOFF_MS = 5_000;
const UNEXPECTED_ERROR_BACKOFF_MS = 1_000;

const RECOVERING_ACTIONS: ReadonlySet<Action> = new Set([
  "wait_confirmation",
  "deposit",
  "redeposit",
  "check_deposit",
  "backoff",
]);

function recovered(): { recovered: true } {
  return { recovered: true };
}

function withSnapshot(snapshot: SessionSnapshot | undefined): { snapshot?: SessionSnapshot } {
  return snapshot === undefined ? {} : { snapshot };
}

/** Acts on one call's outcome (design §3.3) while the caller holds the lock */
export async function respond(
  core: SchemeCore,
  state: SessionState,
  attempt: Attempt,
  ctx: PaymentResponseContext,
  isFinal: boolean,
): Promise<Recovery> {
  const outcome = classifyOutcome(ctx);
  const settle = ctx.settleResponse;
  const { session } = state;

  if (outcome.kind === "ambiguous") {
    session.advanceAmbiguous(attempt.cumulative);
    core.emit({ type: "ambiguous", attemptedZat: attempt.cumulative.toString() });
    return undefined;
  }

  if (outcome.kind === "paid") {
    if (settle !== undefined) core.tracked(state, () => session.applySettle(settle, attempt.cumulative));
    core.emit({ type: "paid", cumulativeZat: session.cumulative.toString(), ...withSnapshot(outcome.snapshot) });
    if (core.decision(state) === "background") core.background(state);
    return undefined;
  }

  return refused(core, state, attempt, outcome, settle, isFinal);
}

async function refused(
  core: SchemeCore,
  state: SessionState,
  attempt: Attempt,
  outcome: Extract<Outcome, { kind: "refused" }>,
  settle: SettleResponse | undefined,
  isFinal: boolean,
): Promise<Recovery> {
  const { session } = state;
  const { code, snapshot } = outcome;
  // A failed settle still acks its transaction (protocol.md §7.3) before the snapshot resyncs
  core.tracked(state, () => {
    if (settle !== undefined) session.applySettle(settle, attempt.cumulative);
    if (snapshot !== undefined) session.applySnapshot(snapshot);
  });

  const action = actionFor(code, { isFinal, canDeposit: core.canDeposit(state) });
  const recovering = action === "resync" ? snapshot !== undefined : RECOVERING_ACTIONS.has(action);
  core.emit({ type: "refused", code, ...withSnapshot(snapshot), recovering });

  switch (action) {
    case "wait_confirmation":
      return waitForPending(core, state, attempt);
    case "deposit":
      return depositAndRecover(core, state, attempt);
    case "redeposit":
      markDead(core, state, attempt.depositTxid);
      return depositAndRecover(core, state, attempt);
    case "resync":
      return snapshot === undefined ? undefined : recovered();
    case "check_deposit":
      return checkPresented(core, state, attempt);
    case "backoff":
      await core.clock.sleep(
        code === REASON.chainUnavailable ? CHAIN_UNAVAILABLE_BACKOFF_MS : UNEXPECTED_ERROR_BACKOFF_MS,
      );
      return recovered();
    case "reject_txid": {
      const txid = attempt.depositTxid;
      if (txid !== undefined) core.tracked(state, () => session.markRejected(txid));
      // The wallet's next deposit would likely be rejected the same way, losing another window
      state.halted = { code, txid };
      core.emit({ type: "fatal", code, message: messageOf(settle, code) });
      return undefined;
    }
    case "fatal":
      core.emit({ type: "fatal", code, message: messageOf(settle, code) });
      return undefined;
    case "stop":
      if (code === REASON.depositDead) markDead(core, state, attempt.depositTxid);
      // The final attempt never pays inline but may start the deposit the next call needs
      if (isFinal && (code === REASON.depositDead || code === REASON.depositRequired) && needsDeposit(state, attempt)) {
        core.background(state);
      }
      return undefined;
  }
}

function messageOf(settle: SettleResponse | undefined, code: string): string {
  const message = settle?.errorMessage;
  return typeof message === "string" && message !== "" ? message : code;
}

function markDead(core: SchemeCore, state: SessionState, txid: string | undefined): void {
  if (txid !== undefined) core.tracked(state, () => state.session.markDead(txid));
}

/** False when a sent deposit exists that this attempt did not present, as paying again would pay twice */
function needsDeposit(state: SessionState, attempt: Attempt): boolean {
  const unacked = state.session.resendTxid();
  return unacked === undefined || unacked === attempt.depositTxid;
}

async function depositAndRecover(core: SchemeCore, state: SessionState, attempt: Attempt): Promise<Recovery> {
  if (!needsDeposit(state, attempt)) return recovered();
  try {
    await core.deposit(state, true);
  } catch {
    // Already reported as deposit_failed
    return undefined;
  }
  return recovered();
}

function watch(core: SchemeCore, txid: string, until: "mined" | "seen"): Promise<WatchResult> {
  return watchTx(core.chain, txid, {
    timeoutMs: core.confirmationWaitMs,
    pollMs: core.pollIntervalMs,
    clock: core.clock,
    until,
  });
}

async function redepositAfterDeath(
  core: SchemeCore,
  state: SessionState,
  attempt: Attempt,
  txid: string,
): Promise<Recovery> {
  markDead(core, state, txid);
  return core.canDeposit(state) ? depositAndRecover(core, state, attempt) : undefined;
}

/** On z402_awaiting_confirmation, wait for the pending deposit's block and never deposit (design §3.4) */
async function waitForPending(core: SchemeCore, state: SessionState, attempt: Attempt): Promise<Recovery> {
  const txid = state.session.pendingTxid() ?? attempt.depositTxid;
  if (txid === undefined) return undefined;
  core.emit({ type: "waiting", txid });
  const result = await watch(core, txid, "mined");
  switch (result.kind) {
    case "mined":
      core.emit({ type: "deposit_confirmed", txid, height: result.height });
      // The single retry must not reach the facilitator before it has seen the block
      await core.clock.sleep(core.facilitatorLagMs);
      return recovered();
    case "dead":
      return redepositAfterDeath(core, state, attempt, txid);
    default:
      return undefined;
  }
}

/** On z402_deposit_not_found, look for the presented tx ourselves and recover once it is seen */
async function checkPresented(core: SchemeCore, state: SessionState, attempt: Attempt): Promise<Recovery> {
  const txid = attempt.depositTxid ?? state.session.resendTxid();
  if (txid === undefined) return undefined;
  core.emit({ type: "waiting", txid });
  const result = await watch(core, txid, "seen");
  switch (result.kind) {
    case "mined":
    case "seen":
      await core.clock.sleep(NOT_FOUND_RECOVER_MS);
      return recovered();
    case "dead":
      return redepositAfterDeath(core, state, attempt, txid);
    default:
      return undefined;
  }
}
