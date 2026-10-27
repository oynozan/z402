import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, test } from "vitest";
import { loadConfig } from "../src/config.js";

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
    });
    expect(config).toEqual({
      network: "zcash:testnet",
      facilitatorUrl: "https://facilitator.example:8443/z402",
      facilitatorToken: "s3cret",
      payTo: `utest1${"q".repeat(60)}`,
      priceZat: 700n,
      host: "0.0.0.0",
      port: 8080,
    });
  });

  test("an empty variable counts as unset", () => {
    const config = loadConfig(env({ Z402_NETWORK: "", Z402_FACILITATOR_TOKEN: "", Z402_PRICE_ZAT: "", Z402_API_PORT: "" }));
    expect(config).toMatchObject({ network: "zcash:regtest", facilitatorToken: undefined, priceZat: 500n, port: 4021 });
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
