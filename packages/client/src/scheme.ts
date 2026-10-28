/**
 * PrepaidVoucherScheme, the x402 SchemeNetworkClient for prepaid-voucher (design §3).
 * createPaymentPayload validates the 402 entry, takes the session lock, deposits inline or in the
 * background, and signs one cumulative voucher. schemeHooks.onPaymentResponse reads the outcome, acts on
 * it through respond.ts, and releases the lock. A safety timer releases it when the hook never fires.
 */
import type { PaymentResponseContext } from "@x402/core/client";
import type {
  DefaultAsset,
  Network,
  PaymentPayloadContext,
  PaymentPayloadResult,
  PaymentRequirements,
  SchemeNetworkClient,
} from "@x402/core/types";
import {
  ASSET,
  depositMemo,
  generateSeed,
  isValidPayTo,
  isZcashNetwork,
  parseTerms,
  parseZat,
  SCHEME,
  signVoucher,
  ZEC_DECIMALS,
  type SessionSnapshot,
  type Terms,
  type TxStatusSource,
  type ZcashWallet,
} from "@z402-net/protocol";
import { systemClock, type Clock } from "./clock.js";
import { DepositStatusUnknownError, DepositUncertainError } from "./errors.js";
import type { ClientEvent } from "./events.js";
import { Mutex } from "./mutex.js";
import { respond, type Attempt, type Recovery, type SchemeCore, type SessionState } from "./respond.js";
import { Session, type LocalDeposit } from "./session.js";
import { TxWatch, type Observation } from "./wait.js";

export interface PrepaidVoucherSchemeOptions {
  wallet: ZcashWallet;
  chain: TxStatusSource;
  /** Default Infinity, the demo's `--cheat` sets 1 */
  maxDeposits?: number;
  /** Background deposit when headroom is below this, default `terms.windowZat` */
  depositTriggerZat?: bigint;
  /** Refuse a 402 whose `windowZat` is larger, default 1_000_000n */
  maxDepositZat?: bigint;
  /** How long the hook waits on `z402_awaiting_confirmation`, default 600_000 */
  confirmationWaitMs?: number;
  /** Own chain polling interval, default 2_000 */
  pollIntervalMs?: number;
  /** Pause after seeing the deposit mined, before recovering, default 6_000 */
  facilitatorLagMs?: number;
  /** Lock release when the hook never fires, default 120_000 */
  safetyReleaseMs?: number;
  onEvent?: (e: ClientEvent) => void;
  /** Tests only, a fixed 32-byte session seed */
  seed?: Uint8Array;
  /** Tests only */
  clock?: Clock;
}

/** A read-only copy of one session's state, for logs and tests */
export interface SessionView {
  readonly network: string;
  readonly payTo: string;
  readonly sessionKey: string;
  readonly cumulativeZat: bigint;
  readonly snapshot: SessionSnapshot | undefined;
  readonly deposits: readonly Readonly<LocalDeposit>[];
  readonly nextIndex: number;
  readonly depositsMade: number;
  /** Why the session refuses every payment from now on, undefined while it can still pay */
  readonly halted: { readonly code: string; readonly txid: string | undefined } | undefined;
}

/** Minimum gap between checks of one uncertain txid, counted from when the wallet reported it */
const UNCERTAIN_RECHECK_MS = 10_000;
const DEPOSIT_STATUS_UNKNOWN = "deposit_status_unknown";
const ZAT_AMOUNT_RE = /^(0|[1-9][0-9]*)$/;

function asError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
}

function nonNegative(name: string, value: number): number {
  if (!(value >= 0)) throw new RangeError(`${name} must be a non-negative number, got ${value}`);
  return value;
}

function haltedError(halt: { code: string; txid: string | undefined }): Error {
  return new Error(`session halted by ${halt.code} on deposit ${halt.txid ?? "(none presented)"}`);
}

function viewOf({ session, halted }: SessionState): SessionView {
  return {
    network: session.network,
    payTo: session.payTo,
    sessionKey: session.sessionKey,
    cumulativeZat: session.cumulative,
    snapshot: session.snapshot === undefined ? undefined : structuredClone(session.snapshot),
    deposits: session.deposits.map((d) => ({ ...d })),
    nextIndex: session.nextIndex,
    depositsMade: session.depositsMade,
    halted: halted === undefined ? undefined : { ...halted },
  };
}

/** Parses one field and prefixes any failure with the field's name */
function field<T>(name: string, parse: () => T): T {
  try {
    return parse();
  } catch (e) {
    throw new Error(`${name}: ${asError(e).message}`);
  }
}

