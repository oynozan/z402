// Prints one ready line on stdout and logs only to stderr, so scripts can wait for the line
import { startApi } from "./app.js";
import { loadConfig } from "./config.js";

const SHUTDOWN_MS = 5000;

async function main(): Promise<void> {
  const options = loadConfig(process.env, (message) => console.error(`api: warning: ${message}`));
  const api = await startApi(options);
  console.log(`api listening on ${api.url} network=${options.network}`);

  const stop = (): void => {
    setTimeout(() => process.exit(1), SHUTDOWN_MS).unref();
    api.close().then(
      () => process.exit(0),
      (err: unknown) => {
        console.error("api: shutdown failed", err);
        process.exit(1);
      },
    );
  };
  // Once, so that a second signal gets the default and ends the process at once
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

main().catch((err: unknown) => {
  console.error(`api: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
