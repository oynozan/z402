// The wallet-fund job of compose.yaml, a port of infra/z3/fund-agent.sh. The agent is account 0 of the Zallet wallet,
// paying from its Orchard-only address at the lowest diversifier index from 1 that accepts one, the rule packages/client
// follows. When it holds less than 1 ZEC spendable, the job mines
// 110 blocks of coinbase to the wallet's miner address, shields up to 10 mature coinbase outputs to the agent, and
// mines the block that confirms them. Otherwise it changes nothing, so every `docker compose up` can run it again.
// RPC addresses come from Z3_ZEBRA_RPC and Z3_ZALLET_RPC (infra/z3/rpc.mjs).
import { readFileSync } from "node:fs";
import { mineNow, zalletRpc, zebraRpc } from "../../infra/z3/rpc.mjs";
import { publish, runJob, sleep, waitFor } from "./lib.mjs";

const MIN_ZAT = 100_000_000;
const FIRST_AGENT_DIVERSIFIER = 1;
const LAST_AGENT_DIVERSIFIER = 16;
/** Coinbase matures after 100 blocks, so 110 leave 10 outputs to shield */
const COINBASE_BLOCKS = 110;
const SHIELD_LIMIT = 10;
const MINER_FILE = "/chain-info/miner-address";
const AGENT_FILE = "/chain-info/agent-ua";

const log = (line) => console.log(`wallet-fund: ${line}`);

/** The tip once Zallet has scanned up to Zebra's tip, else undefined */
async function synced() {
  const tip = Number(await zebraRpc("getblockcount"));
  const status = await zalletRpc("getwalletstatus");
  return status?.wallet_tip?.height === tip && status?.fully_synced_height === tip ? tip : undefined;
}

/** Shielded notes only: z_getbalanceforaccount also counts immature coinbase as spendable transparent value */
async function spendableZat(account) {
  const balance = await zalletRpc("z_getbalanceforaccount", [account, 1]);
  return (balance?.pools?.ironwood?.valueZat ?? 0) + (balance?.pools?.orchard?.valueZat ?? 0);
}

/** The txid of an async operation once it succeeds; z_getoperationresult lists only finished operations */
async function operationTxid(opid) {
  const deadline = Date.now() + 600_000;
  for (let poll = 1; Date.now() < deadline; poll += 1) {
    const [done] = await zalletRpc("z_getoperationresult", [[opid]]);
    if (done !== undefined) {
      if (done.status === "success") return done.result?.txid ?? done.result?.txids?.[0];
      throw new Error(`z_shieldcoinbase ${done.status}: ${JSON.stringify(done.error ?? null)}`);
    }
    // An operation stays in z_getoperationstatus until its result is read, so one missing from both was lost
    if (poll % 20 === 0 && (await zalletRpc("z_getoperationstatus", [[opid]])).length === 0) {
      const [late] = await zalletRpc("z_getoperationresult", [[opid]]);
      if (late === undefined) throw new Error(`Zallet no longer knows operation ${opid} (did it restart?)`);
      if (late.status === "success") return late.result?.txid ?? late.result?.txids?.[0];
      throw new Error(`z_shieldcoinbase ${late.status}: ${JSON.stringify(late.error ?? null)}`);
    }
    await sleep(500);
  }
  throw new Error(`z_shieldcoinbase ${opid} did not finish within 600 s`);
}

/** Zallet's DiversifierIndexReuse: the account's default address already took the index with other receivers */
const isDiversifierReuse = (e) => e?.code === -4 && /already generated with different receiver types/.test(e?.message ?? "");

/** The agent's Orchard-only address at the lowest index from 1 that accepts one, as packages/client picks it */
async function agentAddress(account) {
  for (let index = FIRST_AGENT_DIVERSIFIER; index <= LAST_AGENT_DIVERSIFIER; index += 1) {
    let result;
    try {
      result = await zalletRpc("z_getaddressforaccount", [account, ["orchard"], index]);
    } catch (e) {
      if (isDiversifierReuse(e)) continue;
      throw e;
    }
    if (typeof result?.address !== "string" || result.address === "") {
      throw new Error("z_getaddressforaccount returned no address");
    }
    return result.address;
  }
  throw new Error(
    `Zallet has no Orchard-only address at diversifier indices ${FIRST_AGENT_DIVERSIFIER} to ${LAST_AGENT_DIVERSIFIER}`,
  );
}

runJob("wallet-fund", async () => {
  const miner = readFileSync(MINER_FILE, "utf8").trim();
  if (!miner.startsWith("tm")) throw new Error(`${MINER_FILE} holds no regtest t-address (zallet-init writes it)`);

  const accounts = await waitFor("Zallet RPC", 300_000, () => zalletRpc("z_listaccounts"));
  const account = accounts?.[0]?.account_uuid;
  if (typeof account !== "string") throw new Error("Zallet has no account 0 (zallet-init creates it)");
  const agent = await agentAddress(account);
  publish(AGENT_FILE, agent);

  await waitFor("Zallet sync", 600_000, synced);
  let have = await spendableZat(account);
  if (have >= MIN_ZAT) {
    log(`agent ${agent} already holds ${have} zat spendable`);
    return;
  }

  log(`mining ${COINBASE_BLOCKS} blocks of coinbase to ${miner}`);
  await zebraRpc("generatetoaddress", [COINBASE_BLOCKS, miner]);
  const tip = await waitFor("Zallet sync", 900_000, synced);
  log(`tip ${tip}, shielding mature coinbase to the agent`);
  const { opid } = await zalletRpc("z_shieldcoinbase", [miner, agent, null, SHIELD_LIMIT]);
  const txid = await operationTxid(opid);
  log(`shield txid ${txid}`);
  await mineNow(1);
  await waitFor("Zallet sync", 600_000, synced);

  have = await spendableZat(account);
  if (have < MIN_ZAT) throw new Error(`the agent holds only ${have} zat spendable after funding`);
  log(`agent ${agent} holds ${have} zat spendable`);
});
