// Block clock for the Z3 regtest chain. Zebra mines to the miner address in .env.regtest.
// node infra/z3/clock.mjs mine [n]           mine n blocks now (default 1)
// node infra/z3/clock.mjs run --every 25     mine one block every 25 s until stopped

import { mineNow } from "./rpc.mjs";

const usage = () => {
  console.error("usage: node infra/z3/clock.mjs mine [n] | run [--every <seconds>]");
  process.exit(2);
};

async function timedMine(n) {
  const started = performance.now();
  const height = await mineNow(n);
  return { height, secs: ((performance.now() - started) / 1000).toFixed(2) };
}

const [cmd, ...args] = process.argv.slice(2);

if (cmd === "mine") {
  const n = args[0] === undefined ? 1 : Number(args[0]);
  if (!Number.isInteger(n) || n < 1) usage();
  try {
    const { height, secs } = await timedMine(n);
    console.log(`height ${height} (+${n} in ${secs}s)`);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
} else if (cmd === "run") {
  const i = args.indexOf("--every");
  const every = i === -1 ? 25 : Number(args[i + 1]);
  if (!(every > 0)) usage();
  process.on("SIGINT", () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));
  console.log(`block clock: one block every ${every}s`);
  for (;;) {
    const tick = performance.now();
    const stamp = new Date().toISOString();
    try {
      const { height, secs } = await timedMine(1);
      console.log(`${stamp} height ${height} (${secs}s)`);
    } catch (err) {
      console.error(`${stamp} mine failed: ${err.message}`);
    }
    const wait = Math.max(0, every * 1000 - (performance.now() - tick));
    await new Promise((r) => setTimeout(r, wait));
  }
} else {
  usage();
}
