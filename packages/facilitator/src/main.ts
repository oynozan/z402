// Prints one ready line on stdout and logs only to stderr, so scripts can wait for the line
import { createLightwalletdClient } from "@z402-net/lightwalletd";
import { startFacilitator, type FacilitatorHandle } from "./app.js";
import { cachedTip, LightwalletdChainView } from "./chain/lightwalletdChainView.js";
import { zdecryptNetwork, zdecryptOwnsShielded } from "./chain/zdecrypt.js";
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
  for (const warning of config.warnings) console.error(`facilitator: warning: ${warning}`);
  const lwd = createLightwalletdClient({ url: config.lwdUrl });

  let fatal = false;
  // A failed ledger write, or a lock another start took, leaves the file and the live state in doubt
  const onFatal = (err: unknown): void => {
    if (fatal) return;
    fatal = true;
    log("facilitator: the ledger cannot be written, exiting so that a restart replays it", err);
    process.exitCode = 1;
    setTimeout(() => process.exit(1), FATAL_EXIT_MS).unref();
  };

  let handle: FacilitatorHandle | undefined;
  try {
    await runStartupChecks({
      zdecryptBin: config.zdecryptBin,
      uivk: config.uivk,
      payTo: config.payTo,
      network: config.network,
      lwd,
      expectedBranchId: config.expectedBranchId,
    });
    // One tip for every provider's view, so that the watchers of all of them cost lightwalletd one read a second
    const tip = cachedTip(lwd);
    const viewOf = (p: { payTo: string; uivk: string }) =>
      new LightwalletdChainView({
        lwd,
        zdecryptBin: config.zdecryptBin,
        uivk: p.uivk,
        payTo: p.payTo,
        network: config.network,
        tip,
      });
    handle = await startFacilitator({
      network: config.network,
      chain: viewOf({ payTo: config.payTo, uivk: config.uivk }),
      payTo: config.payTo,
      terms: config.terms,
      authToken: config.authToken,
      ledgerPath: config.ledgerPath,
      providers: {
        dir: config.providersDir,
        chainFor: viewOf,
        owns: (p) =>
          zdecryptOwnsShielded({
            bin: config.zdecryptBin,
            key: p.uivk,
            address: p.payTo,
            network: zdecryptNetwork(config.network),
          }),
        max: config.maxProviders,
        registrationToken: config.registrationToken,
        registrationEnabled: config.registrationEnabled,
      },
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
  console.log(`facilitator providers=${handle.providerCount()}`);

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
