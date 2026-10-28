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
  ProtocolError,
  type Terms,
  type ZcashNetwork,
} from "@z402/protocol";
import { MAX_PAY_TO_LENGTH } from "./payTo.js";

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
  /** Where the registry and the ledgers of the registered providers live */
  providersDir: string;
  /** The most providers that can register, the operator not counted */
  maxProviders: number;
  /** Bearer token that POST /providers requires, and undefined leaves registration open to anyone */
  registrationToken: string | undefined;
  /** False answers POST /providers with 403 registration_disabled, as mainnet does with no token and no opt-in */
  registrationEnabled: boolean;
  host: string;
  port: number;
  terms: Terms;
  /** Settings that work but put something at risk, which main prints before the startup checks */
  warnings: string[];
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

/** The most characters a viewing key may have, which is what the provider registry holds */
const MAX_UIVK_LENGTH = 1024;
const DEFAULT_MAX_PROVIDERS = 32;
const MAX_PROVIDERS_LIMIT = 1000;
/** Characters a registration token needs, since nothing limits how often a caller may guess one */
const MIN_REGISTRATION_TOKEN_LENGTH = 32;
const OPEN_REGISTRATION = "POST /providers is open to anyone: set Z402_REGISTRATION_TOKEN to require a token";
const CLOSED_REGISTRATION =
  "POST /providers answers 403 registration_disabled on mainnet: set Z402_REGISTRATION_TOKEN to require a token, " +
  "or Z402_REGISTRATION_OPEN=1 to let anyone register";
const DEFAULT_ZDECRYPT_BIN = "crates/zdecrypt/target/release/zdecrypt";
const BRANCH_ID_RE = /^[0-9a-f]{8}$/i;
const PORT_RE = /^(0|[1-9][0-9]{0,4})$/;
const COUNT_RE = /^(0|[1-9][0-9]{0,9})$/;
/** An RFC 6750 b64token, the only token an Authorization header can carry and match */
const B64TOKEN = /^[A-Za-z0-9\-._~+/]+=*$/;

const TERM_VARIABLES = [
  { variable: "Z402_WINDOW_ZAT", key: "windowZat", whole: false },
  { variable: "Z402_CREDIT_RATIO_BPS", key: "creditRatioBps", whole: true },
  { variable: "Z402_CREDIT_CAP_ZAT", key: "creditCapZat", whole: false },
  { variable: "Z402_ZERO_CONF_MIN_EXPIRY_BLOCKS", key: "zeroConfMinExpiryBlocks", whole: true },
] as const;

/** True when `uivk` has the shape of a viewing key of `network`, which is all that is known without zdecrypt */
export function isValidUivk(uivk: string, network: string): boolean {
  const profile = Object.values(PROFILES).find((p) => p.network === network);
  return profile !== undefined && uivk.length <= MAX_UIVK_LENGTH && profile.ivk.test(uivk);
}

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

interface KeysFile {
  fields: Record<string, unknown>;
  path: string;
  /** What the file holds that the facilitator must not, the spending seed before the full viewing key */
  secret: string | undefined;
}

/** Reads the keys file, quoting none of it in an error */
function readKeysFile(env: Env): KeysFile | undefined {
  const configured = read(env, "Z402_MERCHANT_KEYS_FILE");
  if (configured === undefined) return undefined;
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
  const secret = Object.hasOwn(parsed, "seedHex")
    ? "the spending seed"
    : Object.hasOwn(parsed, "ufvk")
      ? "the full viewing key"
      : undefined;
  return { fields: parsed, path, secret };
}

