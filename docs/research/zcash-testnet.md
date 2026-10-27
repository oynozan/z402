# Zcash testnet ground truth for z402 (track: zcash-testnet)

Probed live on 2026-10-27, 11:02–11:58 UTC, against `testnet.zec.rocks:443`. Every claim below names its source: a command and its output, a file at a commit, or a URL.

## TL;DR (read this first)

1. **Only `testnet.zec.rocks:443` answers** (lightwalletd v0.5.4 on Zebra 7.0.0, lightwallet-protocol v0.5.0). NU7 is active: branch `0x77190AD9`, activated at testnet height 4,465,026 on 2026-10-04T18:21:45Z. The other endpoints tried are dead, and the Zaino one returns 503.
2. **The protocol changed under the spec.** NU6.3 (testnet 4,134,000, 2026-07-04) added **v6 transactions and the Ironwood pool**. The Orchard pool can no longer receive value. A payment to a UA's Orchard receiver now lands in `vActionsIronwood`. The merchant's same Orchard IVK decrypts it, but only through `orchard 0.16`'s `NoteEncryptionDomain::<IronwoodVersion>` (note-plaintext lead byte 0x03). An Orchard-domain decryptor finds nothing.
3. **What is on chain:** of the last 60 blocks' transactions, 112 of 113 are v6 (`nVersionGroupId 0xD884B698`) and 1 is v5. All carry branch `0x77190AD9`. In the last 400 blocks: 0 Sapling outputs, 8 Orchard actions, 1,091 Ironwood actions. Shielded payments are now Ironwood-only.
4. **GetTransaction (load-bearing).** `TxFilter.hash` is the 32 txid bytes in **protocol (internal) order**, i.e. `reverse(hexdecode(displayTxid))`. A mempool transaction returns `height = 0`. grpcurl omits that field unless you pass `-emit-defaults`. A mined transaction returns its block height. An unknown txid returns gRPC `NotFound`. A hash that is not 32 bytes returns `InvalidArgument`.
5. **Blocks come every ~25 s, not 75 s.** Over the last 1,000 blocks: mean 25.9 s, median 20 s, p90 53 s, max 164 s. From first sighting in the mempool to being mined: median 22 s, max 131 s. Some miners produce coinbase-only blocks, so a transaction can wait 5–7 blocks.
6. **Stable crates parse NU7 now. The spec's "pre-release only" note is stale.** `zcash_protocol 0.11.0`, `zcash_primitives 0.31.0`, `zcash_keys 0.17.0`, `zcash_client_backend 0.25.0`, `zcash_address 0.14.0` and `zcash_transparent 0.11.0` were released 2026-10-21. `orchard 0.16.0`, `sapling-crypto 0.9.0` and `zcash_note_encryption 0.5.1` were released 2026-09-30. No `zcash_unstable` cfg is needed. The 0.10.x / 0.30.x line cannot parse NU7 transactions. Kage and Hanko pin the superseded `-pre` builds.
7. **Fees (ZIP 317):** 5,000 zat × max(2, logical actions). One recipient plus change is 2 Ironwood actions, which is **10,000 zat**; I saw this live on 2-action transactions. 3 actions cost 15,000 zat.
8. **Expiry (ZIP 203 + ZIP 218):** the default expiry delta is **120 blocks from NU7** (~50 min). Some live wallets still use 40 (~17 min). A transaction not mined by its `nExpiryHeight` can never be mined, so the facilitator should drop that D_pend once `tip > nExpiryHeight`.
9. **Faucet:** the Valar faucet gives 0.125 TAZ per IP per 24 h and accepts UA, Sapling or t-addresses. **Explorer:** use `https://testnet.zecblock.com/tx/<txid>` (its API is on the NU7 chain). Avoid testnet.zcashexplorer.app: it sits on a stale fork at height 4,495,268 and 404s current txids.

---

## 0. How to reproduce

Every probe below uses this template:

```sh
cd /private/tmp/claude-501/-Users-oynozan-Desktop-Dev-Web3-z402/afbb7c76-d88e-47a4-8a53-fd001155f8ac/scratchpad/downloads/protos
G=/private/tmp/claude-501/-Users-oynozan-Desktop-Dev-Web3-z402/afbb7c76-d88e-47a4-8a53-fd001155f8ac/scratchpad/bin/grpcurl
$G -max-time 30 -import-path . -proto service.proto testnet.zec.rocks:443 cash.z.wallet.sdk.rpc.CompactTxStreamer/<Method>   # add -d '<json>' and -emit-defaults as needed
```

The local protos are byte-identical to `zcash/lightwallet-protocol` tag **v0.6.0** (commit `299805c19011a027d2c48c5e912dd05041f76156`, 2026-10-19). The server speaks **v0.5.0** (commit `ac7cee052a1bf5d430985a478d39e8b513fc4bd4`, 2026-06-30). Both versions already define `PoolType.IRONWOOD = 4` and `CompactTx.ironwoodActions = 9`. v0.6.0 adds only `GetStandardFee`, and the live server answers that with `Unimplemented: unknown method GetStandardFee`.

grpcurl prints proto3 `uint64` values as JSON strings and **omits zero-valued fields unless you pass `-emit-defaults`**. A TypeScript gRPC client behaves the same way: with `@grpc/proto-loader`, use `longs: String, defaults: true`. Don't use JS numbers for `height`, because the fork sentinel `0xffffffffffffffff` is not a safe integer.

Spike scripts I wrote (all in `/private/tmp/claude-501/-Users-oynozan-Desktop-Dev-Web3-z402/afbb7c76-d88e-47a4-8a53-fd001155f8ac/scratchpad/spikes/zcash-testnet/`):
- `txparse.py`: a minimal v4/v5/v6 structure parser (header plus component counts), written to the ZIP 225 and ZIP 229 layouts.
- `sample_txs.py`: GetTransaction on every transaction in the last N blocks, then parses each one.
- `mempool_poll.sh`: an 11-minute loop of GetMempoolTx followed by an immediate GetTransaction on each result.
- `mempool_latency.py`, `blockstats.py`, `jsplit.py`.
- Raw outputs are in `out/`: `sample_txs_60.json`, `mempool_poll/log.txt`, `blockrange_400.json`, `blockrange_1000.json` and others.

