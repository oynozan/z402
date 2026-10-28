import { setTimeout as sleep } from "node:timers/promises";
import { wrapFetchWithPayment, x402Client, type SchemeNetworkClient } from "@x402/fetch";
import type { Flags } from "./flags.js";
import { formatCallFailure, formatCallLine, outcomeOf, type CallOutcome } from "./log.js";

export type RunEnd = "finished" | "stopped" | "aborted" | "failed";

export interface AgentOptions {
  flags: Flags;
  zcashClientScheme: SchemeNetworkClient;
  print?: (line: string) => void;
  /** Aborting ends the loop and cuts the call in flight short */
  signal?: AbortSignal;
  shouldStop?: (outcome: CallOutcome) => boolean;
  /** Each call's outcome, with the 0-based index of its target */
  onCall?: (target: number, outcome: CallOutcome) => void;
}

export async function runAgent({ flags, zcashClientScheme, print = console.log, signal, shouldStop, onCall }: AgentOptions): Promise<RunEnd> {
  const client = new x402Client();
  client.register(flags.network, zcashClientScheme); // the one line that adds Zcash
  const paidFetch = wrapFetchWithPayment(fetch, client);

  const { targets } = flags;
  const total = flags.calls * targets.length;
  for (let i = 1; i <= total; i++) {
    if (signal?.aborted) return "aborted";
    const started = Date.now();
    // The targets take turns, and their lines are tagged only when there are several
    const target = (i - 1) % targets.length;
    const tag = targets.length > 1 ? target + 1 : undefined;

    let res: Response;
    try {
      res = await paidFetch(targets[target]!, { signal });
    } catch (e) {
      if (signal?.aborted) return "aborted";
      print(formatCallFailure(i, e, tag));
      return "failed";
    }
    const outcome = outcomeOf(res);
    await res.body?.cancel();
    print(formatCallLine(i, res.status, outcome.snapshot, outcome.error, tag));
    onCall?.(target, outcome);

    if (shouldStop?.(outcome)) return "stopped";
    const wait = flags.intervalMs - (Date.now() - started);
    if (i < total && wait > 0) await sleep(wait, undefined, { signal }).catch(() => {});
  }
  return "finished";
}
