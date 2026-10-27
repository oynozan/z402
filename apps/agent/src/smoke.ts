import { parseArgs } from "node:util";
import { ZalletRpcWallet } from "@z402/client";
import { depositMemo, generateSeed, publicKeyFromSeed } from "@z402/protocol";
import { zainoTxStatus } from "./chain.js";
import { loadZ3Rpc, pollUntil, Z3_DEFAULTS } from "./z3.js";

const DEPOSIT_ZAT = 100_000n;
const POLL_MS = 1_000;
const WAIT_MS = 60_000;

const USAGE = `usage: tsx src/smoke.ts --to <payTo> [--zallet-url <url>] [--zallet-user <user>] [--zallet-password <password>]
                          [--lightwalletd <url>] [--no-mine]

Sends one 100000 zat deposit to <payTo> through ZalletRpcWallet, watches it in Zaino's mempool, mines a block
(unless --no-mine) and prints { txid, memo, minedHeight, expiryHeight } as JSON.`;

function log(message: string): void {
  console.error(message);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      to: { type: "string" },
      "zallet-url": { type: "string", default: Z3_DEFAULTS.zalletUrl },
      "zallet-user": { type: "string", default: Z3_DEFAULTS.zalletUser },
      "zallet-password": { type: "string", default: Z3_DEFAULTS.zalletPassword },
      lightwalletd: { type: "string", default: Z3_DEFAULTS.lightwalletdUrl },
      mine: { type: "boolean", default: true },
    },
    allowNegative: true,
  });
  if (values.to === undefined) {
    console.error(USAGE);
    process.exit(2);
  }

  const wallet = new ZalletRpcWallet({
    url: values["zallet-url"],
    user: values["zallet-user"],
    password: values["zallet-password"],
  });
  const { status, close } = zainoTxStatus(values.lightwalletd);

  try {
    const memo = depositMemo(publicKeyFromSeed(generateSeed()), 1);
    const t0 = Date.now();
    const since = (): string => `${((Date.now() - t0) / 1000).toFixed(1)} s`;

    log(`sending ${DEPOSIT_ZAT} zat to ${values.to}`);
    const { txid } = await wallet.sendDeposit({ to: values.to, amountZat: DEPOSIT_ZAT, memo });
    log(`sent ${txid} after ${since()}`);

    const seen = await pollUntil(
      "the deposit in Zaino",
      async () => {
        const s = await status.status(txid);
        return s.found ? s : undefined;
      },
      { timeoutMs: WAIT_MS, intervalMs: POLL_MS },
    );
    log(`seen in ${seen.location} after ${since()}, expiry height ${seen.expiryHeight}`);

    let minedHeight = seen.minedHeight;
    if (values.mine) {
      const rpc = await loadZ3Rpc();
      const tip = await rpc.mineNow(1);
      log(`mined a block, Zebra tip ${tip}`);
      const mined = await pollUntil(
        "the deposit to be mined in Zaino",
        async () => {
          const s = await status.status(txid);
          return s.found && s.location === "mined" ? s : undefined;
        },
        { timeoutMs: WAIT_MS, intervalMs: POLL_MS },
      );
      minedHeight = mined.minedHeight;
      log(`mined at height ${minedHeight} after ${since()}`);
    }

    console.log(JSON.stringify({ txid, memo, minedHeight, expiryHeight: seen.expiryHeight }, null, 2));
  } finally {
    close();
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