## 1. Server identity and tip drift (probe 1)

`GetLightdInfo` at 2026-10-27T11:02:25Z:

```json
{"version":"v0.5.4","vendor":"ECC LightWalletD","taddrSupport":true,"chainName":"test",
 "saplingActivationHeight":"280000","consensusBranchId":"77190ad9","blockHeight":"4547223",
 "gitCommit":"c22ca9ba67676e61cd8ee107538ffd9a77799bab","buildDate":"2026-08-28","buildUser":"root",
 "estimatedHeight":"4547226","zcashdBuild":"v7.0.0+git.e8db87e","zcashdSubversion":"/Zebra:7.0.0/",
 "lightwalletProtocolVersion":"v0.5.0"}
```

`upgradeName` and `upgradeHeight` are absent, so no further upgrade is scheduled on testnet.

| UTC time | `GetLatestBlock.height` | notes |
|---|---|---|
| 11:02:25 | 4547223 | hash (base64, protocol order) `VkSqeH2pxJB1u9iJ/VngipJsGsIKEXaOnzCdLZoNAAA=` |
| 11:15:32 | 4547242 | |
| 11:49:28 | 4547320 | hash `6a41axH2ztftCO4Igo0xL7N4EZAbIPDqBnW4XDo3AAA=` |
| 11:56:11 | 4547338 | the server fields other than height did not change |

From 11:02 to 11:56 the tip advanced 115 blocks in 3,226 s, about 28 s per block.

The lightwalletd v0.5.4 tag is commit `09593edbee4ee68d47e5a53f8ce1c83514c4e8e6` (2026-08-27). The server reports `gitCommit c22ca9ba…`, a build from 2026-08-28. Upstream HEAD is `4abfe9cd` (2026-10-22), and tag v0.6.0 exists.

**Mainnet, for context** (`zec.rocks:443`, `na.zec.rocks:443` and `eu.zec.rocks:443` at 11:14:53Z):

```json
{"version":"v0.5.3","chainName":"main","consensusBranchId":"37a5165b","blockHeight":"3532352",
 "upgradeName":"NU7","upgradeHeight":"3543405","zcashdSubversion":"/Zebra:7.0.0/ (na) | /Zakura:1.7.0/ (zec.rocks, eu)"}
```

So mainnet runs NU6.3 now and reaches NU7 at height 3,543,405. That is about 2026-11-06 01:30 UTC if blocks keep a 75 s spacing; this date is my estimate.

## 2. Network upgrades: what is live and what changed

### 2.1 Constants (sources: ZIP 258 and ZIP 259 at zips commit `2bdf394`, 2026-10-21; `librustzcash` `components/zcash_protocol/src/consensus.rs` at `a551fac`)

| Upgrade | Branch id | Testnet height (time) | Mainnet height (time) | Main content |
|---|---|---|---|---|
| NU6.3 | `0x37A5165B` | 4,134,000 (block time 2026-07-04T18:08:30Z) | 3,428,143 (2026-07-28T14:07:23Z) | v6 tx format (ZIP 229), **Ironwood pool**, Orchard pool restricted (ZIP 2006), Ironwood notes use lead byte 0x03 (ZIP 2005), ZIP 317 Revision 1 |
| NU7 | `0x77190AD9` | 4,465,026 (2026-10-04T18:21:45Z) | 3,543,405 (scheduled) | **25 s block target** (ZIP 218), per-pool and global action limits, NSM (ZIP 237), 60% of fees removed from circulation (ZIP 235), **v4 transactions invalid** (ZIP 2003), funding-stream revisions, and a testnet min-difficulty threshold of 450 s |

I took the activation times from `GetBlock` on the activation heights (`{"height":4465026}` returned `time 1791138105`, and so on). `consensus.rs` also carries `RETIRED_NU7_BRANCH_ID = 0x7719_0ad8` (an earlier proposal) and `NU7_PLACEHOLDER = 0xffff_ffff`. Only `0x77190AD9` is valid.

### 2.2 What NU7 did and did not change (ZIP 259 §Abstract, §Backward compatibility)

- It added **no new transaction format**. "Once NU7 activates, version 4 transactions are invalid, while version 5 and version 6 transactions remain valid." v5 and v6 are "structurally unchanged". A transaction signed before activation is still not valid afterwards, because its signatures commit to the branch id.
- It does not deploy OrchardZSA/ZSAs or memo bundles. ZIP 229 lists ZSAs, `zip233Amount`, explicit fees and memo bundles as non-requirements of v6. ZIP 259 states it does not deploy ZIP 233 or ZIP 234. Memo bundles (ZIP 231) remain a draft for ZIP 317 Revision 2.
- The block target drops from 75 s to 25 s. On testnet, a block now gets minimum difficulty only if it comes more than 450 s after the previous block. In my 1,000-block sample, no gap exceeded 450 s.
- Action limits per block: Orchard ≤ 330, Ironwood ≤ 330, Sapling inputs plus outputs ≤ 300, with a global shielded budget of 330 (ZIP 218 §Security). These don't affect a 2-action deposit.
- `MAX_REORG_LENGTH` is now at least 600 blocks, and the anchor depth stays at 3 blocks, about 1.25 min (ZIP 218).

### 2.3 NU6.3 and Ironwood: the change that matters most for the deposit check

Sources: ZIP 229 §Abstract and §Transaction Format; ZIP 258 §Consensus rules; ZIP 326 §Scanning; ZIP 2005 §3.2.1.

- "The addition of the *Ironwood pool* does not change address structures or encodings. At the protocol level, Orchard spending-key and viewing-key material grants authority to spend or view notes in both the Orchard and Ironwood pools." (ZIP 229)
- "A receiver, and the corresponding incoming viewing key, is scoped to the Orchard *protocol*, not to a pool: the same ivk is used to trial-decrypt both Orchard-pool and Ironwood-pool note ciphertexts." (ZIP 326)
- From NU6.3, no new value may enter the Orchard pool (`valueBalanceOrchard ≥ 0`). Every Orchard-pool action must have `enableCrossAddress = 0`, which means the output goes to the spender's own address. Coinbase transactions carry no Orchard actions (ZIP 258). **So a payment from the agent to the merchant's Orchard receiver can only be an Ironwood-pool output.** Sapling outputs are still allowed by consensus, but I saw none on chain.
- Every Ironwood note plaintext has lead byte **0x03**, which has a different `pre_rcm` derivation (ZIP 2005). Orchard notes keep 0x02. That byte is "the only note-level distinction between the two pools" (ZIP 229).
- ZIP 2005 adds a `use_qsk` key flag, and the ivk depends on it. A wallet uses one value per account, so the UIVK exported for the merchant's address is self-consistent. A seed restore must scan with both values (ZIP 326).

