import { describe, expect, test } from "vitest";
import { siteOrigin } from "../src/lib/origin";
import { DEFAULT_DISCOVERY_URL, allowedPath, discoveryBase, forwardedQuery, upstreamUrl } from "../src/lib/proxy";

describe("discoveryBase", () => {
  test("defaults to the local facilitator", () => {
    expect(DEFAULT_DISCOVERY_URL).toBe("http://127.0.0.1:4022");
    expect(discoveryBase(undefined)).toBe(DEFAULT_DISCOVERY_URL);
    expect(discoveryBase("  ")).toBe(DEFAULT_DISCOVERY_URL);
  });

  test("drops trailing slashes", () => {
    expect(discoveryBase("http://facilitator:4022/")).toBe("http://facilitator:4022");
    expect(discoveryBase("http://facilitator:4022//")).toBe("http://facilitator:4022");
  });
});

describe("allowedPath", () => {
  test("passes the Bazaar's list and search only", () => {
    expect(allowedPath(["resources"])).toBe("resources");
    expect(allowedPath(["search"])).toBe("search");
  });

  test("refuses every other path", () => {
    const refused = [undefined, [], ["status"], ["health"], ["resources", "x"], [".."], ["", "search"], ["Search"]];
    for (const segments of [...refused, ["constructor"], ["__proto__"], ["hasOwnProperty"]]) {
      expect(allowedPath(segments)).toBeNull();
    }
  });
});

describe("forwardedQuery", () => {
  test("keeps the list's documented parameters, in order, and drops the rest", () => {
    expect(forwardedQuery("resources", "?type=http&limit=5&token=x&offset=2&query=llm&cursor=3")).toBe(
      "?type=http&limit=5&offset=2",
    );
    expect(forwardedQuery("resources", "?payTo=u1&scheme=prepaid-voucher&network=zcash%3Aregtest&extensions=bazaar")).toBe(
      "?payTo=u1&scheme=prepaid-voucher&network=zcash%3Aregtest&extensions=bazaar",
    );
  });

  test("keeps the search's documented parameters, which take a cursor and no offset", () => {
    expect(forwardedQuery("search", "?query=drop+box&limit=2&offset=4&cursor=20&type=http")).toBe(
      "?query=drop+box&limit=2&cursor=20&type=http",
    );
  });

  test("passes a value as it came, and a parameter as often as it came", () => {
    expect(forwardedQuery("search", "?query=a%26b%3Dc%20%C3%A9")).toBe("?query=a%26b%3Dc+%C3%A9");
    expect(forwardedQuery("resources", "?limit=1&limit=2")).toBe("?limit=1&limit=2");
  });

  test("is empty when nothing is left", () => {
    expect(forwardedQuery("resources", "")).toBe("");
    expect(forwardedQuery("resources", "?")).toBe("");
    expect(forwardedQuery("resources", "?debug=1")).toBe("");
  });
});

describe("upstreamUrl", () => {
  const base = "http://127.0.0.1:4022";

  test("sends a list or a search on to the Bazaar with its documented parameters", () => {
    expect(upstreamUrl(base, ["resources"], "?type=http&limit=5&secret=1")).toBe(
      "http://127.0.0.1:4022/discovery/resources?type=http&limit=5",
    );
    expect(upstreamUrl(base, ["resources"], "")).toBe("http://127.0.0.1:4022/discovery/resources");
    expect(upstreamUrl(base, ["search"], "?query=llm")).toBe("http://127.0.0.1:4022/discovery/search?query=llm");
  });

  test("returns null for a path outside the allowlist", () => {
    expect(upstreamUrl(base, ["status"], "")).toBeNull();
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
