import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LightdInfo } from "@z402/lightwalletd";
import {
  ChainUnavailableError,
  NETWORK_MAINNET,
  NETWORK_REGTEST,
  NETWORK_TESTNET,
  type ZcashNetwork,
} from "@z402/protocol";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { startFakeLwd, type FakeLwd } from "../../lightwalletd/test/support/fakeLwd.js";
import { keyDigest } from "../src/providers/apiKey.js";
import { providerId } from "../src/providers/id.js";
import { runStartupChecks, StartupError } from "../src/startup.js";
import { FakeBinaries, type Call } from "./support/fakeZdecrypt.js";
import { KAGE_MEMO, KAGE_TXID, keys, minedFixture, ZDECRYPT_BIN } from "./support/fixtures.js";

const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));
const TESTNET_BRANCH = "77190ad9";
const REGTEST_BRANCH = "37a5165b";

const fakes = new FakeBinaries();
const scratch = mkdtempSync(join(tmpdir(), "z402-startup-"));
afterAll(() => {
  fakes.dispose();
  rmSync(scratch, { recursive: true, force: true });
});

/** The Sapling activation each network's lightwalletd reports, regtest's as Z3's Zaino reports it */
const SAPLING_AT: Record<ZcashNetwork, number> = {
  [NETWORK_MAINNET]: 419_200,
  [NETWORK_TESTNET]: 280_000,
  [NETWORK_REGTEST]: 1,
};

/** A lightwalletd of `network`, testnet unless given, on the branch given */
function lwdAt(consensusBranchId: string, over: Partial<LightdInfo> & { network?: ZcashNetwork } = {}) {
  const { network = NETWORK_TESTNET, ...fields } = over;
  const info: LightdInfo = {
    chainName: "test",
    saplingActivationHeight: SAPLING_AT[network],
    consensusBranchId,
    blockHeight: 1,
    version: "v0.0.0",
    ...fields,
  };
  return { getLightdInfo: vi.fn(async () => info) };
}

const merchant = {
  zdecryptBin: ZDECRYPT_BIN,
  uivk: keys.merchant.uivk,
  payTo: keys.merchant.orchardOnlyAddress,
  network: NETWORK_TESTNET,
  expectedBranchId: TESTNET_BRANCH,
  log: () => undefined,
} as const;

/** The error runStartupChecks rejects with, failing the test if it resolves */
async function refusal(attempt: Promise<unknown>): Promise<StartupError> {
  try {
    await attempt;
  } catch (e) {
    if (e instanceof StartupError) return e;
    throw e;
  }
  throw new Error("expected the startup checks to fail");
}

