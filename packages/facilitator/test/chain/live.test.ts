import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { LightwalletdClient } from "@z402/lightwalletd";
import { NETWORK_REGTEST } from "@z402/protocol";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { LightwalletdChainView } from "../../src/chain/lightwalletdChainView.js";
import { REPO_ROOT, ZDECRYPT_BIN } from "../support/fixtures.js";

const LWD_URL = "http://127.0.0.1:28137";
const SECRETS = join(REPO_ROOT, ".secrets", "merchant-regtest.json");
// This deposit exists only on the current Z3 chain, so after docker compose down -v pick a new one
const DEPOSIT_TXID = "98e84dabd476c1a59543ca3c51b9040e0080252abdd1c6b25c7eec1255df0eaf";
const DEPOSIT_MEMO = "aa80f78d384bdfad5a714585bac5ce6628110234f48a50476c81d92389c92046:1";

describe.skipIf(!process.env.Z402_LIVE || !existsSync(SECRETS))("live regtest deposit", () => {
  let lwd: LightwalletdClient;
  let view: LightwalletdChainView;

  beforeAll(async () => {
    const { createLightwalletdClient } = await import("@z402/lightwalletd");
    const merchant = JSON.parse(readFileSync(SECRETS, "utf8")) as { uivk: string; orchardOnlyAddress: string };
    lwd = createLightwalletdClient({ url: LWD_URL });
    view = new LightwalletdChainView({
      lwd,
      zdecryptBin: ZDECRYPT_BIN,
      uivk: merchant.uivk,
      payTo: merchant.orchardOnlyAddress,
      network: NETWORK_REGTEST,
    });
  });

  afterAll(() => lwd?.close());

  test("reads the deposit that paid the regtest merchant", async () => {
    await expect(view.inspect(DEPOSIT_TXID)).resolves.toMatchObject({
      found: true,
      txid: DEPOSIT_TXID,
      location: "mined",
      minedHeight: 115,
      hasTransparent: false,
      outputs: [{ pool: "ironwood", valueZat: 100000n, memo: DEPOSIT_MEMO }],
    });
  });

  test("an unknown transaction is a definitive not-found", async () => {
    await expect(view.inspect("ab".repeat(32))).resolves.toEqual({ found: false });
  });

  test("the tip is a block height", async () => {
    expect(await view.tip()).toBeGreaterThanOrEqual(115);
  });
});
