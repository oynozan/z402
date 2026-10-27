/**
 * The facilitator's environment (design §4.7 step 1). Every problem names the variable at fault, and no message
 * ever carries the viewing key, the token or the contents of the keys file.
 */
import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEMO_TERMS,
  encodeTerms,
  isValidPayTo,
  NETWORK_MAINNET,
  NETWORK_REGTEST,
  NETWORK_TESTNET,
  parseTerms,
  parseZat,
  ProtocolError,
  type Terms,
  type ZcashNetwork,
} from "@z402/protocol";

/** The repository root, found from this file and never from the working directory, which `pnpm --filter` changes */
export const REPO_ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface FacilitatorEnv {
  network: ZcashNetwork;
  payTo: string;
  uivk: string;
  authToken: string;
  lwdUrl: string;
  /** Undefined only where no default exists (mainnet) and none was given, which skips the branch check */
  expectedBranchId: string | undefined;
  zdecryptBin: string;
  ledgerPath: string;
  host: string;
  port: number;
  priceZat: bigint;
  terms: Terms;
}

type Env = Record<string, string | undefined>;

interface Profile {
  network: ZcashNetwork;
  lwdUrl: string | undefined;
  branchId: string | undefined;
  /** ZIP 316 incoming viewing key prefixes, revision 0 then revision 2 */
  ivk: RegExp;
  ivkHint: string;
  payToHint: string;
}

// The prefixes are HRP_UNIFIED_IVK and HRP_UNIFIED_IVK_R2 of zcash_address 0.14.0 constants.rs
const PROFILES: Readonly<Record<string, Profile>> = {
  regtest: {
    network: NETWORK_REGTEST,
    lwdUrl: "http://127.0.0.1:28137",
    branchId: "37a5165b",
    ivk: /^(uivkregtest|uviregtest)1[02-9ac-hj-np-z]+$/,
    ivkHint: "uivkregtest1... or uviregtest1...",
    payToHint: "uregtest1... or zuregtest1...",
  },
  testnet: {
    network: NETWORK_TESTNET,
    lwdUrl: "https://testnet.zec.rocks:443",
    branchId: "77190ad9",
    ivk: /^(uivktest|uvitest)1[02-9ac-hj-np-z]+$/,
    ivkHint: "uivktest1... or uvitest1...",
    payToHint: "utest1... or zutest1...",
  },
  mainnet: {
    network: NETWORK_MAINNET,
    lwdUrl: undefined,
    branchId: undefined,
    ivk: /^(uivk|uvi)1[02-9ac-hj-np-z]+$/,
    ivkHint: "uivk1... or uvi1...",
    payToHint: "u1... or zu1...",
  },
};

const DEFAULT_ZDECRYPT_BIN = "crates/zdecrypt/target/release/zdecrypt";
const BRANCH_ID_RE = /^[0-9a-f]{8}$/i;
const PORT_RE = /^(0|[1-9][0-9]{0,4})$/;
const COUNT_RE = /^(0|[1-9][0-9]{0,9})$/;

const TERM_VARIABLES = [
  { variable: "Z402_WINDOW_ZAT", key: "windowZat", whole: false },
  { variable: "Z402_CREDIT_RATIO_BPS", key: "creditRatioBps", whole: true },
  { variable: "Z402_CREDIT_CAP_ZAT", key: "creditCapZat", whole: false },
  { variable: "Z402_ZERO_CONF_MIN_EXPIRY_BLOCKS", key: "zeroConfMinExpiryBlocks", whole: true },
] as const;

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

/** Reads the keys file, quoting none of it in an error */
function readKeysFile(env: Env): Record<string, unknown> {
  const configured = read(env, "Z402_MERCHANT_KEYS_FILE");
  if (configured === undefined) return {};
  const path = pathOf(configured);

  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? "unknown error";
    throw new ConfigError(`Z402_MERCHANT_KEYS_FILE: cannot read ${path} (${code})`);
  }
  // JSON.parse quotes the start of its input in its error, which here could be a seed
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

function termsOf(env: Env): Terms {
  const wire: Record<string, unknown> = { ...encodeTerms(DEMO_TERMS) };
  for (const { variable, key, whole } of TERM_VARIABLES) {
    const raw = read(env, variable);
    if (raw === undefined) continue;
    wire[key] = whole ? (COUNT_RE.test(raw) ? Number(raw) : Number.NaN) : raw;
    // Each variable is checked as it is set, on top of values that are known to be good
    try {
      parseTerms(wire);
    } catch (e) {
      if (e instanceof ProtocolError) throw new ConfigError(`${variable}: ${e.message}`);
      throw e;
    }
  }
  return parseTerms(wire);
}

