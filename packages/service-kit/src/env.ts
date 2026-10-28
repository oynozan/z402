/**
 * The environment every paid service shares (design §3.1). An empty variable counts as unset, and every error names the
 * variable at fault without quoting a secret.
 */
import { readFileSync } from "node:fs";
import {
  isValidPayTo,
  NETWORK_MAINNET,
  NETWORK_REGTEST,
  NETWORK_TESTNET,
  parseZat,
  ProtocolError,
  type ZcashNetwork,
} from "@z402/protocol";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export type Env = Record<string, string | undefined>;

export interface ServiceEnv {
  network: ZcashNetwork;
  facilitatorUrl: string;
  facilitatorToken: string | undefined;
  payTo: string;
  /** Price of one call in zatoshi, for every route that does not set its own */
  priceZat: bigint;
  /** Public origin of the service, without a trailing slash, used for 402 resource URLs and discovery */
  publicUrl: string;
  host: string;
  port: number;
  /** How long a service waits at start for a facilitator that does not answer yet */
  facilitatorWaitMs?: number;
  /** How often a ready service declares its routes to the facilitator's Bazaar, 30000 by default; 0 never does */
  declareIntervalMs?: number;
}

const NETWORKS: Readonly<Record<string, { network: ZcashNetwork; payToHint: string }>> = {
  regtest: { network: NETWORK_REGTEST, payToHint: "uregtest1... or zuregtest1..." },
  testnet: { network: NETWORK_TESTNET, payToHint: "utest1... or zutest1..." },
  mainnet: { network: NETWORK_MAINNET, payToHint: "u1... or zu1..." },
};

const PORT_RE = /^(0|[1-9][0-9]{0,4})$/;
const WHOLE_RE = /^(0|[1-9][0-9]{0,15})$/;

/** The value of `name`, or undefined when it is unset or empty */
export function read(env: Env, name: string): string | undefined {
  const value = env[name];
  return value === undefined || value === "" ? undefined : value;
}

/** `name` itself, else the trimmed contents of the file named by `<name>_FILE` */
export function readOrFile(env: Env, name: string): string | undefined {
  const direct = read(env, name);
  if (direct !== undefined) return direct;
  const fileVariable = `${name}_FILE`;
  const path = read(env, fileVariable);
  if (path === undefined) return undefined;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    throw new ConfigError(`${fileVariable}: cannot read ${path} (${(e as NodeJS.ErrnoException).code ?? "error"})`);
  }
  const value = text.trim();
  if (value === "") throw new ConfigError(`${fileVariable}: ${path} is empty`);
  return value;
}

/** A whole number within [min, max], `fallback` when unset */
export function readInt(env: Env, name: string, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  const raw = read(env, name);
  if (raw === undefined) return fallback;
  const value = WHOLE_RE.test(raw) ? Number(raw) : Number.NaN;
  if (!(value >= min && value <= max)) {
    throw new ConfigError(`${name}: expected a whole number from ${min} to ${max}`);
  }
  return value;
}

/** An http(s) URL without a trailing slash, `fallback` when unset */
export function readUrl(env: Env, name: string, fallback?: string): string {
  const raw = read(env, name) ?? fallback;
  if (raw === undefined) throw new ConfigError(`${name} is required (an http:// or https:// URL)`);
  const protocol = URL.canParse(raw) ? new URL(raw).protocol : "";
  if (protocol !== "http:" && protocol !== "https:") throw new ConfigError(`${name}: expected an http:// or https:// URL`);
  return raw.replace(/\/+$/, "");
}

function priceOf(env: Env, fallback: bigint): bigint {
  const raw = read(env, "Z402_PRICE_ZAT");
  if (raw === undefined) return fallback;
  let price: bigint;
  try {
    price = parseZat(raw);
  } catch (e) {
    if (e instanceof ProtocolError) throw new ConfigError(`Z402_PRICE_ZAT: ${e.message}`);
    throw e;
  }
  if (price < 1n) throw new ConfigError("Z402_PRICE_ZAT: must be at least 1 zat");
  return price;
}

function portOf(env: Env, fallback: number): number {
  const raw = read(env, "PORT");
  if (raw === undefined) return fallback;
  const port = PORT_RE.test(raw) ? Number(raw) : Number.NaN;
  if (!(port <= 65535)) throw new ConfigError("PORT: expected a whole number from 0 to 65535");
  return port;
}

/**
 * Reads and checks the shared variables, throwing a ConfigError that names the one at fault. `priceZat` is the service's
 * own price for one call, which Z402_PRICE_ZAT overrides.
 */
export function loadServiceEnv(env: Env, o: { port: number; priceZat: bigint }): ServiceEnv {
  const name = read(env, "Z402_NETWORK") ?? "regtest";
  const profile = Object.hasOwn(NETWORKS, name) ? NETWORKS[name] : undefined;
  if (profile === undefined) throw new ConfigError("Z402_NETWORK: expected regtest, testnet or mainnet");

  const facilitatorUrl = readUrl(env, "Z402_FACILITATOR_URL");
  const facilitatorToken = readOrFile(env, "Z402_FACILITATOR_TOKEN");

  const payTo = readOrFile(env, "Z402_PAY_TO");
  if (payTo === undefined) {
    throw new ConfigError("Z402_PAY_TO is required (the merchant's shielded-only unified address, or Z402_PAY_TO_FILE)");
  }
  if (!isValidPayTo(payTo, profile.network)) {
    throw new ConfigError(
      `Z402_PAY_TO: not a shielded-only unified address for ${profile.network} (expected ${profile.payToHint})`,
    );
  }

  const host = read(env, "HOST") ?? "127.0.0.1";
  if (host.trim() === "") throw new ConfigError("HOST: must not be blank");
  const port = portOf(env, o.port);

  return {
    network: profile.network,
    facilitatorUrl,
    facilitatorToken,
    payTo,
    priceZat: priceOf(env, o.priceZat),
    publicUrl: readUrl(env, "PUBLIC_URL", `http://localhost:${port}`),
    host,
    port,
    facilitatorWaitMs: readInt(env, "Z402_FACILITATOR_WAIT_MS", 120_000, 0, 3_600_000),
  };
}