## 3. Transactions on testnet today (probe 4)

### 3.1 Header survey (`sample_txs.py out/blockrange_400.json 60`, blocks 4,547,170–4,547,229)

```
version/vgid/branch counts: {(6, '0xd884b698', '0x77190ad9'): 112, (5, '0x26a7270a', '0x77190ad9'): 1}
gettx_height == block height for all: True
non-coinbase component shapes: [('ironwood2', 42), ('ironwood3', 7), ('t(in1,out11)', 1), ('t(in1,out2)', 1),
                                 ('t(in1,out0) + ironwood1', 1), ('t(in1,out1) + ironwood1', 1)]
coinbase: v6, expiryHeight == block height (ZIP 203 NU5 rule), 11/60 coinbases carry 1 Ironwood action
```

Over 400 blocks (`blockstats.py out/blockrange_400.json`, with all four `poolTypes`), the element totals were `{'sapling_out': 0, 'sapling_spend': 0, 'orchard': 8, 'ironwood': 1091, 'vin': 81, 'vout': 482}`.

The only v5 transaction was a transparent fan-out: `ff44f222bbe16e3852acb15c02561126ac697d1e1bf90abdd132ea0b258ab404`, with 1 input and 11 outputs.

### 3.2 Byte layout of a live v6 transaction

This is mempool tx `0d2985371830c1c9bcb602f241f2fd08b7bbe9b53ea4057095806a9b01e65efa`, 9,166 bytes:

```
06000080 98b684d8 d90a1977 00000000 c5624500 00 00 00 00 00 02 ...
header   vgid     branch   lock     expiry   tin tout nSpS nOutS nActO nActIronwood
=0x80000006 (fOverwintered|6)  0xD884B698  0x77190AD9  0  4547269
```

The parsed result is `flagsIronwood=7` (spends, outputs and cross-address all enabled), `valueBalanceIronwood=10000`, which is the fee, and no transparent or Sapling parts. Field order follows ZIP 229: common header (20 B), then transparent, Sapling, Orchard, and finally the **Ironwood component**: `nActionsIronwood`, 820 B × n actions, flags (1), valueBalance (8), anchor (32), proof size and proofs (2720 + 2272·n), spend auth sigs (64·n), and the binding sig (64). Reading `nExpiryHeight` costs nothing: it is `uint32le` at bytes 16..20 for v5 and v6.

A v6 txid is not a hash of the raw bytes. It is the ZIP 244 digest tree extended by ZIP 229 (Ironwood digest; anchors moved into auth data). So a client never derives a txid from `GetMempoolStream` bytes without a library. Use `zcash_primitives 0.31` `Transaction::txid()`.

### 3.3 Fees and expiry seen live

- Every 2-action Ironwood-only transaction had `valueBalanceIronwood = 10000`, and every 3-action one had `15000`. That matches ZIP 317 (§7.3).
- `expiryHeight − mined height` across 53 non-coinbase transactions: `{38:9, 36:7, 40:7, 35:5, 39:5, 37:3, 118:3, 119:3, 34:2, 31:2, 362:1, 120:1, 116:1, 33:1, 117:1}`. Two wallet populations show up: one sets target+40 (pre-NU7 crates) and one sets target+120 (`zcash_primitives 0.31` `NU7_DEFAULT_TX_EXPIRY_DELTA = 3 × 40`, in `zcash_primitives/src/transaction/builder.rs:63-69`).

## 4. lightwalletd GetTransaction semantics (probe 2, load-bearing)

### 4.1 Byte order of `TxFilter.hash` (proven live)

GetMempoolTx returned `txid: "ak0F22gPZxgSggxco+aFiOnJSHzAzlJ5+IKDijiDR88="`, which is hex `6a4d05db…8347cf`. I called GetTransaction with each byte order:

```
-d '{"hash":"ak0F22gPZxgSggxco+aFiOnJSHzAzlJ5+IKDijiDR88="}'   -> OK, data 9166 bytes
-d '{"hash":"z0eDOIqDgvh5Us7AfEjJ6YiF5qNcDIISGGcPaNsFTWo="}'   (bytes reversed) ->
  ERROR: Code: NotFound
  Message: GetTransaction: getrawtransaction 6a4d05db680f671812820c5ca3e68588e9c9487cc0ce5279f882838a388347cf failed: -5: Transaction not found in mempool or best chain
```

lightwalletd reverses whatever bytes it receives and passes the result to Zebra's `getrawtransaction`. The code is in `frontend/service.go` at v0.5.4, around line 466: `txidHex := hash32.Encode(hash32.Reverse(hash32.FromSlice(txf.Hash)))`. So:

- **display txid** (explorers, Zebra RPC, `zingo-cli` output, the x402 payload): `cf4783388a8382f87952cec07c48c9e98885e6a35c0c821218670f68db054d6a`
- **`TxFilter.hash`** = `Buffer.from(displayHex, "hex").reverse()` (32 bytes)
- **`CompactTx.txid`** from GetMempoolTx and GetBlock is already in protocol order. Reverse it to get the display form.

zecblock's API confirms the display form: `https://api.testnet.zecblock.com/v1/transactions/cf4783388a…6a` returns that tx at block 4,547,227. Hanko does the same conversion: `TxId::from_hex(display)` and then `TxFilter { hash: txid.as_ref().to_vec() }` (`hanko/packages/core/src/lwd.rs:274,297`).

### 4.2 `RawTransaction.height`

