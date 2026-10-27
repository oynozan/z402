// Prints one ready line on stdout and logs only to stderr, so scripts can wait for the line
import { createLightwalletdClient } from "@z402/lightwalletd";
import { startFacilitator } from "./app.js";
import { LightwalletdChainView } from "./chain/lightwalletdChainView.js";
import { loadConfig } from "./config.js";
import { runStartupChecks } from "./startup.js";

const SHUTDOWN_MS = 5000;
/** Long enough for the response in flight to flush */
const FATAL_EXIT_MS = 50;

const log = (message: string, err?: unknown): void => {
  if (err === undefined) console.error(message);
  else console.error(message, err);
};

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const lwd = createLightwalletdClient({ url: config.lwdUrl });

  let fatal = false;
  // A failed ledger write leaves the file and the live state in doubt, so a restart must replay the file
  const onFatal = (err: unknown): void => {
    if (fatal) return;
    fatal = true;
    log("facilitator: a ledger write failed, exiting so that a restart replays the ledger", err);
    process.exitCode = 1;
    setTimeout(() => process.exit(1), FATAL_EXIT_MS).unref();
  };

  let handle;
  try {
    await runStartupChecks({
      zdecryptBin: config.zdecryptBin,
      uivk: config.uivk,
      payTo: config.payTo,
      network: config.network,
      lwd,
      expectedBranchId: config.expectedBranchId,
    });
    handle = await startFacilitator({
      network: config.network,
      chain: new LightwalletdChainView({
        lwd,
        zdecryptBin: config.zdecryptBin,
        uivk: config.uivk,
        payTo: config.payTo,
        network: config.network,
      }),
      payTo: config.payTo,
      priceZat: config.priceZat,
      terms: config.terms,
      authToken: config.authToken,
      ledgerPath: config.ledgerPath,
      host: config.host,
      port: config.port,
      onFatal,
      log,
    });
  } catch (e) {
    lwd.close();
    throw e;
  }

  console.log(`facilitator listening on ${handle.url} network=${config.network} payTo=${config.payTo}`);

  const running = handle;
  const stop = (): void => {
    setTimeout(() => process.exit(1), SHUTDOWN_MS).unref();
    running.close().then(
      () => {
        lwd.close();
        process.exit(0);
      },
      (err: unknown) => {
        log("facilitator: shutdown failed", err);
        process.exit(1);
      },
    );
  };
  // Once, so that a second signal gets the default and ends the process at once
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

main().catch((err: unknown) => {
  console.error(`facilitator: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
