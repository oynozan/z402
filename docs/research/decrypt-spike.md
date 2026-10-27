# Decrypt spike: trial-decrypting z402 deposits on NU7 testnet with an incoming viewing key

Track: decrypt-spike · 2026-10-27 · spike code (throwaway, promotable): `/private/tmp/claude-501/-Users-oynozan-Desktop-Dev-Web3-z402/afbb7c76-d88e-47a4-8a53-fd001155f8ac/scratchpad/spikes/decrypt-spike/zdecrypt`

## TL;DR

1. **Crates:** use the **stable** crates.io line released 2026-10-21: `zcash_primitives =0.31.0`, `zcash_protocol =0.11.0`, `zcash_keys =0.17.0`, `zcash_address =0.14.0`, `orchard =0.16.0`, `sapling-crypto =0.9.0`, `zcash_note_encryption =0.5.1` and `zip32 =0.3.0`. No git deps, no `zcash_unstable` cfg, no protoc, Rust ≥ 1.89.
2. **The old stable line is dead:** `zcash_primitives 0.30.1` / `zcash_protocol 0.10.6` fails every current testnet tx with `invalid consensus branch id 0x77190ad9` (ran it). `--cfg zcash_unstable="nu7"` cannot fix it, because that line maps Nu7 to the placeholder `0xffffffff` and gives it no testnet activation height.
3. **NU7 is live on testnet:** height 4,465,026, branch `0x77190ad9`, all txs v6 (vgid `0xd884b698`). **Every shielded tx in the last 121 blocks used the Ironwood pool** (153/153 txs, 376 actions, 0 Sapling, 0 Orchard). Ironwood notes go to the UA's **Orchard receiver** and decrypt with the **Orchard IVK** (V3 plaintext). A decryptor that reads only `orchard_bundle()` sees nothing.
4. **The tool:** `zdecrypt` is about 600 lines of Rust (plus 166 feature-gated test-builder lines) and makes no network calls. It takes a UIVK or UFVK plus raw tx hex plus a height, rejects trailing bytes, and decrypts Sapling, Orchard and Ironwood outputs to JSON. With `--expect-memo` and `--min-zat` it adds a z402 verdict. Cold build 21 s, 1.2 MB binary, offline `cargo test` passes 5/5.
5. **Negative tests:** 17 real testnet txs parse, 7 of them live from the mempool (judged at tip+1). All decrypt nothing under a fresh key.
6. **Positive tests, real chain:** published demo UIVKs decrypt 5 real Ironwood payments exactly, e.g. 100,000 zat with memo `x402z-f19a63da20cbc0749ea800b3`.
7. **Positive test, synthetic v6/NU7 deposit:** fully shielded, real Halo 2 proof, built offline to a fresh key. It decrypts to value, memo `<sessionKey>:0` and the exact receiver. A UFVK also sees the change in the internal scope.
8. **Speed:** decrypt takes 0.1–0.2 ms for a 2-action tx with no match, about 1 ms with a match, and about 1.8 ms for 30 actions. From Node, a one-shot spawn takes about 2.5 ms p50 and the `serve` sidecar 1.1 ms mean. lightwalletd answered in 0.75–11.5 s, so **use the one-shot CLI** (key in env, hex on stdin, JSON out). Skip napi-rs.
9. **Facilitator must:** fetch with `GetTransaction` (hash = byte-reversed txid; height 0 = mempool, so pass `--tip`; gRPC NotFound = retry), compare `txid`, require `verdict.ok`, and dedupe txids. Treat `tip > expiryHeight` while still unmined as a dead deposit. Blocks now come about every 25 s. The tool does not verify proofs, so trust is in Zebra's mempool.

---

## 1. Crate set that parses current testnet transactions

### 1.1 Versions that worked (ran-it: built, parsed 17 real txs, built and decrypted a v6 tx)

| crate | version | crates.io publish | sha256 (Cargo.lock) |
|---|---|---|---|
| zcash_primitives | 0.31.0 | 2026-10-21 | `50ad9ffda3d83c35e401b2f914980762f201ab40525cb0aab67b8d91e180e7df` |
| zcash_protocol | 0.11.0 | 2026-10-21 | `266da226b6be42545b9fc299f1def9f5e525764845b8afa874f167155de943ba` |
| zcash_keys | 0.17.0 | 2026-10-21 | `6e35ad8dafd173b0465e5963b520b241f497d978319faed46547bd81f403fa98` |
| zcash_address | 0.14.0 | 2026-10-21 | `372023d82d978ab3f27b8e9f7f9b56fc61f3c9cc2b72ec2f8e3bbb278497e474` |
| zcash_transparent | 0.11.0 (transitive) | 2026-10-21 | `eb804d0179500e9543502dd6dfa178826617107897e6fe171241e5b767b7a0dd` |
| orchard | 0.16.0 | 2026-09-30 | `4ae7ceb7b5387bd76cf3c0712f57708795c925cecf097036cedb60b5c3706e8f` |
| sapling-crypto | 0.9.0 | 2026-09-30 | `4a2cbdcfeef20006adf72699cd466f21fe349674277cc05d3fc9b7302db7b182` |
| zcash_note_encryption | 0.5.1 | 2026-09-30 | `4812d133908ebf1a1c91d2411a109f63a863a152633db1fc7fbb0f774edeae30` |
| zip32 | 0.3.0 | 2026-09-29 | `601ab4bc5f8312fa39f5411e07eb66b538687064c6e936b34eaa78f1e99ebe4d` |

Sources: crates.io API `GET https://crates.io/api/v1/crates/<name>/versions` (queried 2026-10-27) and the spike's `zdecrypt/Cargo.lock`. All entries use the `registry+https://github.com/rust-lang/crates.io-index` source. Every `zcash_*` crate here has MSRV 1.89. I built with rustc 1.99.1 (aarch64-apple-darwin).

Exact `[dependencies]` of the lean decryptor (from `zdecrypt/Cargo.toml`):

```toml
zcash_primitives = { version = "=0.31.0", default-features = false, features = ["std"] }
zcash_protocol = { version = "=0.11.0", default-features = false, features = ["std"] }
zcash_keys = { version = "=0.17.0", default-features = false, features = ["std", "orchard", "sapling"] }
zcash_address = { version = "=0.14.0", default-features = false, features = ["std"] }
orchard = { version = "=0.16.0", default-features = false, features = ["std"] }
sapling = { package = "sapling-crypto", version = "=0.9.0", default-features = false, features = ["std"] }
zcash_note_encryption = "=0.5.1"
zip32 = "=0.3.0"
hex = "0.4"
serde_json = "1"
getrandom = "0.3"
```

`default-features = false` drops `circuits` and `multicore`, so neither halo2 nor bellman is compiled. Parsing and decryption need no proving code. `zcash_keys` and `zcash_primitives` themselves depend on orchard and sapling with `default-features = false` (read-source: `zcash_keys-0.17.0/Cargo.toml` `[dependencies.orchard]`, `zcash_primitives-0.31.0/Cargo.toml` `[dependencies.orchard]`).

### 1.2 Why this line, and the NU7 gotchas

- `zcash_protocol 0.11.0` CHANGELOG (read-source, `CHANGELOG.md` "## [0.11.0] - 2026-10-21"):
  - "`NetworkUpgrade::Nu7, BranchId::Nu7` ... are now available without the `--cfg zcash_unstable="nu7"` configuration flag."
  - "`BranchId::Nu7` now maps to and from the consensus branch ID `0x77190AD9` (was the placeholder `0xFFFFFFFF`)."
  - "`TestNetwork` now activates NU7 at height `4465026`, and the mainnet activation height has been set." The code has mainnet at 3,543,405 (`consensus.rs:567`) and testnet at 4,465,026 (`consensus.rs:601`).
  - These items first appeared in **0.11.0-pre.0** (2026-09-30). The pre.1 line that Kage and Hanko pin behaves the same on testnet; it only lacks the mainnet height and the block-spacing helpers.
