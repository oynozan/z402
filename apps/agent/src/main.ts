import { constants } from "node:os";
import { runAgent, type RunEnd } from "./agent.js";
import { FlagError, parseFlags, USAGE, type Flags } from "./flags.js";
import { formatRunHeader, stopAtDepositRefusal, TargetTally } from "./log.js";
import { createZcashClient, PreflightError, type ZcashClient } from "./zcash.js";

const print = (line: string): void => console.log(line);

const ENDINGS: Record<RunEnd, string> = {
  finished: "done",
  stopped: "stopped: the merchant refused at its credit limit, and the cheating agent has no deposit left to pay",
  aborted: "interrupted",
  failed: "stopped on an error",
};

async function run(flags: Flags): Promise<number> {
  const abort = new AbortController();
  let signalled: NodeJS.Signals | undefined;
  for (const name of ["SIGINT", "SIGTERM"] as const) {
    process.on(name, () => {
      if (signalled !== undefined) process.exit(128 + constants.signals[name]);
      signalled = name;
      print(`${name}: finishing the call in flight, then closing the wallet (again to quit now)`);
      abort.abort();
    });
  }

  let zcash: ZcashClient;
  try {
    zcash = await createZcashClient(flags, print);
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    return e instanceof FlagError ? 2 : 1;
  }

  for (const line of formatRunHeader(flags)) print(line);
  const tally = flags.targets.length > 1 ? new TargetTally(flags.targets) : undefined;
  let end: RunEnd;
  try {
    end = await runAgent({
      flags,
      zcashClientScheme: zcash.zcashClientScheme,
      print,
      signal: abort.signal,
      ...(flags.cheat ? { shouldStop: stopAtDepositRefusal } : {}),
      ...(tally === undefined ? {} : { onCall: (target, outcome) => tally.record(target, outcome) }),
    });
  } finally {
    await zcash.close().catch((e: unknown) => console.error(`closing the wallet failed: ${e instanceof Error ? e.message : e}`));
  }
  if (tally !== undefined) for (const line of tally.lines(zcash.zcashClientScheme.sessions())) print(line);
  print(ENDINGS[end]);
  if (end === "failed") return 1;
  return signalled === undefined ? 0 : 128 + constants.signals[signalled];
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv[0] === "discover") {
    // Loaded only here, so the demo never depends on the Bazaar client
    const { discoverMain } = await import("./discover.js");
    return discoverMain(argv.slice(1));
  }
  if (argv.includes("--help") || argv.includes("-h")) {
    print(USAGE);
    return 0;
  }
  let flags: Flags;
  try {
    flags = parseFlags(argv);
  } catch (e) {
    console.error(`${e instanceof Error ? e.message : e}\n\n${USAGE}`);
    return 2;
  }
  return run(flags);
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    console.error(e instanceof Error ? (e.stack ?? e.message) : e);
    process.exitCode = 1;
  },
);