/** localhost, 127.0.0.0/8 or ::1, with or without the brackets a URL puts around an IPv6 address */
function isLoopback(host: string): boolean {
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  return bare.toLowerCase() === "localhost" || bare === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(bare);
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

function maxProvidersOf(env: Env): number {
  const raw = read(env, "Z402_MAX_PROVIDERS");
  if (raw === undefined) return DEFAULT_MAX_PROVIDERS;
  const count = COUNT_RE.test(raw) ? Number(raw) : Number.NaN;
  if (!(count <= MAX_PROVIDERS_LIMIT)) {
    throw new ConfigError(`Z402_MAX_PROVIDERS: expected a whole number from 0 to ${MAX_PROVIDERS_LIMIT}`);
  }
  return count;
}

function registrationTokenOf(env: Env): string | undefined {
  const token = read(env, "Z402_REGISTRATION_TOKEN");
  if (token !== undefined && !B64TOKEN.test(token)) {
    throw new ConfigError(
      "Z402_REGISTRATION_TOKEN: must be one token of letters, digits and -._~+/ (no spaces or control characters)",
    );
  }
  if (token !== undefined && token.length < MIN_REGISTRATION_TOKEN_LENGTH) {
    throw new ConfigError(
      `Z402_REGISTRATION_TOKEN: must be at least ${MIN_REGISTRATION_TOKEN_LENGTH} characters, ` +
        "for example the output of openssl rand -hex 32",
    );
  }
  return token;
}

/** Whether the operator opted in to open registration, which is exactly 1 or nothing */
function openRegistrationOf(env: Env): boolean {
  const raw = read(env, "Z402_REGISTRATION_OPEN");
  if (raw !== undefined && raw !== "1") throw new ConfigError("Z402_REGISTRATION_OPEN: expected 1, or leave it unset");
  return raw === "1";
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
  const parsed = URL.canParse(url) ? new URL(url) : undefined;
  if (parsed === undefined || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
    throw new ConfigError("Z402_LWD_URL: expected an http:// or https:// URL");
  }
  // Regtest keeps plaintext to any host, since its endpoint is often another container of the same compose network
  if (parsed.protocol === "http:" && profile.network !== NETWORK_REGTEST && !isLoopback(parsed.hostname)) {
    throw new ConfigError(
      `Z402_LWD_URL: plaintext http:// is allowed only to a loopback host on ${profile.network}; use https://`,
    );
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
  const warnings: string[] = [];

  // The explicit variable wins, and the file is opened only for what is still missing
  let file: KeysFile | null | undefined;
  const fromFile = (field: string): string | undefined => {
    if (file === undefined) {
      file = readKeysFile(env) ?? null;
      if (file?.secret !== undefined) {
        const advice =
          `Z402_MERCHANT_KEYS_FILE: ${file.path} holds ${file.secret}; ` +
          "give the facilitator only uivk and orchardOnlyAddress, or set Z402_UIVK and Z402_PAY_TO";
        // Whoever breaks into the network-facing facilitator gets what it holds, which must not be real money
        if (network === NETWORK_MAINNET) throw new ConfigError(advice);
        warnings.push(advice);
      }
    }
    const value = file?.fields[field];
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
        ? `${variable} is required (${hint}); set Z402_UIVK and Z402_PAY_TO, ` +
            "or Z402_MERCHANT_KEYS_FILE to a file holding only uivk and orchardOnlyAddress"
        : `${variable} is not set and Z402_MERCHANT_KEYS_FILE has no "${field}" string`,
    );
  };

  const pay = keyed("Z402_PAY_TO", "orchardOnlyAddress", "the shielded-only unified address deposits go to");
  if (pay.value.length > MAX_PAY_TO_LENGTH) {
    throw new ConfigError(`Z402_PAY_TO${pay.origin}: must be at most ${MAX_PAY_TO_LENGTH} characters`);
  }
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
  if (!B64TOKEN.test(authToken)) {
    throw new ConfigError(
      "Z402_FACILITATOR_TOKEN: must be one token of letters, digits and -._~+/ (no spaces or control characters)",
    );
  }

  const lwdUrl = lwdUrlOf(env, profile);
  const lwdHost = new URL(lwdUrl).hostname;
  if (network === NETWORK_MAINNET && !isLoopback(lwdHost)) {
    warnings.push(
      `Z402_LWD_URL points at ${lwdHost}: the facilitator trusts it for whether a deposit exists and how deep it is ` +
        "mined; for real money use a node you operate",
    );
  }
  const expectedBranchId = branchIdOf(env, profile);
  const zdecryptBin = pathOf(read(env, "Z402_ZDECRYPT_BIN") ?? DEFAULT_ZDECRYPT_BIN);
  const ledgerPath = pathOf(read(env, "Z402_LEDGER") ?? `.data/facilitator-ledger.${name}.jsonl`);
  const providersDir = pathOf(read(env, "Z402_PROVIDERS_DIR") ?? `.data/providers.${name}`);
  const maxProviders = maxProvidersOf(env);
  const registrationToken = registrationTokenOf(env);
  const optedIn = openRegistrationOf(env);
  const host = read(env, "Z402_FACILITATOR_HOST") ?? "127.0.0.1";
  if (host.trim() === "") throw new ConfigError("Z402_FACILITATOR_HOST: must not be blank");
  if (!isLoopback(host)) {
    warnings.push(
      `Z402_FACILITATOR_HOST: ${host} is not a loopback host, so the facilitator and its bearer token are reachable ` +
        "over plain http",
    );
  }
  const port = portOf(env);
  // Never read or checked, since each provider prices its own routes
  if (read(env, "Z402_PRICE_ZAT") !== undefined) {
    warnings.push("Z402_PRICE_ZAT is ignored: each provider prices its own routes");
  }
  const terms = termsOf(env);

  // Anyone may take the provider slots while registration is open, and a mainnet facilitator waits to be told so
  const open = registrationToken === undefined && maxProviders > 0;
  const registrationEnabled = !(open && network === NETWORK_MAINNET && !optedIn);
  if (open) warnings.push(registrationEnabled ? OPEN_REGISTRATION : CLOSED_REGISTRATION);

  return {
    network,
    payTo: pay.value,
    uivk: key.value,
    authToken,
    lwdUrl,
    expectedBranchId,
    zdecryptBin,
    ledgerPath,
    providersDir,
    maxProviders,
    registrationToken,
    registrationEnabled,
    host,
    port,
    terms,
    warnings,
  };
}
