import { spawn } from "node:child_process";
import { NETWORK_MAINNET, NETWORK_REGTEST, NETWORK_TESTNET, type ZcashNetwork } from "@z402/protocol";

/** The bare network names the zdecrypt CLI accepts */
export type ZdecryptNetwork = "regtest" | "testnet" | "mainnet";

export function zdecryptNetwork(network: ZcashNetwork): ZdecryptNetwork {
  switch (network) {
    case NETWORK_REGTEST:
      return "regtest";
    case NETWORK_TESTNET:
      return "testnet";
    case NETWORK_MAINNET:
      return "mainnet";
    default:
      throw new TypeError(`${String(network)} is not a Zcash network`);
  }
}

/** Every message is fixed text or the error text zdecrypt itself prints, never the key or other child output */
export class ZdecryptError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ZdecryptError";
  }
}

export interface ZOutput {
  pool: "sapling" | "orchard" | "ironwood";
  scope: "external" | "internal";
  valueZat: number;
  memoKind: "text" | "empty" | "binary";
  memoText: string | null;
  toPayTo?: boolean;
}

export interface ZReport {
  txid: string;
  version: number;
  expiryHeight: number;
  transparentIn: number;
  transparentOut: number;
  outputs: ZOutput[];
}

export type ZdecryptAt = { tip: number } | { height: number };

const DEFAULT_TIMEOUT_MS = 10_000;
// zdecrypt exits with 2 and an error object on stdout when it refuses its input
const EXIT_ERROR = 2;

const POOLS = ["sapling", "orchard", "ironwood"] as const;
const SCOPES = ["external", "internal"] as const;
const MEMO_KINDS = ["text", "empty", "binary"] as const;

/** The arguments after the binary name, the key goes in the environment and never in here */
export function zdecryptArgs(at: ZdecryptAt, payTo?: string): string[] {
  const args = ["decrypt", ...("tip" in at ? ["--tip", String(at.tip)] : ["--height", String(at.height)])];
  if (payTo !== undefined) args.push("--pay-to", payTo);
  return args;
}

interface Invocation {
  bin: string;
  args: string[];
  key: string;
  stdin?: string;
  timeoutMs: number;
}

interface Exited {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
}

// Only the error code is kept because Node quotes a rejected argument, and that can be the key
function couldNotStart(e: unknown): ZdecryptError {
  const code = (e as NodeJS.ErrnoException).code ?? "unknown error";
  return new ZdecryptError(`zdecrypt could not be started (${code})`);
}

function start(bin: string, args: string[], key: string) {
  // The key travels only in the environment because argv shows in ps
  const env: NodeJS.ProcessEnv = { ZDECRYPT_KEY: key };
  if (process.env.PATH !== undefined) env.PATH = process.env.PATH;
  return spawn(bin, args, { env, stdio: ["pipe", "pipe", "ignore"] });
}

function spawnZdecrypt({ bin, args, key, stdin, timeoutMs }: Invocation): Promise<Exited> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof start>;
    try {
      child = start(bin, args, key);
    } catch (e) {
      reject(couldNotStart(e));
      return;
    }
    const chunks: Buffer[] = [];

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new ZdecryptError(`zdecrypt timed out after ${timeoutMs} ms`));
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    // A child that stops reading breaks the pipe, and its exit code already says why
    child.stdin.on("error", () => {});
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(couldNotStart(e));
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout: Buffer.concat(chunks).toString("utf8") });
    });
    child.stdin.end(stdin);
  });
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// JSON.parse quotes the start of its input in the error, so the failure keeps no cause
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

async function call(invocation: Invocation): Promise<unknown> {
  const { code, signal, stdout } = await spawnZdecrypt(invocation);
  const printed = parseJson(stdout);
  if (code === 0) {
    if (printed === undefined) throw new ZdecryptError("zdecrypt printed no JSON report");
    return printed;
  }
  if (code === null) throw new ZdecryptError(`zdecrypt was killed by ${signal}`);
  if (code === EXIT_ERROR && isRecord(printed) && typeof printed.error === "string") {
    throw new ZdecryptError(printed.error);
  }
  throw new ZdecryptError(`zdecrypt exited with code ${code}`);
}

function malformed(field: string): ZdecryptError {
  return new ZdecryptError(`zdecrypt report is malformed (${field})`);
}

function unsigned(from: Record<string, unknown>, field: string): number {
  const v = from[field];
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) throw malformed(field);
  return v;
}

function oneOf<T extends string>(from: Record<string, unknown>, field: string, allowed: readonly T[]): T {
  const found = allowed.find((a) => a === from[field]);
  if (found === undefined) throw malformed(field);
  return found;
}

function parseOutput(raw: unknown): ZOutput {
  if (!isRecord(raw)) throw malformed("output");
  const { memoText, toPayTo } = raw;
  if (typeof memoText !== "string" && memoText !== null) throw malformed("memoText");
  const output: ZOutput = {
    pool: oneOf(raw, "pool", POOLS),
    scope: oneOf(raw, "scope", SCOPES),
    valueZat: unsigned(raw, "valueZat"),
    memoKind: oneOf(raw, "memoKind", MEMO_KINDS),
    memoText,
  };
  if (toPayTo !== undefined) {
    if (typeof toPayTo !== "boolean") throw malformed("toPayTo");
    output.toPayTo = toPayTo;
  }
  return output;
}

// Every field the deposit verdict reads is checked, so a changed report fails closed instead of reading as zero
function parseReport(raw: unknown): ZReport {
  if (!isRecord(raw)) throw malformed("report");
  if (typeof raw.txid !== "string") throw malformed("txid");
  if (!Array.isArray(raw.outputs)) throw malformed("outputs");
  return {
    txid: raw.txid,
    version: unsigned(raw, "version"),
    expiryHeight: unsigned(raw, "expiryHeight"),
    transparentIn: unsigned(raw, "transparentIn"),
    transparentOut: unsigned(raw, "transparentOut"),
    outputs: raw.outputs.map(parseOutput),
  };
}

export async function zdecryptDecrypt(o: {
  bin: string;
  key: string;
  rawHex: string;
  at: ZdecryptAt;
  payTo?: string;
  network: ZdecryptNetwork;
  timeoutMs?: number;
}): Promise<ZReport> {
  const args = [...zdecryptArgs(o.at, o.payTo), "--network", o.network];
  const timeoutMs = o.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return parseReport(await call({ bin: o.bin, args, key: o.key, stdin: o.rawHex, timeoutMs }));
}

export async function zdecryptOwns(o: {
  bin: string;
  key: string;
  address: string;
  network: ZdecryptNetwork;
}): Promise<{ hasTransparent: boolean; ownedByKey: boolean }> {
  const args = ["owns", "--address", o.address, "--network", o.network];
  const printed = await call({ bin: o.bin, args, key: o.key, timeoutMs: DEFAULT_TIMEOUT_MS });
  if (!isRecord(printed) || typeof printed.hasTransparent !== "boolean" || typeof printed.ownedByKey !== "boolean") {
    throw malformed("owns");
  }
  return { hasTransparent: printed.hasTransparent, ownedByKey: printed.ownedByKey };
}
