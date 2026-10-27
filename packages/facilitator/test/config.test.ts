import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { NETWORK_MAINNET, NETWORK_REGTEST, NETWORK_TESTNET } from "@z402/protocol";
import { afterAll, describe, expect, test } from "vitest";
import { ConfigError, loadConfig } from "../src/config.js";

/** The repository root, taken from this file's own place in the tree and never from the working directory */
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** A string with the right prefix and charset, which is all loadConfig can check without zdecrypt */
const bech32 = (hrp: string, length = 60): string => `${hrp}1${"q".repeat(length)}`;

const PAY_TO = bech32("uregtest");
const UIVK = bech32("uivkregtest", 100);

const BASE: Record<string, string | undefined> = {
  Z402_PAY_TO: PAY_TO,
  Z402_UIVK: UIVK,
  Z402_FACILITATOR_TOKEN: "token",
};

const env = (over: Record<string, string | undefined> = {}) => ({ ...BASE, ...over });

/** The ConfigError loadConfig throws for this environment, failing the test if it loads */
function refusal(e: Record<string, string | undefined>): ConfigError {
  try {
    loadConfig(e);
  } catch (err) {
    if (err instanceof ConfigError) return err;
    throw err;
  }
  throw new Error("expected loadConfig to throw");
}

const scratch = mkdtempSync(join(tmpdir(), "z402-config-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function keysFile(content: unknown, name = "keys.json"): string {
  const path = join(scratch, name);
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
  return path;
}

describe("defaults", () => {
  test("regtest is the default network and every default matches the table", () => {
    expect(loadConfig(env())).toEqual({
      network: NETWORK_REGTEST,
      payTo: PAY_TO,
      uivk: UIVK,
      authToken: "token",
      lwdUrl: "http://127.0.0.1:28137",
      expectedBranchId: "37a5165b",
      zdecryptBin: join(ROOT, "crates", "zdecrypt", "target", "release", "zdecrypt"),
      ledgerPath: join(ROOT, ".data", "facilitator-ledger.regtest.jsonl"),
      host: "127.0.0.1",
      port: 4022,
      priceZat: 500n,
      terms: { windowZat: 100000n, creditRatioBps: 2500, creditCapZat: 200000n, zeroConfMinExpiryBlocks: 20 },
    });
  });

  test("testnet takes the public endpoint, its own branch id and its own ledger", () => {
    const config = loadConfig(
      env({ Z402_NETWORK: "testnet", Z402_PAY_TO: bech32("utest"), Z402_UIVK: bech32("uivktest", 100) }),
    );
    expect(config).toMatchObject({
      network: NETWORK_TESTNET,
      lwdUrl: "https://testnet.zec.rocks:443",
      expectedBranchId: "77190ad9",
      ledgerPath: join(ROOT, ".data", "facilitator-ledger.testnet.jsonl"),
    });
  });

  test("mainnet has no default endpoint and no default branch id", () => {
    const mainnet = { Z402_NETWORK: "mainnet", Z402_PAY_TO: bech32("u"), Z402_UIVK: bech32("uivk", 100) };
    expect(refusal(env(mainnet)).message).toMatch(/Z402_LWD_URL/);

    const config = loadConfig(env({ ...mainnet, Z402_LWD_URL: "https://mainnet.example:443" }));
    expect(config).toMatchObject({
      network: NETWORK_MAINNET,
      lwdUrl: "https://mainnet.example:443",
      expectedBranchId: undefined,
      ledgerPath: join(ROOT, ".data", "facilitator-ledger.mainnet.jsonl"),
    });
  });

  test("the settings override their defaults", () => {
    const config = loadConfig(
      env({
        Z402_LWD_URL: "http://127.0.0.1:1",
        Z402_EXPECTED_BRANCH_ID: "AABBCCDD",
        Z402_FACILITATOR_HOST: "127.0.0.2",
        Z402_FACILITATOR_PORT: "0",
        Z402_PRICE_ZAT: "7",
        Z402_WINDOW_ZAT: "250000",
        Z402_CREDIT_RATIO_BPS: "10000",
        Z402_CREDIT_CAP_ZAT: "0",
        Z402_ZERO_CONF_MIN_EXPIRY_BLOCKS: "0",
      }),
    );
    expect(config).toMatchObject({
      lwdUrl: "http://127.0.0.1:1",
      expectedBranchId: "aabbccdd",
      host: "127.0.0.2",
      port: 0,
      priceZat: 7n,
      terms: { windowZat: 250000n, creditRatioBps: 10000, creditCapZat: 0n, zeroConfMinExpiryBlocks: 0 },
    });
  });

  test("an empty variable counts as unset", () => {
    const config = loadConfig(
      env({ Z402_NETWORK: "", Z402_PRICE_ZAT: "", Z402_LWD_URL: "", Z402_FACILITATOR_PORT: "" }),
    );
    expect(config).toMatchObject({ network: NETWORK_REGTEST, priceZat: 500n, port: 4022 });
  });
});

describe("Z402_NETWORK", () => {
  test.each(["devnet", "REGTEST", " regtest", "main"])("%j is refused", (network) => {
    expect(refusal(env({ Z402_NETWORK: network })).message).toMatch(/Z402_NETWORK/);
  });
});

describe("Z402_PAY_TO", () => {
  test.each([
    ["a transparent-including address on testnet", "testnet", bech32("tutest"), bech32("uivktest", 100)],
    ["a testnet address on regtest", "regtest", bech32("utest"), UIVK],
    ["a regtest address on testnet", "testnet", bech32("uregtest"), bech32("uivktest", 100)],
    ["a mainnet address on regtest", "regtest", bech32("u"), UIVK],
    ["text that is no address", "regtest", "not-an-address", UIVK],
  ])("%s is refused", (_, network, payTo, uivk) => {
    const e = env({ Z402_NETWORK: network, Z402_PAY_TO: payTo, Z402_UIVK: uivk });
    expect(refusal(e).message).toMatch(/Z402_PAY_TO/);
  });

  test("a missing address is refused", () => {
    expect(refusal(env({ Z402_PAY_TO: undefined })).message).toMatch(/Z402_PAY_TO/);
  });

  test("the revision 2 shielded-only address is accepted", () => {
    expect(loadConfig(env({ Z402_PAY_TO: bech32("zuregtest") })).payTo).toBe(bech32("zuregtest"));
  });
});

describe("Z402_UIVK", () => {
  const payToHrp = { regtest: "uregtest", testnet: "utest", mainnet: "u" } as const;
  const ivkHrps = {
    regtest: ["uivkregtest", "uviregtest"],
    testnet: ["uivktest", "uvitest"],
    mainnet: ["uivk", "uvi"],
  } as const;
  const notIvk = ["uviewregtest", "uviewtest", "uview", "uvfregtest", "uvftest", "uvf", "uregtest", "utest", "u"];

  const names = ["regtest", "testnet", "mainnet"] as const;
  const wrongForNetwork = names.flatMap((network) =>
    [...names.filter((n) => n !== network).flatMap((n) => ivkHrps[n]), ...notIvk].map((hrp) => [network, hrp] as const),
  );

  function envFor(network: (typeof names)[number], uivk: string | undefined) {
    return env({
      Z402_NETWORK: network,
      Z402_PAY_TO: bech32(payToHrp[network]),
      Z402_UIVK: uivk,
      Z402_LWD_URL: "http://127.0.0.1:1",
    });
  }

  test.each(names.flatMap((network) => ivkHrps[network].map((hrp) => [network, hrp] as const)))(
    "on %s a %s key is accepted",
    (network, hrp) => {
      expect(loadConfig(envFor(network, bech32(hrp, 100))).uivk).toBe(bech32(hrp, 100));
    },
  );

  test.each(wrongForNetwork)("on %s a %s key is refused", (network, hrp) => {
    const uivk = bech32(hrp, 100);
    const error = refusal(envFor(network, uivk));
    expect(error.message).toMatch(/Z402_UIVK/);
    expect(error.message).not.toContain(uivk);
  });

  test("a missing key is refused", () => {
    expect(refusal(env({ Z402_UIVK: undefined })).message).toMatch(/Z402_UIVK/);
  });
});

describe("Z402_FACILITATOR_TOKEN", () => {
  test.each([undefined, ""])("%j is refused", (token) => {
    expect(refusal(env({ Z402_FACILITATOR_TOKEN: token })).message).toMatch(/Z402_FACILITATOR_TOKEN/);
  });

  test("the token is kept exactly as given", () => {
    expect(loadConfig(env({ Z402_FACILITATOR_TOKEN: " a b " })).authToken).toBe(" a b ");
  });
});

describe("Z402_MERCHANT_KEYS_FILE", () => {
  const merchant = { orchardOnlyAddress: PAY_TO, uivk: UIVK, ufvk: "uviewregtest1secret", seedHex: "00".repeat(32) };

  test("supplies the address and the key when the variables are not set", () => {
    const config = loadConfig({
      Z402_FACILITATOR_TOKEN: "t",
      Z402_MERCHANT_KEYS_FILE: keysFile(merchant),
    });
    expect(config).toMatchObject({ payTo: PAY_TO, uivk: UIVK });
    // Nothing else in the file is carried along
    const carried = JSON.stringify(config, (_, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
    expect(carried).not.toContain(merchant.ufvk);
    expect(carried).not.toContain(merchant.seedHex);
  });

  test("explicit Z402_PAY_TO and Z402_UIVK win over the file", () => {
    const other = { Z402_PAY_TO: bech32("zuregtest"), Z402_UIVK: bech32("uviregtest", 100) };
    const config = loadConfig({
      Z402_FACILITATOR_TOKEN: "t",
      Z402_MERCHANT_KEYS_FILE: keysFile(merchant),
      ...other,
    });
    expect(config).toMatchObject({ payTo: other.Z402_PAY_TO, uivk: other.Z402_UIVK });
  });

  test("a file that is not needed is not read", () => {
    const config = loadConfig(env({ Z402_MERCHANT_KEYS_FILE: join(scratch, "absent.json") }));
    expect(config.payTo).toBe(PAY_TO);
  });

  test("a relative path resolves against the repository root, not the working directory", () => {
    const path = keysFile(merchant, "relative.json");
    const config = loadConfig({
      Z402_FACILITATOR_TOKEN: "t",
      Z402_MERCHANT_KEYS_FILE: relative(ROOT, path),
    });
    expect(config.uivk).toBe(UIVK);
  });

  test("a missing file names the variable", () => {
    const error = refusal({ Z402_FACILITATOR_TOKEN: "t", Z402_MERCHANT_KEYS_FILE: join(scratch, "absent.json") });
    expect(error.message).toMatch(/Z402_MERCHANT_KEYS_FILE/);
  });

  test("a file that is not JSON names the variable and never echoes the file", () => {
    // JSON.parse quotes the first characters of what it cannot read, so the check is for a short prefix
    const path = keysFile("SECRET {not json", "garbage.json");
    const error = refusal({ Z402_FACILITATOR_TOKEN: "t", Z402_MERCHANT_KEYS_FILE: path });
    expect(error.message).toMatch(/Z402_MERCHANT_KEYS_FILE/);
    expect(error.message).not.toContain("SECRET");
  });

  test.each([
    ["a JSON array", []],
    ["no uivk", { orchardOnlyAddress: PAY_TO }],
    ["no orchardOnlyAddress", { uivk: UIVK }],
    ["a uivk that is not a string", { orchardOnlyAddress: PAY_TO, uivk: 7 }],
  ])("%s names the variable", (_, content) => {
    const path = keysFile(content, "partial.json");
    expect(refusal({ Z402_FACILITATOR_TOKEN: "t", Z402_MERCHANT_KEYS_FILE: path }).message).toMatch(
      /Z402_MERCHANT_KEYS_FILE/,
    );
  });

  test("an address from the file is still checked against the network", () => {
    const path = keysFile({ orchardOnlyAddress: bech32("utest"), uivk: UIVK }, "wrong-network.json");
    expect(refusal({ Z402_FACILITATOR_TOKEN: "t", Z402_MERCHANT_KEYS_FILE: path }).message).toMatch(/Z402_PAY_TO/);
  });
});

describe("paths", () => {
  test("absolute values are used as they are", () => {
    const config = loadConfig(env({ Z402_LEDGER: "/var/z402/ledger.jsonl", Z402_ZDECRYPT_BIN: "/opt/zdecrypt" }));
    expect(config).toMatchObject({ ledgerPath: "/var/z402/ledger.jsonl", zdecryptBin: "/opt/zdecrypt" });
  });

  test("relative values resolve against the repository root", () => {
    const config = loadConfig(env({ Z402_LEDGER: ".data/other.jsonl", Z402_ZDECRYPT_BIN: "bin/zdecrypt" }));
    expect(config).toMatchObject({
      ledgerPath: join(ROOT, ".data", "other.jsonl"),
      zdecryptBin: join(ROOT, "bin", "zdecrypt"),
    });
  });
});

describe("numbers", () => {
  test.each(["0", "-1", "1.5", "abc", "1e3", "0x10", " 5", "05", "2100000000000001"])(
    "Z402_PRICE_ZAT=%j is refused",
    (value) => {
      expect(refusal(env({ Z402_PRICE_ZAT: value })).message).toMatch(/Z402_PRICE_ZAT/);
    },
  );

  test.each(["65536", "-1", "abc", "40.5", "04022"])("Z402_FACILITATOR_PORT=%j is refused", (value) => {
    expect(refusal(env({ Z402_FACILITATOR_PORT: value })).message).toMatch(/Z402_FACILITATOR_PORT/);
  });

  test.each([
    ["Z402_WINDOW_ZAT", "0"],
    ["Z402_WINDOW_ZAT", "abc"],
    ["Z402_CREDIT_RATIO_BPS", "10001"],
    ["Z402_CREDIT_RATIO_BPS", "-1"],
    ["Z402_CREDIT_RATIO_BPS", "12.5"],
    ["Z402_CREDIT_CAP_ZAT", "-5"],
    ["Z402_CREDIT_CAP_ZAT", "2100000000000001"],
    ["Z402_ZERO_CONF_MIN_EXPIRY_BLOCKS", "-1"],
    ["Z402_ZERO_CONF_MIN_EXPIRY_BLOCKS", "soon"],
  ])("%s=%j is refused and named", (variable, value) => {
    expect(refusal(env({ [variable]: value })).message).toMatch(new RegExp(variable));
  });
});

describe("endpoint and branch id", () => {
  test.each(["ftp://127.0.0.1:1", "127.0.0.1:28137", "not a url"])("Z402_LWD_URL=%j is refused", (url) => {
    expect(refusal(env({ Z402_LWD_URL: url })).message).toMatch(/Z402_LWD_URL/);
  });

  test.each(["37a5165", "0x37a5165b", "37a5165bb", "zzzzzzzz"])("Z402_EXPECTED_BRANCH_ID=%j is refused", (id) => {
    expect(refusal(env({ Z402_EXPECTED_BRANCH_ID: id })).message).toMatch(/Z402_EXPECTED_BRANCH_ID/);
  });

  test("an empty host is refused", () => {
    expect(refusal(env({ Z402_FACILITATOR_HOST: " " })).message).toMatch(/Z402_FACILITATOR_HOST/);
  });
});

test("a refusal is a ConfigError", () => {
  const error = refusal(env({ Z402_PRICE_ZAT: "0" }));
  expect(error).toBeInstanceOf(Error);
  expect(error.name).toBe("ConfigError");
});
