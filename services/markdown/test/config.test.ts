import { ConfigError } from "@z402-net/service-kit";
import { describe, expect, test } from "vitest";
import { loadMarkdownConfig } from "../src/config.js";

describe("loadMarkdownConfig", () => {
  test("defaults", () => {
    expect(loadMarkdownConfig({})).toEqual({
      allowedPorts: new Set([80, 443, 8080, 8443]),
      maxBytes: 5 * 1024 * 1024,
      maxMarkdownBytes: 1024 * 1024,
      timeoutMs: 15_000,
      maxRedirects: 5,
      ratePerMin: 30,
      maxConcurrent: 4,
      convertWorkers: 1,
      workerHeapMb: 192,
      cacheMs: 60_000,
      cacheEntries: 100,
      cacheBytes: 32 * 1024 * 1024,
      userAgent: "z402-markdown/0.1",
      trustProxy: false,
    });
  });

  test("reads every variable, and an empty one counts as unset", () => {
    const config = loadMarkdownConfig({
      MARKDOWN_ALLOWED_PORTS: " 443 , 8443",
      MARKDOWN_MAX_BYTES: "2048",
      MARKDOWN_MAX_MARKDOWN_BYTES: "4096",
      MARKDOWN_TIMEOUT_MS: "500",
      MARKDOWN_MAX_REDIRECTS: "0",
      MARKDOWN_RATE_PER_MIN: "5",
      MARKDOWN_MAX_CONCURRENT: "2",
      MARKDOWN_CONVERT_WORKERS: "3",
      MARKDOWN_WORKER_HEAP_MB: "512",
      MARKDOWN_CACHE_MS: "5000",
      MARKDOWN_CACHE_ENTRIES: "7",
      MARKDOWN_CACHE_BYTES: "2097152",
      MARKDOWN_USER_AGENT: "  agent/2  ",
      MARKDOWN_TRUST_PROXY: "",
    });
    expect(config).toMatchObject({
      allowedPorts: new Set([443, 8443]),
      maxBytes: 2048,
      maxMarkdownBytes: 4096,
      timeoutMs: 500,
      maxRedirects: 0,
      ratePerMin: 5,
      maxConcurrent: 2,
      convertWorkers: 3,
      workerHeapMb: 512,
      cacheMs: 5000,
      cacheEntries: 7,
      cacheBytes: 2 * 1024 * 1024,
      userAgent: "agent/2",
      trustProxy: false,
    });
  });

  test("MARKDOWN_TRUST_PROXY takes a hop count or the proxies' addresses, as Express does", () => {
    const trust = (value: string): unknown => loadMarkdownConfig({ MARKDOWN_TRUST_PROXY: value }).trustProxy;
    expect(trust("false")).toBe(false);
    expect(trust("1")).toBe(1);
    expect(trust("loopback")).toBe("loopback");
    expect(trust("10.0.0.0/8, 127.0.0.1")).toBe("10.0.0.0/8, 127.0.0.1");
  });

  test("every error names the variable at fault", () => {
    const bad: Record<string, string[]> = {
      MARKDOWN_ALLOWED_PORTS: [" ", "80,,443", "0", "65536", "http", "80;443"],
      MARKDOWN_MAX_BYTES: ["1", "5MiB", "-1"],
      MARKDOWN_MAX_MARKDOWN_BYTES: ["0"],
      MARKDOWN_TIMEOUT_MS: ["0", "120001"],
      MARKDOWN_MAX_REDIRECTS: ["21"],
      MARKDOWN_RATE_PER_MIN: ["0"],
      MARKDOWN_MAX_CONCURRENT: ["0", "65"],
      MARKDOWN_CONVERT_WORKERS: ["0", "17"],
      MARKDOWN_WORKER_HEAP_MB: ["127", "4097"],
      MARKDOWN_CACHE_MS: ["999"],
      MARKDOWN_CACHE_ENTRIES: ["0"],
      MARKDOWN_CACHE_BYTES: ["1048575"],
      MARKDOWN_USER_AGENT: ["agent\r\nX-Injected: 1", "é", "a".repeat(257)],
      // true takes the left-most X-Forwarded-For address, which the client writes itself even behind a proxy
      MARKDOWN_TRUST_PROXY: ["not-an-address", "true"],
    };
    for (const [name, values] of Object.entries(bad)) {
      for (const value of values) {
        let thrown: unknown;
        try {
          loadMarkdownConfig({ [name]: value });
        } catch (e) {
          thrown = e;
        }
        expect(thrown, `${name}=${JSON.stringify(value)}`).toBeInstanceOf(ConfigError);
        expect((thrown as Error).message.startsWith(`${name}:`), (thrown as Error).message).toBe(true);
      }
    }
  });
});