| Case | Observed | Source |
|---|---|---|
| tx in mempool | `"height": "0"` (absent without `-emit-defaults`). In my 11-minute poll, 242 of 242 in-mempool lookups returned 0 | `out/mempool_poll/log.txt` |
| mined tx | the block height. Holds for all 113 sampled txs, e.g. the mempool tx above later returned `"height":"4547227"` | `sample_txs_60.json` |
| mined on a non-main-chain fork | `0xffffffffffffffff`, documented and not observed. lightwalletd copies Zebra's int64 `height` into a uint64 (`common/common.go` `ParseRawTransaction: Height: uint64(txinfo.Height)`) | service.proto `RawTransaction` comment, lightwalletd v0.5.4 |

The 0/MAX mapping was added on purpose; see the comment in `service.proto` and librustzcash issue #1484. Hanko's mapping matches it: `0 => Mempool`, `u64::MAX => Orphaned` (`lwd.rs:254-262`).

### 4.3 Errors

```
unknown txid (random 32 bytes)  -> Code: NotFound,        Message: GetTransaction: getrawtransaction <hex> failed: -5: Transaction not found in mempool or best chain
31-byte hash                    -> Code: InvalidArgument, Message: GetTransaction: transaction ID has invalid length: 31
empty TxFilter                  -> Code: InvalidArgument, Message: GetTransaction: specify a txid
transient network failure       -> grpcurl "Failed to dial target host ... context deadline exceeded" (seen once in ~600 calls)
```

A dropped, expired or double-spent mempool transaction comes back the same way as an unknown one: `NotFound` with Zebra error -5. I inferred this from the code path and did not observe it on a real dropped tx.

### 4.4 Mempool RPCs (lightwalletd v0.5.4 `frontend/service.go`, `common/mempool.go`)

- **GetMempoolTx(GetMempoolTxRequest)** streams `CompactTx` and closes. By default it returns only Sapling, Orchard and Ironwood data. Each action carries only a **52-byte ciphertext prefix**, which is enough for compact trial decryption (value and recipient) but **not for the memo**. For memo and transparent checks you need the full GetTransaction. `index` is 0 and `fee` is unset for mempool entries. `exclude_txid_suffixes` takes protocol-order byte suffixes (at most 20,000 entries, each at most 32 bytes).
- **GetMempoolStream(Empty)** streams `RawTransaction` with height 0 and **no txid**. lightwalletd refreshes its copy of the mempool from Zebra at most every 2 s, and the stream **closes when lightwalletd sees a new tip**. Live, I saw closures after 1 s, 10 s and 21 s, so clients must reconnect.
- **GetTransaction(TxFilter)** skips that cache and calls Zebra's `getrawtransaction <txid> 1`. A transaction becomes visible here as soon as Zebra accepts it into its mempool.

### 4.5 How long deposits sit in the mempool (`mempool_latency.py`, 24 txs over 11 minutes)

- From first sighting to the mined block's timestamp: **median 22 s, max 131 s**. Some values are negative because miner timestamps precede my sighting.
- Most transactions were mined in the next block. Four first seen at tips 4,547,235–237 waited until 4,547,242: blocks 4,547,238–241 were **coinbase-only** while those transactions sat in the mempool.
- The mempool held 0–6 transactions at any time (`summary.txt`). It is never "busy".

## 5. Block timing (probe 3)

Source: `GetBlockRange` with `CompactBlock.time`. The script is `blockstats.py`.

| Sample | n gaps | mean | median | p75 | p90 | p95 | p99 | max | min | gaps >75 s | >150 s | >450 s |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| last 200 (to 4,547,229) | 199 | 26.4 | 18 | 31 | 60 | 77 | 123 | 155 | 3 | 11 | 1 | 0 |
| last 200 (to 4,547,338) | 199 | 27.0 | 21 | 30 | 54 | 74 | 134 | 164 | 4 | 9 | 2 | 0 |
| last 1,000 (4,546,338–4,547,338, 7.2 h) | 1000 | 25.9 | 20 | 34 | 53 | 68 | 111 | 164 | 2 | 34 | 2 | 0 |

The difficulty is about 8,760 (from the zecblock API). Timestamps never decreased in these samples.

Watch out: `GetBlockRange` **without `poolTypes` omits transparent-only transactions and the `vin`/`vout` fields**. I measured 0.78 tx per block without it and 1.98 with `["TRANSPARENT","SAPLING","ORCHARD","IRONWOOD"]`.

## 6. Public testnet lightwalletd endpoints (probe 5, 11:15–11:17Z)

| Endpoint | Result |
|---|---|
| `testnet.zec.rocks:443` | **OK**: v0.5.4, Zebra 7.0.0, branch 77190ad9 |
| `testnet.zec.rocks:9067` | TCP reset by peer |
| `zaino.testnet.unsafe.zec.rocks:443` | resolves (66.241.125.109) but returns HTTP **503 Service Unavailable** |
| `na.` / `eu.` / `ap.testnet.zec.rocks:443` | no DNS records; dial timeout |
| `lightwalletd.testnet.electriccoin.co:9067` / `:443` | resolves to Cloudflare; 9067 times out and 443 fails the TLS handshake |
| `testnet.lightwalletd.com:9067` / `:443`, `lwd.testnet.zecblock.com:443`, `testnet.zec.stardust.rest:443` | no DNS or dial timeout |

This leaves a **single point of failure**. The facilitator and the agent both depend on one public server, so build retries and timeouts.

zingo-cli has **no default indexer for testnet**. You must pass `--server https://testnet.zec.rocks:443`; see the `IndexerChoice::Default.resolve(&ChainType::Testnet).is_err()` doctest in `zingolib/src/config.rs` at `3fb32d2`.

## 7. librustzcash crates and NU7 (research item 6)

### 7.1 Versions and dates (crates.io API and the sparse index, queried 2026-10-27)

| Crate | Last pre-NU7-capable stable | NU7-capable pre-releases | **NU7-capable stable** |
|---|---|---|---|
| zcash_protocol | 0.10.6 (2026-09-08) | 0.11.0-pre.0 (10-01), pre.1 (10-14) | **0.11.0 (2026-10-21)** |
| zcash_primitives | 0.30.1 (2026-08-19) | 0.31.0-pre.0/1/2 (10-01/06/14) | **0.31.0 (2026-10-21)** |
| zcash_keys | 0.16.1 (2026-07-29) | 0.17.0-pre.0/1/2 | **0.17.0 (2026-10-21)** |
| zcash_client_backend | 0.24.0 (2026-08-19) | 0.25.0-pre.0/1/2 | **0.25.0 (2026-10-21)** |
| zcash_address | 0.13.0 | 0.14.0-pre.0/1/2 | **0.14.0 (2026-10-21)** |
| zcash_transparent | 0.10.0 | 0.11.0-pre.0/1/2 | **0.11.0 (2026-10-21)** |
| zcash_client_sqlite | 0.22.0 | 0.23.0-pre.0/1/2 | **0.23.0 (2026-10-21)** |
| orchard | 0.15.5 | | **0.16.0 (2026-09-30)** |
| sapling-crypto | 0.8.0 | | **0.9.0 (2026-09-30)** |
| zcash_note_encryption | 0.5.0 | | **0.5.1 (2026-09-30)** |