describe("runStartupChecks with the real zdecrypt", () => {
  test("passes for the merchant fixture key and its address", async () => {
    await expect(runStartupChecks({ ...merchant, lwd: lwdAt(TESTNET_BRANCH) })).resolves.toBeUndefined();
  });

  test("never looks at chainName", async () => {
    // Zaino reports "test" on regtest, so no name can be trusted
    for (const chainName of ["main", "regtest", "", "anything"]) {
      const lwd = lwdAt(TESTNET_BRANCH, { chainName });
      await expect(runStartupChecks({ ...merchant, lwd })).resolves.toBeUndefined();
    }
  });

  test("an address another key owns is refused as ownedByKey", async () => {
    const error = await refusal(
      runStartupChecks({ ...merchant, payTo: keys.publishedPaywallAddress, lwd: lwdAt(TESTNET_BRANCH) }),
    );
    expect(error.message).toMatch(/ownedByKey/);
    expect(error.message).toMatch(/Z402_UIVK/);
    expect(error.message).toMatch(/Z402_PAY_TO/);
  });

  test("a key of another network is refused by the owns check without echoing the key", async () => {
    const lwd = lwdAt(REGTEST_BRANCH, { network: NETWORK_REGTEST });
    const error = await refusal(runStartupChecks({ ...merchant, network: NETWORK_REGTEST, lwd }));
    expect(error.message).toMatch(/owns/);
    expect(error.message).not.toContain(keys.merchant.uivk.slice(12, 60));
  });

  test("another branch id is refused as consensusBranchId", async () => {
    const error = await refusal(runStartupChecks({ ...merchant, lwd: lwdAt(REGTEST_BRANCH) }));
    expect(error.message).toMatch(/consensusBranchId/);
    expect(error.message).toContain(REGTEST_BRANCH);
    expect(error.message).toContain(TESTNET_BRANCH);
    expect(error.message).toMatch(/Z402_EXPECTED_BRANCH_ID/);
  });

  test("the branch ids are compared without regard to case", async () => {
    await expect(
      runStartupChecks({ ...merchant, expectedBranchId: "77190AD9", lwd: lwdAt(TESTNET_BRANCH) }),
    ).resolves.toBeUndefined();
  });

  test("a lightwalletd that does not answer is refused as the network check", async () => {
    const lwd = {
      getLightdInfo: async (): Promise<LightdInfo> => {
        throw new ChainUnavailableError("lightwalletd GetLightdInfo failed: 14 UNAVAILABLE");
      },
    };
    const error = await refusal(runStartupChecks({ ...merchant, lwd }));
    expect(error.message).toMatch(/^startup check failed \(network\): /);
    expect(error.message).toMatch(/Z402_LWD_URL/);
    expect(error.message).toMatch(/UNAVAILABLE/);
  });

  test("a binary that is not there is refused as the self-test and names Z402_ZDECRYPT_BIN", async () => {
    const error = await refusal(
      runStartupChecks({ ...merchant, zdecryptBin: join(scratch, "no-such-zdecrypt"), lwd: lwdAt(TESTNET_BRANCH) }),
    );
    expect(error.message).toMatch(/self-test/);
    expect(error.message).toMatch(/Z402_ZDECRYPT_BIN/);
  });
});

