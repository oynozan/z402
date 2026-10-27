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
}

export async function runAgent({ flags, zcashClientScheme, print = console.log, signal, shouldStop }: AgentOptions): Promise<RunEnd> {
  const client = new x402Client();
  client.register(flags.network, zcashClientScheme); // the one line that adds Zcash
  const paidFetch = wrapFetchWithPayment(fetch, client);

  for (let i = 1; i <= flags.calls; i++) {
    if (signal?.aborted) return "aborted";
    const started = Date.now();

    let res: Response;
    try {
      res = await paidFetch(`${flags.api}/chunk`, { signal });
    } catch (e) {
      if (signal?.aborted) return "aborted";
      print(formatCallFailure(i, e));
      return "failed";
    }
    const outcome = outcomeOf(res);
    await res.body?.cancel();
    print(formatCallLine(i, res.status, outcome.snapshot, outcome.error));

    if (shouldStop?.(outcome)) return "stopped";
    const wait = flags.intervalMs - (Date.now() - started);
    if (i < flags.calls && wait > 0) await sleep(wait, undefined, { signal }).catch(() => {});
  }
  return "finished";
}
