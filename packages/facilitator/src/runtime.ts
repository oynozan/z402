/**
 * One provider's runtime (design §3). It holds what a payTo needs and shares nothing with another provider, which is
 * the chain view of its viewing key, its ledger with the lock on it, and the state, resolver, watcher, scheme and
 * x402Facilitator built on them. The host opens runtimes and decides when each one polls, starts and stops.
 */
import { closeSync, openSync } from "node:fs";
import { x402Facilitator } from "@x402/core/facilitator";
import type { ChainView, Terms, ZcashNetwork } from "@z402/protocol";
import {
  checkLedgerHeader,
  Ledger,
  LedgerMismatch,
  LedgerRefusal,
  type LedgerEvent,
  type LedgerOwner,
} from "./core/ledger.js";
import { lockLedger } from "./core/ledgerLock.js";
import { DepositResolver } from "./core/resolver.js";
import { commit, FacilitatorState } from "./core/state.js";
import { ChainWatcher } from "./core/watcher.js";
import { providerId } from "./providers/id.js";
import { PrepaidVoucherFacilitatorScheme } from "./scheme.js";

export type Log = (msg: string, err?: unknown) => void;

export interface RuntimeOptions {
  network: ZcashNetwork;
  payTo: string;
  chain: ChainView;
  terms: Terms;
  /** JSON Lines ledger replayed at open, left out means an in-memory ledger and no file I/O */
  ledgerPath?: string;
  /** How long verify waits for a deposit the chain does not show yet, default 30000 */
  depositWaitMs?: number;
  /** Default 5000 */
  pollIntervalMs?: number;
  /** Called on a failed ledger write or once the ledger lock names another start, so the host exits */
  onFatal: (err: unknown) => void;
  log?: Log;
}

export interface ProviderRuntime {
  /** The provider id, fixed by the network and the payTo */
  readonly id: string;
  readonly network: ZcashNetwork;
  readonly payTo: string;
  /** The only facilitator that answers to this provider's key, with the scheme of its payTo registered */
  readonly facilitator: x402Facilitator;
  /** One best effort pass over every live deposit, which does nothing once stopped */
  pollNow(): Promise<void>;
  /** Starts the watcher, which does nothing once stopped */
  start(): void;
  /** Stops the watcher, and a pass still in flight does not write to the ledger */
  stop(): void;
  /** Frees the ledger file for the next start, and does nothing the second time */
  release(): void;
  /** What the scheme advertises, the rail's terms with their version, which every provider's runtime shares */
  extra(): Record<string, unknown>;
}

const DEFAULT_POLL_MS = 5000;
const DEFAULT_DEPOSIT_WAIT_MS = 30_000;

function text(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Locks and replays the ledger, then builds everything that serves its payTo, and neither polls nor starts */
export async function openRuntime(o: RuntimeOptions): Promise<ProviderRuntime> {
  const opened = await openLedger(o.ledgerPath, { network: o.network, payTo: o.payTo }, o.onFatal);
  try {
    return assemble(o, opened);
  } catch (e) {
    opened.release();
    throw e;
  }
}

function assemble(o: RuntimeOptions, { ledger, state, release }: OpenLedger): ProviderRuntime {
  // A watcher pass already in flight when stop() runs must not write once it resumes
  let closed = false;

  // Not gated on closed, since a settle in flight must still be recorded and the server closes before it ends
  const write = (events: LedgerEvent[]): void => commit(ledger, state, events);
  const resolver = new DepositResolver({ chain: o.chain, log: o.log });
  const watcher = new ChainWatcher({
    chain: o.chain,
    state,
    // The scheme reports its own failed writes, and a refused batch wrote nothing, so only these failures are fatal
    commit: (events) => {
      if (closed) return;
      try {
        write(events);
      } catch (err) {
        if (!(err instanceof LedgerRefusal)) o.onFatal(err);
        throw err;
      }
    },
    intervalMs: o.pollIntervalMs ?? DEFAULT_POLL_MS,
    log: o.log,
  });
  const scheme = new PrepaidVoucherFacilitatorScheme({
    config: {
      network: o.network,
      payTo: o.payTo,
      terms: o.terms,
      depositWaitMs: o.depositWaitMs ?? DEFAULT_DEPOSIT_WAIT_MS,
    },
    state,
    resolver,
    watcher,
    commit: write,
    onFatal: o.onFatal,
    log: o.log,
  });

  return {
    id: providerId(o.network, o.payTo),
    network: o.network,
    payTo: o.payTo,
    // The facilitator hosts the Bazaar, so /supported lists the extension
    facilitator: new x402Facilitator().register(o.network, scheme).registerExtension({ key: "bazaar" }),
    pollNow: () => (closed ? Promise.resolve() : watcher.pollNow()),
    start: () => {
      if (!closed) watcher.start();
    },
    stop: () => {
      closed = true;
      watcher.stop();
    },
    release,
    extra: () => scheme.getExtra(o.network),
  };
}

interface OpenLedger {
  ledger: Ledger;
  state: FacilitatorState;
  /** Frees the ledger file for the next facilitator, and does nothing the second time */
  release: () => void;
}

/** Locks the file, proves it can be written, then replays it, so a facilitator that says ready can record a settle */
async function openLedger(
  path: string | undefined,
  own: LedgerOwner,
  fatal: (err: unknown) => void,
): Promise<OpenLedger> {
  if (path === undefined) return { ledger: new Ledger(), state: new FacilitatorState(), release: () => undefined };
  const lock = await lockLedger(path, { onLost: fatal });
  try {
    writable(path);
    return { ...replayed(path, own, lock.assertHeld), release: lock.release };
  } catch (e) {
    lock.release();
    throw e;
  }
}

function writable(path: string): void {
  try {
    closeSync(openSync(path, "a", 0o600));
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EISDIR" || code === "EROFS") {
      throw new Error(`ledgerPath: ${path} is not writable (${code})`, { cause: e });
    }
    throw new Error(`ledgerPath: cannot open ${path} (${code ?? text(e)})`, { cause: e });
  }
}

/** Replays the ledger of `own`, and gives a ledger with no events the header that names its facilitator */
function replayed(path: string, own: LedgerOwner, guard: () => void): { ledger: Ledger; state: FacilitatorState } {
  try {
    // Every write first checks that the lock is still this facilitator's
    const ledger = new Ledger(path, { guard });
    const state = new FacilitatorState();
    let first = true;
    // Each event is applied as it is read, so a long ledger is never held whole
    for (const event of ledger.events()) {
      if (first) checkLedgerHeader(event, own, path);
      const header = first && event.t === "ledger";
      first = false;
      if (!header) state.apply(event);
    }
    if (first) ledger.appendSync([{ t: "ledger", network: own.network, payTo: own.payTo }]);
    return { ledger, state };
  } catch (e) {
    if (e instanceof LedgerMismatch) throw e;
    throw new Error(`ledgerPath: cannot replay ${path}: ${text(e)}`, { cause: e });
  }
}
