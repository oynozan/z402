import { accessSync, constants, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const FIXTURE_DIR = join(REPO_ROOT, "crates", "zdecrypt", "tests", "fixtures");

export const ZDECRYPT_BIN =
  process.env.Z402_ZDECRYPT_BIN ?? join(REPO_ROOT, "crates", "zdecrypt", "target", "release", "zdecrypt");

try {
  accessSync(ZDECRYPT_BIN, constants.X_OK);
} catch {
  throw new Error(
    `zdecrypt binary missing — run pnpm --filter @z402/facilitator run build:native (looked for ${ZDECRYPT_BIN})`,
  );
}

export interface KeysFixture {
  publishedX402Uivk: string;
  publishedPaywallUivk: string;
  publishedPaywallAddress: string;
  merchant: { uivk: string; ufvk: string; address: string; orchardOnlyAddress: string };
  agentUfvk: string;
  deposit: { txid: string; hex: string; memo: string; tip: number };
  funding: { txid: string; hex: string };
}

export const keys: KeysFixture = JSON.parse(readFileSync(join(FIXTURE_DIR, "keys-and-synthetic.json"), "utf8"));

/** Real testnet transaction where the published x402 UIVK is paid 100000 zat in Ironwood */
export const KAGE_TXID = "030c3cbf78ce8460553bba4e82c0ba813f039bd3ecf4d7f2e81c59837dc28351";
export const KAGE_MEMO = "x402z-f19a63da20cbc0749ea800b3";

/** Real testnet transaction with a transparent output, paid to the published paywall UIVK */
export const PAYWALL_TXID = "bb8d88426b96a4cd92ec90446d154de5321da7b2bb863d9249a43838e49a82ec";
export const PAYWALL_MEMO = "zpv-d7289a63fabd56ff2f8a7261";

/** A frozen `<txid>.mined` fixture, one line of `<height> <hex>` */
export function minedFixture(txid: string): { height: number; hex: string } {
  const [height, hex] = readFileSync(join(FIXTURE_DIR, `${txid}.mined`), "utf8").trim().split(" ");
  if (height === undefined || hex === undefined) throw new Error(`fixture ${txid}.mined is not "<height> <hex>"`);
  return { height: Number(height), hex };
}

export function hexBytes(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex, "hex"));
}
