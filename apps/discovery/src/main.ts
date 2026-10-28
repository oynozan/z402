// Prints one ready line on stdout and logs only to stderr, so scripts can wait for the line
import { loadConfig } from "./config.js";
import { startDiscovery, type DiscoveryHandle } from "./index.js";

const SHUTDOWN_MS = 5000;

// A probed service must never take discovery down, so a stray rejection is logged and the process carries on
process.on("unhandledRejection", (reason) => console.error("discovery: unhandled rejection", reason));

async function main(): Promise<void> {
  const config = loadConfig(process.env);

  let discovery: DiscoveryHandle | undefined;
  const stop = (): void => {
    setTimeout(() => process.exit(1), SHUTDOWN_MS).unref();
    (discovery?.close() ?? Promise.resolve()).then(
      () => process.exit(0),
      (err: unknown) => {
        console.error("discovery: shutdown failed", err);
        process.exit(1);
      },
    );
  };
  // Installed before the first refresh, since a process that is PID 1 in a container ignores signals without a handler
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  discovery = await startDiscovery(config);
  console.log(`discovery listening on ${discovery.url} services=${config.services.length}`);
}

main().catch((err: unknown) => {
  console.error(`discovery: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
