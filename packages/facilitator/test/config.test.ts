import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { NETWORK_MAINNET, NETWORK_REGTEST, NETWORK_TESTNET } from "@z402/protocol";
import { afterAll, describe, expect, test } from "vitest";
import { ConfigError, isValidUivk, loadConfig } from "../src/config.js";

/** The repository root, taken from this file's own place in the tree and never from the working directory */
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** A string with the right prefix and charset, which is all loadConfig can check without zdecrypt */
const bech32 = (hrp: string, length = 60): string => `${hrp}1${"q".repeat(length)}`;

const PAY_TO = bech32("uregtest");
const UIVK = bech32("uivkregtest", 100);

/** The settings each network needs, mainnet's endpoint included, which the tests of registration lay under env() */
const ON = {
  regtest: {},
  testnet: { Z402_NETWORK: "testnet", Z402_PAY_TO: bech32("utest"), Z402_UIVK: bech32("uivktest", 100) },
  mainnet: {
    Z402_NETWORK: "mainnet",
    Z402_PAY_TO: bech32("u"),
    Z402_UIVK: bech32("uivk", 100),
    Z402_LWD_URL: "https://127.0.0.1:9067",
  },
} as const;

/** A registration token of the 32 characters the facilitator asks for, for the tests that are not about registration */
const REGISTRATION = "r-5d1b84-secret-token-0123456789";
const OPEN = "POST /providers is open to anyone: set Z402_REGISTRATION_TOKEN to require a token";
const CLOSED =
  "POST /providers answers 403 registration_disabled on mainnet: set Z402_REGISTRATION_TOKEN to require a token, " +
  "or Z402_REGISTRATION_OPEN=1 to let anyone register";

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
      providersDir: join(ROOT, ".data", "providers.regtest"),
      maxProviders: 32,
      registrationToken: undefined,
      registrationEnabled: true,
      host: "127.0.0.1",
      port: 4022,
      terms: { windowZat: 100000n, creditRatioBps: 2500, creditCapZat: 200000n, zeroConfMinExpiryBlocks: 20 },
      warnings: [OPEN],
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
      providersDir: join(ROOT, ".data", "providers.testnet"),
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
      providersDir: join(ROOT, ".data", "providers.mainnet"),
    });
  });

  test("the settings override their defaults", () => {
    const config = loadConfig(
      env({
        Z402_LWD_URL: "http://127.0.0.1:1",
        Z402_EXPECTED_BRANCH_ID: "AABBCCDD",
        Z402_FACILITATOR_HOST: "127.0.0.2",
        Z402_FACILITATOR_PORT: "0",
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
      terms: { windowZat: 250000n, creditRatioBps: 10000, creditCapZat: 0n, zeroConfMinExpiryBlocks: 0 },
    });
  });

  test("an empty variable counts as unset", () => {
    const config = loadConfig(
      env({ Z402_NETWORK: "", Z402_PRICE_ZAT: "", Z402_LWD_URL: "", Z402_FACILITATOR_PORT: "" }),
    );
    expect(config).toMatchObject({ network: NETWORK_REGTEST, port: 4022, warnings: [OPEN] });
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

  test("an address of exactly 1024 characters is accepted", () => {
    const payTo = bech32("uregtest", 1015);
    expect(payTo).toHaveLength(1024);
    expect(loadConfig(env({ Z402_PAY_TO: payTo })).payTo).toBe(payTo);
  });

  test.each([1025, 59_000])("an address of %d characters is refused, naming the variable and not quoting it", (n) => {
    const payTo = bech32("uregtest", n - 9);
    const error = refusal(env({ Z402_PAY_TO: payTo }));
    expect(error.message).toBe("Z402_PAY_TO: must be at most 1024 characters");
    expect(error.message).not.toContain(payTo);
  });

  test("an address of 1025 characters in the keys file is refused, naming the variable and the file", () => {
    const path = keysFile({ orchardOnlyAddress: bech32("uregtest", 1016), uivk: UIVK }, "long-address.json");
    const error = refusal({ Z402_FACILITATOR_TOKEN: "t", Z402_MERCHANT_KEYS_FILE: path });
    expect(error.message).toBe("Z402_PAY_TO (from Z402_MERCHANT_KEYS_FILE): must be at most 1024 characters");
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

  test("a missing key points at the two variables before any keys file", () => {
    expect(refusal(env({ Z402_UIVK: undefined })).message).toBe(
      "Z402_UIVK is required (the merchant's unified incoming viewing key); set Z402_UIVK and Z402_PAY_TO, " +
        "or Z402_MERCHANT_KEYS_FILE to a file holding only uivk and orchardOnlyAddress",
    );
  });
});

describe("Z402_FACILITATOR_TOKEN", () => {
  test.each([undefined, ""])("%j is refused", (token) => {
    expect(refusal(env({ Z402_FACILITATOR_TOKEN: token })).message).toMatch(/Z402_FACILITATOR_TOKEN/);
  });

  test.each([" a b ", "s3cret\n", "a b", "tab\there"])("%j, which no header can match, is refused", (token) => {
    const error = refusal(env({ Z402_FACILITATOR_TOKEN: token }));
    expect(error.message).toMatch(/^Z402_FACILITATOR_TOKEN: /);
    expect(error.message).not.toContain(token);
  });

  test.each(["t-7c2e91-secret", "dGhlIHRva2Vu==", "a.b_c~d+e/f"])("%j is kept exactly as given", (token) => {
    expect(loadConfig(env({ Z402_FACILITATOR_TOKEN: token })).authToken).toBe(token);
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

  describe("that holds more than the facilitator needs", () => {
    const MAINNET = { orchardOnlyAddress: bech32("u"), uivk: bech32("uivk", 100) };
    const advice = (path: string, what: string) =>
      `Z402_MERCHANT_KEYS_FILE: ${path} holds ${what}; give the facilitator only uivk and orchardOnlyAddress, ` +
      "or set Z402_UIVK and Z402_PAY_TO";

    test("is refused on mainnet when it holds the spending seed", () => {
      const path = keysFile({ ...MAINNET, seedHex: merchant.seedHex }, "mainnet-seed.json");
      const e = { Z402_NETWORK: "mainnet", Z402_LWD_URL: "https://127.0.0.1:9067" };
      const error = refusal({ ...e, Z402_FACILITATOR_TOKEN: "t", Z402_MERCHANT_KEYS_FILE: path });
      expect(error.message).toBe(advice(path, "the spending seed"));
      expect(error.message).not.toContain(merchant.seedHex);
    });

    test("is refused on mainnet when it holds the full viewing key", () => {
      const path = keysFile({ ...MAINNET, ufvk: "uview1fixture" }, "mainnet-ufvk.json");
      const e = { Z402_NETWORK: "mainnet", Z402_LWD_URL: "https://127.0.0.1:9067" };
      const error = refusal({ ...e, Z402_FACILITATOR_TOKEN: "t", Z402_MERCHANT_KEYS_FILE: path });
      expect(error.message).toBe(advice(path, "the full viewing key"));
    });

    test("loads elsewhere with one warning that gives the same advice", () => {
      const path = keysFile(merchant, "regtest-seed.json");
      const config = loadConfig({ Z402_FACILITATOR_TOKEN: "t", Z402_MERCHANT_KEYS_FILE: path });
      expect(config).toMatchObject({ payTo: PAY_TO, uivk: UIVK });
      expect(config.warnings).toEqual([advice(path, "the spending seed"), OPEN]);
      expect(config.warnings.join(" ")).not.toContain(merchant.seedHex);
    });

    test("is not warned about when only the variables are used", () => {
      const path = keysFile({ ...MAINNET, seedHex: merchant.seedHex }, "unused-seed.json");
      const e = { Z402_NETWORK: "mainnet", Z402_LWD_URL: "https://127.0.0.1:9067", ...MAINNET };
      const config = loadConfig({
        ...e,
        Z402_PAY_TO: MAINNET.orchardOnlyAddress,
        Z402_UIVK: MAINNET.uivk,
        Z402_FACILITATOR_TOKEN: "t",
        Z402_REGISTRATION_TOKEN: REGISTRATION,
        Z402_MERCHANT_KEYS_FILE: path,
      });
      expect(config.warnings).toEqual([]);
    });
  });

  test("a file of only uivk and orchardOnlyAddress gives no warning, on mainnet too", () => {
    const viewOnly = { orchardOnlyAddress: bech32("u"), uivk: bech32("uivk", 100) };
    const path = keysFile(viewOnly, "view-only.json");
    const config = loadConfig({
      Z402_NETWORK: "mainnet",
      Z402_LWD_URL: "https://127.0.0.1:9067",
      Z402_FACILITATOR_TOKEN: "t",
      Z402_REGISTRATION_TOKEN: REGISTRATION,
      Z402_MERCHANT_KEYS_FILE: path,
    });
    expect(config).toMatchObject({ payTo: viewOnly.orchardOnlyAddress, uivk: viewOnly.uivk, warnings: [] });
  });
});

describe("paths", () => {
  test("absolute values are used as they are", () => {
    const config = loadConfig(
      env({
        Z402_LEDGER: "/var/z402/ledger.jsonl",
        Z402_ZDECRYPT_BIN: "/opt/zdecrypt",
        Z402_PROVIDERS_DIR: "/var/z402/providers",
      }),
    );
    expect(config).toMatchObject({
      ledgerPath: "/var/z402/ledger.jsonl",
      zdecryptBin: "/opt/zdecrypt",
      providersDir: "/var/z402/providers",
    });
  });

  test("relative values resolve against the repository root", () => {
    const config = loadConfig(
      env({ Z402_LEDGER: ".data/other.jsonl", Z402_ZDECRYPT_BIN: "bin/zdecrypt", Z402_PROVIDERS_DIR: ".data/p" }),
    );
    expect(config).toMatchObject({
      ledgerPath: join(ROOT, ".data", "other.jsonl"),
      zdecryptBin: join(ROOT, "bin", "zdecrypt"),
      providersDir: join(ROOT, ".data", "p"),
    });
  });
});

describe("Z402_MAX_PROVIDERS", () => {
  test.each([
    ["0", 0],
    ["1", 1],
    ["32", 32],
    ["1000", 1000],
  ])("%j is %d", (value, expected) => {
    expect(loadConfig(env({ Z402_MAX_PROVIDERS: value })).maxProviders).toBe(expected);
  });

  test("an empty variable counts as unset, which is 32", () => {
    expect(loadConfig(env({ Z402_MAX_PROVIDERS: "" })).maxProviders).toBe(32);
  });

  test.each(["1001", "-1", "1.5", "abc", "1e2", "0x10", " 5", "05", "99999999999"])("%j is refused", (value) => {
    const message = refusal(env({ Z402_MAX_PROVIDERS: value })).message;
    expect(message).toBe("Z402_MAX_PROVIDERS: expected a whole number from 0 to 1000");
  });
});

describe("Z402_REGISTRATION_TOKEN", () => {
  test("is left out unless it is set, which leaves registration open", () => {
    expect(loadConfig(env()).registrationToken).toBeUndefined();
    expect(loadConfig(env({ Z402_REGISTRATION_TOKEN: "" })).registrationToken).toBeUndefined();
  });

  test.each([
    "r-3f9a1c-secret-0123456789abcdef",
    `${"A".repeat(30)}==`,
    `a.b_c~d+e/f${"0".repeat(21)}`,
    "x".repeat(200),
  ])("%j is kept exactly as given", (token) => {
    expect(loadConfig(env({ Z402_REGISTRATION_TOKEN: token })).registrationToken).toBe(token);
  });

  test("of 32 characters is the shortest that is taken", () => {
    expect(loadConfig(env({ Z402_REGISTRATION_TOKEN: "r".repeat(32) })).registrationToken).toBe("r".repeat(32));
  });

  test.each([1, 8, 16, 31])("of %d characters is refused, naming the variable and not quoting the token", (length) => {
    const token = "Q".repeat(length);
    const error = refusal(env({ Z402_REGISTRATION_TOKEN: token }));
    expect(error.message).toBe(
      "Z402_REGISTRATION_TOKEN: must be at least 32 characters, for example the output of openssl rand -hex 32",
    );
    expect(error.message).not.toContain(token);
  });

  test("counts a padding sign like any character", () => {
    const padded = `${"r".repeat(31)}=`;
    expect(loadConfig(env({ Z402_REGISTRATION_TOKEN: padded })).registrationToken).toBe(padded);
    expect(refusal(env({ Z402_REGISTRATION_TOKEN: `${"r".repeat(30)}=` })).message).toMatch(/at least 32/);
  });

  test.each([" a b ", "s3cret\n", "a b", "tab\there", "a=b"])("%j, which no header can match, is refused", (token) => {
    const error = refusal(env({ Z402_REGISTRATION_TOKEN: token }));
    expect(error.message).toBe(
      "Z402_REGISTRATION_TOKEN: must be one token of letters, digits and -._~+/ (no spaces or control characters)",
    );
    expect(error.message).not.toContain(token);
  });

  test("can be the same as the facilitator token", () => {
    const same = env({ Z402_FACILITATOR_TOKEN: REGISTRATION, Z402_REGISTRATION_TOKEN: REGISTRATION });
    expect(loadConfig(same)).toMatchObject({ authToken: REGISTRATION, registrationToken: REGISTRATION });
  });
});

describe("Z402_REGISTRATION_OPEN", () => {
  test.each([undefined, ""])("%j is unset", (value) => {
    expect(loadConfig(env({ Z402_REGISTRATION_OPEN: value })).registrationEnabled).toBe(true);
  });

  test("1 is accepted", () => {
    expect(loadConfig(env({ Z402_REGISTRATION_OPEN: "1" })).registrationEnabled).toBe(true);
  });

  test.each(["yes", "true", "TRUE", "0", "2", "01", "10", " 1", "1 ", "1\n", "on", "open", "-1"])(
    "%j is refused, naming the variable and not quoting the value",
    (value) => {
      const error = refusal(env({ Z402_REGISTRATION_OPEN: value }));
      expect(error.message).toBe("Z402_REGISTRATION_OPEN: expected 1, or leave it unset");
    },
  );

  test("is refused on every network and beside a token, since it is judged before it is needed", () => {
    for (const over of [ON.regtest, ON.testnet, ON.mainnet, { Z402_REGISTRATION_TOKEN: REGISTRATION }]) {
      expect(refusal(env({ ...over, Z402_REGISTRATION_OPEN: "yes" })).message).toMatch(/^Z402_REGISTRATION_OPEN: /);
    }
  });
});

describe("registration exposure", () => {
  const names = ["regtest", "testnet", "mainnet"] as const;
  const withToken = { Z402_REGISTRATION_TOKEN: REGISTRATION };

  test.each(["regtest", "testnet"] as const)("on %s, with no token, registration is open and warned about", (name) => {
    const config = loadConfig(env(ON[name]));
    expect(config).toMatchObject({ registrationToken: undefined, registrationEnabled: true });
    expect(config.warnings).toEqual([OPEN]);
  });

  test("on mainnet, with no token and no opt-in, registration is off and one warning says why", () => {
    const config = loadConfig(env(ON.mainnet));
    expect(config).toMatchObject({ registrationToken: undefined, registrationEnabled: false });
    expect(config.warnings).toEqual([CLOSED]);
  });

  test("on mainnet, an empty token and an empty opt-in count as unset, so registration is off", () => {
    const config = loadConfig(env({ ...ON.mainnet, Z402_REGISTRATION_TOKEN: "", Z402_REGISTRATION_OPEN: "" }));
    expect(config).toMatchObject({ registrationToken: undefined, registrationEnabled: false });
    expect(config.warnings).toEqual([CLOSED]);
  });

  test("on mainnet, Z402_REGISTRATION_OPEN=1 opens registration, with the warning of open registration", () => {
    const config = loadConfig(env({ ...ON.mainnet, Z402_REGISTRATION_OPEN: "1" }));
    expect(config).toMatchObject({ registrationToken: undefined, registrationEnabled: true });
    expect(config.warnings).toEqual([OPEN]);
  });

  test.each(names)("on %s, a token gates registration and nothing is warned about", (name) => {
    const config = loadConfig(env({ ...ON[name], ...withToken }));
    expect(config).toMatchObject({ registrationToken: REGISTRATION, registrationEnabled: true });
    expect(config.warnings).toEqual([]);
  });

  test.each(names)("on %s, Z402_REGISTRATION_OPEN=1 beside a token changes nothing", (name) => {
    const config = loadConfig(env({ ...ON[name], ...withToken, Z402_REGISTRATION_OPEN: "1" }));
    expect(config).toMatchObject({ registrationToken: REGISTRATION, registrationEnabled: true });
    expect(config.warnings).toEqual([]);
  });

  test.each(names)("on %s, Z402_MAX_PROVIDERS=0 admits no one, so nothing is open or warned about", (name) => {
    const config = loadConfig(env({ ...ON[name], Z402_MAX_PROVIDERS: "0" }));
    expect(config).toMatchObject({ maxProviders: 0, registrationEnabled: true });
    expect(config.warnings).toEqual([]);
  });

  test.each(names)("on %s, one provider slot is enough for the warning", (name) => {
    const config = loadConfig(env({ ...ON[name], Z402_MAX_PROVIDERS: "1", Z402_REGISTRATION_OPEN: "1" }));
    expect(config.warnings).toEqual([OPEN]);
  });

  test("the warning comes after the others and names no token", () => {
    const config = loadConfig(env({ Z402_FACILITATOR_HOST: "0.0.0.0", Z402_PRICE_ZAT: "800" }));
    expect(config.warnings).toHaveLength(3);
    expect(config.warnings[2]).toBe(OPEN);
    const gated = loadConfig(env({ ...withToken, Z402_FACILITATOR_HOST: "0.0.0.0" }));
    expect(gated.warnings.join(" ")).not.toContain(REGISTRATION);
  });

  test("the warning for a mainnet that is off tells both ways out and nothing else about it", () => {
    expect(CLOSED).toContain("Z402_REGISTRATION_TOKEN");
    expect(CLOSED).toContain("Z402_REGISTRATION_OPEN=1");
    expect(loadConfig(env(ON.mainnet)).warnings).toHaveLength(1);
  });
});

describe("isValidUivk", () => {
  const hrps = {
    [NETWORK_REGTEST]: ["uivkregtest", "uviregtest"],
    [NETWORK_TESTNET]: ["uivktest", "uvitest"],
    [NETWORK_MAINNET]: ["uivk", "uvi"],
  } as const;
  const networks = [NETWORK_REGTEST, NETWORK_TESTNET, NETWORK_MAINNET] as const;

  test.each(networks.flatMap((network) => hrps[network].map((hrp) => [network, hrp] as const)))(
    "on %s a %s key is valid",
    (network, hrp) => {
      expect(isValidUivk(bech32(hrp, 100), network)).toBe(true);
    },
  );

  test.each(
    networks.flatMap((network) =>
      networks.filter((n) => n !== network).flatMap((n) => hrps[n].map((hrp) => [network, hrp] as const)),
    ),
  )("on %s a %s key of another network is not", (network, hrp) => {
    expect(isValidUivk(bech32(hrp, 100), network)).toBe(false);
  });

  test.each([
    ["an address", bech32("uregtest")],
    ["a full viewing key", bech32("uviewregtest", 100)],
    ["an empty string", ""],
    ["a key with a space", `${bech32("uivkregtest", 100)} `],
    ["a key with a newline", `${bech32("uivkregtest", 100)}\n`],
    ["a character outside bech32", `uivkregtest1${"b".repeat(100)}`],
    ["only the prefix", "uivkregtest1"],
    ["a key of 1025 characters", `uivkregtest1${"q".repeat(1025 - "uivkregtest1".length)}`],
  ])("%s is not valid on regtest", (_, uivk) => {
    expect(isValidUivk(uivk, NETWORK_REGTEST)).toBe(false);
  });

  test("a key of 1024 characters is valid, since the registry holds no more", () => {
    expect(isValidUivk(`uivkregtest1${"q".repeat(1024 - "uivkregtest1".length)}`, NETWORK_REGTEST)).toBe(true);
  });

  test("a network that is none of the three is valid for no key", () => {
    expect(isValidUivk(bech32("uivkregtest", 100), "zcash:signet")).toBe(false);
  });

  test("agrees with the key Z402_UIVK takes", () => {
    const uivk = bech32("uivkregtest", 100);
    expect(isValidUivk(uivk, NETWORK_REGTEST)).toBe(true);
    expect(loadConfig(env({ Z402_UIVK: uivk })).uivk).toBe(uivk);
  });
});

describe("numbers", () => {
  test.each(["0", "-1", "1.5", "abc", "1e3", "0x10", " 5", "05", "2100000000000001", "800"])(
    "Z402_PRICE_ZAT=%j is not read: no refusal, no price in the config, and one warning",
    (value) => {
      const config = loadConfig(env({ Z402_PRICE_ZAT: value }));

      expect(config).not.toHaveProperty("priceZat");
      expect(config.warnings).toEqual(["Z402_PRICE_ZAT is ignored: each provider prices its own routes", OPEN]);
      expect({ ...config, warnings: [] }).toEqual({ ...loadConfig(env()), warnings: [] });
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

describe("plaintext http://", () => {
  const TESTNET = { Z402_NETWORK: "testnet", Z402_PAY_TO: bech32("utest"), Z402_UIVK: bech32("uivktest", 100) };
  const MAINNET = { Z402_NETWORK: "mainnet", Z402_PAY_TO: bech32("u"), Z402_UIVK: bech32("uivk", 100) };

  const NETWORKS = { testnet: [TESTNET, NETWORK_TESTNET], mainnet: [MAINNET, NETWORK_MAINNET] } as const;

  test.each([
    ["testnet", "http://lwd.example:9067"],
    ["mainnet", "http://lwd.example:9067"],
    ["mainnet", "http://10.0.0.5:9067"],
    ["testnet", "http://[::ffff:7f00:1]:9067"],
  ] as const)("on %s to %s, which is not loopback, is refused", (name, url) => {
    const [over, network] = NETWORKS[name];
    expect(refusal(env({ ...over, Z402_LWD_URL: url })).message).toBe(
      `Z402_LWD_URL: plaintext http:// is allowed only to a loopback host on ${network}; use https://`,
    );
  });

  test.each(["http://127.0.0.1:9067", "http://127.8.9.10:9067", "http://localhost:9067", "http://[::1]:9067"])(
    "on testnet to loopback %s is accepted",
    (url) => {
      expect(loadConfig(env({ ...TESTNET, Z402_LWD_URL: url })).lwdUrl).toBe(url);
    },
  );

  test("on regtest to any host is accepted, as a compose network names its own", () => {
    const config = loadConfig(env({ Z402_LWD_URL: "http://zaino:8137", Z402_REGISTRATION_TOKEN: REGISTRATION }));
    expect(config).toMatchObject({ lwdUrl: "http://zaino:8137", warnings: [] });
  });
});

describe("warnings", () => {
  // A token keeps the warning about open registration out, so that each test sees the one warning it is about
  const MAINNET = {
    Z402_NETWORK: "mainnet",
    Z402_PAY_TO: bech32("u"),
    Z402_UIVK: bech32("uivk", 100),
    Z402_REGISTRATION_TOKEN: REGISTRATION,
  };
  const tokened = (over: Record<string, string | undefined>) => env({ Z402_REGISTRATION_TOKEN: REGISTRATION, ...over });

  test("a facilitator host that is not loopback is warned about once", () => {
    expect(loadConfig(tokened({ Z402_FACILITATOR_HOST: "0.0.0.0" })).warnings).toEqual([
      "Z402_FACILITATOR_HOST: 0.0.0.0 is not a loopback host, so the facilitator and its bearer token are reachable " +
        "over plain http",
    ]);
  });

  test.each(["127.0.0.1", "localhost", "::1"])("a facilitator host of %s is not warned about", (host) => {
    expect(loadConfig(tokened({ Z402_FACILITATOR_HOST: host })).warnings).toEqual([]);
  });

  test("a mainnet endpoint that is not loopback is named in one warning", () => {
    expect(loadConfig(env({ ...MAINNET, Z402_LWD_URL: "https://zec.rocks:443" })).warnings).toEqual([
      "Z402_LWD_URL points at zec.rocks: the facilitator trusts it for whether a deposit exists and how deep it is " +
        "mined; for real money use a node you operate",
    ]);
  });

  test("a mainnet endpoint on loopback is not warned about", () => {
    expect(loadConfig(env({ ...MAINNET, Z402_LWD_URL: "https://127.0.0.1:9067" })).warnings).toEqual([]);
  });

  test("an empty Z402_PRICE_ZAT counts as unset and is not warned about", () => {
    expect(loadConfig(tokened({ Z402_PRICE_ZAT: "" })).warnings).toEqual([]);
  });

  test("the price warning comes once, after the warnings of the settings it sits beside", () => {
    expect(loadConfig(tokened({ Z402_FACILITATOR_HOST: "0.0.0.0", Z402_PRICE_ZAT: "800" })).warnings).toEqual([
      "Z402_FACILITATOR_HOST: 0.0.0.0 is not a loopback host, so the facilitator and its bearer token are reachable " +
        "over plain http",
      "Z402_PRICE_ZAT is ignored: each provider prices its own routes",
    ]);
  });

  test("a testnet endpoint is not warned about, as no real money is at stake", () => {
    const testnet = { Z402_NETWORK: "testnet", Z402_PAY_TO: bech32("utest"), Z402_UIVK: bech32("uivktest", 100) };
    expect(loadConfig(tokened(testnet)).warnings).toEqual([]);
  });
});

test("a refusal is a ConfigError", () => {
  const error = refusal(env({ Z402_WINDOW_ZAT: "0" }));
  expect(error).toBeInstanceOf(Error);
  expect(error.name).toBe("ConfigError");
});