export class PrepaidVoucherScheme implements SchemeNetworkClient {
  readonly scheme = SCHEME;
  readonly schemeHooks: { onPaymentResponse(ctx: PaymentResponseContext): Promise<Recovery> };

  readonly #wallet: ZcashWallet;
  readonly #seed: Uint8Array | undefined;
  readonly #maxDepositZat: bigint;
  readonly #safetyReleaseMs: number;
  readonly #core: SchemeCore;
  readonly #states = new Map<string, SessionState>();
  /** Requirements objects that already got their one recovery retry (design §3.3) */
  readonly #recovered = new WeakSet<PaymentRequirements>();

  constructor(opts: PrepaidVoucherSchemeOptions) {
    if (opts.seed !== undefined && opts.seed.length !== 32) throw new RangeError("seed must be 32 bytes");
    if (!(opts.pollIntervalMs === undefined || opts.pollIntervalMs > 0)) {
      throw new RangeError(`pollIntervalMs must be positive, got ${opts.pollIntervalMs}`);
    }
    this.#wallet = opts.wallet;
    this.#seed = opts.seed;
    this.#maxDepositZat = opts.maxDepositZat ?? 1_000_000n;
    this.#safetyReleaseMs = nonNegative("safetyReleaseMs", opts.safetyReleaseMs ?? 120_000);
    const maxDeposits = nonNegative("maxDeposits", opts.maxDeposits ?? Number.POSITIVE_INFINITY);
    const onEvent = opts.onEvent;

    const core: SchemeCore = {
      chain: opts.chain,
      clock: opts.clock ?? systemClock,
      confirmationWaitMs: nonNegative("confirmationWaitMs", opts.confirmationWaitMs ?? 600_000),
      pollIntervalMs: opts.pollIntervalMs ?? 2_000,
      facilitatorLagMs: nonNegative("facilitatorLagMs", opts.facilitatorLagMs ?? 6_000),
      emit: (e) => {
        try {
          onEvent?.(e);
        } catch {
          // A logging callback must never break a payment
        }
      },
      canDeposit: (state) => state.halted === undefined && state.session.depositsMade < maxDeposits,
      decision: (state) =>
        state.session.depositDecision(
          state.price,
          opts.depositTriggerZat ?? state.terms.windowZat,
          core.canDeposit(state),
        ),
      deposit: (state, inline) => this.#deposit(state, inline),
      background: (state) => {
        if (core.canDeposit(state)) this.#deposit(state, false).catch(() => {});
      },
      tracked: (state, change) => {
        const { session } = state;
        const before = session.deposits.map((d) => d.state);
        change();
        session.deposits.forEach((d, i) => {
          if (d.txid === undefined || d.state === before[i]) return;
          if (d.state === "acked") core.emit({ type: "deposit_acked", txid: d.txid });
          else if (d.state === "dead") core.emit({ type: "deposit_dead", txid: d.txid });
        });
        const snapshot = session.snapshot;
        if (snapshot === undefined) return;
        for (const confirmed of session.newlyConfirmed(snapshot)) {
          core.emit({ type: "deposit_confirmed", ...confirmed, snapshot });
        }
      },
    };
    this.#core = core;
    this.schemeHooks = { onPaymentResponse: (ctx) => this.#onPaymentResponse(ctx) };
  }

  /** Lets the stock client's spend controls price ZEC (protocol.md §9.1) */
  findDefaultAsset(asset: string, network: Network): DefaultAsset | undefined {
    return asset === ASSET && isZcashNetwork(network)
      ? { asset: ASSET, decimals: ZEC_DECIMALS, symbol: ASSET }
      : undefined;
  }

  async createPaymentPayload(
    x402Version: number,
    req: PaymentRequirements,
    ctx?: PaymentPayloadContext,
  ): Promise<PaymentPayloadResult> {
    const { price, terms } = this.#validate(req, ctx);
    const state = this.#stateFor(req, terms, price);
    if (state.halted !== undefined) throw haltedError(state.halted);
    const release = await state.mutex.acquire();
    try {
      // A call queued on the lock may have waited through the hook that halted the session
      if (state.halted !== undefined) throw haltedError(state.halted);
      state.terms = terms;
      state.price = price;
      await this.#recheckUncertain(state);
      const decision = this.#core.decision(state);
      if (decision === "inline") await this.#deposit(state, true);
      else if (decision === "background") this.#core.background(state);
      return this.#sign(x402Version, state, release);
    } catch (e) {
      release();
      throw e;
    }
  }

  session(payTo: string, network?: string): SessionView | undefined {
    for (const state of this.#states.values()) {
      const { session } = state;
      if (session.payTo !== payTo || (network !== undefined && session.network !== network)) continue;
      return viewOf(state);
    }
    return undefined;
  }

  /** Every session, one per payee, in the order they started */
  sessions(): SessionView[] {
    return [...this.#states.values()].map(viewOf);
  }

  /** Cancels safety timers, lets in-flight deposits finish, then closes the wallet */
  async close(): Promise<void> {
    const inflight: Promise<string>[] = [];
    for (const state of this.#states.values()) {
      state.attempt?.cancelTimer();
      if (state.inflightDeposit !== undefined) inflight.push(state.inflightDeposit);
    }
    await Promise.allSettled(inflight);
    await this.#wallet.close?.();
  }

  /** Design §3.2 step 1, run before any lock or wallet use, and every message names its field */
  #validate(req: PaymentRequirements, ctx: PaymentPayloadContext | undefined): { price: bigint; terms: Terms } {
    if (req.scheme !== SCHEME) throw new Error(`scheme: expected "${SCHEME}", got ${JSON.stringify(req.scheme)}`);
    if (!isZcashNetwork(req.network)) throw new Error(`network: ${JSON.stringify(req.network)} is not a Zcash network`);
    if (req.asset !== ASSET) throw new Error(`asset: expected "${ASSET}", got ${JSON.stringify(req.asset)}`);
    if (!isValidPayTo(req.payTo, req.network)) {
      throw new Error(`payTo: not a shielded unified address for ${req.network}`);
    }
    const price = field("amount", () => parseZat(req.amount));
    if (price < 1n) throw new Error("amount: the price must be at least 1 zat");
    const terms = field("extra", () => parseTerms(req.extra));
    if (price > terms.windowZat) throw new Error(`amount: ${price} exceeds windowZat ${terms.windowZat}`);
    if (terms.windowZat > this.#maxDepositZat) {
      throw new Error(`windowZat: ${terms.windowZat} exceeds maxDepositZat ${this.#maxDepositZat}`);
    }
    const cap = ctx?.maxAmountPerPayment;
    if (cap !== undefined) {
      if (typeof cap !== "string" || !ZAT_AMOUNT_RE.test(cap)) {
        throw new Error(`maxAmountPerPayment: ${JSON.stringify(cap)} is not an integer zat amount`);
      }
      if (terms.windowZat > BigInt(cap)) {
        throw new Error(`windowZat: ${terms.windowZat} exceeds maxAmountPerPayment ${cap}`);
      }
    }
    return { price, terms };
  }

  #stateFor(req: PaymentRequirements, terms: Terms, price: bigint): SessionState {
    const key = `${req.network}|${req.payTo}`;
    let state = this.#states.get(key);
    if (state === undefined) {
      const seed = this.#seed ?? generateSeed();
      const session = new Session({ payTo: req.payTo, network: req.network, seed });
      state = {
        session,
        seed,
        mutex: new Mutex(),
        terms,
        price,
        attempt: undefined,
        inflightDeposit: undefined,
        uncertain: new Map(),
        halted: undefined,
      };
      this.#states.set(key, state);
      this.#core.emit({ type: "session", network: req.network, payTo: req.payTo, sessionKey: session.sessionKey });
    }
    return state;
  }

