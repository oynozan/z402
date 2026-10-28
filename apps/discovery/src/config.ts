export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export type Env = Record<string, string | undefined>;

export const PROBE_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"] as const;
export type ProbeMethod = (typeof PROBE_METHODS)[number];

export function isProbeMethod(x: string): x is ProbeMethod {
  return (PROBE_METHODS as readonly string[]).includes(x);
}

export interface Target {
  method: ProbeMethod;
  url: string;
}

export interface DiscoveryConfig {
  /** Base URLs of the kit-based services, in the order they are listed */
  services: string[];
  /** Paid routes that are not built on the kit */
  targets: Target[];
  refreshMs: number;
  timeoutMs: number;
  host: string;
  port: number;
}

export const DEFAULT_REFRESH_MS = 30_000;
export const DEFAULT_TIMEOUT_MS = 5_000;
export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 4030;

const WHOLE_RE = /^(0|[1-9][0-9]{0,15})$/;
const TARGET_RE = /^(\S+)\s+(\S+)$/;

/** The value of `name`, or undefined when it is unset or empty */
function read(env: Env, name: string): string | undefined {
  const value = env[name];
  return value === undefined || value === "" ? undefined : value;
}

/** The comma-separated entries of `name`, trimmed, with blank ones dropped */
function readList(env: Env, name: string): string[] {
  return (read(env, name) ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

/** A whole number within [min, max], `fallback` when unset */
function readInt(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = read(env, name);
  if (raw === undefined) return fallback;
  const value = WHOLE_RE.test(raw) ? Number(raw) : Number.NaN;
  if (!(value >= min && value <= max)) throw new ConfigError(`${name}: expected a whole number from ${min} to ${max}`);
  return value;
}

/** Errors point at the entry by position and never quote it, since a URL may carry credentials */
function httpUrl(name: string, raw: string, entry: number): URL {
  const url = URL.canParse(raw) ? new URL(raw) : undefined;
  if (url === undefined || (url.protocol !== "http:" && url.protocol !== "https:")) {
    throw new ConfigError(`${name}: entry ${entry} is not an http:// or https:// URL`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new ConfigError(`${name}: entry ${entry} must not contain credentials`);
  }
  if (url.hash !== "") throw new ConfigError(`${name}: entry ${entry} must not have a fragment`);
  return url;
}

function serviceUrls(entries: string[]): string[] {
  const bases: string[] = [];
  entries.forEach((raw, i) => {
    const url = httpUrl("DISCOVERY_SERVICES", raw, i + 1);
    if (url.search !== "") throw new ConfigError(`DISCOVERY_SERVICES: entry ${i + 1} must not have a query string`);
    const base = `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
    const first = bases.indexOf(base);
    if (first >= 0) throw new ConfigError(`DISCOVERY_SERVICES: entry ${i + 1} repeats entry ${first + 1}`);
    bases.push(base);
  });
  return bases;
}

function targetList(entries: string[]): Target[] {
  const targets: Target[] = [];
  entries.forEach((entry, i) => {
    const parts = TARGET_RE.exec(entry);
    const method = parts?.[1]?.toUpperCase() ?? "";
    if (parts === null || !isProbeMethod(method)) {
      throw new ConfigError(
        `DISCOVERY_TARGETS: entry ${i + 1} must look like "GET http://host:port/path" with a method of ${PROBE_METHODS.join(", ")}`,
      );
    }
    const url = httpUrl("DISCOVERY_TARGETS", parts[2] ?? "", i + 1).href;
    const first = targets.findIndex((t) => t.method === method && t.url === url);
    if (first >= 0) throw new ConfigError(`DISCOVERY_TARGETS: entry ${i + 1} repeats entry ${first + 1}`);
    targets.push({ method, url });
  });
  return targets;
}

/** Reads and checks the environment, throwing a ConfigError that names the variable at fault */
export function loadConfig(env: Env): DiscoveryConfig {
  const services = serviceUrls(readList(env, "DISCOVERY_SERVICES"));
  const targets = targetList(readList(env, "DISCOVERY_TARGETS"));
  if (services.length === 0 && targets.length === 0) {
    throw new ConfigError(
      "DISCOVERY_SERVICES is required (comma-separated service URLs such as http://127.0.0.1:4031), or set DISCOVERY_TARGETS",
    );
  }
  const refreshMs = readInt(env, "DISCOVERY_REFRESH_MS", DEFAULT_REFRESH_MS, 1_000, 86_400_000);
  const timeoutMs = readInt(env, "DISCOVERY_TIMEOUT_MS", DEFAULT_TIMEOUT_MS, 1, 60_000);
  const host = read(env, "HOST") ?? DEFAULT_HOST;
  if (host.trim() === "") throw new ConfigError("HOST: must not be blank");
  const port = readInt(env, "PORT", DEFAULT_PORT, 0, 65535);
  return { services, targets, refreshMs, timeoutMs, host, port };
}
