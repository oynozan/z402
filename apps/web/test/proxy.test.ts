import { describe, expect, test } from "vitest";
import { siteOrigin } from "../src/lib/origin";
import { DEFAULT_DISCOVERY_URL, allowedPath, discoveryBase, upstreamUrl } from "../src/lib/proxy";

describe("discoveryBase", () => {
  test("defaults to the local discovery service", () => {
    expect(discoveryBase(undefined)).toBe(DEFAULT_DISCOVERY_URL);
    expect(discoveryBase("  ")).toBe(DEFAULT_DISCOVERY_URL);
  });

  test("drops trailing slashes", () => {
    expect(discoveryBase("http://discovery:4030/")).toBe("http://discovery:4030");
    expect(discoveryBase("http://discovery:4030//")).toBe("http://discovery:4030");
  });
});

describe("allowedPath", () => {
  test("passes resources and status only", () => {
    expect(allowedPath(["resources"])).toBe("resources");
    expect(allowedPath(["status"])).toBe("status");
  });

  test("refuses every other path", () => {
    for (const segments of [undefined, [], ["health"], ["search"], ["resources", "x"], [".."], ["", "status"], ["Status"]]) {
      expect(allowedPath(segments)).toBeNull();
    }
  });
});

describe("upstreamUrl", () => {
  const base = "http://127.0.0.1:4030";

  test("keeps the query of a resources request", () => {
    expect(upstreamUrl(base, ["resources"], "?type=http&limit=5")).toBe(
      "http://127.0.0.1:4030/discovery/resources?type=http&limit=5",
    );
    expect(upstreamUrl(base, ["status"], "")).toBe("http://127.0.0.1:4030/discovery/status");
    expect(upstreamUrl(base, ["status"], "?")).toBe("http://127.0.0.1:4030/discovery/status");
  });

  test("returns null for a path outside the allowlist", () => {
    expect(upstreamUrl(base, ["..", "health"], "")).toBeNull();
    expect(upstreamUrl(base, ["health"], "?x=1")).toBeNull();
  });
});

describe("siteOrigin", () => {
  const from = (headers: Record<string, string>) => (name: string) => headers[name] ?? null;

  test("uses Host over plain http", () => {
    expect(siteOrigin(from({ host: "localhost:3412" }))).toBe("http://localhost:3412");
  });

  test("prefers the first forwarded host and scheme", () => {
    expect(
      siteOrigin(from({ host: "web:3000", "x-forwarded-host": "z402.example, proxy", "x-forwarded-proto": "https,http" })),
    ).toBe("https://z402.example");
  });

  test("ignores a malformed host or scheme", () => {
    expect(siteOrigin(from({ host: "evil.test/<script>", "x-forwarded-proto": "javascript" }))).toBe(
      "http://localhost:3000",
    );
    expect(siteOrigin(from({ host: "[::1]:3000" }))).toBe("http://[::1]:3000");
  });
});
