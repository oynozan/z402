import { fileURLToPath } from "node:url";
import { ConfigError } from "./env.js";

/**
 * Loads a service's own .env when it exists. A variable already set in the environment wins, so values that compose
 * or the shell pass in are never overridden by the file.
 */
export function loadDotEnv(file: URL): void {
  const path = fileURLToPath(file);
  try {
    process.loadEnvFile(path);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw new ConfigError(`.env: cannot read ${path} (${code ?? "error"})`);
  }
}
