# Z3 regtest, observed (2026-10-27)

> What the stack actually did, measured on the machine, as opposed to `z3.md`, which was derived
> from sources. Where the two differ, this file wins. Scripts: `infra/z3/` (see its README).

## 0. Summary

| Fact | Observed |
|---|---|
| Path that worked | **Primary**: Z3 `e84ce9fd` + Zebra 6.2.3 + Zallet beta.1 + Zaino **0.10.2-no-tls**, with one extra fix (Zaino LMDB map size, §2). Neither the Zallet beta.3 fallback nor fallback A was needed. |
| `GetTransaction` in mempool | `height: "0"` |
| `GetTransaction` once mined | `height: "<block height>"` (`"113"` for a tx mined in block 113) |
| `GetTransaction` unknown txid | gRPC **13 INTERNAL**, details `RPC error: LegacyRpcError { code: -5, message: "No such mempool or main chain transaction" }` |
| `TxFilter.hash` | byte-reversed txid (display order reversed). Natural byte order gives the same not-found error. |
| `GetLightdInfo.chainName` | `"test"` (not `"regtest"`) |
| `GetLightdInfo.consensusBranchId` | `"37a5165b"` (NU6.3), `upgradeName: "NU6.3"`, `upgradeHeight: "2"` |
| Zallet tx expiry | `expiryHeight = tip at build + 41 = next block + 40`. Mined in the next block, `expiry − minedHeight = 40`. Same for `z_shieldcoinbase` and `z_sendmany`. |
| Tx version | v6 (header `06000080`), shielded value in the **ironwood** pool |
| `generate 1` | 0.11–0.35 s wall clock (including `getblockcount`) |
| Shielded send (`z_sendmany`, 1 recipient + memo) | 5.8–9.9 s from call to `status: "success"`, visible in Zaino 0.1–0.3 s later |
| Fee of that send | **25,000 zat** (5 Ironwood actions: Zallet splits change into 4 notes), tx 18,634 bytes |
| Regtest block subsidy to the miner | 6.25 ZEC (coinbase output `625000000` zat) |
| Agent funding | 62.5 ZEC shielded from 10 coinbase UTXOs, fee 60,000 zat, spendable 62.4994 ZEC |

## 1. Environment and images

- macOS arm64 (Apple M5). Docker 29.5.2 server inside **Colima** (`colima-domture` context, a VM
  shared with another project): Ubuntu 24.04, kernel 6.8, aarch64, 4 CPUs, 8 GiB RAM. amd64
  images run emulated.
- Images that ran:

  | Service | Image | Digest | Arch |
  |---|---|---|---|
  | zebra | `zfnd/zebra:6.2.3` | `sha256:bb2a6029db277ee3a10e951dcc0ddd36b4cbcbe0fad684746d695ee21d53fde2` | arm64 native |
  | zallet | `zodlinc/zallet:v0.1.0-beta.1@sha256:1849b446…` (Z3 pin) | `sha256:1849b4469875dc0165942c06d15fa6a7da76b2d43bade578cc8e5903a639869d` | arm64 native |
  | zaino | `zingodevops/zainod:0.10.2-no-tls` (override) | `sha256:fc5716da26e0634b2dfdcb80d710dc63c883c44e0501700825cee1155a384f02` | amd64, emulated |
  | cookie-permissions | `alpine:3` | `sha256:be2656061b536c1883c4034790e21d0a09c5aaaf51968b89368a3c0371ea2c9a` | arm64 |

- gRPC client: `@grpc/grpc-js@1.14.6` + `@grpc/proto-loader@0.8.1` against
  `zcash/lightwallet-protocol` `ec53075c` (v0.6.0) `walletrpc/service.proto`, loaded with
  `longs: String`. `grpcurl` is not installed.

## 2. Where reality differed from `z3.md`

1. **Zaino 0.10.2 does not start under amd64 emulation with its default LMDB map.** Every
   start failed with
   `Zaino failed to start, e: NodeBackedIndexerService error: Tonic status error: code: 'Internal error', message: "LMDB database error: Cannot allocate memory"`.
   The default `[storage.database] size` is 384 (GB). 8 GB failed the same way; **1 GB works**.
   `up.sh` appends `[storage.database]` / `size = 1` to the live `config/regtest/zaino.toml`.
   This is a property of the emulated amd64 process, not of Zaino's logic. 1 GB is ample for
   regtest.