### 7.2 What the source shows

All crates came from `static.crates.io` and were unpacked under `scratchpad/downloads/zcash-testnet/crates/`.

- In `zcash_protocol 0.10.6`, `src/consensus.rs` has `#[cfg(zcash_unstable = "nu7")] 0xffff_ffff => Ok(BranchId::Nu7)`, and Nu7's activation is `None`. Without the cfg the branch does not exist. **A tx whose header says `0x77190AD9` is an unknown branch** and fails to parse. That breaks every current testnet transaction (§3.1). Setting the cfg doesn't help either, because it maps the placeholder 0xFFFFFFFF.
- In `0.11.0-pre.0` and `pre.1`, `0x7719_0ad9 => Ok(BranchId::Nu7)` appears **without a cfg**, with testnet activation 4,465,026 and mainnet `None`.
- The `0.11.0` CHANGELOG says: "`NetworkUpgrade::Nu7, BranchId::Nu7` … are now available without the `--cfg zcash_unstable="nu7"` configuration flag"; "`BranchId::Nu7` now maps to … `0x77190AD9` (was the placeholder `0xFFFFFFFF`)"; it "sets the NU7 mainnet activation height to 3543405"; the MSRV is 1.89.
- The `zcash_primitives 0.31.0` CHANGELOG says: "`BranchId::Nu7` is available without a custom compiler configuration … `TxVersion::valid_in_branch` accepts `V5` and `V6` … but not `V4`", and the default expiry is target+120 from NU7.
- At librustzcash HEAD (`a551fac`, 2026-10-26), the only `zcash_unstable` values are `"nutachyon"` and `"zip233"`. Neither is needed.
- zingolib HEAD (`3fb32d2`, 2026-10-26) pins `=0.25.0`, `=0.17.0`, `=0.31.0`, `=0.11.0`, `=0.14.0`, orchard 0.16.0, sapling-crypto 0.9.0 and zcash_note_encryption 0.5.1. A wallet built from it agrees with these crates.
- Kage and Hanko pin `zcash_client_backend =0.25.0-pre.2`, `zcash_keys =0.17.0-pre.2`, `zcash_primitives =0.31.0-pre.2`, `zcash_protocol =0.11.0-pre.1`, `zcash_transparent =0.11.0-pre.2`, `orchard 0.16`, `sapling-crypto 0.9` and `zcash_note_encryption 0.5`. Their comment says they "checked on crates.io 2026-10-20", the day before the final releases. These pins parse NU7 transactions, but they are superseded.

### 7.3 Exact Rust API to check an Ironwood deposit with an IVK only

Taken from `zcash_client_backend/src/decrypt.rs` at HEAD, which uses UFVKs. The IVK-only form is the same calls with the UIVK's Orchard IVK.

```rust
use zcash_keys::keys::UnifiedIncomingViewingKey;                 // zcash_keys 0.17
use zcash_primitives::transaction::Transaction;                    // zcash_primitives 0.31
use zcash_protocol::consensus::{BranchId, TEST_NETWORK};           // zcash_protocol 0.11
use orchard::{keys::PreparedIncomingViewingKey, note_encryption::{IronwoodVersion, OrchardVersion, NoteEncryptionDomain}}; // orchard 0.16
use zcash_note_encryption::try_note_decryption;                    // 0.5.x

let uivk = UnifiedIncomingViewingKey::decode(&TEST_NETWORK, uivk_str)?;       // "uivktest1…" (Rev0) or "uvitest1…" (Rev2)
let ivk  = uivk.orchard().as_ref().expect("UIVK has Orchard item");
let pivk = PreparedIncomingViewingKey::new(ivk);
let tx   = Transaction::read(&raw[..], BranchId::Nu7)?;                      // v5/v6 read the branch id from the header
assert!(tx.transparent_bundle().is_none());                                   // "no transparent part"
let mut paid = 0u64;
if let Some(b) = tx.ironwood_bundle() {
    for a in b.actions() {
        let d = NoteEncryptionDomain::<IronwoodVersion>::for_action(a);       // NOT OrchardVersion: wrong domain = silent miss
        if let Some((note, _addr, memo /* [u8;512] */)) = try_note_decryption(&d, &pivk, a) {
            paid += note.value().inner();  /* check memo per ZIP 302 (§8.5) */
        }
    }
}
// Also check tx.orchard_bundle() with OrchardVersion (should be empty post-NU6.3), and Sapling if payTo has a Sapling receiver.
```

`Transaction::read(reader, consensus_branch_id)` is at `zcash_primitives/src/transaction/mod.rs:973`. The accessors `ironwood_bundle()` (line 661), `expiry_height()` (641) and `txid()` (969) are in the same file. `UnifiedIncomingViewingKey::decode` is in `zcash_keys/src/keys.rs:1739`, and `.orchard()` is at line 2003. On the comment "Decrypting a bundle under the other kind's domain would silently detect nothing", see `decrypt.rs` around line 259. I checked the orchard names in the published `orchard-0.16.0` crate source. `note_encryption.rs:114-146` defines `trait DomainVersion { const NOTE_VERSION }`, `OrchardVersion => NoteVersion::V2` (lead byte 0x02) and `IronwoodVersion => NoteVersion::V3` (0x03), and decryption returns `None` when the lead byte doesn't match. `NoteEncryptionDomain::<P>::for_action` is at line 194, `NoteValue::inner() -> u64` is in `value.rs:110`, and `PreparedIncomingViewingKey::new(&IncomingViewingKey)` is in `keys.rs:781`. I did not compile this snippet. TypeScript has no library that parses v6 or decrypts Ironwood, so the facilitator needs a Rust helper (Hanko's `zpay-verify` or a small binary).

