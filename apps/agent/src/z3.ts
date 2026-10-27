import { fileURLToPath, pathToFileURL } from "node:url";

/** Default endpoints and credentials of the local Z3 regtest stack (infra/z3/README.md) */
export const Z3_DEFAULTS = {
  zalletUrl: "http://127.0.0.1:50232",
  zalletUser: "zebra",
  zalletPassword: "zebra",
  lightwalletdUrl: "http://127.0.0.1:28137",
  /** The merchant's regtest payTo */
  merchantPayTo:
    "uregtest1etwrjmjldyyet5pge876dfxerpgmsmarxg920s50y3dgc3wa36xmemqexfyw87jm3h0cttupk92qkrv8uafvjrl2j73d8nck7g35axkz",
} as const;

/** The parts of infra/z3/rpc.mjs this package uses */
export interface Z3Rpc {
  mineNow(n?: number): Promise<number>;
  zebraRpc(method: string, params?: unknown[]): Promise<unknown>;
  zalletRpc(method: string, params?: unknown[]): Promise<unknown>;
}

/** Loads infra/z3/rpc.mjs by absolute path, so it works from any working directory */
export async function loadZ3Rpc(): Promise<Z3Rpc> {
  const path = fileURLToPath(new URL("../../../infra/z3/rpc.mjs", import.meta.url));
  return (await import(pathToFileURL(path).href)) as Z3Rpc;
}

/** Runs `probe` every `intervalMs` until it returns a value, or throws once `timeoutMs` has passed */
export async function pollUntil<T>(
  label: string,
  probe: () => Promise<T | undefined>,
  o: { timeoutMs: number; intervalMs: number },
): Promise<T> {
  const deadline = Date.now() + o.timeoutMs;
  let lastError: unknown;
  for (;;) {
    try {
      const value = await probe();
      if (value !== undefined) return value;
    } catch (e) {
      lastError = e;
    }
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, o.intervalMs));
  }
  const detail = lastError instanceof Error ? `, last error: ${lastError.message}` : "";
  throw new Error(`timed out after ${o.timeoutMs} ms waiting for ${label}${detail}`);
}