- `zcash_primitives 0.31.0` CHANGELOG (read-source):
  - "`TxVersion::suggested_for_branch` returns `TxVersion::V6` for it, and `TxVersion::valid_in_branch` accepts `V5` and `V6` transactions but not `V4` transactions under it (ZIP 2003)." The code is at `transaction/mod.rs:245`: `Nu7 => false, // ZIP 2003`.
  - V6 is `V6_TX_VERSION = 6`, `V6_VERSION_GROUP_ID = 0xD884B698` (`zcash_protocol-0.11.0/src/constants.rs:40-42`). It was introduced at NU6.3 and carries separate Orchard and Ironwood bundles (CHANGELOG 0.29.0-pre.0).
- **Old line fails (ran-it).** `oldline-check` (`zcash_primitives =0.30.1`, `zcash_protocol =0.10.6`) on mined tx `99b4142e…31df` and on `030c3cbf…8351`:
  ```
  for_height gives Nu6_3, parse error: invalid consensus branch id 0x77190ad9
  ```
  The error comes from `read_header_fragment` (`zcash_primitives-0.31.0/src/transaction/mod.rs:1152-1166` has the same code).
- **cfg cannot rescue the old line (read-source).** In `zcash_protocol-0.10.6/src/consensus.rs`, `#[cfg(zcash_unstable = "nu7")] NetworkUpgrade::Nu7 => None` sits at line 539 (testnet) and `0xffff_ffff => Ok(BranchId::Nu7)` at line 776.
- **No `.cargo/config.toml` or RUSTFLAGS are needed.** Kage and Hanko set none either (grep over both repos: no `zcash_unstable`, no RUSTFLAGS). The only remaining unstable cfg is `zcash_unstable="nutachyon"` (V7 txs), which is irrelevant here.
- **For v5 and v6, `Transaction::read(reader, branch)` ignores `branch`.** It reads the branch id from the tx header (`transaction/mod.rs:973-985`, `read_v5`/`read_v6`). The argument matters only for v4. The height you pass therefore matters only for v4 and for Sapling's ZIP 212 rule. Pass the right height anyway: the mined height, or tip+1 for the mempool.
- **`Transaction::read` does not check for trailing bytes.** `zdecrypt` wraps the input in a `Cursor` and rejects leftovers (ran-it: `{"error":"transaction does not parse: 1 trailing bytes after the transaction"}`).
- **Kage and Hanko pins (read-source):** Kage `Cargo.toml` at `03307609` and Hanko `packages/core/Cargo.toml` at `3c7edae8` pin `zcash_primitives =0.31.0-pre.2`, `zcash_protocol =0.11.0-pre.1`, `zcash_keys =0.17.0-pre.2`, `zcash_client_backend =0.25.0-pre.2`, `orchard 0.16`, `sapling-crypto 0.9`, `zcash_note_encryption 0.5` and toolchain 1.89.0. Kage's comment says "checked on crates.io 2026-10-20", one day before the stable release. Hanko's `Cargo.lock` has `orchard 0.16.0`, `sapling-crypto 0.9.0` and `zcash_note_encryption 0.5.1`, identical to the stable line.
- **zingolib main is on the same stable line (read-source).** Shallow clone at `3fb32d277ef956e75da124c1442526fb4d91d97a` (2026-10-26): `Cargo.lock` has `zcash_primitives 0.31.0`, `zcash_protocol 0.11.0`, `zcash_client_backend 0.25.0`, `zcash_keys 0.17.0`, `orchard 0.16.0` and `sapling-crypto 0.9.0`, and 85 `.rs` files mention Ironwood. A current zingo-cli (crate `zingo-cli 0.4.0`) builds NU7 txs. The client agent must use a build from about now, not an old release.

## 2. NU7 / Ironwood facts the facilitator depends on

| fact | evidence |
|---|---|
| Testnet NU7 at 4,465,026, branch `0x77190ad9` | read-source `zcash_protocol-0.11.0/src/consensus.rs:601,909`. Live (ran-it): `GetLightdInfo.consensusBranchId = "77190ad9"`, tip about 4,547,3xx |
| All live txs are v6 / `0xd884b698` / `Nu7` | ran-it: 17 real txs parsed, `version: 6`, `versionGroupId: "0xd884b698"`, `branch: "Nu7"` |
| Orchard pool closed to cross-address payments since NU6.3 (turnstile), so payments land in Ironwood | read-source `zcash_protocol-0.11.0/src/consensus.rs:1094-1097`: "NU6.3, which introduces the Ironwood value pool ... cross-address transfers are prohibited for the Orchard value pool and permitted for the Ironwood value pool". `zcash_client_backend-0.25.0/src/data_api/wallet/input_selection.rs:1017-1040`: "Represent an Orchard-receiver payment as an Ironwood-pool output once Ironwood is active ... the Orchard turnstile (a consensus rule) forbids adding value to the Orchard pool" |
| Ironwood shares the UA's Orchard receiver (no new UA typecode) | read-source `zcash_keys-0.17.0/src/address.rs:847` "Ironwood shares the Orchard receiver." Ran-it: real payments decrypt with `uivk.orchard()` |
| Ironwood decryption = Orchard decryption with note plaintext V3 (lead byte `0x03`) | read-source `orchard-0.16.0/src/note_encryption.rs:213-219` (`OrchardDomain` accepts `0x02`, `IronwoodDomain` accepts `0x03`). `Bundle::decrypt_outputs_with_keys` uses the bundle's own `BundleVersion` (`bundle.rs:663-682`). Ran-it: `noteVersion: 3` on every Ironwood output |
| Live usage: 121 blocks (4,547,107 → 4,547,227) had 153 txs, 376 Ironwood actions, 0 Sapling outputs or spends, 0 Orchard actions | ran-it: `GetBlockRange`, `data/blocks.jsonl` |
| Sapling still exists under NU7 (`has_sapling` true) | read-source `consensus.rs:1036`. Ran-it: third-party Sapling shielding tx `4a9412fa…8634` at 4,530,168 parses with 2 Sapling outputs |
| Block target is 25 s after NU7 (was 75 s) | read-source `consensus.rs:44-50` `NU7_POW_TARGET_SPACING_RATIO = 3`, `:781` `POST_NU7_POW_TARGET_SPACING = 25 s`. Ran-it: mean 28.7 s over 120 blocks |
| Default expiry delta is 120 blocks from NU7 (was 40) | read-source `zcash_primitives-0.31.0/src/transaction/builder.rs:61-69`. Ran-it: at tip 4,547,319, six of the seven mempool txs expired 35–39 blocks ahead (the old 40-block delta) and one 120 ahead (4,547,439). Wallets in the wild still use the old delta |
| Coinbase now pays into Ironwood | ran-it: `521793dd…3eb3` has `coinbase: true`, 1 Ironwood action, `spendsEnabled: false` |
| A 2-action Ironwood tx is 9,166 bytes. The largest seen (30 actions) is 97,536 bytes | ran-it |
| ZIP 317 fee for the deposit shape (1 Ironwood spend + 2 outputs) is 10,000 zat | ran-it: `build-test` reports `feeZat: 10000` (marginal fee 5,000 × 2 logical actions, `fees/zip317.rs:19,24`) |

