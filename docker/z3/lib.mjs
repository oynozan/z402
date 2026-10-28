// Helpers for the chain jobs of compose.yaml (chain-init.mjs, wallet-fund.mjs)
import { renameSync, writeFileSync } from "node:fs";

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Polls `probe` until it returns something other than undefined or false, and throws once `timeoutMs` has passed.
 * A probe that throws counts as not ready yet, since every RPC here may hit a container that is still starting.
 */
export async function waitFor(label, timeoutMs, probe, intervalMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  for (;;) {
    try {
      const value = await probe();
      if (value !== undefined && value !== false) return value;
    } catch (e) {
      lastError = e;
    }
    if (Date.now() >= deadline) {
      const detail = lastError instanceof Error ? `, last error: ${lastError.message}` : "";
      throw new Error(`${label}: not ready after ${Math.round(timeoutMs / 1000)} s${detail}`);
    }
    await sleep(intervalMs);
  }
}

/** Replaces the file in one rename, so a reader never sees half of it */
export function publish(path, text) {
  writeFileSync(`${path}.tmp`, `${text}\n`);
  renameSync(`${path}.tmp`, path);
}

/** Runs the job, printing a failure as one line that starts with its name */
export function runJob(name, job) {
  job().then(
    () => process.exit(0),
    (e) => {
      console.error(`${name}: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    },
  );
}
