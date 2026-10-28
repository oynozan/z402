/** The chain tip is the drop box's clock, since a drop is held for blocks and not for seconds */
import { stderr, type Log } from "./log.js";

export interface TipSource {
  /** The latest tip, or undefined before the first answer and once the last good one is older than the stale limit */
  tip(): number | undefined;
  /** Starts polling, which a second call does not repeat */
  start(): void;
  stop(): void;
}

/** What the source needs of a lightwalletd client */
export interface TipClient {
  getTip(): Promise<number>;
}

export interface PollingTipSource extends TipSource {
  /** One poll now, which never rejects */
  poll(): Promise<void>;
}

/** The last good tip is trusted this long, so a lightwalletd restart does not stop the service */
export const TIP_STALE_MS = 60_000;
/** Polling slower than this would leave the tip stale between two polls */
export const MAX_POLL_MS = TIP_STALE_MS / 2;

export interface TipSourceOptions {
  client: TipClient;
  pollMs: number;
  /** Called with every tip that differs from the one before it, e.g. to sweep the store */
  onTip?: (tip: number) => void;
  log?: Log;
  now?: () => number;
  staleMs?: number;
}

export function createTipSource(o: TipSourceOptions): PollingTipSource {
  const { client, pollMs, onTip } = o;
  const log = o.log ?? stderr;
  const now = o.now ?? Date.now;
  const staleMs = o.staleMs ?? TIP_STALE_MS;

  let latest: { height: number; at: number } | undefined;
  let failing = false;
  let running = false;
  let timer: NodeJS.Timeout | undefined;
  // A poll still in flight when the source stops must not write after it
  let generation = 0;

  const report = (what: string, e: unknown): void => {
    log(`dropbox: ${what}: ${e instanceof Error ? e.message : String(e)}`);
  };

  async function poll(): Promise<void> {
    const mine = generation;
    let height: number;
    try {
      height = await client.getTip();
      if (!Number.isSafeInteger(height) || height < 0) throw new TypeError(`not a block height: ${String(height)}`);
    } catch (e) {
      if (mine !== generation) return;
      // One line per outage and not one per poll
      if (!failing) report("cannot read the chain tip, keeping the last one", e);
      failing = true;
      return;
    }
    if (mine !== generation) return;
    if (failing) log("dropbox: the chain tip is readable again");
    failing = false;
    const changed = latest?.height !== height;
    latest = { height, at: now() };
    if (changed && onTip !== undefined) {
      try {
        onTip(height);
      } catch (e) {
        report("tip handler failed", e);
      }
    }
  }

  function loop(mine: number): void {
    void poll().then(() => {
      if (mine !== generation) return;
      timer = setTimeout(() => loop(mine), pollMs);
      // The HTTP server keeps the process alive, the poll must not
      timer.unref();
    });
  }

  return {
    tip: () => (latest !== undefined && now() - latest.at <= staleMs ? latest.height : undefined),
    poll,
    start() {
      if (running) return;
      running = true;
      loop(generation);
    },
    stop() {
      running = false;
      generation += 1;
      clearTimeout(timer);
    },
  };
}