## 3. The spike tool: `zdecrypt`

Location: `/private/tmp/claude-501/-Users-oynozan-Desktop-Dev-Web3-z402/afbb7c76-d88e-47a4-8a53-fd001155f8ac/scratchpad/spikes/decrypt-spike/zdecrypt`. It contains `Cargo.toml`, `Cargo.lock`, `src/lib.rs` (413 lines), `src/main.rs` (185), `src/testbuild.rs` (166, feature-gated) and `tests/fixtures.rs` (108) plus `tests/fixtures/`. It was written from scratch. It follows the same decrypt-loop shape as Kage `verify.rs` and Hanko `lib.rs` (both MIT), and its tests use their published demo keys and txids. Credit both if promoted.

### 3.1 Build

```sh
S=/private/tmp/claude-501/-Users-oynozan-Desktop-Dev-Web3-z402/afbb7c76-d88e-47a4-8a53-fd001155f8ac/scratchpad/spikes/decrypt-spike
cd $S/zdecrypt
CARGO_HOME=$S/cargo-home CARGO_TARGET_DIR=$S/target cargo build --release            # lean facilitator binary
CARGO_HOME=$S/cargo-home CARGO_TARGET_DIR=$S/target cargo test --release             # 5 offline fixture tests
CARGO_HOME=$S/cargo-home CARGO_TARGET_DIR=$S/target-testbuild cargo build --release --features testbuild   # + build-test
```

Release profile: `opt-level=3`, `lto="thin"`, `codegen-units=4`, `strip=true`.

### 3.2 CLI (exact)

```
zdecrypt keygen [--seed-hex HEX] [--pretty]
zdecrypt derive-uivk                                   # key from ZDECRYPT_KEY, prints {"uivk","from"}
zdecrypt decrypt (--height H | --tip T) [--pay-to UA] [--expect-memo M --min-zat Z]
                 [--tx-hex HEX | --tx-file PATH | hex on stdin] [--pretty]
zdecrypt owns --address UA                              # which receivers of UA the key owns
zdecrypt serve                                          # NDJSON sidecar, see 3.5
zdecrypt build-test --merchant-address UA [--value 100000] [--memo M] [--height 4547300] [--agent-seed-hex HEX]   # testbuild only
```

- The key comes from env `ZDECRYPT_KEY` (preferred, since argv shows in `ps`) or `--key`. A `uview…` string is decoded as a UFVK (external + internal scopes); anything else as a UIVK (external only). Testnet only.
- `--height H`: the tx is mined at H. `--tip T`: a mempool tx, judged at T+1, the same rule `zcash_client_backend::decrypt_transaction` uses ("mempool height", `decrypt.rs:179-184`).
- Exit 0 means one JSON object on stdout. Exit 2 means `{"error":"..."}` on stdout and `error: ...` on stderr. A parse failure is exit 2. "Nothing decrypted" is exit 0 with `outputs: []`.

### 3.3 Output JSON (real run: synthetic deposit, `--tip 4547329 --pay-to <merchant UA> --expect-memo <memo> --min-zat 100000`)

```json
{
  "txid": "8877c091c97986797e7850c31fe2efed2efbe1369d41ff191623ba9c6f4ef690",
  "version": 6, "versionGroupId": "0xd884b698", "branch": "Nu7", "branchId": "0x77190ad9",
  "heightUsed": 4547330, "heightKind": "mempool", "branchMatchesHeight": true,
  "lockTime": 0, "expiryHeight": 4547450, "expired": false,
  "transparentIn": 0, "transparentOut": 0, "coinbase": false,
  "sapling": null,
  "orchard": null,
  "ironwood": { "actions": 2, "valueBalanceZat": 10000, "spendsEnabled": true, "outputsEnabled": true, "crossAddressEnabled": true },
  "keyKind": "uivk",
  "outputs": [{
    "pool": "ironwood", "index": 0, "scope": "external", "valueZat": 100000,
    "memoKind": "text", "memoText": "2b9717fe612c664f1d5af1bb538197782820b23c144d6f59b865e81f71c54650:0", "memoHex": null,
    "recipient": "utest19zmqcmg8yqng8y95gyq7k5zpg3w23pyrvnaqdmurumzh7svdt7u7sqp8vvqx0248tszzcxy5mx63a94cyj44xa29mqpq66a8jqts6mdj",
    "receiverHex": "c2cb226dcfcb488d0660d9bfac4189fbc811a9f136b964364d676f67acb3a6537fb504c4e2f31d867b57af",
    "diversifierIndex": "1", "noteVersion": 3, "toPayTo": true
  }],
  "payTo": { "hasTransparent": false, "orchardOwned": true, "saplingOwned": true, "ownedByKey": true },
  "verdict": { "ok": true, "paidZat": 100000, "reasons": [] },
  "sizeBytes": 9166, "parseMicros": 75, "decryptMicros": 1156
}
```

Field notes:
- `txid` is the display (byte-reversed) hex recomputed from the bytes (ZIP 244 for v5 and v6). Compare it to the requested txid.
- `outputs[].pool` is `"sapling" | "orchard" | "ironwood"`. `scope` is `"external" | "internal"`; internal appears only with a UFVK.
- `memoKind` is `"text"` (then `memoText`), `"empty"`, or `"binary"` (then `memoHex`, trailing zeros trimmed).
- `recipient` is a single-receiver testnet UA (Orchard family) or a `ztestsapling…` address. `receiverHex` is the raw 43-byte receiver, which `toPayTo` compares against `payTo`'s receiver for that pool.
- `valueZat` is a JSON number. The 21M ZEC maximum, 2.1e15, is below 2^53, so it is safe in JS.
- `expired` is `expiryHeight != 0 && heightUsed > expiryHeight`. A tx can still be mined at `heightUsed == expiryHeight` (ran-it: tip 4,547,449 → ok, tip 4,547,450 → `EXPIRED`).
- `payTo` / `toPayTo` appear only with `--pay-to`. `verdict` appears only with `--expect-memo` and `--min-zat`.

### 3.4 Verdict rule and reason codes

The verdict applies the z402 rule. Only **external-scope** outputs count, and only those whose **text memo equals `--expect-memo` exactly**. If `--pay-to` is given, the output's receiver must also equal `payTo`'s receiver for that pool (the Orchard receiver for orchard/ironwood). The values of the counted outputs are summed (`paidZat`), and the verdict needs `paidZat ≥ --min-zat` with no transparent input or output and not expired. Reason codes match Hanko's `zpay-verify` where they overlap:

