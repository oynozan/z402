/**
 * The x402 facilitator scheme for prepaid-voucher (design §4.3 and §4.4, protocol.md v1.1).
 *
 * verify authenticates the voucher, waits at most for one lookup of a deposit the voucher needs and
 * one refresh of the session before refusing, and never writes payment state (its refresh may record
 * chain status). settle reads only what the resolver has cached and never awaits, so its decision and
 * its commit run with no other settle in between.
 * decide() is the single judge of a voucher, always against the state as it is when it runs.
 */
import type {
  Network,
  PaymentPayload,
  PaymentRequirements,
  SchemeNetworkFacilitator,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import {
  ASSET,
  checkVoucher,
  computeLimit,
  encodeTerms,
  isDepositDead,
  isValidPayTo,
  isZcashNetwork,
  parseTerms,
  parseVoucherPayload,
  ProtocolError,
  REASON,
  SCHEME,
  verifyVoucher,
  ZCASH_NETWORKS,
  type ReasonCode,
  type SessionSnapshot,
  type Terms,
  type VoucherPayload,
  type ZcashNetwork,
} from "@z402/protocol";
import { chainPosition, evaluateDeposit } from "./core/evaluate.js";
import { LedgerRefusal, type LedgerEvent } from "./core/ledger.js";
import type { DepositResolver, Lookup } from "./core/resolver.js";
import { buildSnapshot } from "./core/snapshot.js";
import type { FacilitatorState } from "./core/state.js";
import { asOfTip } from "./core/transitions.js";
import type { DepositRecord, Evaluation } from "./core/types.js";
import type { ChainWatcher } from "./core/watcher.js";
import { termsVersion } from "./termsVersion.js";

export interface SchemeConfig {
  network: ZcashNetwork;
  payTo: string;
  priceZat: bigint;
  terms: Terms;
  /** How long verify waits for the lookup of a deposit the voucher needs */
  depositWaitMs: number;
  /** How long verify waits for a refresh of the session before refusing, default 5000 (one RPC deadline, §10) */
  refreshWaitMs?: number;
}

export interface SchemeDeps {
  config: SchemeConfig;
  state: FacilitatorState;
  resolver: DepositResolver;
  watcher: ChainWatcher;
  /** Appends a batch to the ledger and applies it, throwing before any change when it refuses the batch */
  commit: (events: LedgerEvent[]) => void;
  /** Called once when a ledger write fails, since the file and the live state may disagree from then on */
  onFatal?: (err: unknown) => void;
  log?: (msg: string, err?: unknown) => void;
}

/** A voucher whose signature verified */
interface Voucher {
  sessionKey: string;
  /** The received string, the one the signature covers and the ledger records */
  cumulativeZat: string;
  cNew: bigint;
  depositTxid: string | undefined;
}

interface Refusal {
  code: ReasonCode;
  message: string;
  /** The real reason, for the operator's log only and never for the reply */
  note?: string;
}

/** What the payload's depositTxid means for this voucher */
type Presented =
  | { kind: "none" }
  | { kind: "credited" }
  | { kind: "refused"; refusal: Refusal; needsLookup: boolean }
  | { kind: "usable"; record: DepositRecord }
  | { kind: "in_flight" }
  | { kind: "unusable"; refusal: Refusal; retry: boolean; once?: boolean };

type Verdict =
  | {
      ok: true;
      events: LedgerEvent[];
      /** The reply acks the presented txid, credited before or by these events */
      acks: boolean;
      credits: boolean;
      amountZat: bigint;
      tip: number;
      snapshot: SessionSnapshot;
      lookAgain: boolean;
    }
  | { ok: false; refusal: Refusal; snapshot: SessionSnapshot; needsLookup: boolean; once: boolean; refresh: boolean };

type Accepted = Extract<Verdict, { ok: true }>;

type Authenticated = { ok: true; voucher: Voucher } | { ok: false; refusal: Refusal };

const FATAL_LOG = "ledger write failed — facilitator must restart";
const DEFAULT_REFRESH_WAIT_MS = 5000;
/** The API gives the facilitator 60 s, so no wait of verify may be longer */
const MAX_WAIT_MS = 60_000;
const UNEXPECTED_VERIFY: Refusal = { code: REASON.unexpectedVerifyError, message: "the facilitator failed to verify" };
const UNEXPECTED_SETTLE: Refusal = { code: REASON.unexpectedSettleError, message: "the facilitator failed to settle" };
const POISONED_VERIFY: Refusal = { code: REASON.unexpectedVerifyError, message: "the facilitator must restart" };
const POISONED_SETTLE: Refusal = { code: REASON.unexpectedSettleError, message: "the facilitator must restart" };
/** One answer for every found deposit a session cannot use, so none of them tells what the merchant's key sees */
const CANNOT_CREDIT: Refusal = { code: REASON.depositMemoMismatch, message: "the deposit cannot be credited" };
const DEAD: Refusal = { code: REASON.depositDead, message: "the deposit is dead" };

export class PrepaidVoucherFacilitatorScheme implements SchemeNetworkFacilitator {
  readonly scheme = SCHEME;
  readonly caipFamily = "zcash:*";

  readonly #config: Required<SchemeConfig>;
  readonly #state: FacilitatorState;
  readonly #resolver: DepositResolver;
  readonly #watcher: ChainWatcher;
  readonly #commit: (events: LedgerEvent[]) => void;
  readonly #onFatal: (err: unknown) => void;
  readonly #log: (msg: string, err?: unknown) => void;
  readonly #extra: Record<string, unknown>;
  /** Set by a failed ledger write, after which every call is refused until a restart replays the file */
  #poisoned = false;

  constructor(d: SchemeDeps) {
    this.#config = checkedConfig(d.config);
    this.#state = d.state;
    this.#resolver = d.resolver;
    this.#watcher = d.watcher;
    this.#commit = d.commit;
    this.#onFatal = d.onFatal ?? (() => undefined);
    this.#log = d.log ?? ((msg, err) => (err === undefined ? console.error(msg) : console.error(msg, err)));
    const { payTo, priceZat, terms } = this.#config;
    this.#extra = { ...encodeTerms(terms), termsVersion: termsVersion(payTo, priceZat, terms), payTo };
  }

  getExtra(_network: Network): Record<string, unknown> {
    return { ...this.#extra };
  }

  getSigners(_network: string): string[] {
    return [];
  }

  async verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse> {
    if (this.#poisoned) return verifyRefused(POISONED_VERIFY);
    try {
      const auth = this.#authenticate(payload, requirements);
      if (!auth.ok) return verifyRefused(auth.refusal);
      const v = auth.voucher;
      const verdict = await this.#prepare(v);
      if (this.#poisoned) return verifyRefused(POISONED_VERIFY);
      if (!verdict.ok) {
        this.#note(verdict.refusal);
        return verifyRefused(verdict.refusal, { payer: v.sessionKey, snapshot: verdict.snapshot });
      }
      if (verdict.lookAgain && v.depositTxid !== undefined) {
        this.#resolver.startBackground(v.depositTxid, this.#config.depositWaitMs);
      }
      return { isValid: true, payer: v.sessionKey, extra: { session: verdict.snapshot } };
    } catch (e) {
      this.#log("prepaid-voucher verify failed", e);
      return verifyRefused(UNEXPECTED_VERIFY);
    }
  }

  async settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> {
    const network = networkOf(requirements, this.#config.network);
    if (this.#poisoned) return settleRefused(POISONED_SETTLE, network);
    let committed: { v: Voucher; verdict: Accepted };
    try {
      const auth = this.#authenticate(payload, requirements);
      if (!auth.ok) return settleRefused(auth.refusal, network);
      const v = auth.voucher;
      // Nothing in settle awaits, so no other settle can commit between this decision and the write
      const verdict = this.#decide(v);
      if (!verdict.ok) {
        this.#note(verdict.refusal);
        return settleRefused(verdict.refusal, network, { payer: v.sessionKey, snapshot: verdict.snapshot });
      }
      try {
        this.#commit(verdict.events);
      } catch (e) {
        // A refused batch wrote nothing, so only a failed write puts the file in doubt
        if (e instanceof LedgerRefusal) {
          this.#log("settle batch refused", e);
          return settleRefused(UNEXPECTED_SETTLE, network);
        }
        return this.#fatal(e, network);
      }
      committed = { v, verdict };
    } catch (e) {
      this.#log("prepaid-voucher settle failed", e);
      return settleRefused(UNEXPECTED_SETTLE, network);
    }
    return this.#settled(committed.v, committed.verdict, network);
  }

  /** The reply to a committed settle, still a success when its snapshot cannot be built, since the charge is written */
  #settled(v: Voucher, verdict: Accepted, network: Network): SettleResponse {
    const reply: SettleResponse = {
      success: true,
      transaction: verdict.acks ? (v.depositTxid ?? "") : "",
      network,
      payer: v.sessionKey,
      amount: verdict.amountZat.toString(),
    };
    try {
      if (verdict.credits && v.depositTxid !== undefined) this.#resolver.forget(v.depositTxid);
      const deposits = this.#state.depositsOf(v.sessionKey).map((d) => asOfTip(d, verdict.tip));
      return { ...reply, extra: { session: this.#snapshot(v.sessionKey, v.cNew, deposits, verdict.tip) } };
    } catch (e) {
      this.#log("prepaid-voucher settle committed, but its snapshot failed", e);
      return reply;
    }
  }

  /** Verify's only waits, the lookup of a deposit the voucher needs and one refresh before refusing */
  async #prepare(v: Voucher): Promise<Verdict> {
    let verdict = this.#decide(v);
    let lookup: Lookup | undefined;
    let earlier: Lookup | undefined;
    if (!verdict.ok && verdict.needsLookup && v.depositTxid !== undefined) {
      earlier = this.#resolver.peek(v.depositTxid);
      // One read settles whether a deposit seen alive before its expiry was mined, so it gets no waiting budget
      lookup = await this.#resolver.lookup(v.depositTxid, verdict.once ? 0 : this.#config.depositWaitMs);
      verdict = this.#decide(v, lookup, earlier);
    }
    if (!verdict.ok && verdict.refresh) {
      await this.#refreshed(v.sessionKey);
      verdict = this.#decide(v, lookup, earlier);
    }
    return verdict;
  }

  /** One refresh of the session, given up on after refreshWaitMs since it can queue behind a whole watcher pass */
  async #refreshed(sessionKey: string): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const given = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.#config.refreshWaitMs);
    });
    try {
      // refreshSession never rejects, so the race ends with whichever comes first
      await Promise.race([this.#watcher.refreshSession(sessionKey), given]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Every check up to the signature, after which the caller is known and may see its session */
  #authenticate(payload: PaymentPayload, requirements: PaymentRequirements): Authenticated {
    const refuse = (code: ReasonCode, message: string): Authenticated => ({ ok: false, refusal: { code, message } });
    if (!this.#matches(requirements)) {
      return refuse(REASON.invalidPaymentRequirements, "the requirements differ from this facilitator's configuration");
    }
    if (!isRecord(payload)) return refuse(REASON.invalidPayload, "the payment payload is not an object");
    if (payload.x402Version !== 2) return refuse(REASON.invalidX402Version, "x402Version must be 2");
    const accepted: unknown = payload.accepted;
    if (!isRecord(accepted)) return refuse(REASON.invalidPayload, "accepted is not an object");
    if (accepted.scheme !== requirements.scheme) return refuse(REASON.invalidScheme, "accepted.scheme differs");
    if (accepted.network !== requirements.network) return refuse(REASON.invalidNetwork, "accepted.network differs");

    let p: VoucherPayload;
    try {
      p = parseVoucherPayload(payload.payload);
    } catch (e) {
      if (e instanceof ProtocolError) return refuse(REASON.invalidPayload, e.message);
      throw e;
    }
    const { network, payTo } = this.#config;
    if (!verifyVoucher(p, { scheme: SCHEME, network, payTo })) {
      return refuse(REASON.invalidSignature, "the voucher signature does not verify");
    }
    const { sessionKey, cumulativeZat, depositTxid } = p;
    return { ok: true, voucher: { sessionKey, cumulativeZat, cNew: BigInt(cumulativeZat), depositTxid } };
  }

  #matches(r: PaymentRequirements): boolean {
    const c = this.#config;
    if (!isRecord(r) || r.scheme !== SCHEME || r.network !== c.network || r.asset !== ASSET) return false;
    if (r.payTo !== c.payTo || r.amount !== c.priceZat.toString()) return false;
    try {
      return sameTerms(parseTerms(r.extra), c.terms);
    } catch {
      return false;
    }
  }

  /** Judges the voucher on the current state, reading the presented deposit from `fresh` or else the cache */
  #decide(v: Voucher, fresh?: Lookup, earlier?: Lookup): Verdict {
    const { priceZat, terms } = this.#config;
    const cLast = this.#state.session(v.sessionKey)?.cLast ?? 0n;
    const known = v.depositTxid === undefined ? undefined : (fresh ?? this.#resolver.peek(v.depositTxid));
    // The newest tip any read has seen, so an older lookup cannot keep a deposit alive past its expiry
    const tip = Math.max(this.#watcher.lastTip() ?? 0, known?.kind === "found" ? known.tip : 0);
    // A pending deposit whose lookups keep failing stops counting at its expiry, and only the watcher records it
    const credited = this.#state.depositsOf(v.sessionKey).map((d) => asOfTip(d, tip));
    const presented = this.#presented(v, known, tip, earlier);
    const deposits = presented.kind === "usable" ? [...credited, presented.record] : credited;
    // Projected as if the presented deposit were credited, which the client never takes for an ack
    const snapshot = this.#snapshot(v.sessionKey, cLast, deposits, tip);
    const limit = computeLimit(deposits, terms).limitZat;

    const check = checkVoucher({ cLast, cNew: v.cNew, price: priceZat, limit });
    if (check === "cumulative_mismatch") {
      const message = `cumulativeZat must be at least ${cLast + priceZat}`;
      return refused({ code: REASON.cumulativeMismatch, message }, snapshot);
    }
    if (presented.kind === "refused") {
      return refused(presented.refusal, snapshot, { needsLookup: presented.needsLookup, once: false, refresh: false });
    }
    if (check === "ok") {
      const events: LedgerEvent[] = presented.kind === "usable" ? [depositEvent(presented.record)] : [];
      events.push({ t: "voucher", sessionKey: v.sessionKey, cumulativeZat: v.cumulativeZat });
      return {
        ok: true,
        events,
        acks: presented.kind === "credited" || presented.kind === "usable",
        credits: presented.kind === "usable",
        amountZat: v.cNew - cLast,
        tip,
        snapshot,
        lookAgain: presented.kind === "in_flight" || (presented.kind === "unusable" && presented.retry),
      };
    }

    // Deposits only raise the limit, so a new presented deposit was needed and did not suffice
    const isNew = presented.kind === "usable" || presented.kind === "in_flight" || presented.kind === "unusable";
    const live =
      presented.kind === "usable" || presented.kind === "in_flight" || credited.some((d) => d.status === "pending");
    // A failure the chain has answered for good is not looked up again
    const definitive = presented.kind === "unusable" && !presented.retry;
    // A refresh reads only credited deposits, so only a credited pending one can raise the limit after it
    const next = {
      needsLookup: isNew && !definitive,
      once: presented.kind === "unusable" && presented.once === true,
      refresh: credited.some((d) => d.status === "pending"),
    };
    if (presented.kind === "unusable") return refused(presented.refusal, snapshot, next);
    const over = `cumulativeZat ${v.cNew} is over the limit ${limit}`;
    return live
      ? refused({ code: REASON.awaitingConfirmation, message: `${over} until a deposit confirms` }, snapshot, next)
      : refused({ code: REASON.depositRequired, message: `${over} with nothing pending` }, snapshot, next);
  }

  /** `earlier` is what the cache held before verify's fresh read, which tells a lost deposit's expiry */
  #presented(v: Voucher, known: Lookup | undefined, tip: number, earlier?: Lookup): Presented {
    const txid = v.depositTxid;
    if (txid === undefined) return { kind: "none" };
    const record = this.#state.deposit(txid);
    // Credited elsewhere, it is answered from the same read an uncredited txid would be, so nothing tells them apart
    const elsewhere = record !== undefined && record.sessionKey !== v.sessionKey;
    if (record !== undefined && !elsewhere) {
      if (asOfTip(record, tip).status !== "dead") return { kind: "credited" };
      return { kind: "refused", refusal: DEAD, needsLookup: false };
    }

    if (known?.kind === "found" && elsewhere) {
      const refusal = { ...CANNOT_CREDIT, note: `the presented deposit ${txid} is credited to another session` };
      return { kind: "refused", refusal, needsLookup: false };
    }
    if (known?.kind === "found") {
      const e = evaluateDeposit(known.inspection, v.sessionKey, this.#config.terms, tip, known.tip);
      // Only a newer tip says it died, and it may have been mined since it was read, so it is read again first
      if (!e.ok && e.code === REASON.depositDead && chainPosition(known.inspection, known.tip).status !== "dead") {
        return unusable(REASON.chainUnavailable, "the deposit has not been read since its expiry", true, true);
      }
      if (!e.ok) return unusable(e.code, CANNOT_CREDIT.message, false);
      return { kind: "usable", record: creditedRecord(txid, v.sessionKey, e, known.tip) };
    }
    if (this.#resolver.inFlight(txid)) return { kind: "in_flight" };
    if (known?.kind === "not_found") {
      // Gone once the tip passed the expiry an earlier read saw, as the watcher would call it
      if (expiredUnmined(earlier, tip)) return unusable(REASON.depositDead, CANNOT_CREDIT.message, false);
      return unusable(REASON.depositNotFound, "the chain has no such tx", true);
    }
    // A lookup that rejected unexpectedly or aged out leaves no result, which is as retryable as an outage
    return unusable(REASON.chainUnavailable, known === undefined ? "not looked up" : "the chain is unreadable", true);
  }

  #note(r: Refusal): void {
    if (r.note !== undefined) this.#log(r.note);
  }

  #snapshot(sessionKey: string, cumulativeZat: bigint, deposits: DepositRecord[], tip: number): SessionSnapshot {
    return buildSnapshot({ sessionKey, cumulativeZat, deposits, terms: this.#config.terms, tip });
  }

  /** A failed write may have left part of the batch in the file, so nothing is trusted until a restart */
  #fatal(err: unknown, network: Network): SettleResponse {
    this.#poisoned = true;
    this.#log(FATAL_LOG);
    this.#onFatal(err);
    return settleRefused(POISONED_SETTLE, network);
  }
}

function refused(
  refusal: Refusal,
  snapshot: SessionSnapshot,
  next: { needsLookup: boolean; once: boolean; refresh: boolean } = { needsLookup: false, once: false, refresh: false },
): Verdict {
  return { ok: false, refusal, snapshot, ...next };
}

/** Payer and snapshot appear only once the signature verified (protocol.md §7.1) */
function verifyRefused(r: Refusal, session?: { payer: string; snapshot: SessionSnapshot }): VerifyResponse {
  const known = session === undefined ? {} : { payer: session.payer, extra: { session: session.snapshot } };
  return { isValid: false, invalidReason: r.code, invalidMessage: r.message, ...known };
}

function settleRefused(
  r: Refusal,
  network: Network,
  session?: { payer: string; snapshot: SessionSnapshot },
): SettleResponse {
  const known = session === undefined ? {} : { payer: session.payer, extra: { session: session.snapshot } };
  return { success: false, errorReason: r.code, errorMessage: r.message, transaction: "", network, ...known };
}

/** True when the lookup saw the deposit unmined and the tip has since reached its expiry */
function expiredUnmined(seen: Lookup | undefined, tip: number): boolean {
  if (seen?.kind !== "found" || seen.inspection.location === "mined") return false;
  return isDepositDead({ minedHeight: null, expiryHeight: seen.inspection.expiryHeight, tip });
}

/** `once` asks verify for a single fresh read, with no waiting budget */
function unusable(code: ReasonCode, message: string, retry: boolean, once = false): Presented {
  return { kind: "unusable", refusal: { code, message }, retry, once };
}

/** The record a deposit is credited with, its status as the lookup that found it saw it */
function creditedRecord(
  txid: string,
  sessionKey: string,
  e: Extract<Evaluation, { ok: true }>,
  firstSeenTip: number,
): DepositRecord {
  return {
    txid,
    sessionKey,
    valueZat: e.valueZat,
    zeroConf: e.zeroConf,
    expiryHeight: e.expiryHeight,
    firstSeenTip,
    status: e.status,
    minedHeight: e.minedHeight,
    confirmations: e.confirmations,
    notFound: null,
    deadAtTip: null,
  };
}

function depositEvent(d: DepositRecord): LedgerEvent {
  return {
    t: "deposit",
    txid: d.txid,
    sessionKey: d.sessionKey,
    valueZat: d.valueZat.toString(),
    zeroConf: d.zeroConf,
    expiryHeight: d.expiryHeight,
    firstSeenTip: d.firstSeenTip,
    status: d.status,
    minedHeight: d.minedHeight,
    confirmations: d.confirmations,
  };
}

function sameTerms(a: Terms, b: Terms): boolean {
  return (
    a.windowZat === b.windowZat &&
    a.creditRatioBps === b.creditRatioBps &&
    a.creditCapZat === b.creditCapZat &&
    a.zeroConfMinExpiryBlocks === b.zeroConfMinExpiryBlocks
  );
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function networkOf(requirements: unknown, fallback: Network): Network {
  const network = isRecord(requirements) ? requirements.network : undefined;
  return typeof network === "string" ? (network as Network) : fallback;
}

/** Refuses a configuration under which the scheme would misjudge every voucher, naming the field */
function checkedConfig(c: SchemeConfig): Required<SchemeConfig> {
  if (!isZcashNetwork(c.network)) throw new Error(`network: expected one of ${ZCASH_NETWORKS.join(", ")}`);
  if (!isValidPayTo(c.payTo, c.network)) throw new Error(`payTo: not a shielded-only unified address for ${c.network}`);
  // A price of 0 would let a replayed voucher pass the increment check
  if (typeof c.priceZat !== "bigint" || c.priceZat < 1n) throw new Error("priceZat: must be at least 1 zat");
  try {
    parseTerms(encodeTerms(c.terms));
  } catch (e) {
    throw new Error(`terms: ${e instanceof Error ? e.message : String(e)}`);
  }
  waitOf("depositWaitMs", c.depositWaitMs);
  if (c.refreshWaitMs !== undefined) waitOf("refreshWaitMs", c.refreshWaitMs);
  return { ...c, terms: { ...c.terms }, refreshWaitMs: c.refreshWaitMs ?? DEFAULT_REFRESH_WAIT_MS };
}

function waitOf(name: string, ms: number): void {
  if (!Number.isInteger(ms) || ms < 0 || ms > MAX_WAIT_MS) {
    throw new Error(`${name}: expected a whole number from 0 to ${MAX_WAIT_MS}`);
  }
}
