import type { SettleResponse } from "@x402/core/types";
import { publicKeyFromSeed, type SessionSnapshot } from "@z402/protocol";
import { snapshotFromExtra } from "./outcome.js";

export interface LocalDeposit {
  index: number;
  memo: string;
  txid?: string;
  state: "sending" | "sent" | "acked" | "dead" | "rejected" | "failed" | "uncertain";
}

/** States that mean a deposit exists or may exist, so the first call must not make another one. */
const LIVE_STATES: ReadonlySet<LocalDeposit["state"]> = new Set(["sending", "sent", "acked", "uncertain"]);

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

  constructor(i: { payTo: string; network: string; seed: Uint8Array }) {
    this.payTo = i.payTo;
    this.network = i.network;
    this.sessionKey = publicKeyFromSeed(i.seed);
  }

  /** The snapshot lists a pending deposit, or a local `sent` one is neither acked nor dead. */
  hasPending(): boolean {
    return (
      (this.snapshot?.deposits.some((d) => d.status === "pending") ?? false) ||
      this.deposits.some((d) => d.state === "sent")
    );
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

  /** The newest `sent` deposit. It leaves that state once acked (`settle.transaction` or the snapshot) or dead. */
  resendTxid(): string | undefined {
    for (let i = this.deposits.length - 1; i >= 0; i--) {
      const d = this.deposits[i];
      if (d !== undefined && d.state === "sent" && d.txid !== undefined) return d.txid;
    }
    return undefined;
  }

  applySnapshot(s: SessionSnapshot): void {
    this.cumulative = BigInt(s.cumulativeZat);
    for (const listed of s.deposits) {
      const local = this.find(listed.txid);
      if (local !== undefined) local.state = listed.status === "dead" ? "dead" : "acked";
    }
    this.snapshot = s;
  }

  applySettle(s: SettleResponse, attempted: bigint): void {
    if (typeof s.transaction === "string" && s.transaction !== "") {
      const local = this.find(s.transaction);
      if (local !== undefined) local.state = "acked";
    }
    if (s.success !== true) return;
    const snapshot = snapshotFromExtra(s.extra);
    if (snapshot !== undefined) this.applySnapshot(snapshot);
    else this.cumulative = attempted;
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

  private find(txid: string): LocalDeposit | undefined {
    return this.deposits.find((d) => d.txid === txid);
  }
}