2. **Z3's `regtest-init.sh` re-run guard is wrong for Zallet beta.1.** It treats the wallet as
   initialised only if `/data/*.age` exists. beta.1 writes `identity.txt` and `wallet.db` and
   never a `.age` file, so a second run would `rm -f /data/wallet.db` on an initialised wallet.
   `up.sh` runs it once, guarded by its own marker in the wallet volume.
3. **`chainName` is `"test"`**, confirming `z3.md` §4.6. `estimatedHeight` is meaningless on
   regtest (`"6619020"` at height 2); never use it.
4. **Fee is not 10,000 zat for a one-recipient send.** Zallet split the change into 4 notes, so
   the tx had 5 Ironwood actions and paid 25,000 zat (ZIP 317, 5 × 5,000). Budget at least
   25,000 zat per deposit, or read `fee_paid` from `z_listtransactions`.
5. **`z_getbalanceforaccount [uuid, 1]` lists immature coinbase as spendable transparent.** After
   funding it reported `transparent.valueZat: 62500000000` (100 coinbase UTXOs at heights
   13–112 with the tip at 113, so all but one or two still immature). The adapter must count only `ironwood` (+ `orchard`), as `z3.md` §3 already says.
6. **`z_listtransactions` returns memos as decoded UTF-8 text** (`"memo": "z402-probe:0"`), not
   hex, even though `z_sendmany` requires hex. In a send to another address of the same account,
   every output, including the recipient one, has `is_change: true`; behaviour for an external
   recipient is still unverified.
7. Account 0's diversifier index 0 already holds a p2pkh+sapling+orchard UA, so an Orchard-only
   UA at index 0 is refused (`-4 Error: address at diversifier index 0 was already generated
   with different receiver types.`). `AGENT_UA` uses index 1, which is stable across calls.
8. Shielded coinbase lands in the **ironwood** pool, as predicted. `z_shieldcoinbase` with
   `limit 10` took 10 UTXOs and left 1 mature one (`remainingUTXOs: 1`).
9. Zebra 6.2.3 has `generatetoaddress`; 110 blocks took 11–17 s. `generate` pays the
   `.env.regtest` miner `tmSRd1r8gs77Ja67Fw1JcdoXytxsyrLTPJm`, which is not a wallet address.
10. Compose warns `volume "z3-regtest-zallet" already exists but was not created by Docker
    Compose` because `regtest-init.sh` creates it with `docker run`. Harmless:
    `down.sh --wipe` (`down --volumes`) still removes it.
11. Not needed: `allow_insecure_remote_bind`, Zallet beta.3, any activation-height change.
    `require_backup = false` was applied as a precaution; the run without it was not tried.

## 3. Raw observations

### 3.1 Bring-up (`bash infra/z3/up.sh` on a wiped machine, 31 s)

```
==> Checks
    Zebra height:            2
    Zaino chainName:         test
    Zaino consensusBranchId: 37a5165b

==> Running images
    cookie-permissions	alpine:3	Up 9 seconds (healthy)
    zaino	zingodevops/zainod:0.10.2-no-tls	Up 2 seconds (health: starting)
    zallet	zodlinc/zallet:v0.1.0-beta.1@sha256:1849b4469875dc0165942c06d15fa6a7da76b2d43bade578cc8e5903a639869d	Up 3 seconds
    zebra	zfnd/zebra:6.2.3	Up 9 seconds (healthy)
```

Re-run on a running stack: 2.7 s, every step skipped. `down.sh` then `up.sh`: 16 s, height,
wallet and Zaino index kept (Zaino answered after 9 s).

Zebra `getblockchaininfo` (trimmed with jq):

