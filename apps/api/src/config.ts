/**
 * The API's environment for `main`. Every problem names the variable at fault. The merchant keys file is parsed whole,
 * but only its orchardOnlyAddress is used, so the viewing key in it is never used. No message quotes the file.
 */
import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isValidPayTo,
  NETWORK_MAINNET,
  NETWORK_REGTEST,
  NETWORK_TESTNET,
  parseZat,
  ProtocolError,
  type ZcashNetwork,
} from "@z402/protocol";
import type { ApiOptions } from "./app.js";

/** The repository root, found from this file and never from the working directory, which `pnpm --filter` changes */
const REPO_ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

type Env = Record<string, string | undefined>;

interface Profile {
  network: ZcashNetwork;
  payToHint: string;
}

const PROFILES: Readonly<Record<string, Profile>> = {
  regtest: { network: NETWORK_REGTEST, payToHint: "uregtest1... or zuregtest1..." },
  testnet: { network: NETWORK_TESTNET, payToHint: "utest1... or zutest1..." },
  mainnet: { network: NETWORK_MAINNET, payToHint: "u1... or zu1..." },
};

const DEFAULT_PRICE_ZAT = 500n;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4021;
const PORT_RE = /^(0|[1-9][0-9]{0,4})$/;

/** An empty variable counts as unset, the way `VAR= cmd` unsets it in a shell */
function read(env: Env, name: string): string | undefined {
  const value = env[name];
  return value === undefined || value === "" ? undefined : value;
}

/** Absolute paths stay as they are and anything else is relative to the repository root */
function pathOf(value: string): string {
  return isAbsolute(value) ? value : resolve(REPO_ROOT, value);
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function profileOf(env: Env): Profile {
  const name = read(env, "Z402_NETWORK") ?? "regtest";
  const profile = Object.hasOwn(PROFILES, name) ? PROFILES[name] : undefined;
  if (profile === undefined) throw new ConfigError("Z402_NETWORK: expected regtest, testnet or mainnet");
  return profile;
}

function facilitatorUrlOf(env: Env): string {
  const url = read(env, "Z402_FACILITATOR_URL");
  if (url === undefined) {
    throw new ConfigError("Z402_FACILITATOR_URL is required (the facilitator's http:// or https:// URL)");
  }
  const protocol = URL.canParse(url) ? new URL(url).protocol : "";
  if (protocol !== "http:" && protocol !== "https:") {
    throw new ConfigError("Z402_FACILITATOR_URL: expected an http:// or https:// URL");
  }
  return url;
}

function readKeysFile(configured: string): Record<string, unknown> {
  const path = pathOf(configured);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? "unknown error";
    throw new ConfigError(`Z402_MERCHANT_KEYS_FILE: cannot read ${path} (${code})`);
  }
  // JSON.parse quotes the start of its input in its error, which here could be a key
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ConfigError(`Z402_MERCHANT_KEYS_FILE: ${path} is not valid JSON`);
  }
  if (!isRecord(parsed)) {
    throw new ConfigError(`Z402_MERCHANT_KEYS_FILE: ${path} must hold the JSON object that zdecrypt keygen prints`);
  }
  return parsed;
}

/** The explicit variable wins, and the keys file is opened only when it is missing */
function payToOf(env: Env, profile: Profile): string {
  let payTo = read(env, "Z402_PAY_TO");
  let origin = "";
  if (payTo === undefined) {
    const file = read(env, "Z402_MERCHANT_KEYS_FILE");
    if (file === undefined) {
      throw new ConfigError(
        "Z402_PAY_TO is required (the merchant's shielded-only unified address, or set Z402_MERCHANT_KEYS_FILE to a zdecrypt keygen JSON)",
      );
    }
    const address = readKeysFile(file).orchardOnlyAddress;
    if (typeof address !== "string" || address === "") {
      throw new ConfigError('Z402_PAY_TO is not set and Z402_MERCHANT_KEYS_FILE has no "orchardOnlyAddress" string');
    }
    payTo = address;
    origin = " (from Z402_MERCHANT_KEYS_FILE)";
  }
  if (!isValidPayTo(payTo, profile.network)) {
    throw new ConfigError(
      `Z402_PAY_TO${origin}: not a shielded-only unified address for ${profile.network} (expected ${profile.payToHint})`,
    );
  }
  return payTo;
}

function priceOf(env: Env): bigint {
  const raw = read(env, "Z402_PRICE_ZAT");
  if (raw === undefined) return DEFAULT_PRICE_ZAT;
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

function hostOf(env: Env): string {
  const host = read(env, "Z402_API_HOST") ?? DEFAULT_HOST;
  if (host.trim() === "") throw new ConfigError("Z402_API_HOST: must not be blank");
  return host;
}

function portOf(env: Env): number {
  const raw = read(env, "Z402_API_PORT");
  if (raw === undefined) return DEFAULT_PORT;
  const port = PORT_RE.test(raw) ? Number(raw) : Number.NaN;
  if (!(port <= 65535)) throw new ConfigError("Z402_API_PORT: expected a whole number from 0 to 65535");
  return port;
}

/** Reads and checks the environment, throwing a ConfigError that names the variable */
export function loadConfig(env: Env): ApiOptions {
  const profile = profileOf(env);
  return {
    network: profile.network,
    facilitatorUrl: facilitatorUrlOf(env),
    facilitatorToken: read(env, "Z402_FACILITATOR_TOKEN"),
    payTo: payToOf(env, profile),
    priceZat: priceOf(env),
    host: hostOf(env),
    port: portOf(env),
  };
}