  /** Design §3.2 steps 4 and 5 */
  #sign(x402Version: number, state: SessionState, release: () => void): PaymentPayloadResult {
    const { session } = state;
    const cumulative = session.cumulative + state.price;
    const cumulativeZat = cumulative.toString();
    const depositTxid = session.resendTxid();
    const sig = signVoucher(state.seed, {
      scheme: SCHEME,
      network: session.network,
      payTo: session.payTo,
      sessionKey: session.sessionKey,
      cumulativeZat,
    });
    const attempt: Attempt = { cumulative, depositTxid, sig, release, cancelTimer: () => {} };
    // Armed here, not at lock time, because an inline deposit may outlast safetyReleaseMs
    attempt.cancelTimer = this.#core.clock.setTimer(this.#safetyReleaseMs, () => this.#safetyRelease(state, attempt));
    state.attempt = attempt;

    const withTxid = depositTxid === undefined ? {} : { depositTxid };
    this.#core.emit({ type: "voucher", cumulativeZat, ...withTxid });
    return { x402Version, payload: { sessionKey: session.sessionKey, cumulativeZat, sig, ...withTxid } };
  }

  /** The hook never fired, which counts as an ambiguous outcome (protocol.md §9.3) */
  #safetyRelease(state: SessionState, attempt: Attempt): void {
    if (state.attempt !== attempt) return;
    state.attempt = undefined;
    state.session.advanceAmbiguous(attempt.cumulative);
    this.#core.emit({ type: "ambiguous", attemptedZat: attempt.cumulative.toString() });
    attempt.release();
  }

  async #onPaymentResponse(ctx: PaymentResponseContext): Promise<Recovery> {
    const state = this.#states.get(`${ctx.requirements.network}|${ctx.requirements.payTo}`);
    const attempt = state?.attempt;
    // A hook for an attempt the safety release gave up on must not touch the next holder's lock
    if (state === undefined || attempt === undefined || ctx.paymentPayload.payload["sig"] !== attempt.sig) {
      return undefined;
    }
    state.attempt = undefined;
    attempt.cancelTimer();
    try {
      const isFinal = this.#recovered.has(ctx.requirements);
      const result = await respond(this.#core, state, attempt, ctx, isFinal);
      if (result !== undefined) this.#recovered.add(ctx.requirements);
      return result;
    } catch (e) {
      // Never throw out of the hook, so the app still gets the merchant's response
      this.#core.emit({ type: "fatal", code: "client_error", message: asError(e).message });
      return undefined;
    } finally {
      attempt.release();
    }
  }

  /** One wallet send per session at a time, shared by inline and background triggers */
  #deposit(state: SessionState, inline: boolean): Promise<string> {
    if (state.inflightDeposit !== undefined) return state.inflightDeposit;
    if (state.halted !== undefined) return Promise.reject(haltedError(state.halted));
    const send = this.#sendDeposit(state, inline);
    state.inflightDeposit = send;
    const clear = (): void => {
      if (state.inflightDeposit === send) state.inflightDeposit = undefined;
    };
    send.then(clear, clear);
    return send;
  }

  /** Design §3.5, where a `DepositUncertainError` leaves the deposit uncertain and uncounted */
  async #sendDeposit(state: SessionState, inline: boolean): Promise<string> {
    const { session } = state;
    const { clock, emit } = this.#core;
    const index = session.nextIndex++;
    const memo = depositMemo(session.sessionKey, index);
    const local: LocalDeposit = { index, memo, state: "sending" };
    session.deposits.push(local);
    emit({ type: "deposit_started", index, inline });
    const started = clock.now();
    try {
      const { txid } = await this.#wallet.sendDeposit({ to: session.payTo, amountZat: state.terms.windowZat, memo });
      local.txid = txid;
      local.state = "sent";
      session.depositsMade += 1;
      emit({ type: "deposit_broadcast", index, txid, ms: clock.now() - started });
      return txid;
    } catch (e) {
      const error = asError(e);
      if (error instanceof DepositUncertainError) {
        local.txid = error.txid;
        local.state = "uncertain";
        state.uncertain.set(error.txid, {
          nextCheckAt: clock.now() + UNCERTAIN_RECHECK_MS,
          watch: new TxWatch(this.#core.chain, error.txid, clock),
        });
      } else if (error instanceof DepositStatusUnknownError) {
        // It may be on the chain with no txid to watch, so another deposit could pay twice
        local.state = "uncertain";
        state.halted = { code: DEPOSIT_STATUS_UNKNOWN, txid: "(unknown)" };
      } else {
        local.state = "failed";
      }
      emit({ type: "deposit_failed", index, error });
      if (error instanceof DepositStatusUnknownError) {
        emit({ type: "fatal", code: DEPOSIT_STATUS_UNKNOWN, message: error.message });
      }
      throw error;
    }
  }

  /** Promotes an uncertain deposit that reached the chain to sent, or marks it dead (design §4) */
  async #recheckUncertain(state: SessionState): Promise<void> {
    const now = this.#core.clock.now();
    for (const local of state.session.deposits) {
      if (local.state !== "uncertain" || local.txid === undefined) continue;
      const check = state.uncertain.get(local.txid);
      if (check === undefined || now < check.nextCheckAt) continue;
      check.nextCheckAt = now + UNCERTAIN_RECHECK_MS;
      let seen: Observation | undefined;
      try {
        seen = await check.watch.observe();
      } catch {
        // A broken status source must not fail the payment
        continue;
      }
      if (seen === undefined) continue;
      state.uncertain.delete(local.txid);
      if (seen.kind === "dead") {
        this.#core.tracked(state, () => {
          local.state = "dead";
        });
      } else {
        local.state = "sent";
        state.session.depositsMade += 1;
      }
    }
  }
}
