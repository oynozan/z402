/** This service's own variables (design §4.2). The shared Z402_* ones are read by loadServiceEnv from the kit. */
import { ConfigError, read, readInt, type Env } from "@z402/service-kit";
import express from "express";

export interface MarkdownConfig {
  /** Ports a page URL and every redirect may use */
  allowedPorts: ReadonlySet<number>;
  /** Largest page body, counted as received and again after decompression */
  maxBytes: number;
  /** Largest markdown answer; a longer one is cut and marked truncated */
  maxMarkdownBytes: number;
  /** One deadline for a page fetch (DNS, connections, redirects, body), and another for its conversion */
  timeoutMs: number;
  maxRedirects: number;
  /** Page fetches per minute per client IP (an IPv6 client counts per /64); cache hits are free */
  ratePerMin: number;
  /** Pages fetched and converted at once */
  maxConcurrent: number;
  /** Conversion worker threads, each converting one page at a time */
  convertWorkers: number;
  /** Heap limit of each conversion worker, which also sets how many tags a page may have (maxTagsFor) */
  workerHeapMb: number;
  cacheMs: number;
  cacheEntries: number;
  /** Markdown the cache holds at most, in UTF-8 bytes (the newest page is always kept) */
  cacheBytes: number;
  userAgent: string;
  /** Express "trust proxy": which proxies may name the client IP that the rate limit counts */
  trustProxy: boolean | number | string;
}

const MiB = 1024 * 1024;
const PORT_RE = /^[1-9][0-9]{0,4}$/;
const HEADER_VALUE_RE = /^[\x20-\x7e]{1,256}$/;

function portsOf(env: Env): ReadonlySet<number> {
  const name = "MARKDOWN_ALLOWED_PORTS";
  const raw = read(env, name) ?? "80,443,8080,8443";
  const ports = raw.split(",").map((part) => {
    const text = part.trim();
    const port = PORT_RE.test(text) ? Number(text) : Number.NaN;
    if (!(port <= 65535)) throw new ConfigError(`${name}: expected comma-separated ports from 1 to 65535`);
    return port;
  });
  return new Set(ports);
}

function userAgentOf(env: Env): string {
  const value = (read(env, "MARKDOWN_USER_AGENT") ?? "z402-markdown/0.1").trim();
  if (!HEADER_VALUE_RE.test(value)) {
    throw new ConfigError("MARKDOWN_USER_AGENT: expected 1 to 256 printable ASCII characters");
  }
  return value;
}

function trustProxyOf(env: Env): boolean | number | string {
  const name = "MARKDOWN_TRUST_PROXY";
  const raw = read(env, name)?.trim();
  if (raw === undefined || raw === "" || raw === "false") return false;
  if (raw === "true") return true;
  if (/^[0-9]{1,3}$/.test(raw)) return Number(raw);
  try {
    // Express compiles the value when it is set, which is where a bad address list throws
    express().set("trust proxy", raw);
  } catch (e) {
    throw new ConfigError(`${name}: ${e instanceof Error ? e.message : "not a trust proxy value"}`);
  }
  return raw;
}

/** Reads and checks MARKDOWN_*, throwing a ConfigError that names the variable at fault */
export function loadMarkdownConfig(env: Env): MarkdownConfig {
  return {
    allowedPorts: portsOf(env),
    maxBytes: readInt(env, "MARKDOWN_MAX_BYTES", 5 * MiB, 1024, 64 * MiB),
    maxMarkdownBytes: readInt(env, "MARKDOWN_MAX_MARKDOWN_BYTES", MiB, 1024, 16 * MiB),
    timeoutMs: readInt(env, "MARKDOWN_TIMEOUT_MS", 15_000, 100, 120_000),
    maxRedirects: readInt(env, "MARKDOWN_MAX_REDIRECTS", 5, 0, 20),
    ratePerMin: readInt(env, "MARKDOWN_RATE_PER_MIN", 30, 1, 100_000),
    maxConcurrent: readInt(env, "MARKDOWN_MAX_CONCURRENT", 4, 1, 64),
    // One worker of 192 MB keeps the whole service inside a 512 MB container, whatever the page
    convertWorkers: readInt(env, "MARKDOWN_CONVERT_WORKERS", 1, 1, 16),
    workerHeapMb: readInt(env, "MARKDOWN_WORKER_HEAP_MB", 192, 128, 4096),
    // At least a second, since the paid retry of a page is served from the cache
    cacheMs: readInt(env, "MARKDOWN_CACHE_MS", 60_000, 1_000, 86_400_000),
    cacheEntries: readInt(env, "MARKDOWN_CACHE_ENTRIES", 100, 1, 100_000),
    cacheBytes: readInt(env, "MARKDOWN_CACHE_BYTES", 32 * MiB, MiB, 1024 * MiB),
    userAgent: userAgentOf(env),
    trustProxy: trustProxyOf(env),
  };
}