## 8. ZIPs (research item 7)

All are from zcash/zips at `2bdf39494320e5e04057ac93b1794031ebfb00b5` (2026-10-21).

### 8.1 ZIP 315: trusted and untrusted TXOs (last changed `f101150`, 2026-10-13)

- A **trusted TXO** is an output of a transaction "created by the same wallet", such as change. Any other received TXO is untrusted.
- Recommended policy: **10 confirmations for untrusted TXOs, 3 for trusted ones**. "Wallets SHOULD NOT permit the spending of TXOs with fewer than 3 confirmations". The exceptions are transparent UTXOs in shielding transactions and ephemeral TEX UTXOs.
- The anchor sits 3 blocks back.
- At 25 s blocks, 3 confirmations take about 1–1.5 min, so the agent's change is spendable again after about 75 s at the median. Splitting into about 5 notes is still sensible but less critical than at 75 s. ZIP 218 explicitly does not argue for lowering confirmation counts.

### 8.2 ZIP 203 (with the NU7 note) and ZIP 218 §Default expiry delta

- `nExpiryHeight` is a uint32 holding a block height. The transaction **can be mined up to and including that height**. After it, the transaction "will be removed from the mempool" and can never be mined. 0 disables expiry. Coinbase expiry equals the block height.
- The default delta is 40 blocks from Blossom on; **from NU7 it becomes 120 blocks**, which is still about 50 min. ZIP 203 §"Changes for NU7" and ZIP 218 replace ZIP 315's expiration text with "40 blocks after the target height … before NU7 activation, and … 120 blocks after the target height from NU7 activation". zcash_primitives 0.31 implements it (§3.3).
- ZIP 218 keeps `TX_EXPIRING_SOON_THRESHOLD` at 3.
- ZIP 203 also says: "UIs and services must never rely on zero-confirmation transactions in Zcash". z402's trust ramp does exactly that, and so does the spec's "Known limits".
- **What this means for the trust ramp.** An unconfirmed deposit that never gets mined (fee too low, conflict, network trouble) stops being mineable after `nExpiryHeight`. That is at most about 120 blocks, ~50 min, after it was built, or ~40 blocks, ~17 min, with older wallets. The 30 s poller can therefore drop it from D_pend once `tip > nExpiryHeight` and it is still unmined. A `NotFound` for a deposit seen earlier also means it was evicted, double-spent or expired.

### 8.3 ZIP 317 (Revision 1 added Ironwood at NU6.3; commit `39703bc`, 2026-06-29)

- `conventional_fee = marginal_fee × max(grace_actions, logical_actions)`, with `marginal_fee = 5000` zat and `grace_actions = 2`.
- `logical_actions` = transparent + 2·nJoinSplit + max(nSpendsSapling, nOutputsSapling) + nActionsOrchard + **nActionsIronwood**.
- An Orchard-protocol bundle uses actions = max(spent notes, outputs), with a minimum of 2.
- **One recipient plus change, spending at most 2 notes, is 2 actions = 10,000 zat. This is confirmed live.** Spending 3 notes costs 15,000 zat. Each output beyond 2 adds 5,000.
- "It is not a consensus requirement that fees follow this formula". Revision 2 (memo chunks) is still a draft.

### 8.4 ZIP 316: unified addresses and viewing keys (last changed `a9b838e`, 2026-06-24)

| Kind | Revision 0 testnet HRP | Revision 2 testnet HRP |
|---|---|---|
| UA | `utest` | `zutest` (shielded-only), `tutest` (transparent-enabled) |
| UFVK | `uviewtest` | `uvftest` |
| UIVK | `uivktest` | `uvitest` |

`zcash_address 0.14` knows all of these HRPs (`components/zcash_address/src/constants.rs:138-181`).

- Receiver typecodes: 0x03 Orchard, 0x02 Sapling, 0x01 P2SH, 0x00 P2PKH.
- Items are **encoded in ascending typecode order**. Senders pick by the priority list Orchard > Sapling > transparent.
- A UA must contain at least one shielded receiver under Revision 0, and a Revision 2 `zu…` address has no transparent items.
- Ironwood adds **no** typecode (ZIP 229).
- The addresses seen live are Revision 0: the faucet donation address is `utest1pmslle44…`, and a faucet payout went to `utest124lj…`. **Expect `payTo = utest1…` and a `uivktest1…` key, and accept the Revision 2 forms too.**

### 8.5 ZIP 302: memos

- The memo is 512 bytes. If byte 0 ≤ 0xF4, it is UTF-8 text **padded with 0x00**; a reader "MUST strip any trailing zero bytes" and then decode it as UTF-8.
- `0xF6` followed by 511 zeros means no memo. `0xFF` means arbitrary data. 0xF5 is legacy.
- So `"<sessionKey hex 64>:<depositIndex>"` (about 66 to 75 ASCII bytes) fits as a text memo. Compare after stripping trailing zeros, and compare exactly; don't trim whitespace.

### 8.6 ZIP 212 and ZIP 2005: note plaintext lead bytes

- Sapling: 0x02 only after Canopy + 32,256 blocks. Orchard: always 0x02. **Ironwood: 0x03 only** (ZIP 2005 §3.2.1, which amends `allowedLeadBytes`).
- On today's testnet heights, Sapling decryption should use `zip212_enforcement(params, height)`, which returns `On`. Ironwood must use the `IronwoodVersion` domain.

## 9. Faucets and explorers for the demo (research item 8)

- **Valar testnet faucet**, `https://faucet.testnet.valargroup.dev/`. Live `GET /api/status`: `payout "0.125"`, `ipLimit "0.125"`, `windowSeconds 86400`, `addressCooldownSeconds 86400`, `balance "7465.99"`, `capRemaining "18.75"`, `ready true`, `chainHeight 4547244`. The page says: "One payout per IP address every 24 hours. Unified, Sapling and transparent testnet addresses are accepted." It claims with `POST /api/claim {"address": "<addr>"}`, which returns 202 with `{id}`, or 429 with `retryAfterSeconds`.
  - 0.125 TAZ is 12,500,000 zat, enough for the whole demo: about 3 windows at 110,000 zat each, plus splitting into 5 notes.
  - Its `explorerTxUrl` points at testnet.zcashexplorer.app, which is broken (see below).
  - Source code: `github.com/valargroup/valar-testnet-faucet`.
