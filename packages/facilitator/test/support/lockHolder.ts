// A process that takes a ledger lock, says "held" on stdout and keeps it until it is killed or sent SIGTERM
import { lockLedger } from "../../src/core/ledgerLock.js";

const [path, heartbeatMs, staleMs, pollMs] = process.argv.slice(2);
const release = await lockLedger(path ?? "", {
  heartbeatMs: Number(heartbeatMs),
  staleMs: Number(staleMs),
  pollMs: Number(pollMs),
});
// Ready for SIGTERM before it says it holds the lock, so a test may stop it at once
process.on("SIGTERM", () => {
  release();
  process.exit(0);
});
process.stdout.write(`held ${process.pid}\n`);
setInterval(() => undefined, 60_000);
