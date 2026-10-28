/**
 * The checks that stop a misconfigured facilitator from starting (design §4.7 steps 2 to 4). They run in this order,
 * each one only if the one before passed, and every failure names its check and the setting to look at.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { LightdInfo, LightwalletdClient } from "@z402/lightwalletd";
import { NETWORK_MAINNET, NETWORK_TESTNET, type ZcashNetwork } from "@z402/protocol";
import { ZdecryptError, zdecryptDecrypt, zdecryptNetwork, zdecryptOwns } from "./chain/zdecrypt.js";
import { REPO_ROOT } from "./config.js";

export class StartupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StartupError";
  }
}

export interface StartupCheckOptions {
  zdecryptBin: string;
  uivk: string;
  payTo: string;
  network: ZcashNetwork;
  lwd: Pick<LightwalletdClient, "getLightdInfo">;
  /** Left out where no branch id is known, which logs a warning instead of checking */
  expectedBranchId?: string;
  /** Where the warning goes, `console.warn` by default */
  log?: (message: string) => void;
}

const FIXTURE_DIR = join(REPO_ROOT, "crates", "zdecrypt", "tests", "fixtures");

/** A real testnet transaction paying the published Kage x402 key 100000 zat in Ironwood, so always read as testnet */
const KAGE_TXID = "030c3cbf78ce8460553bba4e82c0ba813f039bd3ecf4d7f2e81c59837dc28351";
const KAGE_MEMO = "x402z-f19a63da20cbc0749ea800b3";
const KAGE_VALUE_ZAT = 100000;

/** Where Sapling activated on each public network, which tells the networks apart where chainName cannot */
const SAPLING_ACTIVATION: ReadonlyMap<ZcashNetwork, number> = new Map([
  [NETWORK_MAINNET, 419_200],
  [NETWORK_TESTNET, 280_000],
]);

function failed(check: string, detail: string): StartupError {
  return new StartupError(`startup check failed (${check}): ${detail}`);
}

function text(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function readVector(): { height: number; hex: string; key: string } {
  const [height, hex] = readFileSync(join(FIXTURE_DIR, `${KAGE_TXID}.mined`), "utf8")
    .trim()
    .split(" ");
  const keys: unknown = JSON.parse(readFileSync(join(FIXTURE_DIR, "keys-and-synthetic.json"), "utf8"));
  const key = (keys as { publishedX402Uivk?: unknown } | null)?.publishedX402Uivk;
  if (height === undefined || hex === undefined || !Number.isSafeInteger(Number(height)) || typeof key !== "string") {
    throw new Error("the Kage fixtures do not have the expected shape");
  }
  return { height: Number(height), hex, key };
}

/** Proves the binary can decrypt a transaction at all, against a vector whose answer is known */
async function selfTest(bin: string): Promise<void> {
  const check = "self-test";
  let vector: ReturnType<typeof readVector>;
  try {
    vector = readVector();
  } catch (e) {
    throw failed(
      check,
      `cannot read the Kage test vector under ${FIXTURE_DIR} (${(e as NodeJS.ErrnoException).code ?? text(e)})`,
    );
  }

  let report;
  try {
    report = await zdecryptDecrypt({
      bin,
      key: vector.key,
      rawHex: vector.hex,
      at: { height: vector.height },
      network: "testnet",
    });
  } catch (e) {
    if (e instanceof ZdecryptError) {
      throw failed(
        check,
        `${e.message}; is Z402_ZDECRYPT_BIN (${bin}) a built zdecrypt? (pnpm --filter @z402/facilitator build:native)`,
      );
    }
    throw e;
  }

  const decrypted =
    report.txid === KAGE_TXID &&
    report.outputs.some(
      (out) =>
        out.pool === "ironwood" &&
        out.scope === "external" &&
        out.valueZat === KAGE_VALUE_ZAT &&
        out.memoText === KAGE_MEMO,
    );
  if (!decrypted) {
    throw failed(
      check,
      `zdecrypt did not decrypt the Kage test vector ${KAGE_TXID} to an ironwood output of ${KAGE_VALUE_ZAT} zat ` +
        `with memo ${KAGE_MEMO}; is Z402_ZDECRYPT_BIN (${bin}) a current build?`,
    );
  }
}

/** The key must decrypt what is sent to payTo, and payTo must not take deposits in the clear */
async function ownership(o: StartupCheckOptions): Promise<void> {
  let owns;
  try {
    owns = await zdecryptOwns({
      bin: o.zdecryptBin,
      key: o.uivk,
      address: o.payTo,
      network: zdecryptNetwork(o.network),
    });
  } catch (e) {
    if (e instanceof ZdecryptError) {
      throw failed("owns", `${e.message}; check Z402_UIVK and Z402_PAY_TO against Z402_NETWORK (${o.network})`);
    }
    throw e;
  }
  if (!owns.ownedByKey) {
    throw failed("ownedByKey", "Z402_UIVK is not the viewing key of Z402_PAY_TO, so no deposit to it could be read");
  }
  if (owns.hasTransparent) {
    throw failed("hasTransparent", "Z402_PAY_TO has a transparent receiver, but deposits must be shielded");
  }
}

async function lightdInfo(lwd: StartupCheckOptions["lwd"]): Promise<LightdInfo> {
  try {
    return await lwd.getLightdInfo();
  } catch (e) {
    throw failed("network", `lightwalletd did not answer GetLightdInfo (${text(e)}); check Z402_LWD_URL`);
  }
}

/** A regtest may activate Sapling anywhere but where a public network did, and Z3's Zaino reports 1 */
function servesNetwork(info: LightdInfo, network: ZcashNetwork): void {
  const reported = info.saplingActivationHeight;
  const own = SAPLING_ACTIVATION.get(network);
  const serves = own === undefined ? ![...SAPLING_ACTIVATION.values()].includes(reported) : reported === own;
  if (!serves) {
    throw failed(
      "network",
      `lightwalletd reports Sapling activation at ${reported}, which is not ${network}'s; ` +
        "Z402_LWD_URL serves another network",
    );
  }
}

/** The consensus branch tells which network upgrade the endpoint follows */
function branch(info: LightdInfo, expected: string): void {
  const reported = info.consensusBranchId;
  if (reported.toLowerCase() !== expected.toLowerCase()) {
    throw failed(
      "consensusBranchId",
      `lightwalletd reports ${reported} but Z402_EXPECTED_BRANCH_ID is ${expected}; ` +
        "the endpoint is on another upgrade (or network); check Z402_LWD_URL and Z402_NETWORK",
    );
  }
}

/** Throws a StartupError that names the failed check */
export async function runStartupChecks(o: StartupCheckOptions): Promise<void> {
  await selfTest(o.zdecryptBin);
  await ownership(o);
  const info = await lightdInfo(o.lwd);
  servesNetwork(info, o.network);
  if (o.expectedBranchId === undefined) {
    const warn = o.log ?? ((message: string) => console.warn(message));
    warn("warning: Z402_EXPECTED_BRANCH_ID is not set, so the consensus branch of lightwalletd is not checked");
    return;
  }
  branch(info, o.expectedBranchId);
}