- `testnet.zecfaucet.com` has no DNS. `faucet.zecpages.com` resolves but gave no HTTP response within 12 s.
- **Explorer to use:** `https://testnet.zecblock.com/tx/<display txid>`, which is the format Kage and Hanko link to. Its JSON API is `https://api.testnet.zecblock.com/v1/transactions/<txid>` and it **follows the NU7 chain** (`indexedHeight 4547335`). For the Ironwood tx `cf478338…` the API shows only `version 6`, `hasIronwood true`, `ironwoodActions 2`, `feeZat "10000"`, `valueBalanceIronwoodZat "10000"`, and empty inputs and outputs. **No amount or address is visible**, which is exactly demo step 7.
  - The HTML site returned HTTP 429 (bot protection) to curl. Check it in a real browser before recording.
- **Explorer to avoid:** `testnet.zcashexplorer.app` (Nighthawk). It shows tip **4,495,268** with "Orchard Pool 238070 TAZ" and coinbase-only blocks still being mined at 11:52Z, while the real chain is at 4,547,3xx. It returned 404 "Transaction Not Found" for three current txids. That is consistent with zcashd-based infrastructure stuck on a pre-NU6.3 fork (ZIP 258: "`zcashd` will not implement the consensus changes for NU6.3"), though that cause is inferred.
- I did not test `testnet.cipherscan.app` (HTTP 429 to curl) or `blockexplorer.one/zcash/testnet` (HTTP 200, but I did not check its chain height).

## 10. What this means for the facilitator and the wire contract

1. **Payload `depositTxid`: 64 lowercase hex characters, display order.** The facilitator converts with `Buffer.from(hex,"hex").reverse()` into `TxFilter.hash`, and rejects any length other than 32 bytes before calling.
2. **Deposit fetch in `/verify`:** loop `GetTransaction` for 15 s. Treat gRPC `NotFound` as "not yet" and retry about every 1 s. Treat `height == "0"` as pending (D_pend), `"18446744073709551615"` as orphaned (not confirmed), and any other value h as mined with confirmations = tip − h + 1, using `GetLatestBlock`.
3. **Deposit validity**, all from the full raw tx:
   - `header == 0x80000005 or 0x80000006`, and `consensusBranchId == 0x77190AD9`.
   - `tx_in_count == 0 && tx_out_count == 0` (no transparent part).
   - the sum of the Ironwood notes (plus Orchard and Sapling ones, if any) that decrypt under the merchant's external IVK must be ≥ `windowZat`.
   - the memo, decoded per ZIP 302, must equal `<sessionKey>:<depositIndex>`.
   - optionally, record `nExpiryHeight` (bytes 16..20, LE) as the time-to-live of D_pend.
4. **Confirmation poller (30 s):** for each pending deposit call GetTransaction. Mined means move it to D_conf. `NotFound`, or `tip > nExpiryHeight` while still pending, means drop it and stop counting it in D_pend. At about 25 s per block, the first poll after a deposit usually finds it mined (median 22 s; tail about 2+ min).
5. **Fee:** the client's window cost is `windowZat + 10,000` zat when it spends at most 2 notes. The 402 `extra` doesn't need a fee field, but the 10% figure in the spec holds.
6. **`payTo`** must be a UA with an Orchard receiver: `utest1…` (Revision 0) or `zutest1…` (Revision 2). The merchant exports `uivktest1…` or `uvitest1…`. Senders will create Ironwood outputs to it.

## 11. Cross-track notes (not verified in this track)

- zingo-cli at HEAD has an **Unreleased "Mixnet Mode"**. Its CHANGELOG says: "A connected session runs the nym mixnet unconditionally and fails closed: Transmission … travel the mixnet". The `nakednet-test-mode` feature "suspends the go-online refusal of a build without the mixnet". Mixnet broadcast adds latency inside the 15 s `/verify` window and needs a `nym-proxy`. **The client track must check which zingo-cli build or flags avoid this.** The last zingo-cli release is 0.4.0. zingolib tags include `zingolib_v8.0.0-rc.0`.
- The spec's premise of "~75 s per payment" is now ~25 s on testnet, and also on mainnet after about 2026-11-06. The streamed-voucher design still wins, at HTTP speed against ~20–60 s per confirmation.

## 12. Sources

- lightwalletd: `github.com/zcash/lightwalletd` tag v0.5.4 = `09593edbee4ee68d47e5a53f8ce1c83514c4e8e6`; `frontend/service.go` (GetTransaction around line 459, GetMempoolTx around 709, GetMempoolStream around 684); `common/common.go` (ParseRawTransaction around 709, the reply struct around 159); `common/mempool.go`. HEAD `4abfe9cd` (2026-10-22).
- lightwallet-protocol: `github.com/zcash/lightwallet-protocol` v0.5.0 `ac7cee0`, v0.6.0 `299805c`, HEAD `ec53075` (2026-10-22).
- ZIPs: `github.com/zcash/zips` `2bdf394` (2026-10-21): zip-0259.md (NU7), zip-0258.md (NU6.3), zip-0229.md (v6), zip-0326.md, zip-2005.md, zip-0218.md, zip-0203.rst, zip-0315.rst, zip-0317.rst, zip-0316.rst, zip-0302.rst, zip-0212.rst. Rendered: `https://zips.z.cash/zip-0259`, and the same pattern for the others.
- librustzcash: `github.com/zcash/librustzcash` `a551fac8a233f54799ca1920ef78ef098cfda929` (2026-10-26). crates.io: `https://crates.io/api/v1/crates/<name>/versions` and `https://static.crates.io/crates/<name>/<name>-<ver>.crate`.
- zingolib: `github.com/zingolabs/zingolib` `3fb32d277ef956e75da124c1442526fb4d91d97a` (2026-10-26). Kage: `03307609` (2026-10-27). Hanko: `3c7edae8` (2026-10-26).
- Live: testnet.zec.rocks:443, zec.rocks:443, faucet.testnet.valargroup.dev/api/status, api.testnet.zecblock.com/v1/…, testnet.zcashexplorer.app.

