// A start that spins until a shared instant, then races the others for one ledger lock and says whether it won
import { lockLedger } from "../../src/core/ledgerLock.js";

const [path, goAt, heartbeatMs, staleMs, pollMs, holdMs] = process.argv.slice(2);
while (Date.now() < Number(goAt)) {
  // Spinning keeps every contender's start within a fraction of a millisecond of the others
}
const timing = { heartbeatMs: Number(heartbeatMs), staleMs: Number(staleMs), pollMs: Number(pollMs) };
lockLedger(path ?? "", timing).then(
  ({ release }) => {
    process.stdout.write("won\n");
    setTimeout(() => {
      release();
      process.exit(0);
    }, Number(holdMs));
  },
  () => {
    process.stdout.write("lost\n");
    process.exit(0);
  },
);
