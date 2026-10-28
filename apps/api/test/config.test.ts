import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, test, vi } from "vitest";
import { ConfigError, loadConfig } from "../src/config.js";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const PAY_TO = `uregtest1${"q".repeat(60)}`;
const FACILITATOR_URL = "http://127.0.0.1:4022";
/** In every keys file below, and in no message or result */
const UIVK = "uivkregtest1testfixturenotakey";

const scratch = mkdtempSync(join(tmpdir(), "z402-api-config-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function keysFile(name: string, content: string): string {
  const path = join(scratch, name);
  writeFileSync(path, content);
  return path;
}

const keys = (orchardOnlyAddress: unknown) =>
  JSON.stringify({ seedHex: "00".repeat(32), ufvk: "uviewregtest1fixture", uivk: UIVK, orchardOnlyAddress });

const env = (over: Record<string, string | undefined> = {}) => ({
  Z402_FACILITATOR_URL: FACILITATOR_URL,
  Z402_PAY_TO: PAY_TO,
  ...over,
});

describe("loadConfig", () => {
  test("the defaults", () => {
    expect(loadConfig(env())).toEqual({
      network: "zcash:regtest",
      facilitatorUrl: FACILITATOR_URL,
      facilitatorToken: undefined,
      payTo: PAY_TO,
      priceZat: 500n,
      host: "127.0.0.1",
      port: 4021,
    });
  });

  test("every variable is read", () => {
    const config = loadConfig({
      Z402_NETWORK: "testnet",
      Z402_FACILITATOR_URL: "https://facilitator.example:8443/z402",
      Z402_FACILITATOR_TOKEN: "s3cret",
      Z402_PAY_TO: `utest1${"q".repeat(60)}`,
      Z402_PRICE_ZAT: "700",
      Z402_API_HOST: "0.0.0.0",
      Z402_API_PORT: "8080",
      Z402_API_PUBLIC_URL: "https://api.example.com:8443/z402/",
    });
    expect(config).toEqual({
      network: "zcash:testnet",
      facilitatorUrl: "https://facilitator.example:8443/z402",
      facilitatorToken: "s3cret",
      payTo: `utest1${"q".repeat(60)}`,
      priceZat: 700n,
      host: "0.0.0.0",
      port: 8080,
      publicUrl: "https://api.example.com:8443/z402",
    });
  });

  test("an empty variable counts as unset", () => {
    const config = loadConfig(
      env({
        Z402_NETWORK: "",
        Z402_FACILITATOR_TOKEN: "",
        Z402_PRICE_ZAT: "",
        Z402_API_PORT: "",
        Z402_API_PUBLIC_URL: "",
      }),
    );
    expect(config).toMatchObject({ network: "zcash:regtest", facilitatorToken: undefined, priceZat: 500n, port: 4021 });
    expect(config.publicUrl).toBeUndefined();
  });

  test.each([
    ["regtest", "zcash:regtest", PAY_TO],
    ["testnet", "zcash:testnet", `utest1${"q".repeat(60)}`],
    ["mainnet", "zcash:mainnet", `u1${"q".repeat(60)}`],
  ])("Z402_NETWORK %s is %s", (name, network, payTo) => {
    expect(loadConfig(env({ Z402_NETWORK: name, Z402_PAY_TO: payTo })).network).toBe(network);
  });

  test.each(["zcash:regtest", "Regtest", "devnet", "toString", "__proto__"])(
    "Z402_NETWORK %s is refused",
    (name) => {
      expect(() => loadConfig(env({ Z402_NETWORK: name }))).toThrow(/^Z402_NETWORK:/);
    },
  );

  test("Z402_FACILITATOR_URL is required", () => {
    expect(() => loadConfig(env({ Z402_FACILITATOR_URL: undefined }))).toThrow(/^Z402_FACILITATOR_URL is required/);
  });

  test.each(["127.0.0.1:4022", "ftp://127.0.0.1:4022", "not a url"])("Z402_FACILITATOR_URL %s is refused", (url) => {
    expect(() => loadConfig(env({ Z402_FACILITATOR_URL: url }))).toThrow(/^Z402_FACILITATOR_URL:/);
  });

  test.each([`utest1${"q".repeat(60)}`, `turegtest1${"q".repeat(60)}`, "uregtest1UPPER", ""])(
    "Z402_PAY_TO %s is refused on regtest",
    (payTo) => {
      // An empty value is unset, which leaves payTo missing
      expect(() => loadConfig(env({ Z402_PAY_TO: payTo }))).toThrow(/^Z402_PAY_TO/);
    },
  );

  test.each([
    ["0", /^Z402_PRICE_ZAT: must be at least 1 zat/],
    ["-5", /^Z402_PRICE_ZAT:/],
    ["05", /^Z402_PRICE_ZAT:/],
    ["1.5", /^Z402_PRICE_ZAT:/],
    ["2100000000000001", /^Z402_PRICE_ZAT:/],
  ])("Z402_PRICE_ZAT %s is refused", (price, error) => {
    expect(() => loadConfig(env({ Z402_PRICE_ZAT: price }))).toThrow(error);
  });

  test("Z402_API_HOST must not be blank", () => {
    expect(() => loadConfig(env({ Z402_API_HOST: "  " }))).toThrow(/^Z402_API_HOST:/);
  });

  test.each([
    ["0", 0],
    ["65535", 65535],
  ])("Z402_API_PORT %s is %d", (raw, port) => {
    expect(loadConfig(env({ Z402_API_PORT: raw })).port).toBe(port);
  });

  test.each(["65536", "-1", "080", "4021x", "1e3"])("Z402_API_PORT %s is refused", (raw) => {
    expect(() => loadConfig(env({ Z402_API_PORT: raw }))).toThrow(/^Z402_API_PORT:/);
  });
});

describe("Z402_API_PUBLIC_URL", () => {
  const publicUrl = (value: string | undefined) => loadConfig(env({ Z402_API_PUBLIC_URL: value })).publicUrl;

  test("is left out of the options when unset, so that the API declares nothing", () => {
    expect(publicUrl(undefined)).toBeUndefined();
    expect(publicUrl("")).toBeUndefined();
  });

  test.each([
    ["https://api.example.com", "https://api.example.com"],
    ["https://api.example.com/", "https://api.example.com"],
    ["https://api.example.com///", "https://api.example.com"],
    ["http://127.0.0.1:4021", "http://127.0.0.1:4021"],
    ["http://api:4021/", "http://api:4021"],
    ["http://[::1]:4021", "http://[::1]:4021"],
    ["HTTPS://API.example.com", "HTTPS://API.example.com"],
    // A path is kept, since the API may sit behind a proxy that serves it under one
    ["https://example.com/z402/", "https://example.com/z402"],
    ["https://example.com/a%20b/c", "https://example.com/a%20b/c"],
  ])("%s is accepted as %s", (raw, expected) => {
    expect(publicUrl(raw)).toBe(expected);
  });

  test.each([
    ["no scheme", "api.example.com"],
    ["no scheme and a port", "api.example.com:4021"],
    ["a relative path", "/chunk"],
    ["not a URL", "not a url"],
    ["another scheme", "ftp://api.example.com"],
    ["a scheme and nothing else", "https://"],
    ["no host", "https:///chunk"],
    ["a port that is no port", "https://api.example.com:port"],
    ["a port past 65535", "https://api.example.com:99999"],
    ["whitespace around it", " https://api.example.com "],
    ["whitespace in the path", "https://api.example.com/a b"],
    // The URL parser reads a backslash as a slash, which the catalog does not
    ["a backslash", "https://api.example.com\\z402"],
  ])("%s is refused as not an http(s) URL", (_name, raw) => {
    expect(() => publicUrl(raw)).toThrow(new ConfigError("Z402_API_PUBLIC_URL: expected an http:// or https:// URL"));
  });

  test.each([
    ["a username", "https://agent@api.example.com"],
    ["a username and a password", "https://agent:hunter2@api.example.com"],
    ["a password alone", "https://:hunter2@api.example.com"],
    ["an empty userinfo", "https://@api.example.com"],
    ["credentials and a path", "http://agent:hunter2@api.example.com/z402"],
  ])("%s is refused without quoting it", (_name, raw) => {
    expect(() => publicUrl(raw)).toThrow(new ConfigError("Z402_API_PUBLIC_URL: must not carry credentials"));
  });

  test.each([
    ["a query", "https://api.example.com?key=hunter2"],
    ["a query after a path", "https://api.example.com/z402?key=hunter2"],
    ["an empty query", "https://api.example.com?"],
    ["an empty query after a slash", "https://api.example.com/?"],
    ["a fragment", "https://api.example.com#top"],
    ["an empty fragment", "https://api.example.com/#"],
    ["a query and a fragment", "https://api.example.com/z402?a=1#top"],
  ])("%s is refused without quoting it", (_name, raw) => {
    expect(() => publicUrl(raw)).toThrow(new ConfigError("Z402_API_PUBLIC_URL: must not have a query or a fragment"));
  });

  test("a value that would make a resource URL the catalog refuses is refused at start", () => {
    // The catalog takes a resource of at most 2048 characters, and /chunk is 6 of them
    const prefix = "https://api.example.com/";
    const longest = `${prefix}${"a".repeat(2048 - prefix.length - "/chunk".length)}`;
    expect(publicUrl(longest)).toBe(longest);
    expect(publicUrl(`${longest}/`)).toBe(longest);
    const message = "Z402_API_PUBLIC_URL: with /chunk it makes a resource URL over 2048 characters";
    expect(() => publicUrl(`${longest}a`)).toThrow(new ConfigError(message));
  });

  test("no refusal quotes the value", () => {
    for (const raw of ["https://agent:hunter2@api.example.com", "https://api.example.com?key=hunter2", "hunter2"]) {
      let message = "";
      try {
        publicUrl(raw);
      } catch (e) {
        message = e instanceof Error ? e.message : String(e);
      }
      expect(message).toMatch(/^Z402_API_PUBLIC_URL: /);
      expect(message).not.toContain("hunter2");
    }
  });
});

describe("payTo from Z402_MERCHANT_KEYS_FILE", () => {
  const noPayTo = (file: string) => env({ Z402_PAY_TO: undefined, Z402_MERCHANT_KEYS_FILE: file });

  test("is the file's orchardOnlyAddress", () => {
    expect(loadConfig(noPayTo(keysFile("keys.json", keys(PAY_TO)))).payTo).toBe(PAY_TO);
  });

  test("a relative path is taken from the repository root, not the working directory", () => {
    const path = keysFile("relative.json", keys(PAY_TO));
    expect(loadConfig(noPayTo(relative(REPO_ROOT, path))).payTo).toBe(PAY_TO);
  });

  test("Z402_PAY_TO wins and the file is then never opened", () => {
    expect(loadConfig(env({ Z402_MERCHANT_KEYS_FILE: join(scratch, "missing.json") })).payTo).toBe(PAY_TO);
  });

  describe("that holds more than the address", () => {
    const MAINNET_PAY_TO = `u1${"q".repeat(60)}`;
    const mainnet = (file: string) => ({
      Z402_NETWORK: "mainnet",
      Z402_FACILITATOR_URL: "https://facilitator.example:8443",
      Z402_MERCHANT_KEYS_FILE: file,
    });

    test("is refused on mainnet when it holds the spending seed", () => {
      const path = keysFile("mainnet-seed.json", keys(MAINNET_PAY_TO));
      expect(() => loadConfig(mainnet(path), () => undefined)).toThrow(
        new ConfigError(`Z402_MERCHANT_KEYS_FILE: ${path} holds the spending seed; the API needs only Z402_PAY_TO`),
      );
    });

    test("is refused on mainnet when it holds the full viewing key", () => {
      const content = JSON.stringify({ ufvk: "uview1fixture", orchardOnlyAddress: MAINNET_PAY_TO });
      const path = keysFile("mainnet-ufvk.json", content);
      expect(() => loadConfig(mainnet(path), () => undefined)).toThrow(
        new ConfigError(`Z402_MERCHANT_KEYS_FILE: ${path} holds the full viewing key; the API needs only Z402_PAY_TO`),
      );
    });

    test("loads on regtest with one warning", () => {
      const path = keysFile("regtest-seed.json", keys(PAY_TO));
      const warn = vi.fn<(message: string) => void>();
      expect(loadConfig(noPayTo(path), warn).payTo).toBe(PAY_TO);
      expect(warn.mock.calls).toEqual([
        [`Z402_MERCHANT_KEYS_FILE: ${path} holds the spending seed; the API needs only Z402_PAY_TO`],
      ]);
    });

    test("is warned about on stderr unless told otherwise", () => {
      const path = keysFile("default-warn.json", keys(PAY_TO));
      const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        loadConfig(noPayTo(path));
        expect(stderr).toHaveBeenCalledTimes(1);
        expect(String(stderr.mock.calls[0]?.[0])).toMatch(/holds the spending seed/);
      } finally {
        stderr.mockRestore();
      }
    });

    test("is neither opened nor warned about when Z402_PAY_TO is set, as the demo does", () => {
      const warn = vi.fn<(message: string) => void>();
      const seedFile = keysFile("demo-seed.json", keys(PAY_TO));
      expect(loadConfig(env({ Z402_MERCHANT_KEYS_FILE: seedFile }), warn).payTo).toBe(PAY_TO);
      expect(loadConfig(env({ Z402_MERCHANT_KEYS_FILE: join(scratch, "missing.json") }), warn).payTo).toBe(PAY_TO);
      expect(warn).not.toHaveBeenCalled();
    });
  });

  test("a file of only the address gives no warning, on mainnet too", () => {
    const address = `u1${"q".repeat(60)}`;
    const path = keysFile("address-only.json", JSON.stringify({ orchardOnlyAddress: address, uivk: "uivk1fixture" }));
    const warn = vi.fn<(message: string) => void>();
    const config = loadConfig(
      { Z402_NETWORK: "mainnet", Z402_FACILITATOR_URL: "https://f.example", Z402_MERCHANT_KEYS_FILE: path },
      warn,
    );
    expect(config.payTo).toBe(address);
    expect(warn).not.toHaveBeenCalled();
  });

  test("without either one, payTo is required", () => {
    expect(() => loadConfig(env({ Z402_PAY_TO: undefined }))).toThrow(/^Z402_PAY_TO is required/);
  });

  test("a file that cannot be read is named with its resolved path", () => {
    expect(() => loadConfig(noPayTo("no/such/keys.json"))).toThrow(
      `Z402_MERCHANT_KEYS_FILE: cannot read ${join(REPO_ROOT, "no/such/keys.json")} (ENOENT)`,
    );
  });

  test.each([
    ["not JSON", `{"uivk":"${UIVK}"`, /^Z402_MERCHANT_KEYS_FILE: .* is not valid JSON$/],
    ["a JSON array", "[]", /^Z402_MERCHANT_KEYS_FILE: .* must hold the JSON object/],
    ["no orchardOnlyAddress", keys(undefined), /^Z402_PAY_TO is not set and Z402_MERCHANT_KEYS_FILE has no/],
    ["an orchardOnlyAddress of another network", keys(`utest1${"q".repeat(60)}`), /^Z402_PAY_TO \(from Z402_MERCHANT_KEYS_FILE\):/],
  ])("a file with %s is refused without quoting it", (name, content, error) => {
    const path = keysFile(`${name.replace(/\W+/g, "-")}.json`, content);
    let message = "";
    try {
      loadConfig(noPayTo(path));
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).toMatch(error);
    expect(message).not.toContain(UIVK);
  });
});
