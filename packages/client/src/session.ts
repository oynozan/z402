import type { SettleResponse } from "@x402/core/types";
import { publicKeyFromSeed, type SessionSnapshot } from "@z402-net/protocol";
import { snapshotFromExtra } from "./outcome.js";

export interface LocalDeposit {
  index: number;
  memo: string;
  txid?: string;
  state: "sending" | "sent" | "acked" | "dead" | "rejected" | "failed" | "uncertain";
}

/** States that mean a deposit exists or may exist, so the first call must not make another one. */
const LIVE_STATES: ReadonlySet<LocalDeposit["state"]> = new Set(["sending", "sent", "acked", "uncertain"]);

/** No snapshot or settle ack ever moves a deposit out of these */
const TERMINAL_STATES: ReadonlySet<LocalDeposit["state"]> = new Set(["dead", "rejected"]);

/** One of our deposits a snapshot lists as confirmed or final, without a height as the snapshot cannot pin one */
export interface ConfirmedDeposit {
  index: number;
  txid: string;
}

/** What the client knows about one `payTo` + network session. Pure state: no I/O, no timers. */
export class Session {
  readonly payTo: string;
  readonly network: string;
  readonly sessionKey: string;
  cumulative = 0n;
  snapshot?: SessionSnapshot;
  readonly deposits: LocalDeposit[] = [];
  nextIndex = 1;
  depositsMade = 0;
  /** Txids already reported confirmed, so each is reported once */
  private readonly confirmedTxids = new Set<string>();

  constructor(i: { payTo: string; network: string; seed: Uint8Array }) {
    this.payTo = i.payTo;
    this.network = i.network;
    this.sessionKey = publicKeyFromSeed(i.seed);
  }

  /** A snapshot pending entry not locally dead or rejected, or a local `sent` deposit */
  hasPending(): boolean {
    return this.pendingTxid() !== undefined;
  }

  /** The deposit `hasPending` sees, the first such snapshot entry or else the newest local `sent` one */
  pendingTxid(): string | undefined {
    const listed = this.snapshot?.deposits.find((d) => d.status === "pending" && !this.isTerminal(d.txid));
    return listed?.txid ?? this.resendTxid();
  }

  depositDecision(price: bigint, trigger: bigint, canDeposit: boolean): "inline" | "background" | "none" {
    if (!canDeposit) return "none";
    if (this.snapshot === undefined) {
      return this.deposits.some((d) => LIVE_STATES.has(d.state)) ? "none" : "inline";
    }
    if (this.hasPending()) return "none";
    const headroom = BigInt(this.snapshot.limitZat) - this.cumulative;
    if (headroom < price) return "inline";
    if (headroom < trigger) return "background";
    return "none";
  }

  /** The newest `sent` deposit. It leaves that state once a successful settle acks it, or once it is dead. */
  resendTxid(): string | undefined {
    for (let i = this.deposits.length - 1; i >= 0; i--) {
      const d = this.deposits[i];
      if (d !== undefined && d.state === "sent" && d.txid !== undefined) return d.txid;
    }
    return undefined;
  }

  /** False for a snapshot of another session, which no method here applies */
  owns(s: SessionSnapshot): boolean {
    return s.sessionKey === this.sessionKey;
  }

  /** Resyncs from a refusal's snapshot and copies dead statuses, but never acks, as it lists projected deposits */
  applySnapshot(s: SessionSnapshot): void {
    if (this.owns(s)) this.resync(s, false);
  }

  /** Only a successful settle acks, by its transaction or by listing the deposit in its snapshot (protocol.md §7.3) */
  applySettle(s: SettleResponse, attempted: bigint): void {
    if (s.success !== true) return;
    if (typeof s.transaction === "string" && s.transaction !== "") {
      const local = this.find(s.transaction);
      if (local !== undefined && !TERMINAL_STATES.has(local.state)) local.state = "acked";
    }
    const snapshot = snapshotFromExtra(s.extra);
    if (snapshot !== undefined && this.owns(snapshot)) this.resync(snapshot, true);
    else this.cumulative = attempted;
  }

  /** Our live deposits `s` lists as confirmed or final that were not reported before, now marked reported */
  newlyConfirmed(s: SessionSnapshot): ConfirmedDeposit[] {
    const found: ConfirmedDeposit[] = [];
    for (const listed of s.deposits) {
      if (listed.status !== "confirmed" && listed.status !== "final") continue;
      const local = this.find(listed.txid);
      if (local === undefined || TERMINAL_STATES.has(local.state) || !this.noteConfirmed(listed.txid)) continue;
      found.push({ index: local.index, txid: listed.txid });
    }
    return found;
  }

  /** True the first time `txid` is reported confirmed */
  noteConfirmed(txid: string): boolean {
    if (this.confirmedTxids.has(txid)) return false;
    this.confirmedTxids.add(txid);
    return true;
  }

  indexOf(txid: string): number | undefined {
    return this.find(txid)?.index;
  }

  markDead(txid: string): void {
    const local = this.find(txid);
    if (local !== undefined) local.state = "dead";
  }

  markRejected(txid: string): void {
    const local = this.find(txid);
    if (local !== undefined) local.state = "rejected";
  }

  /** The call's result is unknown, so the server may have charged it: never let `cumulative` fall behind. */
  advanceAmbiguous(attempted: bigint): void {
    if (attempted > this.cumulative) this.cumulative = attempted;
  }

  private resync(s: SessionSnapshot, ack: boolean): void {
    this.cumulative = BigInt(s.cumulativeZat);
    for (const listed of s.deposits) {
      const local = this.find(listed.txid);
      if (local === undefined || TERMINAL_STATES.has(local.state)) continue;
      if (listed.status === "dead") local.state = "dead";
      else if (ack) local.state = "acked";
    }
    this.snapshot = s;
  }

  private find(txid: string): LocalDeposit | undefined {
    return this.deposits.find((d) => d.txid === txid);
  }

  private isTerminal(txid: string): boolean {
    const local = this.find(txid);
    return local !== undefined && TERMINAL_STATES.has(local.state);
  }
}