```json
{
  "chain": "test",
  "blocks": 113,
  "consensus": { "chaintip": "37a5165b", "nextblock": "37a5165b" },
  "upgrades": {
    "5ba81b19": "Overwinter@1", "76b809bb": "Sapling@1", "2bb40e60": "Blossom@1",
    "f5b9230b": "Heartwood@1", "e9ff75a6": "Canopy@1", "c2d6d0b4": "NU5@2",
    "c8e71055": "NU6@2", "4dec4df0": "NU6.1@2", "5437f330": "NU6.2@2", "37a5165b": "NU6.3@2"
  }
}
```

Zaino adopted the same schedule from Zebra:
`Adopted activation heights from the validator, heights: ActivationHeights { before_overwinter: None, overwinter: Some(1), sapling: Some(1), blossom: Some(1), heartwood: Some(1), canopy: Some(1), nu5: Some(2), nu6: Some(2), nu6_1: Some(2), nu6_2: Some(2), nu6_3: Some(2), nu7: None }`.

### 3.2 `GetLightdInfo` (`node infra/z3/lwd.mjs info`)

```json
{
  "version": "0.10.2",
  "vendor": "ZingoLabs ZainoD",
  "taddrSupport": true,
  "chainName": "test",
  "saplingActivationHeight": "1",
  "consensusBranchId": "37a5165b",
  "blockHeight": "113",
  "gitCommit": "",
  "branch": "",
  "buildDate": "unknown",
  "buildUser": "root",
  "estimatedHeight": "6619132",
  "zcashdBuild": "v6.2.3",
  "zcashdSubversion": "/Zebra:6.2.3/",
  "donationAddress": "",
  "upgradeName": "NU6.3",
  "upgradeHeight": "2",
  "lightwalletProtocolVersion": "v0.5.0"
}
```

### 3.3 `GetLatestBlock` (`lwd.mjs latest`, hash shown in display order)

```json
{ "height": "114", "hash": "7b83b6db63616eb0c4d59d7e7dff7a87d718cbd913eced045abe3e7a670fa018" }
```

The display-order hash equals Zallet's `getwalletstatus.node_tip.blockhash` at the same height.

### 3.4 Funding and the shield tx (`bash infra/z3/fund-agent.sh --probe`, 31 s)

```
==> Mining 110 blocks of coinbase to the miner address
    tip 112 after 17s
==> Shielding mature coinbase to the agent UA
    {
      "remainingUTXOs": 1,
      "remainingValue": 6.25,
      "shieldingUTXOs": 10,
      "shieldingValue": 62.5,
      "opid": "opid-711ebc8f-41a5-466f-9e3e-e4a3cabe4267"
    }
    shield txid abca8c2ffec8af8be1cfb1940f31fb395ca955a2b61c7c91517845652f6e6711 (7s from call to success)
    Zaino GetTransaction abca8c2f… (mempool, tip 112):
      { "height": "0", "bytes": 10641, "header": "06000080", "expiryHeight": 153 }
==> Mining 1 block
    height 113 (+1 in 0.34s)
    Zaino GetTransaction abca8c2f… (mined, tip 113):
      { "height": "113", "bytes": 10641, "header": "06000080", "expiryHeight": 153 }
==> Agent wallet
    { "pools": { "transparent": { "valueZat": 62500000000 }, "ironwood": { "valueZat": 6249940000 } },
      "minimum_confirmations": 1 }
```

The first run (before the wipe) gave the same numbers: mempool `"0"`, mined `"113"`, expiry 153,
shield 5 s.

### 3.5 Shielded send probe (`z_sendmany`, the deposit shape)

`z_sendmany [AGENT_UA, [{address: <same account, orchard-only, index 2>, amount: "0.001", memo: hex("z402-probe:0")}], 1, null, "FullPrivacy"]`,
then `z_getoperationresult` every 250 ms, then Zaino `GetTransaction` every 100 ms, then
`generate 1`. Two runs:

