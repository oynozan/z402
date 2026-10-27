import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createLightwalletdClient, type LightwalletdClient } from "../src/index.js";

const URL_ = process.env.Z402_LWD_URL ?? "http://127.0.0.1:28137";
const EXPECTED_BRANCH_ID = process.env.Z402_EXPECTED_BRANCH_ID ?? "37a5165b";
const TESTNET_MINED_TX = "030c3cbf78ce8460553bba4e82c0ba813f039bd3ecf4d7f2e81c59837dc28351";

describe.skipIf(!process.env.Z402_LIVE)("live CompactTxStreamer", () => {
  let client: LightwalletdClient;

  beforeAll(() => {
    client = createLightwalletdClient({ url: URL_ });
  });

  afterAll(() => {
    client.close();
  });

  test("consensus branch id matches the configured network", async () => {
    expect((await client.getLightdInfo()).consensusBranchId).toBe(EXPECTED_BRANCH_ID);
  });

  test("tip is a non-negative integer", async () => {
    const tip = await client.getTip();
    expect(Number.isSafeInteger(tip)).toBe(true);
    expect(tip).toBeGreaterThanOrEqual(0);
  });

  test("an unknown txid is a definitive not-found", async () => {
    expect(await client.getTransaction("ab".repeat(32))).toEqual({ found: false });
  });

  test.skipIf(!URL_.includes("testnet.zec.rocks"))("a known testnet transaction is mined", async () => {
    expect(await client.getTransaction(TESTNET_MINED_TX)).toMatchObject({
      found: true,
      location: "mined",
      height: 4521112,
    });
  });
});
