// The chain-init job of compose.yaml: mines the first two blocks, at whose height zebra.toml activates NU5 through
// NU6.3, unless the chain already has them, then checks that the chain tip runs NU6.3.
// Zebra's RPC address comes from Z3_ZEBRA_RPC (infra/z3/rpc.mjs).
import { zebraRpc } from "../../infra/z3/rpc.mjs";
import { runJob, waitFor } from "./lib.mjs";

const ACTIVATION_HEIGHT = 2;
const NU6_3 = "37a5165b";

runJob("chain-init", async () => {
  const tip = await waitFor("Zebra RPC", 300_000, async () => Number(await zebraRpc("getblockcount")));
  if (tip < ACTIVATION_HEIGHT) {
    await zebraRpc("generate", [ACTIVATION_HEIGHT - tip]);
  }
  const info = await zebraRpc("getblockchaininfo");
  const branch = info?.consensus?.chaintip;
  if (branch !== NU6_3) {
    throw new Error(`the chain tip runs consensus branch ${branch}, not ${NU6_3} (NU6.3): Zebra did not load zebra.toml`);
  }
  console.log(`chain-init: height ${info.blocks}, consensus branch ${branch}`);
});