function priceOf(env: Env): bigint {
  const raw = read(env, "Z402_PRICE_ZAT");
  if (raw === undefined) return 500n;
  let price: bigint;
  try {
    price = parseZat(raw);
  } catch (e) {
    if (e instanceof ProtocolError) throw new ConfigError(`Z402_PRICE_ZAT: ${e.message}`);
    throw e;
  }
  // A price of 0 would let a replayed voucher pass the increment check
  if (price < 1n) throw new ConfigError("Z402_PRICE_ZAT: must be at least 1 zat");
  return price;
}

function portOf(env: Env): number {
  const raw = read(env, "Z402_FACILITATOR_PORT");
  if (raw === undefined) return 4022;
  const port = PORT_RE.test(raw) ? Number(raw) : Number.NaN;
  if (!(port <= 65535)) throw new ConfigError("Z402_FACILITATOR_PORT: expected a whole number from 0 to 65535");
  return port;
}

function lwdUrlOf(env: Env, profile: Profile): string {
  const url = read(env, "Z402_LWD_URL") ?? profile.lwdUrl;
  if (url === undefined) throw new ConfigError("Z402_LWD_URL is required on mainnet (no public default is trusted)");
  const protocol = URL.canParse(url) ? new URL(url).protocol : "";
  if (protocol !== "http:" && protocol !== "https:") {
    throw new ConfigError("Z402_LWD_URL: expected an http:// or https:// URL");
  }
  return url;
}

function branchIdOf(env: Env, profile: Profile): string | undefined {
  const raw = read(env, "Z402_EXPECTED_BRANCH_ID");
  if (raw === undefined) return profile.branchId;
  if (!BRANCH_ID_RE.test(raw)) throw new ConfigError("Z402_EXPECTED_BRANCH_ID: expected 8 hex digits, e.g. 37a5165b");
  return raw.toLowerCase();
}

/** Reads and checks the environment, throwing a ConfigError that names the variable */
export function loadConfig(env: Env): FacilitatorEnv {
  const name = read(env, "Z402_NETWORK") ?? "regtest";
  const profile = Object.hasOwn(PROFILES, name) ? PROFILES[name] : undefined;
  if (profile === undefined) throw new ConfigError("Z402_NETWORK: expected regtest, testnet or mainnet");
  const { network } = profile;

  // The explicit variable wins, and the file is opened only for what is still missing
  let file: Record<string, unknown> | undefined;
  const fromFile = (field: string): string | undefined => {
    file ??= readKeysFile(env);
    const value = file[field];
    return typeof value === "string" && value !== "" ? value : undefined;
  };
  const keyed = (variable: string, field: string, hint: string): { value: string; origin: string } => {
    const explicit = read(env, variable);
    if (explicit !== undefined) return { value: explicit, origin: "" };
    const value = fromFile(field);
    if (value !== undefined) return { value, origin: " (from Z402_MERCHANT_KEYS_FILE)" };
    const configured = read(env, "Z402_MERCHANT_KEYS_FILE");
    throw new ConfigError(
      configured === undefined
        ? `${variable} is required (${hint}, or set Z402_MERCHANT_KEYS_FILE to a zdecrypt keygen JSON)`
        : `${variable} is not set and Z402_MERCHANT_KEYS_FILE has no "${field}" string`,
    );
  };

  const pay = keyed("Z402_PAY_TO", "orchardOnlyAddress", "the shielded-only unified address deposits go to");
  if (!isValidPayTo(pay.value, network)) {
    throw new ConfigError(
      `Z402_PAY_TO${pay.origin}: not a shielded-only unified address for ${network} (expected ${profile.payToHint})`,
    );
  }
  const key = keyed("Z402_UIVK", "uivk", "the merchant's unified incoming viewing key");
  if (!profile.ivk.test(key.value)) {
    throw new ConfigError(
      `Z402_UIVK${key.origin}: not a unified incoming viewing key for ${network} (expected ${profile.ivkHint})`,
    );
  }

  const authToken = read(env, "Z402_FACILITATOR_TOKEN");
  if (authToken === undefined)
    throw new ConfigError("Z402_FACILITATOR_TOKEN is required (the bearer token callers present)");

  const lwdUrl = lwdUrlOf(env, profile);
  const expectedBranchId = branchIdOf(env, profile);
  const zdecryptBin = pathOf(read(env, "Z402_ZDECRYPT_BIN") ?? DEFAULT_ZDECRYPT_BIN);
  const ledgerPath = pathOf(read(env, "Z402_LEDGER") ?? `.data/facilitator-ledger.${name}.jsonl`);
  const host = read(env, "Z402_FACILITATOR_HOST") ?? "127.0.0.1";
  if (host.trim() === "") throw new ConfigError("Z402_FACILITATOR_HOST: must not be blank");
  const port = portOf(env);
  const priceZat = priceOf(env);
  const terms = termsOf(env);

  return {
    network,
    payTo: pay.value,
    uivk: key.value,
    authToken,
    lwdUrl,
    expectedBranchId,
    zdecryptBin,
    ledgerPath,
    host,
    port,
    priceZat,
    terms,
  };
}
