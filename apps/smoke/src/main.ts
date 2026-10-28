import { constants } from "node:os";
import { smokeMain } from "./cli.js";
import { createPayer } from "./payer.js";

const print = (line: string): void => console.log(line);
const warn = (line: string): void => console.error(line);

const abort = new AbortController();
let signalled: NodeJS.Signals | undefined;
for (const name of ["SIGINT", "SIGTERM"] as const) {
  process.on(name, () => {
    if (signalled !== undefined) process.exit(128 + constants.signals[name]);
    signalled = name;
    warn(`${name}: stopping at the next step, then closing the wallet (again to quit now)`);
    abort.abort();
  });
}

smokeMain(process.argv.slice(2), { print, warn, createPayer, signal: abort.signal }).then(
  (code) => {
    process.exitCode = signalled === undefined ? code : 128 + constants.signals[signalled];
    // A request that never noticed the abort keeps the process alive, and an interrupted run has nothing left to wait for
    if (signalled !== undefined) setTimeout(() => process.exit(), 1_000).unref();
  },
  (e: unknown) => {
    warn(e instanceof Error ? (e.stack ?? e.message) : String(e));
    process.exitCode = 1;
  },
);