## Verification corrections

Added by the zcash-testnet fact-check pass on 2026-10-27, 12:05–12:35 UTC. All 13 load-bearing claims held up. The items below correct or tighten the facilitator rules built on them. I re-fetched every source independently into `scratchpad/downloads/verify-zcash-testnet/`: zips `2bdf394`, librustzcash `a551fac`, lightwalletd v0.5.4 `09593ed`, crates from static.crates.io, and Zebra v7.0.0 `e8db87e`, which is the server's `zcashdBuild v7.0.0+git.e8db87e`. Spike code: `scratchpad/spikes/verify-zcash-testnet/nu7parse` (subcommands `branch | parse <file> | keys | local | ua <addr>`); outputs are in `out/`.

1. **An unmined deposit is dead once `tip >= nExpiryHeight`, not `tip > nExpiryHeight`.** This corrects TL;DR item 8, the last bullet of §8.2 and §10 item 4. Zebra rejects a non-coinbase tx in any block whose height exceeds its nExpiryHeight (`zebra-consensus/src/transaction/check.rs:607-613`, `if *block_height > expiry_height`), so block N = nExpiryHeight is the last chance. Zebra's mempool evicts the tx as soon as the tip reaches N (`zebrad/src/components/mempool/storage.rs:901`, `if tip_height >= expiry_height`). Rule: when `nExpiryHeight != 0`, an unmined deposit stops counting in D_pend once `tip >= nExpiryHeight`.
2. **A gRPC `NotFound` from GetTransaction doesn't prove that a deposit is gone.** This tightens §4.3 and §10 item 4. lightwalletd v0.5.4 returns `codes.NotFound` for every `getrawtransaction` failure, backend errors included (`frontend/service.go:476-480`). Only the message `-5: Transaction not found in mempool or best chain` (Zebra, `zebra-rpc/src/methods.rs:2274`) means the tx is unknown. Zebra also drops its whole mempool and re-verifies it whenever the best chain switches (`zebrad/src/components/mempool.rs:640-690`, which logs "resetting mempool: switched best chain…"), so a pending deposit can briefly read `NotFound` right after a reorg. Rule for the poller: drop a deposit on `NotFound` only when `tip >= nExpiryHeight` as well, or after several consecutive `-5` answers, and treat any other error as transient.
3. **The fork sentinel can occur on this backend.** This tightens §4.2. Zebra 7.0.0's `getrawtransaction` checks the mempool first (`methods.rs:2114`), then the best chain and every side chain in its non-finalized state (`AnyChainTransaction`, `methods.rs:2187`; `MAX_BLOCK_REORG_HEIGHT = 1000`). A tx that exists only on a side chain returns `height: -1, confirmations: 0` (`methods/types/transaction.rs:313-317, 933-937`), and lightwalletd turns that into `18446744073709551615` (`common/common.go:723`). On a reorg, Zebra re-verifies only its previous mempool contents (`mempool.rs:188-210`), not the transactions from orphaned blocks. An orphaned deposit therefore keeps returning the sentinel until the sender rebroadcasts it or it expires. Count it in neither D_conf nor D_pend.
4. **The +40 expiry also comes from the NU7-capable pre-releases.** This refines §3.3. `zcash_primitives 0.31.0-pre.2`, which Kage and Hanko pin, hardcodes `DEFAULT_TX_EXPIRY_DELTA: u32 = 40` (`src/transaction/builder.rs:53`, used at `:531`) under every branch. Only 0.31.0 final uses 120 under NU7. Two mempool txs seen live at 12:30Z (`2f2c7bac…1a85` and `482d7d31…5d8d`) had nExpiryHeight 4,547,464 and 4,547,467, about 40 past their target heights. They then waited through 7 coinbase-only blocks (4,547,425–431, about 2.5 min) and were mined at 4,547,432. Read the time-to-live from each deposit's own `nExpiryHeight`, and never assume 120.
5. **A simpler decryptor that can't pick the wrong domain.** This adds to §7.3. In orchard 0.16.0, `Bundle::decrypt_outputs_with_keys(&[ivk])` and `decrypt_output_with_key(idx, &ivk)` choose the note version from the bundle's `BundleVersion` (`src/bundle.rs:145-150, 663-698`). zcash_primitives 0.31.0's `read_v6` tags the Ironwood slot as `BundleVersion::ironwood_v3()` (`src/transaction/mod.rs:1117-1131`; `components/orchard.rs:169-185`). So `tx.ironwood_bundle().map(|b| b.decrypt_outputs_with_keys(&[ivk.clone()]))` always uses the right domain. I ran it on an unproven Ironwood bundle built locally with orchard 0.16.0 and sent to a test key decoded from its `uivktest1…` UIVK. `IronwoodVersion` returned `value=100000 memo=Memo::Text("aabbccdd:0")`, `OrchardVersion` returned `None`, and the bundle helper returned the same hit as `IronwoodVersion` (`out/local.txt`). In the same run, an `orchard_v3` (Orchard-pool) builder refused `add_output` with `CrossAddressDisabled`.
6. **Check the txid after fetching.** This adds to §10 item 3. With `zcash_primitives 0.31.0` and `zcash_protocol 0.11.0`, `Transaction::read` parsed 54 of 54 live txs from blocks 4,547,380–400 (all v6 and Nu7), and `tx.txid().to_string()` matched the display txid every time (`out/parse_new_recent.txt`). With 0.30.1 and 0.10.6, all 54 failed with `invalid consensus branch id 0x77190ad9` (`out/parse_old_recent.txt`), although they still parse the boundary txs at 4,133,999 and 4,465,025. The facilitator should require `tx.txid().to_string() == depositTxid`.
7. **Exact pin details.** This refines §7.2. In Kage, `zcash_transparent =0.11.0-pre.2` appears only under `[dev-dependencies]` of `x402z-facilitator`; it resolves to pre.2 anyway through zcash_primitives. Hanko lists it as a normal dependency. The comment "checked on crates.io 2026-10-20" is Kage's; Hanko's says "Same pre-release line as zec-shielded-x402". Both lockfiles resolve orchard 0.16.0, sapling-crypto 0.9.0, zcash_note_encryption 0.5.1 and zcash_address 0.14.0-pre.2.