```
run 1 (tip at send 113)
first poll right after success: {"code":13,"codeName":"INTERNAL","details":"RPC error: LegacyRpcError { code: -5, message: \"No such mempool or main chain transaction\" }"}
mempool GetTransaction: {"height":"0","bytes":18634,"header":"06000080","expiryHeight":154} polls: 2
zebra getrawmempool contains txid: true
mined GetTransaction: {"height":"114","bytes":18634,"header":"06000080","expiryHeight":154} tip: 114
{ z_sendmany_return_ms: 20, call_to_success_ms: 9932, success_to_zaino_visible_ms: 325,
  generate1_ms: 352, expiryHeight: 154, minedHeight: 114, expiry_minus_mined: 40, expiry_minus_tipAtSend: 41 }

run 2 (fresh wallet, tip at send 113)
mempool GetTransaction: {"height":"0","bytes":18634,"header":"06000080","expiryHeight":154} polls: 1
mined GetTransaction: {"height":"114","bytes":18634,"header":"06000080","expiryHeight":154} tip: 114
{ txid: '0ca771e8136680bd6b049d7190154b39ff930872d4c1da16dcfa1b47a0a472f1',
  z_sendmany_return_ms: 10, call_to_success_ms: 5808, success_to_zaino_visible_ms: 92,
  generate1_ms: 319, expiryHeight: 154, minedHeight: 114, expiry_minus_mined: 40, expiry_minus_tipAtSend: 41 }
```

The operation result (`execution_secs: 9` in run 1) carries both `result.txid` and
`result.txids[0]`. In run 1 the first Zaino lookup straight after `success` was still
not-found; the next one, 100 ms later, found it.

`z_listtransactions [uuid]` row for run 1 (outputs trimmed to the recipient):

```json
{ "mined_height": 114, "txid": "e4b5b228…1951", "expiry_height": 154,
  "account_balance_delta": -25000, "fee_paid": 25000, "expired_unmined": false,
  "outputs": [ …4 change notes of 1562453750 zat…,
    { "pool": "ironwood", "output_index": 2, "to_address": "uregtest1n8l5ep8…uvh6",
      "value": 100000, "is_change": true, "memo": "z402-probe:0" } ] }
```

### 3.6 Unknown txid

```
$ node infra/z3/lwd.mjs tx cfb2ec2db6d0e7abfcd33ebc3047b73c05d2bc26b81c27dcc6c7c88ade726521
{
  "code": 13,
  "codeName": "INTERNAL",
  "details": "RPC error: LegacyRpcError { code: -5, message: \"No such mempool or main chain transaction\" }"
}
```

Identical for an all-zero txid, a second random txid, and a real txid sent in natural (non-reversed)
byte order.

### 3.7 Expiry delta

Bytes 16..20 (LE) of the raw v6 tx are `nExpiryHeight`:

| Tx | Built at tip | expiryHeight | Mined at | expiry − mined |
|---|---|---|---|---|
| shield (`z_shieldcoinbase`) | 112 | 153 | 113 | **40** |
| deposit shape (`z_sendmany`) | 113 | 154 | 114 | **40** |

So Zallet sets `expiryHeight = (tip + 1) + 40`, which passes `zeroConfMinExpiryBlocks = 20`.

### 3.8 Block clock

```
$ node infra/z3/clock.mjs mine 3
height 117 (+3 in 0.43s)
$ node infra/z3/clock.mjs mine
height 118 (+1 in 0.17s)
$ node infra/z3/clock.mjs run --every 3
block clock: one block every 3s
2026-10-27T15:32:36.894Z height 119 (0.17s)
2026-10-27T15:32:39.896Z height 120 (0.17s)
2026-10-27T15:32:42.898Z height 121 (0.11s)
```

## 4. Consequences for the contract and adapters

- Not-found on regtest is exactly the `z3.md` §4.3 Zaino row: code 13 INTERNAL plus the
  `LegacyRpcError { code: -5, … }` text. Match on `code == 13 && details includes "code: -5"`.
- Mempool is `height == "0"`, mined is the block height, with Zaino 0.10.2. No tip-height
  workaround is needed.
- Expect one not-found on the first lookup right after broadcast; Zaino caught up within 0.1–0.3 s.
- A deposit takes 6–10 s of proving in Zallet before a txid exists, so persist the txid at
  `success` and allow at least 15 s for the agent's send.
- Assert `consensusBranchId == "37a5165b"`, never `chainName`.
- Budget ≥ 25,000 zat fee per deposit with Zallet.