describe("runStartupChecks with a stand-in zdecrypt", () => {
  const control = join(scratch, "replies.json");
  const stand = { bin: "" };
  let calls: () => Call[];

  const KAGE_REPORT = {
    txid: KAGE_TXID,
    version: 6,
    expiryHeight: 4521200,
    transparentIn: 0,
    transparentOut: 0,
    outputs: [{ pool: "ironwood", scope: "external", valueZat: 100000, memoKind: "text", memoText: KAGE_MEMO }],
  };
  const OWNS = { hasTransparent: false, ownedByKey: true };

  const withOutput = (over: Record<string, unknown>) => ({
    ...KAGE_REPORT,
    outputs: [{ ...KAGE_REPORT.outputs[0], ...over }],
  });

  /** `ownsByKey` answers the owns check of one viewing key in place of `owns`, and `{ $exit, $stdout }` is an exit */
  function reply(decrypt: unknown, owns: unknown = OWNS, ownsByKey: Record<string, unknown> = {}): void {
    writeFileSync(control, JSON.stringify({ decrypt, owns, ownsByKey }));
  }

  beforeAll(() => {
    // One shared script, since a fresh executable starts slowly on macOS, answering from the control file
    const stub = fakes.script(`
const replies = JSON.parse(require("node:fs").readFileSync(${JSON.stringify(control)}, "utf8"));
process.stdin.resume();
process.stdin.on("end", () => {
  const byKey = process.argv[2] === "owns" ? replies.ownsByKey[process.env.ZDECRYPT_KEY] : undefined;
  const reply = byKey ?? replies[process.argv[2]];
  if (reply !== null && typeof reply === "object" && "$exit" in reply) {
    process.stdout.write(JSON.stringify(reply.$stdout));
    process.exitCode = reply.$exit;
  } else {
    process.stdout.write(JSON.stringify(reply));
  }
});
`);
    stand.bin = stub.bin;
    calls = stub.calls;
  });

  const run = (over: Partial<Parameters<typeof runStartupChecks>[0]> = {}) =>
    runStartupChecks({
      ...merchant,
      zdecryptBin: stand.bin,
      payTo: "uaddress",
      uivk: "the-merchant-key",
      lwd: lwdAt(TESTNET_BRANCH),
      ...over,
    });

  test.each([
    [NETWORK_REGTEST, "regtest", REGTEST_BRANCH],
    [NETWORK_TESTNET, "testnet", TESTNET_BRANCH],
    [NETWORK_MAINNET, "mainnet", "bb09b876"],
  ] as Array<[ZcashNetwork, string, string]>)(
    "on %s the owns check passes --network %s while the self-test stays on testnet",
    async (network, bare, branch) => {
      reply(KAGE_REPORT);
      const before = calls().length;
      await run({ network, expectedBranchId: branch, lwd: lwdAt(branch, { network }) });

      const made = calls().slice(before);
      expect(made).toHaveLength(2);
      expect(made[0]?.argv).toEqual([
        "decrypt",
        "--height",
        String(minedFixture(KAGE_TXID).height),
        "--network",
        "testnet",
      ]);
      expect(made[1]?.argv).toEqual(["owns", "--address", "uaddress", "--network", bare]);
    },
  );

  test("the keys travel in the environment only", async () => {
    reply(KAGE_REPORT);
    const before = calls().length;
    await run();
    for (const call of calls().slice(before)) {
      expect(call.argv.join(" ")).not.toContain("the-merchant-key");
      expect(call.envKeys).toEqual(["PATH", "ZDECRYPT_KEY"]);
    }
  });

  test.each([
    ["a different amount", withOutput({ valueZat: 99999 })],
    ["a different memo", withOutput({ memoText: "x402z-000000000000000000000000" })],
    ["no memo", withOutput({ memoKind: "empty", memoText: null })],
    ["another pool", withOutput({ pool: "orchard" })],
    ["an internal output", withOutput({ scope: "internal" })],
    ["no output", { ...KAGE_REPORT, outputs: [] }],
    ["another transaction", { ...KAGE_REPORT, txid: "ab".repeat(32) }],
  ])("a vector that decrypts to %s fails the self-test", async (_, report) => {
    reply(report);
    const error = await refusal(run());
    expect(error.message).toMatch(/self-test/);
    expect(error.message).toContain("100000");
    expect(error.message).toContain(KAGE_MEMO);
  });

  test("a binary whose output is no report fails the self-test", async () => {
    reply({ error: "does not parse" });
    const error = await refusal(run());
    expect(error.message).toMatch(/self-test/);
  });

  test("a transparent receiver in payTo is refused as hasTransparent", async () => {
    reply(KAGE_REPORT, { hasTransparent: true, ownedByKey: true });
    const error = await refusal(run());
    expect(error.message).toMatch(/hasTransparent/);
    expect(error.message).toMatch(/Z402_PAY_TO/);
  });

  test("an unowned address is refused as ownedByKey", async () => {
    reply(KAGE_REPORT, { hasTransparent: false, ownedByKey: false });
    expect((await refusal(run())).message).toMatch(/ownedByKey/);
  });

  test("a failing self-test stops before the owns check and before lightwalletd is asked", async () => {
    reply(withOutput({ valueZat: 1 }));
    const before = calls().length;
    const lwd = lwdAt(TESTNET_BRANCH);
    await refusal(run({ lwd }));
    expect(calls().slice(before)).toHaveLength(1);
    expect(lwd.getLightdInfo).not.toHaveBeenCalled();
  });

  test("a mainnet start without an expected branch id warns instead of failing", async () => {
    reply(KAGE_REPORT);
    const log = vi.fn<(message: string) => void>();
    const lwd = lwdAt("deadbeef", { network: NETWORK_MAINNET });
    await run({ network: NETWORK_MAINNET, expectedBranchId: undefined, lwd, log });
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toMatch(/Z402_EXPECTED_BRANCH_ID/);
  });

  describe("the network lightwalletd serves", () => {
    const otherNetwork = (reported: number, network: ZcashNetwork) =>
      `startup check failed (network): lightwalletd reports Sapling activation at ${reported}, ` +
      `which is not ${network}'s; Z402_LWD_URL serves another network`;

    test("mainnet refuses an endpoint on testnet's Sapling activation and branch, branch id or not", async () => {
      reply(KAGE_REPORT);
      for (const expectedBranchId of [undefined, TESTNET_BRANCH]) {
        const log = vi.fn<(message: string) => void>();
        const lwd = lwdAt(TESTNET_BRANCH, { network: NETWORK_TESTNET });
        const error = await refusal(run({ network: NETWORK_MAINNET, expectedBranchId, lwd, log }));
        expect(error.message).toBe(otherNetwork(280_000, NETWORK_MAINNET));
        expect(log).not.toHaveBeenCalled();
      }
    });

    test("testnet refuses an endpoint that reports regtest's Sapling activation", async () => {
      reply(KAGE_REPORT);
      const error = await refusal(run({ lwd: lwdAt(TESTNET_BRANCH, { network: NETWORK_REGTEST }) }));
      expect(error.message).toBe(otherNetwork(1, NETWORK_TESTNET));
    });

    test.each([280_000, 419_200])("regtest refuses an endpoint that reports %i", async (reported) => {
      reply(KAGE_REPORT);
      const lwd = lwdAt(REGTEST_BRANCH, { saplingActivationHeight: reported });
      const error = await refusal(run({ network: NETWORK_REGTEST, expectedBranchId: REGTEST_BRANCH, lwd }));
      expect(error.message).toBe(otherNetwork(reported, NETWORK_REGTEST));
    });

    test("regtest passes the Sapling activation at 1 that Z3's Zaino reports", async () => {
      reply(KAGE_REPORT);
      const lwd = lwdAt(REGTEST_BRANCH, { network: NETWORK_REGTEST });
      await expect(run({ network: NETWORK_REGTEST, expectedBranchId: REGTEST_BRANCH, lwd })).resolves.toBeUndefined();
    });

    test("is checked before the branch, so an endpoint on another network is named as one", async () => {
      reply(KAGE_REPORT);
      const error = await refusal(run({ lwd: lwdAt(REGTEST_BRANCH, { network: NETWORK_REGTEST }) }));
      expect(error.message).toBe(otherNetwork(1, NETWORK_TESTNET));
    });

    test("and the branch are read from one GetLightdInfo", async () => {
      reply(KAGE_REPORT);
      const lwd = lwdAt(TESTNET_BRANCH);
      await run({ lwd });
      expect(lwd.getLightdInfo).toHaveBeenCalledTimes(1);
    });
  });

  test("an expected branch id is not warned about", async () => {
    reply(KAGE_REPORT);
    const log = vi.fn<(message: string) => void>();
    await run({ log });
    expect(log).not.toHaveBeenCalled();
  });

  describe("main", () => {
    const KEY = "uivk1" + "q".repeat(100);
    const PAY_TO = "u1" + "q".repeat(60);
    const TOKEN = "main-test-token";
    let lwd: FakeLwd;

    beforeAll(async () => {
      lwd = await startFakeLwd({
        latestBlock: { height: "3000000" },
        lightdInfo: { chainName: "main", saplingActivationHeight: "419200", consensusBranchId: "c2d6d0b4" },
      });
    });
    afterAll(() => lwd.close());

    function configured(over: Record<string, string> = {}): NodeJS.ProcessEnv {
      const clean = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("Z402_")));
      return {
        ...clean,
        Z402_NETWORK: "mainnet",
        Z402_LWD_URL: lwd.url,
        Z402_PAY_TO: PAY_TO,
        Z402_UIVK: KEY,
        Z402_FACILITATOR_TOKEN: TOKEN,
        Z402_ZDECRYPT_BIN: stand.bin,
        Z402_LEDGER: join(scratch, "main-ledger.jsonl"),
        Z402_PROVIDERS_DIR: join(scratch, `providers-${Math.random().toString(36).slice(2)}`),
        Z402_FACILITATOR_HOST: "127.0.0.1",
        Z402_FACILITATOR_PORT: "0",
        ...over,
      };
    }

    function launch(env: NodeJS.ProcessEnv) {
      const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
        cwd: PACKAGE_DIR,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const out = { stdout: "", stderr: "" };
      child.stdout.on("data", (chunk: Buffer) => (out.stdout += chunk.toString("utf8")));
      child.stderr.on("data", (chunk: Buffer) => (out.stderr += chunk.toString("utf8")));
      const exited = new Promise<number | null>((resolve) => child.on("close", (code) => resolve(code)));
      return { child, out, exited };
    }

    async function until(done: () => boolean, what: string): Promise<void> {
      for (let i = 0; i < 400 && !done(); i++) await new Promise((resolve) => setTimeout(resolve, 50));
      if (!done()) throw new Error(`timed out waiting for ${what}`);
    }

    test("a missing token exits 1 naming the variable and prints nothing on stdout", { timeout: 30_000 }, async () => {
      const { out, exited } = launch(configured({ Z402_FACILITATOR_TOKEN: "" }));
      expect(await exited).toBe(1);
      expect(out.stderr).toMatch(/Z402_FACILITATOR_TOKEN/);
      expect(out.stdout).toBe("");
    });

    test("each config warning goes to stderr before the startup checks run", { timeout: 30_000 }, async () => {
      reply(withOutput({ valueZat: 1 }));
      const { out, exited } = launch(configured({ Z402_LWD_URL: "https://lwd.invalid:443" }));
      expect(await exited).toBe(1);
      expect(out.stdout).toBe("");
      const lines = out.stderr.trimEnd().split("\n");
      expect(lines[0]).toMatch(/^facilitator: warning: Z402_LWD_URL points at lwd\.invalid: /);
      expect(lines.slice(1).join("\n")).toMatch(/startup check failed \(self-test\)/);
    });

    test("a failed check exits 1 naming the check and never prints the key", { timeout: 30_000 }, async () => {
      reply(withOutput({ valueZat: 1 }));
      const { out, exited } = launch(configured());
      expect(await exited).toBe(1);
      expect(out.stderr).toMatch(/self-test/);
      expect(out.stdout).toBe("");
      expect(out.stderr).not.toContain(KEY);
    });

    test(
      "a ready facilitator prints the ready line, then its provider count, serves with its token and stops on SIGINT",
      { timeout: 30_000 },
      async () => {
        reply(KAGE_REPORT);
        const { child, out, exited } = launch(configured());
        try {
          await until(() => out.stdout.split("\n").length > 2, "the ready line and the provider count");
          const [first, second] = out.stdout.split("\n");
          const ready = /^facilitator listening on (http:\/\/127\.0\.0\.1:\d+) network=zcash:mainnet payTo=(\S+)$/.exec(
            first ?? "",
          );
          expect(ready).not.toBeNull();
          expect(ready?.[2]).toBe(PAY_TO);
          expect(second).toBe("facilitator providers=0");
          const url = ready?.[1] ?? "";

          // The advertisement is public, and everything else needs the token
          expect((await fetch(`${url}/supported`)).status).toBe(200);
          expect((await fetch(`${url}/providers/me`)).status).toBe(401);
          const me = await fetch(`${url}/providers/me`, { headers: { authorization: `Bearer ${TOKEN}` } });
          expect(me.status).toBe(200);
          const supported = await fetch(`${url}/supported`, { headers: { authorization: `Bearer ${TOKEN}` } });
          expect(supported.status).toBe(200);
          expect(await supported.json()).toMatchObject({
            kinds: [{ network: "zcash:mainnet", scheme: "prepaid-voucher" }],
          });

          child.kill("SIGINT");
          expect(await exited).toBe(0);
        } finally {
          child.kill("SIGKILL");
        }
        // stdout holds the ready line and the count alone, and neither secret is printed anywhere
        expect(out.stdout.trimEnd().split("\n")).toHaveLength(2);
        for (const text of [out.stdout, out.stderr]) {
          expect(text).not.toContain(KEY);
          expect(text).not.toContain(TOKEN);
        }
        expect(out.stderr).toMatch(/Z402_EXPECTED_BRANCH_ID/);
      },
    );

    describe("with providers", () => {
      const PROVIDER = { payTo: `u1${"p".repeat(60)}`, uivk: `uivk1${"p".repeat(100)}` };
      const PROVIDER_KEY = `z402_${"K".repeat(43)}`;
      const REGISTRATION = "main-registration-token";

      /** A providers directory that an earlier start left, holding PROVIDER under PROVIDER_KEY */
      function registered(): string {
        const dir = join(scratch, `providers-${Math.random().toString(36).slice(2)}`);
        mkdirSync(join(dir, "ledgers"), { recursive: true, mode: 0o700 });
        const at = "2026-10-28T10:00:00.000Z";
        const provider = {
          id: providerId("zcash:mainnet", PROVIDER.payTo),
          payTo: PROVIDER.payTo,
          uivk: PROVIDER.uivk,
          keyHash: keyDigest(PROVIDER_KEY),
          createdAt: at,
          keyIssuedAt: at,
        };
        writeFileSync(
          join(dir, "registry.json"),
          `${JSON.stringify({ version: 1, network: "zcash:mainnet", providers: [provider] })}\n`,
          { mode: 0o600 },
        );
        return dir;
      }

      test("opens a provider that was registered, counts it and serves its key", { timeout: 30_000 }, async () => {
        reply(KAGE_REPORT);
        const dir = registered();
        const tipReads = () => lwd.calls.filter((c) => c.rpc === "GetLatestBlock").length;
        const before = tipReads();
        const { child, out, exited } = launch(configured({ Z402_PROVIDERS_DIR: dir }));
        try {
          await until(() => out.stdout.split("\n").length > 2, "the ready line and the provider count");
          expect(out.stdout.split("\n")[1]).toBe("facilitator providers=1");
          // The first poll of the operator and of the provider ask for the tip together, and lightwalletd is asked once
          expect(tipReads() - before).toBe(1);
          const url = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(out.stdout)?.[1] ?? "";

          const res = await fetch(`${url}/providers/me`, { headers: { authorization: `Bearer ${PROVIDER_KEY}` } });
          expect(res.status).toBe(200);
          expect(await res.json()).toEqual({
            providerId: providerId("zcash:mainnet", PROVIDER.payTo),
            network: "zcash:mainnet",
            payTo: PROVIDER.payTo,
          });
          child.kill("SIGINT");
          expect(await exited).toBe(0);
        } finally {
          child.kill("SIGKILL");
        }
        expect(existsSync(join(dir, "ledgers", `${providerId("zcash:mainnet", PROVIDER.payTo)}.jsonl`))).toBe(true);
        for (const text of [out.stdout, out.stderr]) {
          for (const secret of [PROVIDER.uivk, PROVIDER_KEY, TOKEN, KEY]) expect(text).not.toContain(secret);
        }
      });

      test("refuses to start when a provider's key no longer owns its payTo", { timeout: 30_000 }, async () => {
        // The operator's key passes its own check, while the provider's reads as a payTo with a transparent receiver
        reply(KAGE_REPORT, OWNS, { [PROVIDER.uivk]: { hasTransparent: true, ownedByKey: true } });
        const { out, exited } = launch(configured({ Z402_PROVIDERS_DIR: registered() }));
        expect(await exited).toBe(1);

        expect(out.stdout).toBe("");
        const id = providerId("zcash:mainnet", PROVIDER.payTo);
        expect(out.stderr).toContain(
          `facilitator: providersDir: provider ${id}: the stored viewing key no longer owns its payTo`,
        );
        expect(out.stderr).not.toContain(PROVIDER.uivk);
      });

      test("answers 403 not_owner to a key that zdecrypt refuses, with no failure", { timeout: 30_000 }, async () => {
        // What the real binary does with a key or an address of the right shape that does not decode
        const refusal = { error: "not a mainnet unified full viewing key (malformed encoding)" };
        reply(KAGE_REPORT, OWNS, { [PROVIDER.uivk]: { $exit: 2, $stdout: refusal } });
        const dir = join(scratch, `providers-${Math.random().toString(36).slice(2)}`);
        const { child, out, exited } = launch(configured({ Z402_PROVIDERS_DIR: dir }));
        try {
          await until(() => out.stdout.split("\n").length > 2, "the ready line and the provider count");
          const url = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(out.stdout)?.[1] ?? "";
          const res = await fetch(`${url}/providers`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ payTo: PROVIDER.payTo, uivk: PROVIDER.uivk }),
          });
          expect(res.status).toBe(403);
          expect(await res.json()).toMatchObject({ error: "not_owner" });
          child.kill("SIGINT");
          expect(await exited).toBe(0);
        } finally {
          child.kill("SIGKILL");
        }
        expect(existsSync(join(dir, "registry.json"))).toBe(false);
        expect(out.stderr.includes("registration failed")).toBe(false);
        for (const text of [out.stdout, out.stderr]) expect(text.includes(PROVIDER.uivk)).toBe(false);
      });

      test("registers a provider over HTTP, proves its key and stores only a hash", { timeout: 30_000 }, async () => {
        reply(KAGE_REPORT);
        const dir = join(scratch, `providers-${Math.random().toString(36).slice(2)}`);
        const { child, out, exited } = launch(
          configured({ Z402_PROVIDERS_DIR: dir, Z402_REGISTRATION_TOKEN: REGISTRATION }),
        );
        let apiKey = "";
        try {
          await until(() => out.stdout.split("\n").length > 2, "the ready line and the provider count");
          expect(out.stdout.split("\n")[1]).toBe("facilitator providers=0");
          const url = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(out.stdout)?.[1] ?? "";
          const body = JSON.stringify({ payTo: PROVIDER.payTo, uivk: PROVIDER.uivk });
          const post = (token?: string) =>
            fetch(`${url}/providers`, {
              method: "POST",
              headers: {
                "content-type": "application/json",
                ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
              },
              body,
            });

          expect((await post()).status).toBe(401);
          const created = await post(REGISTRATION);
          expect(created.status).toBe(201);
          const answer = (await created.json()) as { apiKey: string; providerId: string };
          apiKey = answer.apiKey;
          expect(answer.providerId).toBe(providerId("zcash:mainnet", PROVIDER.payTo));
          const me = await fetch(`${url}/providers/me`, { headers: { authorization: `Bearer ${apiKey}` } });
          expect(me.status).toBe(200);

          child.kill("SIGINT");
          expect(await exited).toBe(0);
        } finally {
          child.kill("SIGKILL");
        }
        const stored = readFileSync(join(dir, "registry.json"), "utf8");
        expect(stored).toContain(keyDigest(apiKey));
        expect(stored).not.toContain(apiKey);
        for (const text of [out.stdout, out.stderr]) {
          for (const secret of [PROVIDER.uivk, apiKey, REGISTRATION, TOKEN, KEY]) expect(text).not.toContain(secret);
        }
        expect(out.stderr).toContain(
          `facilitator: registered provider ${providerId("zcash:mainnet", PROVIDER.payTo)} payTo=${PROVIDER.payTo}`,
        );
      });
    });
  });
});
