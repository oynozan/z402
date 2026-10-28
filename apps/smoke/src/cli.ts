import { FlagError, parseFlags, SERVICE_NAMES, USAGE, wantsHelp, type Flags } from "./flags.js";
import { runFlow, type FlowResult } from "./flow.js";
import { shortAddress } from "./log.js";
import type { Payer, SessionLine } from "./payer.js";

export interface CliIo {
  /** The step lines and the verdict, which are the output of the run */
  print(line: string): void;
  /** What the payment client reports while it works, and every error */
  warn(line: string): void;
  createPayer(flags: Flags, warn: (line: string) => void): Promise<Payer>;
  /** Ends the run before its next step */
  signal?: AbortSignal;
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** What the session paid, and whether the run passed */
export function summaryLines(result: FlowResult, sessions: readonly SessionLine[], services: Flags["services"]): string[] {
  const paid = result.steps.filter((s) => s.paid && s.ok).length;
  const lines =
    sessions.length === 0
      ? ["session none, no voucher was signed"]
      : sessions.map((s) => `session ${shortAddress(s.payTo)} cumulative ${s.cumulativeZat} zat after ${plural(paid, "paid call")}`);

  const skipped = SERVICE_NAMES.filter((name) => services[name] === undefined);
  const note = skipped.length === 0 ? "" : `; skipped: ${skipped.join(", ")}`;
  const failed = result.steps.filter((s) => !s.ok);
  if (result.aborted) {
    lines.push(`smoke interrupted after ${plural(result.steps.length, "step")}`);
  } else if (failed.length > 0) {
    const names = failed.map((s) => `${s.service} ${s.step}`).join(", ");
    lines.push(`smoke FAILED: ${failed.length} of ${plural(result.steps.length, "step")} failed (${names})${note}`);
  } else {
    const checked = SERVICE_NAMES.filter((name) => services[name] !== undefined);
    lines.push(`smoke ok: ${plural(result.steps.length, "step")} passed on ${checked.join(", ")}${note}`);
  }
  return lines;
}

/** Runs the command and returns its exit status: 0 when every step passed, 1 when not, 2 for a flag error */
export async function smokeMain(argv: readonly string[], io: CliIo): Promise<number> {
  if (wantsHelp(argv)) {
    io.print(USAGE);
    return 0;
  }
  let flags: Flags;
  try {
    flags = parseFlags(argv);
  } catch (e) {
    if (!(e instanceof FlagError)) throw e;
    io.warn(`${e.message}\n\n${USAGE}`);
    return 2;
  }

  let payer: Payer;
  try {
    payer = await io.createPayer(flags, io.warn);
  } catch (e) {
    io.warn(message(e));
    return 1;
  }

  let result: FlowResult | undefined;
  try {
    result = await runFlow({
      services: flags.services,
      page: flags.page,
      paidFetch: payer.paidFetch,
      print: io.print,
      spent: () => payer.spent(),
      ...(io.signal === undefined ? {} : { signal: io.signal }),
    });
    for (const line of summaryLines(result, payer.sessions(), flags.services)) io.print(line);
  } catch (e) {
    io.warn(`the smoke test could not finish: ${message(e)}`);
  } finally {
    await payer.close().catch((e: unknown) => io.warn(`closing the wallet failed: ${message(e)}`));
  }
  return result?.ok === true ? 0 : 1;
}