| code | when (ran-it case) |
|---|---|
| `NO_OUTPUT_TO_KEY` | nothing decrypts to the key (other key on the deposit) |
| `MEMO_MISMATCH` | outputs to the key exist, none with the expected memo (memo `…:1` vs `…:0`) |
| `WRONG_RECIPIENT` | memo matches, but the note went to another receiver than `payTo` (payTo = the same key's Orchard-only UA at index 0, deposit at index 1) |
| `AMOUNT_TOO_LOW` | `paidZat < min-zat` (min 100,001 vs 100,000). Also added alongside the two codes above |
| `TRANSPARENT_PART` | `transparentIn + transparentOut > 0` (synthetic funding tx; real tx `bb8d8842…82ec` with `transparentOut: 1`) |
| `EXPIRED` | `heightUsed > expiryHeight` |

Hanko codes that are not here: `TX_NOT_FOUND` and `NOT_CONFIRMED` belong to the Node caller, which owns fetching and confirmations.

### 3.5 `serve` (sidecar) protocol

One JSON request per line on stdin, one reply line on stdout, flushed per line. The key comes from `ZDECRYPT_KEY` once, at start.

```
→ {"id":"a","txHex":"…","tip":4547329,"payTo":"utest1…","expectMemo":"<sk>:0","minZat":100000}
← {"id":"a","ok":true,"result":{…same report as 3.3…}}
→ {"id":"b","txHex":"…","height":4547131}
← {"id":"b","ok":false,"error":"transaction does not parse: 1 trailing bytes after the transaction"}
```

### 3.6 Library API (if linked directly or promoted)

```rust
pub const NETWORK: zcash_protocol::consensus::Network = Network::TestNetwork;
pub fn decode_key(s: &str) -> Result<Keys, String>;                      // UIVK or UFVK
pub enum At { Mined(BlockHeight), Mempool { tip: BlockHeight } }        // At::height() = h or tip+1
pub fn parse_tx(raw: &[u8], height: BlockHeight) -> Result<Transaction, String>;   // rejects trailing bytes
pub fn decrypt(tx: &Transaction, keys: &Keys, height: BlockHeight) -> Vec<Decrypted>;
pub fn inspect_expect(raw: &[u8], keys: &Keys, at: At, pay_to: Option<&UnifiedAddress>, expect: Option<&Expect>) -> Result<serde_json::Value, String>;
pub struct Expect { pub memo: String, pub min_zat: u64 }
pub fn keygen(seed: &[u8; 32]) -> Result<serde_json::Value, String>;
```

The upstream calls it rests on (read-source, all exercised by ran-it runs):
- `UnifiedIncomingViewingKey::decode(&params, &str) -> Result<_, UnifiedDecodingError>`
- `UnifiedFullViewingKey::decode(..)` and `.to_unified_incoming_viewing_key()`
- `uivk.orchard() -> &Option<orchard::keys::IncomingViewingKey>` and `uivk.sapling() -> &Option<sapling::zip32::IncomingViewingKey>`
- `fvk.to_ivk(zip32::Scope::{External,Internal})`
- `Transaction::read(R, BranchId)`, `BranchId::for_height(&params, h)`
- `tx.{sapling_bundle, orchard_bundle, ironwood_bundle, transparent_bundle}()`
- `orchard::Bundle::decrypt_outputs_with_keys(&[IncomingViewingKey]) -> Vec<(usize, IncomingViewingKey, Note, Address, [u8;512])>`
- `zcash_note_encryption::try_note_decryption(&SaplingDomain::new(zip212_enforcement(&params, h)), &PreparedIncomingViewingKey, &OutputDescription)`
- `orchard::keys::IncomingViewingKey::diversifier_index(&Address)` and `sapling::zip32::IncomingViewingKey::decrypt_diversifier(&PaymentAddress)`
- `MemoBytes::from_bytes` and `Memo::try_from(&MemoBytes)`

## 4. Test evidence

### 4.1 Fresh key (ran-it: `zdecrypt keygen`)

```
uivk    uivktest1x7lgwx5tje3e37trflflmgswru57k4x7m65m2aye9hl93k098uv7axdhuulgtm5r7me0h4yt2w5lyr594q2k29nws46hssvt0wwny8gczrmw82gq9e0wn4qx422fm3gzgpzzlf2xgtkgpahqst7z7tc3z87t8wg483cz5et3lpj230ygaswp5dj4mwh9yrutq76vlc3tpm8hl5njxgczk4av4jm8pvkakeh0e77ra7fjgy95qlt
address utest19e5pntklwre680nzd3q7v4ygwu5p7sertkgdrvkqw49ktnz9hxag9tdk2q8ppl4ztj9wqqdcmvdr8dk9peu9xuay674c0z9xmhg9f6k0yxqn45zwsu2rpnd8ra9tzkrq8sqkejsxkwe6ljjhanx953v8n6xs586rfzqkzqvtccu7g5dy   (Orchard+Sapling, diversifier index 1)
orchardOnlyAddress utest1q97m3j4x8x3mfw52ye4r8nx9ye7nuyt54ra0qnf79h2j0v76dqvl2arf9955zk620sjhe3954kc6x364r8rgn4xa6l7nwyr9nyqua6f9   (index 0)
```

Throwaway testnet key. The seed and UFVK are in `…/spikes/decrypt-spike/data/keys/merchant.json`.

- `UnifiedSpendingKey::from_seed(&TestNetwork, &seed32, AccountId::ZERO)` → `.to_unified_full_viewing_key()` → `.to_unified_incoming_viewing_key()`. The UA comes from `ufvk.default_address(UnifiedAddressRequest::unsafe_custom(Require, Require, Omit))`.
- Index 0 was not a valid Sapling diversifier, so the Orchard+Sapling UA starts at index 1. `UnifiedAddressRequest::SHIELDED` would have silently dropped the Sapling receiver at index 0 (`Allow` semantics, `keys.rs:684-687`).
- Without the `transparent-inputs` feature the keys carry no transparent item, so the UA is shielded-only.

### 4.2 Real testnet txs with the fresh key: parse OK, 0 outputs (ran-it)

Fetched with `GetTransaction` via `scripts/fetch_tx.sh <txid>`. Mempool txs came from `GetMempoolStream`, judged at `--tip 4547319`.

| txid | where | bytes | shape | parse µs | decrypt µs |
|---|---|---|---|---|---|
| `99b4142e1f6602c12dfc942dfb34801c783098dae10a5beae7746e650a0531df` | mined 4,547,225 | 9,166 | v6, 2 Ironwood actions, expiry 4,547,247 | 189 | 179 |
| `521793dde2a1827c024ab470ff39554ae1e2e9eff52418494a4562d355773eb3` | mined 4,547,227 | 6,072 | coinbase, 1 Ironwood action | 41 | 69 |
| `658e46afb50b0c4f85a757d13f932a7d2cac8973568b222b99b0bef49290dacf` | mined 4,547,131 | 97,536 | 30 Ironwood actions | 689 | 1,758 |
| `d720163416a57f13e28733354039e49de6b48595a46dc980b37d85fa137e57c3` | mined 4,547,147 | 84,910 | 26 Ironwood actions | 546 | 1,386 |
| `0616c4a3…d8c9`, `b8e0085c…d9a1`, `dee8d1c9…4579`, `3f4523ec…53b8` | mempool | 9,166 each | 2 Ironwood actions, expiry 4,547,354–4,547,356 | 69–319 | 97–121 |
| `c673ab63…f90e` | mempool | 12,322 | 3 Ironwood actions, expiry 4,547,439 | 96 | 150 |
| `d4636ab4…3a9b` | mempool | 9,424 | 1 transparent input + 2 Ironwood actions | 76 | 101 |
| `6b6b8336…2796` | mempool | 421 | purely transparent v6 (2 in, 3 out) | 4 | 0 |
| `4a9412fa75194d31fdae2c796765e1617cdeade286ab231ab75705db827c8634` | mined 4,530,168 | 2,176 | Sapling shielding (1 t-in, 1 t-out, 2 Sapling outputs) | 84 | 309 |

All recomputed txids equal the requested ones.

### 4.3 Real txs with keys their owners published: exact positive decryption (ran-it)

The keys come from Hanko `fixtures/testnet.json` and `deployments/testnet.json` at `3c7edae8` (sourced there from Kage's README and other demo deployments). They are demo-only incoming viewing keys.

| txid | key | result |
|---|---|---|
| `030c3cbf78ce8460553bba4e82c0ba813f039bd3ecf4d7f2e81c59837dc28351` (4,521,112) | Kage x402 merchant UIVK | ironwood, 100,000 zat, memo `x402z-f19a63da20cbc0749ea800b3`, external, div 3, V3 |
| `06d121813387444ca3ecc9720e73160b5b80645d9204c6c411e51cef3a190af1` (4,522,268) | auction UIVK | ironwood, 2,000,000 zat, memo `sba1:6201170948318861529:4625…6802` |
| `7c1f6cc09a7ae9171beffbbb2dfbf15668431d7b997f742e18706d9296b34c16` (4,522,621) | paywall merchant UIVK, `--pay-to` its UA | ironwood idx 1, 10,000 zat, memo `zpv-c3d1529ba80d3f1a28658921`, `toPayTo: true` |
| `bb8d88426b96a4cd92ec90446d154de5321da7b2bb863d9249a43838e49a82ec` (4,522,621) | same | 10,000 zat, `transparentOut: 1` → verdict `TRANSPARENT_PART` |
| `38958ceb0ce952ccf6c11003258072dc8ea97f4f6408dc11c2515aeb126b5869` (4,522,626) | employee UIVK | 50,000 zat, memo `payslip 2026-10 #7: net 0.0005 TAZ`. With payTo = another wallet's UA: `toPayTo: false`, `ownedByKey: false` |
| `030c3cbf…8351` | paywall UIVK (wrong key) | 0 outputs, 108 µs |

### 4.4 Synthetic v6/NU7 deposit to the fresh key (ran-it, `build-test`, testbuild feature)

`zdecrypt build-test --merchant-address <fresh UA> --value 100000 --memo "<random 32-byte hex>:0" --height 4547330` took 4.8 s wall:

1. **Funding tx** `e94af0966859d7a13286dcdb9f8c3cffbc82a87d36b06adca271faf4bf470f26` (11,282 bytes, fee 25,000, built in 1,524 ms including the post-NU6.3 Orchard proving key).
   - Input: a made-up P2PKH coin (`OutPoint([7;32],0)`, secp256k1 key `[0x42;32]`).
   - Outputs: 150,000 zat to the agent's Ironwood address, and 20,000 zat Sapling to the merchant UA's Sapling receiver with memo `z402 sapling check`.
   - Sapling proofs are `sapling::prover::mock` bytes. Note encryption is real.
2. **Deposit tx** `8877c091c97986797e7850c31fe2efed2efbe1369d41ff191623ba9c6f4ef690` (9,166 bytes, the same size as real 2-action txs, fee 10,000, built in 565 ms). This is the z402 deposit shape:
   - It spends the agent's Ironwood note, anchored to a synthetic one-leaf tree with auth path `MerkleHashOrchard::empty_root(Level(i))`.
   - It pays 100,000 zat through `Builder::add_ironwood_output` to the merchant's Orchard receiver with the session memo, and sends 40,000 change to the agent's internal address.
   - It has no transparent part.
   - It carries a real Halo 2 proof and real spend-auth and binding signatures. The chain would reject it only because the anchor and coin are made up.

| decrypt run | result |
|---|---|
| deposit, merchant UIVK, `--tip 4547329` | 1 output: ironwood, 100,000, memo `2b9717fe…4650:0`, `toPayTo: true`, `transparentIn/Out 0/0`, verdict ok |
| deposit, merchant UFVK | identical (external scope) |
| deposit, agent UFVK | 1 output: ironwood idx 1, **internal** scope, 40,000, empty memo |
| deposit, unrelated UIVK | 0 outputs → `NO_OUTPUT_TO_KEY` |
| deposit, `--height 4547330` (as mined) | same as the mempool run |
| funding, merchant UIVK | sapling idx 1, 20,000, memo `z402 sapling check`, `toPayTo: true` (ZIP 212 On), verdict `TRANSPARENT_PART` |
| funding, agent UFVK | ironwood, 150,000, external |

Builder calls used (read-source `zcash_primitives-0.31.0/src/transaction/builder.rs`, ran-it):
- `Builder::new(params, target_height, BuildConfig::Standard { sapling_anchor, orchard_anchor: None, ironwood_anchor: Some(anchor), orchard_padding: BundlePadding::DEFAULT, ironwood_padding: BundlePadding::DEFAULT })`
- `add_transparent_p2pkh_input(pk, OutPoint, TxOut)`
- `add_ironwood_spend::<zip317::FeeError>(fvk, note, merkle_path)`
- `add_ironwood_output::<zip317::FeeError>(Some(ovk), orchard::Address, Zatoshis, MemoBytes)`
- `add_sapling_output`
- `get_fee(&zip317::FeeRule::standard())`
- `build(&TransparentSigningSet, &[], &[SpendAuthorizingKey], rand::rand_core::UnwrapErr(rand::rngs::SysRng), &MockSpendProver, &MockOutputProver, &rule)`

At an NU7 target height the builder emits v6, and the Ironwood builder exists only when `tx_version.has_ironwood()` (`builder.rs:1012-1030`).

### 4.5 Error paths (ran-it, all exit 2)

| input | error |
|---|---|
| a valid tx plus 1 byte | `transaction does not parse: 1 trailing bytes after the transaction` |
| truncated, or `deadbeef` | `transaction does not parse: failed to fill whole buffer` |
| odd-length hex | `tx is not hex: Odd number of digits` |
| both `--height` and `--tip` | `give exactly one of --height (mined) or --tip (mempool)` |
| a UA in place of a key | `not a testnet unified incoming viewing key: Unrecognized Bech32m human-readable prefix: utest` |

### 4.6 Offline regression tests (ran-it)

`cargo test --release` passes 5/5 in 0.02 s on frozen fixtures in `zdecrypt/tests/fixtures/`: real txs `030c3cbf`, `bb8d8842`, `658e46af`, `521793dd`, `4a9412fa`, one mempool tx, and the synthetic deposit and funding txs with their keys.

## 5. Performance (Apple M5, 10 cores, macOS, rustc 1.99.1)

| item | value (ran-it) |
|---|---|
| Lean build, cold (empty `CARGO_HOME`, downloads 128 crates, compiles 120) | **20.9 s** wall (53.8 s user) |
| Lean rebuild after editing `lib.rs` | 2.9 s |
| testbuild build (halo2, bellman, secp256k1; 157 crates) | 20.9 s with downloads warm, 8.2 s incremental |
| `cargo test --release` (compile + run) | 5.3 s |
| Binary size, lean, stripped, thin LTO, arm64 | **1,216,976 bytes** |
| Binary size, testbuild | 3,892,240 bytes |
| Disk | `cargo-home` 156 MB, `target` 188 MB |
| Decrypt, no match, 2 actions | 0.10–0.18 ms. Parse 0.07–0.32 ms |
| Decrypt, 1 Ironwood match (note commitment recheck) | 0.7–2.0 ms |
| Decrypt, 30 actions, no match | 1.4–1.8 ms |
| Decrypt, Sapling match (2 Sapling + 2 Ironwood) | 8.9 ms (single run) |
| Node → one-shot `zdecrypt decrypt` (spawn + key decode + decrypt + JSON), deposit | p50 2.37–2.73 ms, p95 2.66–6.2 ms (40 calls, 2 runs). The first exec after a rebuild took 252 ms (macOS first-run check) |
| Node → `zdecrypt serve` sidecar, deposit | mean 1.09–1.10 ms, p95 1.14–1.17 ms (400 calls). First call 1.8–2.0 ms |
| Node → sidecar, 30-action tx | mean 2.5–2.7 ms |
| `build-test` (both txs, Halo 2 proving) | 4.8 s wall |

Benchmark script: `…/spikes/decrypt-spike/node/bench.mjs` (`node bench.mjs`).

## 6. lightwalletd facts (testnet.zec.rocks:443, ran-it with grpcurl)

- `GetLightdInfo`: `version v0.5.4`, `gitCommit c22ca9ba67676e61cd8ee107538ffd9a77799bab`, `zcashdSubversion /Zebra:7.0.0/`, `consensusBranchId 77190ad9`, `lightwalletProtocolVersion v0.5.0`.
- `GetTransaction(TxFilter{hash})`: `hash` is the 32 txid bytes in **internal order**, i.e. the display hex reversed.
  ```sh
  B64=$(python3 -I -c 'import sys,base64;print(base64.b64encode(bytes.fromhex(sys.argv[1])[::-1]).decode())' $TXID)
  grpcurl -max-time 30 -import-path . -proto service.proto -d "{\"hash\":\"$B64\"}" testnet.zec.rocks:443 cash.z.wallet.sdk.rpc.CompactTxStreamer/GetTransaction
  ```
  - Mined: `{"data":"…","height":"4547225"}`.
  - **Mempool: `{"data":"…"}` with `height` absent (proto3 0)**, verified on mempool tx `ab74de28…4a54`.
  - Unknown: gRPC `NotFound`, `GetTransaction: getrawtransaction 0000…0000 failed: -5: Transaction not found in mempool or best chain`.
  - The proto documents `height = 0xffffffffffffffff` as "mined on a fork that is not the main chain" (`service.proto` `RawTransaction`). Not observed.
- `GetMempoolStream(Empty)`: streams `RawTransaction` **without height**, and the stream stays open until the next block. Fetch the tip with `GetLatestBlock` for `--tip`.
- `GetMempoolTx` returns `CompactTx` with `ironwoodActions[{nullifier, cmx, ephemeralKey, ciphertext(52 B)}]`. There is no memo in compact data, so the full tx is needed.
- `GetStandardFee`: `Unimplemented` on this server, although it is in the downloaded proto.
- **Latency is erratic.** `GetLatestBlock` took 0.75 s, 5.4 s and 11.6 s on consecutive calls. During one burst, 6 dials in a row failed with `context deadline exceeded`, and later 1 dial failed with `EOF`. Every retry succeeded. Keep **one persistent gRPC channel**, use per-call deadlines, and retry.

## 7. Interface proposal for calling it from Node

| option | measured or estimated cost | pros | cons |
|---|---|---|---|
| **A. One-shot CLI** (`spawn`, key in env, hex on stdin, JSON on stdout) | 2.4–2.7 ms p50 per deposit (measured) | Simplest. Crash-isolated. Stateless. The same pattern as Hanko's SDK (`packages/sdk/src/zcash.ts` spawns `zpay-verify`). Easy to swap for Hanko | A process per deposit (irrelevant at about 1 deposit per 100 calls). The macOS first-exec check costs about 250 ms once |
| B. Long-lived sidecar (`zdecrypt serve`, NDJSON over stdio) | 1.1 ms mean (measured) | Key decoded once. No spawn per call | Needs id multiplexing, restart-on-exit and backpressure. Saves about 1.4 ms, which is noise next to 0.75–11 s lightwalletd calls |
| C. napi-rs addon | about 1 ms in-process (estimated) | No IPC | Needs `@napi-rs/cli`, a per-platform `.node` build, and the Rust toolchain wherever it is built. A panic can kill the facilitator process. No measurable benefit |
| D. WASM (wasm-bindgen) | not measured | No native binary | halo2/pasta are large and slower in WASM, and the build is more work. Not needed |

**Recommendation: A.** Put Node in charge of networking (grpc-js `GetTransaction` + `GetLatestBlock`, the 15 s retry loop, and the 30 s poller), and keep the Rust tool pure. Wrapper sketch:

```ts
import { spawn } from 'node:child_process';

export type Reason = 'NO_OUTPUT_TO_KEY' | 'MEMO_MISMATCH' | 'WRONG_RECIPIENT' | 'AMOUNT_TOO_LOW' | 'TRANSPARENT_PART' | 'EXPIRED';
export interface ZOutput { pool: 'sapling' | 'orchard' | 'ironwood'; index: number; scope: 'external' | 'internal'; valueZat: number;
  memoKind: 'text' | 'empty' | 'binary'; memoText: string | null; memoHex: string | null; recipient: string; receiverHex: string;
  diversifierIndex: string | null; noteVersion: 2 | 3 | null; toPayTo?: boolean }
export interface ZReport { txid: string; version: number; branchId: string; heightUsed: number; heightKind: 'mined' | 'mempool';
  expiryHeight: number; expired: boolean; transparentIn: number; transparentOut: number; outputs: ZOutput[];
  verdict?: { ok: boolean; paidZat: number; reasons: Reason[] }; [k: string]: unknown }

export function zdecrypt(bin: string, uivk: string, txHex: string,
  a: { tip?: number; height?: number; payTo: string; expectMemo: string; minZat: number }): Promise<ZReport> {
  const where = a.height !== undefined ? ['--height', String(a.height)] : ['--tip', String(a.tip)];
  const args = ['decrypt', ...where, '--pay-to', a.payTo, '--expect-memo', a.expectMemo, '--min-zat', String(a.minZat)];
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { env: { PATH: process.env.PATH ?? '', ZDECRYPT_KEY: uivk } });
    let out = '', err = '';
    const timer = setTimeout(() => p.kill('SIGKILL'), 10_000);
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('close', (code) => {
      clearTimeout(timer);
      let j: any; try { j = JSON.parse(out); } catch { return reject(new Error(err || `zdecrypt exited ${code}`)); }
      code === 0 ? resolve(j as ZReport) : reject(new Error(j.error ?? err));
    });
    p.stdin.end(txHex);
  });
}
```

## 8. Deposit check, step by step (what `/verify` should do with this tool)

1. `depositTxid` is 64 hex chars in display order. Call `GetTransaction{hash: reverse(hex)}` on a persistent channel.
   - On `NotFound` (gRPC code 5), retry for up to 15 s, per the spec.
   - Also call `GetLatestBlock` → `tip`.
2. If `height == 0`, it is in the mempool: pass `--tip tip`. Otherwise pass `--height height` and compute confirmations as `max(tip,height) - height + 1`. The kage track reports `GetTransaction` can return a height above the `GetLatestBlock` tip.
3. Run `zdecrypt decrypt` with `--pay-to <payTo> --expect-memo "<sessionKey>:<depositIndex>" --min-zat <windowZat>`, the UIVK in `ZDECRYPT_KEY`, and the hex on stdin.
4. Require `report.txid === depositTxid.toLowerCase()`. A lying server could hand over other bytes.
5. Require `report.verdict.ok`. That covers "≥ windowZat to payTo, exact memo, no transparent part, not expired".
6. In TS, refuse a txid that has already been credited (to any session), and require `depositIndex` to be the session's next index. Note that the memo binds a deposit to a session key, but the same txid sent twice would otherwise be counted twice.
7. Store `expiryHeight`. The 30 s poller needs no decryption: re-run `GetTransaction`.
   - `height > 0` → confirmed (D_conf).
   - Still `0` and `tip > expiryHeight` → dead.
   - `NotFound` after it was seen → evicted or double-spent, so drop it from D_pend.
   - `height == 2^64-1` → orphaned.
8. **What is not verified:** Halo 2 / Groth16 proofs, signatures, anchors, nullifier freshness. For 0-conf, the tool trusts that Zebra validated the tx before mempool admission and that lightwalletd is honest. Hanko additionally verifies proofs and signatures (about 2 s per check to rebuild the verifying key, per Hanko's README), which still leaves anchors and nullifiers trusted. This is the same trust as Kage and well inside the spec's zero-conf risk budget.
9. **Merchant setup:** advertise a payTo UA with an **Orchard receiver** (Orchard-only is fine). Payments then land in Ironwood whatever the wallet (`input_selection.rs:1017-1040`). At startup, run `zdecrypt owns --address <payTo>` and require `ownedByKey: true`. A UIVK sees external-scope payments only, which is all a payer can reach.

## 9. Hanko vs zdecrypt (for the facilitator's choice)

| | Hanko `zpay-verify` (`3c7edae8`) | `zdecrypt` |
|---|---|---|
| crates | pre-release pins (`0.31.0-pre.2`, …), Rust 1.89.0 | stable 0.31.0 line, any Rust ≥ 1.89 |
| network | does its own lightwalletd fetch (tonic), tip, compact-block inclusion check | none, Node fetches |
| 0-conf | yes with `--min-conf 0` (read-source `lib.rs:248,260,339`: parses at tip+1, rejects only when `confirmations < min_conf`) | yes (`--tip`) |
| proofs and signatures | verified (about 2 s VK build per run, README) | not verified |
| recipient | not reported (`Output{pool,value,memo,memo_binary}`) | `recipient`, `receiverHex`, `toPayTo` |
| expiry | not reported | `expiryHeight`, `EXPIRED` |
| built here | the hanko track reports the local build was blocked by the permission classifier | built and tested (this track) |

## 10. Risks and open questions

- A 0-conf deposit is only as good as Zebra's mempool validation plus an honest lightwalletd. A malicious or compromised lightwalletd could fabricate a deposit. This is capped by the spec's W + credit risk.
- Wallet expiry deltas vary in the wild (40 or 120 blocks). A deposit built with a 40-block delta that sits in the mempool expires after about 17 minutes at 25 s blocks. The client should broadcast with enough fee (ZIP 317: 10,000 zat for 2 actions) and the poller must handle expiry.
- Blocks are about 25 s now, not 75 s. The spec's "about 75 s per payment" and "blocks can run minutes apart" now overstate the wait. The trust-ramp demo will see confirmations about every 25–30 s, and ZIP 315's 3-confirmation change wait is about 90 s.
- `ZIP 316 Revision 2`: `zcash_keys 0.17.0` encodes UAs and keys at R2 when they carry expiry metadata (CHANGELOG 0.17.0). `decode` accepts both revisions. If zingo-cli exports R2 strings, they still decode (not tested with a real R2 string).
- Not tested: a real broadcast deposit made by zingo-cli, which is the client track's job, and how quickly a broadcast tx appears in lightwalletd's mempool, which the spec's 15 s retry covers.

## Sources

- Spec: `/Users/oynozan/Desktop/Dev/Web3/z402/docs/spec/mvp-build-doc.md`.
- Kage: https://github.com/nickthelegend/zec-shielded-x402 @ `03307609c87d4c04a1e724282c1d834df47e3252` (2026-10-27). Read `Cargo.toml`, `crates/x402z-facilitator/{Cargo.toml,src/verify.rs,tests/verify_real_tx.rs}`.
- Hanko: https://github.com/nickthelegend/zec-payment-verify-sdk @ `3c7edae895183b8b0dc1daa395cdb2124ffb20ec` (2026-10-26). Read `packages/core/{Cargo.toml,Cargo.lock,README.md,src/lib.rs}`, `packages/sdk/src/zcash.ts`, `fixtures/testnet.json`, `deployments/testnet.json`.
- zingolib: https://github.com/zingolabs/zingolib @ `3fb32d277ef956e75da124c1442526fb4d91d97a` (2026-10-26). Read `Cargo.lock` and `zingolib/src/mocks.rs:559-562`.
- Crate sources: `https://static.crates.io/crates/<name>/<name>-<ver>.crate`, extracted under `…/scratchpad/downloads/decrypt-spike/crates/src/`. Read zcash_protocol 0.11.0, 0.11.0-pre.1 and 0.10.6, zcash_primitives 0.31.0, orchard 0.16.0, zcash_keys 0.17.0, sapling-crypto 0.9.0, zcash_note_encryption 0.5.1, zcash_address 0.14.0, zcash_transparent 0.11.0, zcash_client_backend 0.25.0, zip32 0.3.0 and incrementalmerkletree 0.9.0.
- lightwalletd protos: `…/scratchpad/downloads/protos/{service.proto,compact_formats.proto}` (github.com/zcash/lightwallet-protocol `walletrpc/`).
- Live: testnet.zec.rocks:443 via grpcurl, 2026-10-27, tip 4,547,207 → 4,547,335. Raw captures are in `…/spikes/decrypt-spike/data/`.
- Sibling notes (consistent with this one): `docs/research/kage.md`, `docs/research/hanko.md`.

## Verification corrections

Fact-check by track verify-decrypt-spike, 2026-10-27. I re-downloaded every source independently into `…/scratchpad/downloads/verify-decrypt-spike/`: crates from `static.crates.io`, with sha256 equal to the crates.io index, and a fresh zingolib clone. Live probes ran with grpcurl against testnet.zec.rocks:443 (tip 4,547,411). Raw captures are in `…/scratchpad/spikes/verify-decrypt-spike/live/`.

1. **zingolib: the commit is on `dev`, not `main`.**
   - `3fb32d277ef956e75da124c1442526fb4d91d97a` (2026-10-26T18:56:45-07:00) is the tip of `dev`, the default branch (`git ls-remote --symref https://github.com/zingolabs/zingolib.git HEAD` gives `ref: refs/heads/dev`).
   - `main` is `660938b684f89aef91a091f4e0594d26e4328a48`, last commit 2023-07-29. It is stale.
   - `stable` (`ddb6a6ddfaf35b434f06b0c6f868c68fe0aa9b1f`, 2026-10-27T11:12:47Z) and tag `zingolib_v8.0.0-rc.0` (`755c3ada…`, 2026-10-26) lock the same stable crates as `dev`.
   - Tag `zingolib_v7.0.0` (`bfb0a215…`, 2026-10-15) is the crates.io `zingolib 7.0.0` release. It locks the pre-release line: `zcash_protocol 0.11.0-pre.0`, `zcash_primitives 0.31.0-pre.1`, `zcash_client_backend 0.25.0-pre.1` and `zcash_keys 0.17.0-pre.1`. That line also maps Nu7 to `0x77190AD9` at testnet height 4,465,026 (`zcash_protocol-0.11.0-pre.0/src/consensus.rs:613,846`).
2. **`zingo-cli` is not a crates.io crate.**
   - `GET https://crates.io/api/v1/crates/zingo-cli/versions` returns `crate 'zingo-cli' does not exist`. The 0.4.0 is only the workspace package version (`zingo-cli/Cargo.toml`), so `cargo install zingo-cli` cannot work.
   - The documented build is `git clone https://github.com/zingolabs/zingolib.git && cd zingolib && makers run-cli --build-only`, which needs cargo-make. It produces `target/release/zingo-cli` and `target/release/nym-proxy`. The README says a bare `cargo build -p zingo-cli` never produces `nym-proxy`, "and a CLI that finds no proxy cannot go online".
   - `rust-toolchain.toml` pins `channel = "1.99.0"` (local is 1.99.1). `zingolib/build.rs` downloads the Sapling params during the build.
3. **Real evidence that zingo-cli builds v6 Ironwood deposits (read-source; nothing was built or run).**
   - `zingolib/src/mocks.rs:559-562` is a test `StepBuilder` mock, not the send path.
   - The send path is `LightWallet::create_send_proposal` (`zingolib/src/wallet/propose.rs:71-115`). It calls `zcash_client_backend::data_api::wallet::propose_transfer` with `GreedyInputSelector`, `lock_inputs: None` and `proposed_version: None`.
   - The workspace enables the `zcash_client_backend = "=0.25.0"` features `["orchard","transparent-inputs"]` (`Cargo.toml:74-77`).
   - Change goes to `ShieldedPool::Ironwood` once NU6.3 is active (`propose.rs:58-67`), and pepper-sync scans Ironwood notes (`pepper-sync/src/keys.rs:146`).
   - `Builder::new` takes `TxVersion::suggested_for_branch`, which is `V6` for Nu7 (`zcash_primitives-0.31.0/src/transaction/builder.rs:1020-1030`, `transaction/mod.rs:227`).
4. **zingo-cli broadcasts only over the Nym mixnet.** This holds on `dev`, `stable` and `zingolib_v7.0.0` alike.
   - `zingo-cli/src/lib.rs:1306-1380` starts every Online session with `start_mixnet_session(…, MixnetStartPolicy::ForcedOn)`. The comment there reads: "The mixnet is unconditional for a connected session … a provisioning failure fails closed: the session aborts". The CLI then logs "Send and price-fetch become available once it is ready".
   - The default `TransmitPolicy::Mixnet` refuses to send while the transport is not ready (`zingolib/src/mixnet/route.rs:22-29,94-103`).
   - Nakednet sending exists only in two test builds: `consent_to_nakednet_for_tests`, under `cfg(any(test, feature = "testutils"))`, and a `nakednet-test-mode` build without `nym`, which the README calls "never for ordinary use".
   - **Consequence for the wire contract:** a deposit reaches lightwalletd's mempool only after the mixnet bootstraps and relays it. A one-shot `zingo-cli send` must bootstrap first. The spec's 15 s `/verify` retry is unmeasured for this path, so measure it before fixing that window.
5. **Claim 3 ("judge a mempool tx at tip+1, as zcash_client_backend does") is only partly right.**
   - `decrypt_transaction` uses `mined_height.unwrap_or(chain_tip + 1)` only to compute Sapling `zip212_enforcement` (`zcash_client_backend-0.25.0/src/decrypt.rs:177-189`). It takes an already-parsed `Transaction`, and the crate never calls `Transaction::read`. So it does not choose a parse branch.
   - On testnet ZIP 212 is `On` from 1,028,500 + `ZIP212_GRACE_PERIOD` 32,256 = 1,060,756 (`zcash_primitives-0.31.0/src/transaction/components/sapling.rs:82-95`, `zcash_protocol-0.11.0/src/consensus.rs:755`). At today's heights tip vs tip+1 changes nothing for decryption, and v5/v6 take the branch from the header.
   - Judging at tip+1 does matter for expiry (item 6).
6. **The poller's expiry rule in section 8, step 7 is one block late.** ZIP 203 (`zips/zip-0203.rst`, zcash/zips `main` @ `2bdf39494320e5e04057ac93b1794031ebfb00b5`) says: "If the expiry is at block height N, then the transaction must be included in block N or earlier. Block N+1 will be too late". So an unmined deposit is dead once `tip >= expiryHeight` (that is, `tip + 1 > expiryHeight`), not `tip > expiryHeight`. zdecrypt's own `expired` flag (`heightUsed = tip + 1 > expiryHeight`) is already correct; only the prose in step 7 is wrong.
7. **"All txs v6" (TL;DR 3, section 2) is an observation, not a rule.**
   - `TxVersion::valid_in_branch` accepts V5 and V6 under Nu7 and rejects only V4 (`zcash_primitives-0.31.0/src/transaction/mod.rs:245,253,261`).
   - Live (ran-it): block 4,465,026, the first NU7 block, contains v5 tx `a85b0f6a352b9699d4221a93eeadbab457862c4dec2a3ac7ccd0d2f034fc89ea` (vgid `0x26a7270a`, branch `0x77190ad9`). Its coinbase `98ccf227…b608` is v6 with branch `0x77190ad9`. Both txs in block 4,465,025 carry NU6.3 branch `0x37a5165b`, which also confirms the activation height on the live chain.
   - Recent traffic is all v6: 14 of 14 sampled non-coinbase txs. Over blocks 4,547,351–4,547,410 (60 blocks) there were 90 txs, 187 Ironwood actions, 0 Orchard actions, 0 Sapling spends or outputs, and a mean block interval of 20.7 s.
   - **Facilitator rule:** keep accepting v5. A v5 tx has no Ironwood bundle, so it can pay the merchant only through a Sapling receiver. An Orchard-only `payTo` therefore forces v6 Ironwood deposits.
8. **Claim 2 holds, but NU6.3 has two Orchard-pool rules, not one "turnstile".**
   - The **cross-address restriction**: `enableCrossAddress = 0` is consensus-mandatory for Orchard-pool bundles. The post-NU6.3 circuit enforces it as equal `(g_d, pk_d)` between each action's spent note and output note (`orchard-0.16.0/src/lib.rs:191-201`, `src/circuit.rs:898-939`). Orchard actions are also disallowed in coinbase.
   - The **turnstile**: no value may enter the Orchard pool, and change may return there only if it is strictly less than what the Orchard inputs remove (`zcash_client_backend-0.25.0/src/proposal.rs:116-140`, `src/fees/common.rs:216-225`).
   - Both are consensus rules, so the conclusion does not depend on the wallet: a payment to the merchant's Orchard receiver can arrive only as an Ironwood output.
   - In `zcash_client_backend` the routing is gated on `cfg(feature = "orchard")` and on `is_nu_active(Nu6_3, target_height)` (`src/data_api/wallet.rs:140-145`, `input_selection.rs:1017-1040`). If a non-v6 version is explicitly requested, it returns `OrchardReceiverRequiresIronwood` rather than emitting an Orchard output.
9. **zdecrypt's key detection is fragile (minor).**
   - zingo-cli exports only a UFVK: `export_ufvk` returns JSON `{"ufvk": …}` (`zingo-cli/src/commands.rs:373`).
   - The string comes from `UnifiedFullViewingKey::encode`, which tries ZIP 316 R0 (`uviewtest1…`) and falls back to R2 (`uvftest1…`) (`zcash_keys-0.17.0/src/keys.rs:1280-1305`; HRPs at `zcash_address-0.14.0/src/constants.rs:145,174`).
   - zdecrypt's test ("`uview…` means UFVK, anything else UIVK") would misread an R2 UFVK. Try UFVK decoding first, then UIVK.
   - Run `zdecrypt derive-uivk` once at setup, so the facilitator holds only the incoming key, as the spec intends.

Confirmed unchanged: claim 1. In `zcash_protocol` 0.11.0, Nu7 needs no cfg and maps to `0x77190AD9`; testnet activates it at 4,465,026 (`consensus.rs:601`) and mainnet at 3,543,405 (`:567`). It first appeared in 0.11.0-pre.0, which the CHANGELOG dates 2026-09-30; crates.io shows the publish at 2026-10-01T02:23:57Z UTC.
