# Kage (`zec-shielded-x402`): prior art for the z402 facilitator

Track: kage · Researched 2026-10-27 (11:00–11:55 UTC) · Repo HEAD `03307609c87d4c04a1e724282c1d834df47e3252` (2026-10-27 12:20 +0530)

## TL;DR

1. Kage is a Rust workspace with six crates, plus a zero-dependency TS package. The facilitator, `crates/x402z-facilitator`, is about 1,100 lines of axum. It talks to lightwalletd over tonic gRPC/TLS with only 4 RPCs: `GetLightdInfo`, `GetLatestBlock`, `GetTransaction`, `GetBlock`. It trial-decrypts Sapling, Orchard **and Ironwood** outputs with a UIVK. It speaks **x402 v1** only (`X-PAYMENT`, scheme `zcash-shielded`, network `zcash-testnet`).
2. The reusable core is `lwd.rs` (133 lines) plus `verify.rs` (248 lines). That is the code Hanko's `zpay-verify` was later "extracted from" (Hanko README; Hanko commit `30a9483`). **Kage does not depend on Hanko.** Hanko copied Kage's lwd client and decrypt loop.
3. NU7 facts, confirmed in crate source and live. Testnet NU7 activates at 4,465,026 with branch `0x77190ad9`. Transactions are **v6** (live tx header: version 6, vgid `0xd884b698`). **Orchard is closed to cross-address transfers since NU6.3, so payments land in the Ironwood pool.** A decryptor that checks only `orchard_bundle()` misses every payment. Ironwood notes decrypt with the Orchard IVK, plaintext lead byte `0x03`.
4. Kage pins `=0.11.0-pre.1` / `=0.31.0-pre.2` / `=0.25.0-pre.2` / `=0.17.0-pre.2` and uses no `zcash_unstable` cfg, no git deps and no `[patch]`. **Stable releases came out 2026-10-21** (`zcash_protocol 0.11.0`, `zcash_primitives 0.31.0`, `zcash_client_backend 0.25.0`, `zcash_keys 0.17.0`, MSRV 1.89), one day after Kage pinned. Their changelog says NU7 is "available without `--cfg zcash_unstable="nu7"`". No protoc is needed, since the crate ships generated protos.
5. Live gotchas, all verified. `TxFilter.hash` must be the **byte-reversed** (internal) txid; display order gives gRPC `NotFound`. Testnet averages **about 25 s/block** since NU7 (ZIP 218 ratio 3), not the 75 s that Kage and our spec assume. `GetTransaction` can report a height above `GetLatestBlock`'s tip. One dial out of 8 timed out.
6. Mempool: Kage's code handles 0-conf (lightwalletd height `0` means mempool; parse at tip+1), but **Kage never verified a 0-conf payment live**. Every recorded run waited for 1 confirmation. The facilitator does not retry: unknown txid → `404 not_found`, and the caller retried every 15 s.
7. Gaps for z402. Kage does **not** reject transparent inputs; its own tests fund every tx from a transparent input and those pass. It does **not** read the tx expiry height. Its `valid_nonce` regex `[A-Za-z0-9_-]{1,64}` rejects the z402 memo `<64hex>:<n>`. So **the Kage binary can't be used unmodified**.
8. Recommendation: lift `lwd.rs` plus the decrypt half of `verify.rs` (MIT, credit "Kage © 2026 Nivesh Gajengi") into a ~250-line Rust CLI that prints JSON. Add the transparent check and `expiryHeight`. Spawn it from the TS facilitator with the UIVK in an env var, the same pattern Hanko's SDK uses. Use no napi and no WASM. This path skips Hanko's proof re-verification (Hanko spends ~2 s rebuilding the verifying key per check). The trade-off is that you trust Zebra's mempool and chain validation, as Kage does.
9. Kage Tab (prepaid): one shielded payment buys N RFC 9474 blind-RSA tokens via `POST /tab/issue`, and each token is spent with `X-PAYMENT` scheme `zcash-shielded-tab`. It needs Kage's own client to blind and unblind, so it isn't reusable with a stock x402 v2 client.

---

## 0. Provenance and what I ran

| Item | Value | Source |
|---|---|---|
| Repo | https://github.com/nickthelegend/zec-shielded-x402, MIT, "Copyright (c) 2026 Nivesh Gajengi" | `LICENSE`, `README.md:371` |
| Clone | full history at `scratchpad/downloads/kage/zec-shielded-x402` | `git clone` |
| HEAD | `03307609c87d4c04a1e724282c1d834df47e3252` 2026-10-27 12:20:55 +0530 ("form: the demo video…") | `git log -1` |
| History | 131 commits; first `5b93325` 2026-10-20 04:58 +0530. Authors: nickthelegend (108), Loom Orchestra (19), others. 79 commits co-authored by Claude Opus 5.5 | `git log` |
| Branches | `main`; `verifier-fixes-3` and `-5` merged; `verifier-fixes-4` has 1 unmerged commit `b2f954b` (rate-limit memory bounds, server only) | `git log main..origin/…` |
| Hackathon | Zecathon "Shielded Payments" entry, due 2026-10-28 23:59 UTC | `HACKATHON_SUBMISSION_FORM.md:3` |

I did not build Kage or run its scripts. I did run these:

- `grpcurl` probes against `testnet.zec.rocks:443`, recorded in §5.
- Two mempool watchers: `scratchpad/spikes/kage/mempool_watch*.sh`, logs in `scratchpad/spikes/kage/mempool-out/`.
- crates.io API version listings.
- Downloads of the pinned and the stable crate tarballs. Their sha256 equals the Cargo.lock checksums. Extracted to `scratchpad/downloads/kage/crates/`.
- Raw-file fetches of lightwalletd `c22ca9ba` and Zebra `v7.0.0` sources into `scratchpad/downloads/kage/{lightwalletd,zebra}/`.
- A read-only clone of Hanko into `scratchpad/downloads/kage/hanko-compare/` for the code comparison.

## 1. Architecture

### Components

| Component | Lang / framework | Listens | Job |
|---|---|---|---|
| `crates/x402z-facilitator` (bin + lib) | Rust, axum 0.8, tonic 0.14 | `X402Z_FACILITATOR_BIND`, default `127.0.0.1:4021` (`main.rs:529`) | Merchant side, UIVK only. Fetches the tx from lightwalletd, trial-decrypts it, checks it against the challenge, signs an ed25519 receipt, keeps nonce→txid bindings in SQLite |
| `crates/x402z-server` | Rust, axum | public `127.0.0.1:4020`; admin/dashboard `127.0.0.1:4029` | The paid API (`GET /api/quote`), 402 issuing, `X-PAYMENT` settling through facilitator `/settle`, `POST /api/redeem`, `POST /tab/issue`, QR. Challenge book in SQLite |
| `crates/x402z-protocol` | Rust, serde only | — | x402 v1 wire types, ZIP 321 URIs, Kage Tab types (`src/lib.rs`, 636 lines) |
| `crates/x402z-agent` | Rust, `zcash_client_sqlite` wallet | — | The payer: 402 → spendguard → builds and broadcasts a shielded tx → `X-PAYMENT` until settled. Also the Tab client |
| `crates/x402z-mcp` | Rust | stdio JSON-RPC (MCP `2025-06-18`) | LLM tools `paid_fetch`, `redeem_payment`, `tab_fetch`, `spend_status`, `ledger_tail` |
| `crates/spendguard` | Rust | — | Daily cap, host allowlist, approval threshold; XChaCha20-Poly1305 ledger sealing |
| `packages/x402-zcash` | TypeScript, no deps, Node ≥ 22.18 type-stripping | — | v1 client helpers and an Express/Node `paywall()` middleware that settles through the **Rust** facilitator. No chain code in TS |
| `e2e/`, `landing/` | Playwright, static HTML | — | Browser tests and docs site |

Workspace members: `Cargo.toml:3-10`. Toolchain pinned at `1.89.0` (`rust-toolchain.toml:2`). The comment at `Cargo.toml:24-27` says `[profile.dev.package."*"] opt-level = 3` is there because "Halo2 … proving is unusably slow unoptimized".

### How they talk (README flow, `README.md:19-28`)

```
agent -> GET /api/quote
      <- 402 {x402Version:1, accepts:[{scheme:"zcash-shielded", network:"zcash-testnet", maxAmountRequired, payTo, asset:"ZEC", extra:{memoNonce, expiresAt, paymentUri}}]}
      -> spendguard.check() -> shielded tx from the agent's own wallet (memo = nonce)
      -> GET /api/quote  X-PAYMENT: base64 {x402Version, scheme, network, payload:{txid, memoNonce}}
         server -> facilitator POST /settle (Authorization: Bearer $X402Z_FACILITATOR_TOKEN)
                -> lightwalletd -> trial-decrypt with the merchant UIVK
                -> ed25519 receipt (minedAt) -> server checks signature, burns the nonce (SQLite)
      <- 200 + X-PAYMENT-RESPONSE: base64 {success, transaction, network, payer:""}
```

- Server → facilitator: HTTP JSON, `reqwest`, bearer token (`x402z-server/src/main.rs:624-633`).
- Facilitator → lightwalletd: one long-lived tonic channel made at startup and cloned per request (`x402z-facilitator/src/main.rs:545-548`, `:173`).
- Trust: the server trusts only receipts signed by `X402Z_RECEIPT_PUBKEY` (`server main.rs:659-665`).

### How to run it (from README; not executed here)

```sh
cargo run -p x402z-facilitator -- keygen        # prints X402Z_RECEIPT_SIGNING_KEY / X402Z_RECEIPT_PUBKEY
X402Z_AGENT_WALLET_DIR=./wallets/merchant cargo run -p x402z-agent -- new-wallet   # prints seed, birthday, UA, X402Z_MERCHANT_UIVK
set -a; . ./.env; set +a
cargo build --workspace
target/debug/x402z-facilitator &   # needs X402Z_MERCHANT_UIVK, X402Z_RECEIPT_SIGNING_KEY, X402Z_FACILITATOR_TOKEN (>=32 chars)
target/debug/x402z-server &        # needs X402Z_MERCHANT_UA, X402Z_RECEIPT_PUBKEY, X402Z_FACILITATOR_URL, X402Z_FACILITATOR_TOKEN
target/debug/x402z-agent           # needs X402Z_AGENT_SEED/BIRTHDAY/LEDGER/WALLET_DIR/ALLOWED_HOSTS
```

Sources: `README.md:272-288`, `.env.example:1-93`. Facilitator start-up behaviour (`main.rs:498-565`):

- No `ZCASH_LWD_URL` → it prints a notice and uses `https://testnet.zec.rocks:443`.
- It exits 2 on missing or bad config.
- It exits 1 if lightwalletd is unreachable, or if `GetLightdInfo.chain_name != "test"`.

The demo merchant's UIVK is published on purpose (`README.md:323-325`, `docker-compose.yml:23`): `uivktest1ma9hgu9cmmmkv5f5npk7aktj8tradzqyxzwerez5trhku0xxgx7vsh0azzurz44pfdhmyrzxnur3n282f5t0glhje7kay4fw79njmg64g2wupcznmpfpy0gh6wngu0qw07ry404hnh6rq9vuj264gcjfxucylma4c8cuygxezqx2xwph5x66nckx4095pgvjzuq5rudsmr9dztnyv9f2w74unppttta6cu7fr3tx494zqstn2hv`. Its UA: `utest100fnpp4zd4lp0vmu093gwx6p6ujv8lusunnkvrsuxyaca9avmea5fqgt0ktkvm0sf2wnn8fw7ad034fy9lvsrq0x04vn0jqq7dvnyua5zk9s30v2lcys8pk3mm7xnkdt7fyf65xe0vtnv7sswdflaltg9uesty00c6x2kvgc25ygcrzs` (`docker-compose.yml:8`). Ten mined payments to it make good test vectors (`tests/live_testnet.rs:21-32`).

## 2. Payment verification, exactly as Kage does it

### 2.1 Fetching the transaction (`crates/x402z-facilitator/src/lwd.rs`)

| What | Code | Line |
|---|---|---|
| Default URL | `pub const DEFAULT_LWD_URL: &str = "https://testnet.zec.rocks:443";` | `lwd.rs:11` |
| Connect | `Endpoint::from_shared(url)…connect_timeout(10s).timeout(60s)`; TLS `ClientTlsConfig::new().with_webpki_roots()` when `https://`; eager `connect()`; `max_decoding_message_size(32 MiB)` | `lwd.rs:35-47` |
| Chain tip | `GetLatestBlock(ChainSpec{})` → `BlockId.height` (u64 → u32) | `lwd.rs:62-66` |
| Info | `GetLightdInfo(Empty{})` → chain_name, block_height, vendor, version | `lwd.rs:57-60` |
| Tx | `GetTransaction(TxFilter { block: None, index: 0, hash: txid.as_ref().to_vec() })` | `lwd.rs:97-110` (filter at `:98`) |
| Txid parse | `TxId::from_hex(s.trim())`: parses the **display** (explorer) order and stores protocol order. `as_ref()` returns protocol (internal) bytes | `lwd.rs:121-123`; `zcash_protocol-0.11.0/src/txid.rs:38-41,61-70` |
| Not found | `Ok` with empty `data` → `NotFound`. Also a gRPC `Code::NotFound`, or a message containing `no such mempool or blockchain transaction` / `not found` / `no such transaction` | `lwd.rs:99-118` |
| Block time | `GetBlock(BlockId{height, hash: []})` → `CompactBlock.time` (header time, unix s) | `lwd.rs:126-133` |
| Height semantics | `0 → Mempool`, `u64::MAX → Orphaned` (mined on a non-best fork), else `Mined(h)` | `lwd.rs:70-88` |

There are only these four RPCs. Kage does not use `GetMempoolTx`/`GetMempoolStream`, compact-block scanning, or any explorer API (the explorer `testnet.zecblock.com` is only for human links).

### 2.2 Unconfirmed and mempool handling

- No retry inside the facilitator. `NotFound` → HTTP **404**, `status:"not_found"`, `invalidReason/errorReason:"payment_not_found"`, message `lightwalletd does not know tx … yet (tip …)` (`main.rs:178-187`).
- `Orphaned` → **202** `pending`, "only mined on a fork; wait" (`main.rs:193-195`).
- Mempool (height 0) → `mined = None`. The tx is parsed with `BranchId::for_height(params, tip + 1)` and the Sapling ZIP 212 rule is taken at `tip + 1` (`verify.rs:189-197`, `:224`). Its "paid at" time is `now()` (`main.rs:221`), and it has 0 confirmations.
- Confirmation policy: `X402Z_MIN_CONFIRMATIONS`, default **1** (`main.rs:507-514`). Below it the answer is **202** `pending` with `confirmations`, `minConfirmations` and `chainTip` (`main.rs:235-256`), and nothing is bound. `0` accepts mempool txs; the server then logs a warning (`server main.rs:1221`).
- Retrying is the caller's job. The CLI agent re-sends `X-PAYMENT` every **15 s** (`poll_secs: 15`, `agent pay.rs:136`) for up to `X402Z_AGENT_CONFIRM_TIMEOUT_SECS` (default 900, `pay.rs:135`). It retries on `402 settlement_pending`, 429, 502 and 503 (`pay.rs:817`). The dashboard re-checks every 15 s (`README.md:118`).
- **Kage never exercised 0-conf live.** Every recorded run waited for ≥ 1 confirmation (`TESTING.md` live table; `AUDIT.md` U-084 "No unconfirmed payment was broadcast" = UNTESTED). The mempool path is covered only by an in-process test: mempool parse at `h-1` tip gives 0 conf (`tests/verify_real_tx.rs:182-187`).

### 2.3 Confirmations (`verify.rs:180-185`)

```rust
pub fn confirmations(mined: Option<BlockHeight>, tip: BlockHeight) -> u32 {
    match mined { None => 0, Some(h) => (u32::from(tip).saturating_sub(u32::from(h))).saturating_add(1) }
}
```

The mining block counts as 1. A tip that lags behind the mined height still gives 1 (`tests/verify_real_tx.rs:289-290`). I saw that lag live (§5.4).

### 2.4 Parsing and NU7 (`verify.rs:189-197`)

```rust
let height = mined.unwrap_or(tip + 1);
Transaction::read(data, BranchId::for_height(params, height))
```

Then `tx.txid() != requested` → `TxidMismatch` (`main.rs:199-201`). For v5 and v6 the branch argument is **ignored**. `zcash_primitives` 0.31 reads the branch id from the tx header. An unknown id fails with `invalid consensus branch id 0x77190ad9`, which is the error the stable 0.10.x crates produced (`zcash_primitives-0.31.0/src/transaction/mod.rs:973-986` dispatch, `:1118-1146` v6 body, `:1152-1166` header and error; `docs/build-notes.md:12`). The v6 body order is header, transparent, Sapling (v5 format), Orchard, Ironwood (`mod.rs:1118-1132`).

### 2.5 Trial decryption (`verify.rs:89-137`)

- Key: `UnifiedIncomingViewingKey::decode(&TestNetwork, s.trim())` (`verify.rs:50-52`).
- A UFVK (`uviewtest1…`) is accepted with a warning and reduced to `ufvk.to_unified_incoming_viewing_key()`; the full key is not kept (`verify.rs:44-57`, `main.rs:436-463`).
- `x402z-facilitator derive-uivk` prints the UIVK for the UFVK in `X402Z_MERCHANT_UFVK` (`main.rs:465-478`).
- External scope only. The UIVK has no internal key, so change and outgoing outputs are invisible. A test proves the UIVK sees none of the merchant's own change or outgoing outputs, even with the nonce in every memo (`tests/verify_real_tx.rs:319-355`).

```rust
// Sapling
if let (Some(b), Some(ivk)) = (tx.sapling_bundle(), uivk.sapling()) {
    let d = SaplingDomain::new(zip212_enforcement(params, height));
    let p = ivk.prepare();
    for o in b.shielded_outputs() { if let Some((note, addr, memo)) = try_note_decryption(&d, &p, o) { … } }
}
// Orchard and Ironwood share the Orchard IVK; only the domain version differs
if let Some(ivk) = uivk.orchard() {
    if let Some(b) = tx.orchard_bundle()  { orchard_family::<OrchardVersion>(ShieldedPool::Orchard,  ivk, b, &mut out); }
    if let Some(b) = tx.ironwood_bundle() { orchard_family::<IronwoodVersion>(ShieldedPool::Ironwood, ivk, b, &mut out); }
}
// orchard_family: p = PreparedIncomingViewingKey::new(ivk); for a in bundle.actions():
//   d = NoteEncryptionDomain::<V>::for_action(a); try_note_decryption(&d, &p, a) -> (note, addr, memo)
```

- `IronwoodVersion` accepts note plaintext lead byte `0x03` and `OrchardVersion` accepts `0x02`. Everything else is identical (`orchard-0.16.0/src/note_encryption.rs:128-146, 213-219`).
- Each decrypted output gives `IncomingOutput { pool, value_zat, memo: [u8;512], recipient }` (`verify.rs:64-79`).
- `try_note_decryption` (zcash_note_encryption 0.5.1) checks the note commitment, so a forged ciphertext that claims a value the commitment doesn't hold is rejected. This is why pure-TS decryption without Sinsemilla/commitment checks would be unsafe (inferred from how the crate works).
- No proof or signature verification and no block-inclusion check. Kage trusts lightwalletd/Zebra for tx validity. Hanko added both (`hanko-compare/…/packages/core/src/lib.rs:235-275`).

### 2.6 Amount, recipient, memo and transparent checks (`verify.rs:202-248`)

1. **payTo**: `Address::decode(params, &pay_to)` must be `Address::Unified`. It needs at least one of Sapling/Orchard and **no transparent receiver**, else `BadPayTo` (`verify.rs:210-218`). Before that, `validate_shape` requires the `utest1` prefix and length ≥ 20 (`x402z-protocol/src/lib.rs:56-73`). An optional `X402Z_MERCHANT_UA` refuses any other payTo (`main.rs:149-153`).
2. **Memo**: `memo_text()` is `MemoBytes::from_bytes` → `Memo::try_from` → only `Memo::Text`. It must equal `memoNonce` **exactly** (`verify.rs:82-87`, `:225`). A non-text memo is never credited (audit `audit_non_text_memo_is_never_credited`).
3. **Recipient**: the decrypted note address must **equal** payTo's receiver for that pool. Sapling note → `ua.sapling()`; Orchard and Ironwood → `ua.orchard()`, since Ironwood shares the Orchard receiver (`verify.rs:229-232`). A sibling diversified address of the same wallet → `WrongRecipient` (`tests/verify_real_tx.rs:230-233`).
4. **Amount**: the sum over all matching outputs, across pools, must be ≥ `amount_zat`. Overpaying is fine; short gives `Underpaid {paid, want}` (`verify.rs:233-246`; split-pool test `verify_real_tx.rs:197-204`).
5. **Errors**: no matching output gives `NoMatchingOutput`, or `WrongRecipient` if the memo matched (`verify.rs:241-243`).
6. **Transparent**: transparent outputs are never counted and never top up a short payment (`verify_real_tx.rs:309-315`). **Transparent inputs are not rejected.** `build_tx` funds every test tx from a transparent P2PKH input and those txs verify (`verify_real_tx.rs:90-111`, `:175-205`). z402's "no transparent part" rule must be **added**. Hanko's check: `tx.transparent_bundle().is_some_and(|b| !b.vin.is_empty() || !b.vout.is_empty())` (Hanko `lib.rs:261`; `zcash_transparent-0.11.0/src/bundle.rs:81-85` has `pub vin`/`pub vout`).

### 2.7 Replay protection

- Facilitator: SQLite table `bindings(nonce, pay_to, amount_zat, txid, issued_at)` with PRIMARY KEY `(nonce, pay_to, amount_zat)` (`store.rs:26-42`). `/settle` binds the first txid. A second txid for the same requirement → **422** `nonce_already_used`. Re-settling the same pair is allowed (`store.rs:71-82`, `main.rs:158-171`, `:283-294`).
- Keying on the whole requirement is deliberate: a 1-zat tx carrying an open nonce, settled at amount 1, can't lock out the real payment (`store.rs:1-7`, test `:115-126`).
- `/verify` is read-only and binds nothing (`main.rs:267-282`).
- Server: the challenge row is burned once (`mark_spent`, `server main.rs:316-326`). The same `(memoNonce, txid)` gets a 200 again within `X402Z_RESEND_WINDOW_SECS` (default 600) (`server main.rs:607-612`).
- There is no global "txid already credited" set. Uniqueness comes from the per-challenge nonce in the memo. For z402 the equivalent is a global `txid → (sessionKey, depositIndex)` map plus the memo binding.

### 2.8 Expiry

- A challenge lives 15 min (`CHALLENGE_TTL_SECS`, `server main.rs:51`; `maxTimeoutSeconds: 900`). The 402 carries `extra.expiresAt` (unix s) (`server main.rs:357-364`).
- Expiry is judged by the **mined block's header time** from `GetBlock`, which goes into the receipt as `minedAt`. A payment counts if `minedAt <= expiresAt + X402Z_EXPIRY_GRACE_SECS` (default 1200 s) (`main.rs:212-234`; `protocol lib.rs:91-97`).
- A mempool payment uses `now()` (`main.rs:221`).
- Unredeemed challenges are kept for `X402Z_REDEEM_WINDOW_SECS` (default 24 h) (`README.md:120-124`).
- **Tx expiry height is never read.** For z402's poller: `tx.expiry_height()` exists via `Deref` to `TransactionData` (`zcash_primitives-0.31.0/src/transaction/mod.rs:323, 641`). Default expiry delta is **120 blocks** from NU7 in stable `zcash_primitives 0.31.0`. It was **40** in `0.31.0-pre.2`, the version Kage pins (`builder.rs:61-69` stable vs `pre.2 builder.rs:53`). The real delta in a zingo-cli deposit depends on zingo's librustzcash version (open question).

## 3. Dependencies (exact)

Workspace `Cargo.toml` (`:17-22`): `serde 1` with derive, `serde_json 1`. Facilitator `crates/x402z-facilitator/Cargo.toml:15-46`:

| Crate | Requirement | Features | Cargo.lock version | Lock checksum (prefix) |
|---|---|---|---|---|
| zcash_client_backend | `=0.25.0-pre.2` | `lightwalletd-tonic`, `orchard` | 0.25.0-pre.2 | `fdac709d1ea4a802` |
| zcash_keys | `=0.17.0-pre.2` | `orchard`, `sapling` | 0.17.0-pre.2 | `0d5caff2ce11d394` |
| zcash_primitives | `=0.31.0-pre.2` | — | 0.31.0-pre.2 | `5f51d0187f228671` |
| zcash_protocol | `=0.11.0-pre.1` | — | 0.11.0-pre.1 | `b92a9bf4c5aaac45` |
| orchard | `0.16` | — | 0.16.0 | `4ae7ceb7b5387bd7` |
| sapling-crypto (as `sapling`) | `0.9` | — | 0.9.0 | `4a2cbdcfeef20006` |
| zcash_note_encryption | `0.5` | — | 0.5.1 | `4812d133908ebf1a` |
| tonic | `0.14` | `transport`, `tls-ring`, `tls-webpki-roots` | 0.14.6 | `ac2a5518c70fa843` |
| tokio | `1` | rt-multi-thread, macros, net, sync, time | 1.54.0 | — |
| axum | `0.8` | — | 0.8.9 | — |
| ed25519-dalek | `2` (`rand_core`) | — | 2.2.0 | — |
| rusqlite | `0.37` | `bundled` | 0.37.0 | — |
| hex 0.4, base64 0.22, rand 0.8 | | | | |
| dev: zcash_transparent `=0.11.0-pre.2` and zcash_primitives with `transparent-inputs`, `test-dependencies`; secp256k1 0.33; zip32 0.3; rand 0.10 | | | | |

Transitive versions in the lock: `zcash_address 0.14.0-pre.2`, `zcash_transparent 0.11.0-pre.2`, `zip321 0.10.0-pre.2`, `zcash_spec 0.2.1`, `zcash_encoding 0.5.0`, `halo2_proofs 0.4.0`, `halo2_gadgets 0.6.0`, `pasta_curves 0.6.1`, `incrementalmerkletree 0.9.0`, `shardtree 0.8.0`, `prost 0.14.4`, `zip32 0.3.0`.

- **No** `source = "git"` entries, **no** `[patch]` and **no** `.cargo/config`.
- **No `zcash_unstable` cfg or RUSTFLAGS anywhere**: grep over the repo, `ci.yml` and `Dockerfile`.
- The pinned crates' `check-cfg` lists only `zcash_unstable` values `"nutachyon"` and `"zip233"` (`zcash_protocol-0.11.0-pre.1/Cargo.toml:100-107`).
- I downloaded every pinned tarball; its sha256 matches the lock.

What Kage says about NU7:

- "NU7 activated on testnet at height 4465026 (branch id 0x77190AD9), and zcash_protocol 0.11.0-pre.* is the first release that knows it. The stable 0.10.6/0.30/0.24 line cannot parse current testnet transactions." (`crates/x402z-facilitator/Cargo.toml:19-21`)
- The stable crates reject every current testnet tx with `invalid consensus branch id 0x77190ad9`. These crates need Rust ≥ 1.88, so the toolchain is 1.89.0 (`docs/build-notes.md:9-14`).
- "The crates trial-decrypt Ironwood bundles with the Orchard viewing key, and a UA's Orchard receiver also receives in Ironwood. The agent sends change to Ironwood." (`docs/build-notes.md:18`). The agent pays with `propose_standard_transfer_to_address(…, ShieldedPool::Ironwood, …)` (`x402z-agent/src/wallet.rs:176-189`). Early notes say "Orchard is sealed and Ironwood/NU6.3 is live" (commit `4b75770` diff of README).

What the crate source says, on stable and pre-release alike:

- Testnet: NU6.1 3,536,500; NU6.2 4,052,000; NU6.3 4,134,000; **NU7 4,465,026** (`zcash_protocol-0.11.0/src/consensus.rs:601`).
- Mainnet: NU6.3 3,428,143. NU7 is `None` in pre.1 and **3,543,405** in stable 0.11.0 (`consensus.rs:567`; CHANGELOG "This release sets the NU7 mainnet activation height to 3543405").
- `0x7719_0ad9 => BranchId::Nu7` (`consensus.rs:909`).
- `OrchardProtocolRevision::V3`, used from NU6.3 onward: "introduces the Ironwood value pool … cross-address transfers are prohibited for the Orchard value pool and permitted for the Ironwood value pool" (`consensus.rs:1094-1097`). NU7 maps to V3.
- NU7 `has_sprout() == false`; Sapling and Orchard true.
- `NU7_POW_TARGET_SPACING_RATIO = 3`: 75 s → **25 s** block spacing (ZIP 218) (`consensus.rs:43-50`).
- `zcash_primitives 0.31.0` CHANGELOG: "`BranchId::Nu7` is available without a custom compiler configuration … `TxVersion::suggested_for_branch` returns `TxVersion::V6` … `valid_in_branch` accepts V5 and V6 … not V4 under it (ZIP 2003)". Builders are "V6 (NU6.3 onward)" (0.30.0 notes).
- `zcash_protocol 0.11.0` CHANGELOG: "`{NetworkUpgrade::Nu7, BranchId::Nu7}` … now available without the `--cfg zcash_unstable="nu7"` configuration flag". So `zcash_unstable="nu7"` belonged to the old 0.10.x line. On 0.11.x it is not needed.

**Stable releases now exist** (crates.io API, 2026-10-27):

| Crate | Kage pin | Stable now | Date | MSRV |
|---|---|---|---|---|
| zcash_protocol | 0.11.0-pre.1 | **0.11.0** | 2026-10-21 | 1.89 |
| zcash_primitives | 0.31.0-pre.2 | **0.31.0** | 2026-10-21 | 1.89 |
| zcash_client_backend | 0.25.0-pre.2 | **0.25.0** | 2026-10-21 | 1.89 |
| zcash_keys | 0.17.0-pre.2 | **0.17.0** | 2026-10-21 | 1.89 |
| zcash_transparent | 0.11.0-pre.2 | **0.11.0** | 2026-10-21 | 1.89 |
| zcash_address / zip321 | 0.14.0-pre.2 / 0.10.0-pre.2 | 0.14.0 / 0.10.0 | 2026-10-21 | 1.89 |
| orchard / sapling-crypto / zcash_note_encryption | 0.16.0 / 0.9.0 / 0.5.1 | same (already stable) | 2026-09-30 | 1.88 |

Pre-release vs stable source diffs:

- **primitives**: only `transaction/{builder,mod,sighash*,txid,tests}.rs`. These are the `TxDigests` → `Zip143Digests`/`Zip244Digests` enum split, the expiry-delta change and the sighash API. `Transaction::read`, `txid()` and `{sapling,orchard,ironwood,transparent}_bundle()` are unchanged in signature.
- **protocol**: `consensus.rs` (mainnet NU7 height, spacing helpers) and `zip318.rs`.
- **keys**: tests only in `keys.rs`.

So Kage's `verify.rs`/`lwd.rs` should compile on stable unchanged. That is inferred, not compiled.

Consequences for z402:

- Pin the stable set `=0.11.0 / =0.31.0 / =0.25.0 / =0.17.0`, or Kage's exact pre-release set with `--locked` if you copy its `Cargo.lock` (proven live by Kage).
- Our cargo 1.99.1 satisfies MSRV 1.89. **Don't copy `rust-toolchain.toml`**: it would force rustup to install 1.89.0.

protoc: `zcash_client_backend-0.25.0/build.rs:20-41` regenerates protos only if `proto/compact_formats.proto` exists **and** protoc is found. Released crates don't ship the proto dir; they ship `src/proto/{compact_formats,service,proposal}.rs`. So protoc isn't needed, and Kage's CI installs none (`.github/workflows/ci.yml`). The Dockerfile's `protobuf-compiler` install (`Dockerfile:8`) is unnecessary.

## 4. Kage's x402 wire format (v1)

Per `README.md:98-107`, `docs/spec-shielded-x402-agents.md`, and `crates/x402z-protocol/src/lib.rs:165-351`. Kage follows coinbase/x402 `specs/x402-specification-v1.md` and `transports-v1/http.md`, "read 2026-10-21". It does not implement v2 (`README.md:100`). The TS package says "The x402 v2 header names are not implemented" (`packages/x402-zcash/README.md:28`).

| Item | Value | Source |
|---|---|---|
| x402Version | `1` (anything else → `invalid_x402_version`) | `lib.rs:189`; `main.rs:320-322` |
| scheme / network / asset | `"zcash-shielded"` / `"zcash-testnet"` / `"ZEC"`; Tab: `"zcash-shielded-tab"` | `lib.rs:6, 193-194, 549` |
| Headers | request `X-PAYMENT` (base64 JSON); response `X-PAYMENT-RESPONSE` (base64 JSON); legacy `X-PAYMENT-RECEIPT`; human text in `x-payment-error` | `lib.rs:7, 190-191`; `server main.rs:451` |
| base64 | encode standard padded; decode accepts standard, URL-safe, padded or not | `lib.rs:390-404` |

402 body (`PaymentRequiredResponse`, `lib.rs:240-244`), with a live example from `audit/results-live.md`:

```json
{ "x402Version": 1,
  "accepts": [{
    "scheme": "zcash-shielded", "network": "zcash-testnet",
    "maxAmountRequired": "100000",
    "resource": "https://kage-api.201-18-198-162.sslip.io/api/quote",
    "description": "Kage demo quote: paid content unlocked by a shielded Zcash testnet payment",
    "mimeType": "application/json",
    "payTo": "utest100fnpp4…crzs",
    "maxTimeoutSeconds": 900,
    "asset": "ZEC",
    "extra": { "memoNonce": "x402z-2407a3245422986693ef9238", "expiresAt": 1792969902,
               "paymentUri": "zcash:utest100fnpp4…?amount=0.001&memo=eDQwMnotMjQwN2EzMjQ1NDIyOTg2NjkzZWY5MjM4",
               "tab": { "…": "see 4.3" } } }],
  "error": "X-PAYMENT header is required" }
```

- `memoNonce` is `x402z-` plus 24 hex characters (12 random bytes) (`server main.rs:355-362`).
- `valid_nonce` requires 1–64 characters of `[A-Za-z0-9_-]` (`lib.rs:78-80`).
- `valid_txid` requires exactly 64 hex digits (`lib.rs:83-85`).
- `paymentUri` follows ZIP 321: `zcash:<ua>?amount=<decimal ZEC, ≤8 dp, no trailing zeros>&memo=<base64url(memo text), no padding>` (`lib.rs:523-542`). librustzcash's parser round-trips it (`tests/zip321_uri.rs`).

`X-PAYMENT` payload (`PaymentPayload`/`ZcashPayload`, `lib.rs:249-264`):

```json
{"x402Version":1,"scheme":"zcash-shielded","network":"zcash-testnet","payload":{"txid":"<64 hex display order>","memoNonce":"x402z-…"}}
```

`X-PAYMENT-RESPONSE` (`SettlementResponse`, `lib.rs:269-278`): `{"success":true,"transaction":"<txid>","network":"zcash-testnet","payer":""}`. On failure it is `{"success":false,"errorReason":"settlement_pending|invalid_payment|payment_expired|nonce_already_used|unknown_challenge|invalid_payload|invalid_network|invalid_scheme|facilitator_error","transaction":"",…}` (`lib.rs:336-351`). `payer` is always `""`.

Settlement outcomes at the server (spec §6):

| Outcome | Status | Challenge |
|---|---|---|
| Paid | 200 | — |
| Pending | 402 | the **same** challenge, `settlement_pending` |
| Refused | 402 | a fresh challenge |
| Facilitator down | 502 | nothing burned |

### 4.1 Facilitator API

Source: `crates/x402z-facilitator/src/main.rs`.

| Endpoint | Auth | Request | Response |
|---|---|---|---|
| `GET /supported` | none | — | `{"kinds":[{"x402Version":1,"scheme":"zcash-shielded","network":"zcash-testnet"}]}` (`:395-399`, test `:701-708`) |
| `POST /verify` (x402) | `Authorization: Bearer <X402Z_FACILITATOR_TOKEN>`, ≥ 32 chars, constant-time compare; 401 + `WWW-Authenticate: Bearer` otherwise (`:105-121`) | `{"x402Version":1,"paymentPayload":{…},"paymentRequirements":{…}}`; payload `memoNonce` must equal `requirements.extra.memoNonce` (`:317-329`) | read-only `{"isValid":bool,"invalidReason"?:string,"payer":"","status":"confirmed|pending|not_found|rejected|error","error"?:string}` (`:338-356`; `lib.rs:312-320`) |
| `POST /verify` (legacy) | bearer | `{"challenge":{scheme,network:"testnet",payTo,amountZat,memoNonce,expiresAt},"txid":"…"}` (detected by the absence of `paymentPayload`, `:331-333`) | `VerifyResponse {status, receipt?, claims?, confirmations?, minConfirmations?, chainTip?, error?}` **with a receipt and a binding** (`:357-365`; `lib.rs:148-163`) |
| `POST /settle` | bearer | same as x402 `/verify` | flattened `SettlementResponse` plus `{status, receipt?, claims?, confirmations?, minConfirmations?, error?}` (`:370-392`; `lib.rs:293-307`) |
| `GET /health` | none | — | `{"ok":true,"network":"testnet","lightwalletd":url,"chainTip":n,"minConfirmations":n,"viewingKey":"uivk","receiptPubkey":hex}`, or 503; the probe is cached 5 s (`:99, 401-433`) |

HTTP status codes are **not** always 200:

| Status | Meaning |
|---|---|
| 200 | confirmed |
| 202 | pending or orphaned |
| 400 | bad body or txid |
| 404 | not found |
| 422 | rejected |
| 502 | lightwalletd failed |
| 503 | DB error |

Source: `VerifyStatus` docs, `lib.rs:130-143`. A z402 facilitator behind `@x402/core`'s HTTP facilitator client should check what status codes that client expects; this is not checked here.

Receipt (`receipt.rs:20-24`) is `base64url_nopad(claims_json) "." base64url_nopad(ed25519_sig(claims_json))`. Claims: `{memoNonce, amountZat, payTo, txid, confirmations, issuedAt, minedAt?}` (`lib.rs:104-116`). In TS it is verified with SPKI prefix `302a300506032b6570032100` + the 32-byte key (`packages/x402-zcash/src/index.ts:289-296`).

### 4.2 Env vars (facilitator)

| Var | Meaning | Source |
|---|---|---|
| `ZCASH_LWD_URL` | lightwalletd URL | `main.rs:498` |
| `X402Z_MERCHANT_UIVK` / `X402Z_MERCHANT_UFVK` | merchant key; exactly one | `main.rs:436` |
| `X402Z_RECEIPT_SIGNING_KEY` | 64 hex | |
| `X402Z_MIN_CONFIRMATIONS` | default 1 | |
| `X402Z_MERCHANT_UA` | optional payTo lock | |
| `X402Z_EXPIRY_GRACE_SECS` | default 1200 | |
| `X402Z_FACILITATOR_DB` | default `x402z-facilitator.sqlite` | |
| `X402Z_FACILITATOR_BIND` | bind address | |
| `X402Z_FACILITATOR_TOKEN` | required, ≥ 32 chars | |

### 4.3 Kage Tab, the prepaid-token feature (issue and validate flow)

1. **Offer** in `extra.tab` (`TabOffer`, `lib.rs:558-573`; built by `server tab.rs:92-104`):
   - Fields: `{scheme:"zcash-shielded-tab", suite:"RSABSSA-SHA384-PSS-Randomized", keyId, publicKey (base64 DER SPKI, RSA-2048), unitPriceZat, maxTokens (default 20), issuePath:"/tab/issue", epochEndsAt, graceSecs (default 1800)}`.
   - `keyId` = hex of the first 8 bytes of SHA-256(SPKI) (`tab.rs:44-46`).
   - Epoch is 7 days (`tab.rs:29-34`).
2. **Buy**: pay `n × unitPriceZat` to the challenge's payTo with memo = `memoNonce`. Blind n random 32-byte messages; the client does `pk.blind(...)` (`agent tab.rs:302-304`). Then `POST /tab/issue {memoNonce, txid, keyId, blinded:[base64 × n]}` (`TabIssueRequest`, `lib.rs:578-583`). Each blinded message must be 256 bytes (`tab.rs:148-159`).
3. **Issue** (`server main.rs:813-897`):
   1. Key check: previous key in grace, or **409** `tab_key_rotated` with `activeKeyId`, nothing burned.
   2. `1 ≤ n ≤ maxTokens`.
   3. Rate limit.
   4. `confirmed_receipt` → facilitator `/settle` (`Resend::Refused`). Pending gives **202** `{status:"pending"}`.
   5. `check_receipt`.
   6. `n ≤ amountZat / price`; otherwise 422 `invalid_payment`, nothing burned.
   7. `store.spend_for_tab` burns the nonce once; a repeat gives 422 `nonce_already_used`.
   8. `blind_sign_all` → `{keyId, blindSignatures:[base64]}` (`TabIssueResponse`, `lib.rs:588-591`).
4. **Unblind** with `pk.finalize(&bs, br, msg)` on the client (`agent tab.rs:392`).
5. **Spend**: `X-PAYMENT` = base64 `{x402Version:1, scheme:"zcash-shielded-tab", network:"zcash-testnet", payload:{keyId, msg, randomizer, sig}}` (`TabPayload`, `lib.rs:596-602`).
   - The server verifies the signature with `MessageRandomizer`, then records the token id `hex(SHA-256(randomizer‖msg))` in a SQLite spent set (`tab.rs:107-112, 162-178`).
   - It answers 200 with `X-PAYMENT-RESPONSE.transaction = "tab:<first 16 hex of token id>"` (`server main.rs:792-801`).
   - Double spend → 402 `nonce_already_used`. Another epoch → `payment_expired`.
6. Live results: tabs `fa011720…`, `d3bf0b49…`, `b75b2415…`; per-token requests took 0–27 ms (`docs/tab-live-run.txt`).

This is not reusable for z402. It needs a custom client that blinds and unblinds, so it can't work with a stock `wrapFetchWithPayment`. The z402 voucher plus trust ramp replaces it.

## 5. Gotchas (✔ = verified live by me today)

1. ✔ **Txid byte order.** `GetTransaction` with `hash` = reversed display bytes (`KuLUcX1f…` for `f037d597…e22a`) returned height 4529425 and 9,166 bytes. Display-order bytes returned `ERROR: Code: NotFound Message: GetTransaction: getrawtransaction 2ae2d4717d5f…37f0 failed: -5: Transaction not found in mempool or best chain`. lightwalletd reverses the bytes itself: `hash32.Reverse(hash32.FromSlice(txf.Hash))` (`lightwalletd@c22ca9ba frontend/service.go:518-519`). `CompactTx.txid` is also protocol order (`compact_formats.proto:56-61`). Display hex is `zcash_protocol::TxId::from_hex`/`Display`.
2. ✔ **Every node error becomes `NotFound`.** lightwalletd maps *any* `getrawtransaction` RPC error to `codes.NotFound` (`service.go:527-532`). A Zebra hiccup is therefore indistinguishable from "not yet in mempool". Treat NotFound as retryable within the 15 s window.
3. **Mempool height semantics** (read-source; corroborated by hanko.md's live mempool check: `height:null, confirmations:0`).
   - Zebra v7.0.0 `getrawtransaction` checks the mempool first and serializes `height` as `None` (skipped) for a mempool tx, `-1` for a side chain (`zebra-rpc/src/methods.rs:2114-2140`; `methods/types/transaction.rs:313-317`).
   - lightwalletd parses `Height int64` → `uint64`, so mempool → `0` and side chain → `0xffffffffffffffff` (`common/common.go:172-175, 953-969`).
   - That matches Kage's mapping. lightwalletd adds no cache on `GetTransaction`, which proxies straight to the node. Only `GetMempoolTx`/`GetMempoolStream` use a mempool cache, refreshed at most every 2 s (`common/mempool.go:56, 105-152`).
4. **Visibility right after broadcast** (read-source). Zebra's `sendrawtransaction` awaits the mempool verification result before returning (`methods.rs:1509-1562`, `.await` at `:1552`). Once lightwalletd's `SendTransaction` returns `errorCode 0`, the tx is already in that node's mempool. A delay is still possible if the payer broadcast through a different lightwalletd or node (gossip), or if zingo-cli failed but the tx went out anyway (item 9). `testnet.zec.rocks` resolves to a single anycast IP `66.241.124.102` / `2a09:8280:1::32:da2a:0` (Fly.io range); I can't tell whether it is load-balanced. Use the same lightwalletd for the client and the facilitator.
5. ✔ **Block time is about 25 s now.** Measured:

   | Blocks | Seconds | Per block | Note |
   |---|---|---|---|
   | 4546230–4547230 | 25,814 | 25 s | |
   | last 100 | 2,896 | 28 s | |
   | 4465026–4466026 | | 27 s | after NU7 |
   | 4464026–4465026 | 3,922 | 3.9 s | just before NU7 (testnet oddity) |

   Kage's docs and the z402 spec say "about 75 s". Plan the poller and demo timings for ~25 s blocks, with jitter (`GetBlock.time`). This follows from ZIP 218 `NU7_POW_TARGET_SPACING_RATIO = 3`.
6. ✔ **Tip can lag the tx height.** A tx listed by `GetMempoolTx` at lwd tip 4547232 came back from `GetTransaction` with `height 4547233` while `GetLatestBlock` still said 4547232 (`scratchpad/spikes/kage/mempool-out/watch.log`). Compute confirmations with Kage's saturating formula; a "negative" value counts as 1.
7. ✔ **The mempool is often empty.** Over ~33 minutes of 1 s polling only one other tx appeared. Expect your deposits to be the only mempool traffic.
8. ✔ **Transient dial failure.** One `GetLightdInfo` in 8 failed with `Failed to dial target host "testnet.zec.rocks:443": context deadline exceeded`. Retry connects. Kage connects once at startup and exits 1 on failure (`main.rs:545-548`).
9. **zingo-cli** (Kage `docs/tab-live-run.txt:17-21`): "`zingo-cli quicksend` … exited 1 with `Error: Send error. caused by: Transmission error.` but the transaction had reached the network". The client must not blindly re-send a deposit, and the facilitator must tolerate two deposits with consecutive indexes. Kage records no zingo-cli version. It used zingo-cli only as an external payer; Kage's agent wallet is `zcash_client_sqlite` (`docs/build-notes.md:24`).
10. **Faucet.** `testnet.zecfaucet.com` didn't resolve on 2026-10-20. The Valar faucet https://faucet.testnet.valargroup.dev/ worked, giving **0.125 TAZ per IP per day** (`docs/build-notes.md:23`). Check the live state before relying on it.
11. **Fees.** A one-recipient shielded tx paid 10,000 zat (ZIP 317, 2 logical actions × 5,000) (`agent wallet.rs:38-40`; `README.md:309`). Live Ironwood payments are 9,166-byte v6 txs with 2 Ironwood actions (`f037d597`, `592aefbd`).
12. **Sapling params.** The agent's first payment downloads ~50 MB. A truncated download fails its hash check: "5,982,770 of 47,958,396 bytes", fixed by deleting and retrying (`docs/build-notes.md:26-28`). The facilitator never needs the params.
13. **Pools.** All ten of Kage's live payments are Ironwood (`live_testnet.rs:71`, `assert_eq!(p.pools, vec![ShieldedPool::Ironwood])`). Build-time evidence: `BuildConfig::Standard { orchard_anchor: None, ironwood_anchor: Some(...) }` (`verify_real_tx.rs:99-106`). There are no new Orchard outputs to other addresses.
14. **payTo from the UIVK.**

    ```rust
    uivk.default_address(UnifiedAddressRequest::unsafe_custom(Require /*orchard*/, Require /*sapling*/, Omit /*p2pkh*/))
    ```

    This gives the shielded-only UA the key can see (`check_uivk.rs:45-54`; argument order from `zcash_keys-0.17.0/src/keys.rs:740-746`). A wallet UA with a transparent receiver is rejected (`BadPayTo`). With Kage's exact-recipient rule, a payment to a different diversified address of the same wallet gives `WrongRecipient`.
15. **Decryption time is not recorded** anywhere in Kage (no timing in logs or audit JSON). Kage's checks don't verify proofs, so cost is dominated by 2–3 TLS gRPC round trips: `GetLatestBlock`, `GetTransaction`, plus `GetBlock` when mined (inferred). Hanko adds ~2 s of Halo2 verifying-key building per process (hanko.md TL;DR 7).
16. **NotFound shapes**: "lightwalletd and Zaino both report an unknown txid as an RPC error rather than an empty result" (`lwd.rs:95-96`). I verified the lightwalletd shape; Zaino is untested.
17. **Live server info**:
    - lightwalletd `v0.5.4`, gitCommit `c22ca9ba67676e61cd8ee107538ffd9a77799bab`
    - zcashdBuild `v7.0.0+git.e8db87e`, subversion `/Zebra:7.0.0/`
    - consensusBranchId `77190ad9`, chain `test`
    - tip about 4,547,318 at 11:46 UTC
    - The README says no official doc lists this server (`docs/build-notes.md:22`).

## 6. Reuse plan

### 6.1 Kage and Hanko

- Kage has **no dependency** on Hanko: no reference in the tree or in `git log -S` history.
- Hanko depends on Kage's *code*. Hanko commit `30a9483` (2026-10-20 21:27 +0530) reads "core: zpay-verify crate and CLI (extracted from x402's check_uivk)". Hanko `README.md:20` and `HACKATHON_SUBMISSION_FORM.md:49` say "The decryption core is extracted from zec-shielded-x402's `check_uivk` (same author)". Hanko's `Cargo.toml:18` says "Same pre-release line as zec-shielded-x402".
- 46 normalized lines are identical between Kage `lwd.rs`+`verify.rs` and Hanko `packages/core/src/*.rs`. They include the doc comments, `is_not_found`, `TxFilter { block: None, index: 0, hash: txid.as_ref().to_vec() }` and the `orchard_family` body.
- Both are MIT, © 2026 Nivesh Gajengi, and pin identical crates.

What Hanko adds over Kage:

- Proof and signature verification (`auth.rs`).
- A block-inclusion check.
- The transparent-part check.
- SOCKS5 support.
- A JSON CLI.

What Kage has that Hanko lacks:

- An exact-recipient (diversified address) check.
- Mined-time expiry.
- Replay bindings.
- The x402 HTTP shell.

### 6.2 What to lift (with attribution)

| From Kage | Lines | Lift as | Changes for z402 |
|---|---|---|---|
| `crates/x402z-facilitator/src/lwd.rs` | 1-133 (whole file) | `lwd.rs` | Add connect retry; keep everything else (TLS, 32 MiB limit, NotFound mapping, height sentinels, `block_time`) |
| `crates/x402z-facilitator/src/verify.rs` | 16-137 (`MerchantKey`, `IncomingOutput`, `Recipient`, `memo_text`, `orchard_family`, `incoming_outputs`), 179-197 (`confirmations`, `parse_tx`) | `decrypt.rs` | none |
| `verify.rs` | 202-248 (`verify_payment`) | rewrite as `check_deposit` | memo = `"<sessionKeyHex>:<depositIndex>"` (any text, no nonce regex); amount ≥ `windowZat`; keep the payTo shielded-only and exact-recipient checks; **add** `transparent_bundle()` vin/vout empty; **add** `expiry_height` |
| `examples/check_uivk.rs` | 1-108 | model for the CLI | `address <uivk>` mode derives payTo; `derive` turns UFVK→UIVK |
| `tests/live_testnet.rs` | 14-32 | test vectors | 10 mined Ironwood payments + published UIVK; good for CI of the CLI |
| `tests/verify_real_tx.rs` | 90-153 (`build_tx` with real Halo2 proofs) | optional | in-process mempool/transparent/recipient tests without broadcasting |
| `packages/x402-zcash/src/index.ts` | 84-95 (`zecDecimal`, `zip321Uri`), 289-296 (`verifyReceipt`) | TS utils | only if a ZIP 321 URI goes into `extra` |

Credit line for the repo NOTICE/README: "Portions adapted from Kage (github.com/nickthelegend/zec-shielded-x402, MIT, © 2026 Nivesh Gajengi): lightwalletd client and UIVK trial decryption (crates/x402z-facilitator/src/{lwd,verify}.rs @ 0330760)."

**Don't reuse the Kage facilitator binary as-is.**

- `validate_shape` → `valid_nonce` rejects `<64 hex>:<n>`: the colon isn't in `[A-Za-z0-9_-]` and the value is longer than 64 characters (`lib.rs:69-71, 78-80`). That is 400 `invalid_payload` before any chain call.
- It requires `x402Version:1` + `zcash-shielded` + `zcash-testnet` (`lib.rs:446-451, 481-489`).
- It doesn't reject transparent inputs.
- Receipts and bindings are per-challenge and need a bearer token.

The only workable hack is the legacy `/verify` with `X402Z_MIN_CONFIRMATIONS=0` and a memo like `base64url(sessionKey 32 B)` (43 chars) + `-` + index, which fits the regex. But it would bend the wire contract around Kage's quirks and still miss the transparent check.

### 6.3 Interface for the TS facilitator (recommended)

A Rust CLI that prints JSON, spawned per deposit check (deposits are rare: one per 100 calls), with the key in the environment, never in argv. This is the same pattern as Hanko's SDK (`packages/sdk/src/zcash.ts:142-193`: `spawn(bin, args, {env})`, then `JSON.parse(stdout)`). Proposed contract (a proposal, not existing code):

```
z402-zcheck inspect <txid> [--pay-to <utest1…>] [--wait-secs 15] [--poll-ms 1000]
  env: Z402_UIVK=uivktest1…   (or Z402_UFVK=uviewtest1…, reduced to its incoming part)
       Z402_LWD_URL=https://testnet.zec.rocks:443
  stdout (one line):
  {"txid":"<display hex>","found":true,"location":"mempool|mined|orphaned|not_found",
   "height":4547233|null,"tip":4547232,"confirmations":0,"blockTime":1793099000|null,
   "expiryHeight":4547271,"txVersion":6,"branchId":"77190ad9",
   "transparent":{"inputs":0,"outputs":0},
   "outputs":[{"pool":"ironwood|orchard|sapling","valueZat":100000,"memoText":"<64hex>:1"|null,
               "memoHex":"…","toPayTo":true}]}
  exit 0 = report printed (found or not); 2 = config error; 1 = lightwalletd/parse error
z402-zcheck address            # payTo = uivk.default_address(Require, Require, Omit)
z402-zcheck derive             # UFVK -> UIVK
```

The TS policy then lives in the facilitator:

```ts
ok = found && (location === "mempool" || location === "mined")
  && transparent.inputs === 0 && transparent.outputs === 0
  && sum(outputs.filter(o => o.toPayTo && o.memoText === `${sessionKey}:${depositIndex}`).map(o => o.valueZat)) >= windowZat
```

- confirmed = `confirmations >= 1`
- expired-unmined = `location === "mempool" && tip > expiryHeight`; drop it from D_pend
- replay = global `Map<txid, {sessionKey, depositIndex}>`
- The 30 s poller re-runs `inspect` on pending deposits.

Why not the alternatives:

- **napi-rs** adds a native-addon build and ABI matching for Node 26, and gains little at one deposit per window.
- **WASM**: tonic doesn't run in wasm. You would need grpc-js plus `@grpc/proto-loader` for the fetch and a wasm build of orchard/halo2/sapling (getrandom wasm features and other config). That is too risky for a ~5 h facilitator budget.
- **A long-lived JSON-lines daemon** (`z402-zcheck serve`, reading `{"id":…,"txid":…}` lines) is a fine upgrade if spawn plus TLS handshake latency matters.

Build notes for whoever builds it:

- Put the crate inside the project.
- Set `CARGO_TARGET_DIR` to a spike or target dir.
- Use `cargo build --release` (Kage notes dependency builds are slow unoptimized).
- No protoc is needed.
- The first build compiles librustzcash, "several minutes" per `README.md:16`.

hanko.md says building the external Hanko repo was blocked by the permission classifier. Building code we wrote, with lifted files inside our own repo, is a different case, but get the user's OK if a prompt appears.

### 6.4 Wire-contract implications for z402

- **Scheme and network**: Kage's ids are v1-style (`zcash-shielded`, `zcash-testnet`). For z402's v2 `zcash:testnet`, pick a different scheme id (e.g. `zcash-voucher` or `zcash-stream`) so a Kage v1 client never confuses the two. This is a proposal.
- **Pending**: Kage's "pending → 402 with the same challenge, retry every 15 s" loop is exactly what the stock v2 fetch wrapper can't do (it retries a 402 only once). The trust ramp removes that loop. Don't copy `settlement_pending` semantics into `/verify` for voucher calls.
- **Payer**: Kage sends `""` everywhere for privacy. z402 can use the sessionKey hex as `payer`, a pseudonym, if `@x402/core` requires a non-empty value (unchecked).
- **Auth**: Kage protects `/verify` and `/settle` with a ≥ 32-char bearer token and puts the facilitator on loopback. Do the same if the API server and facilitator are separate processes.
- **payTo**: derive it from the UIVK with `Require/Require/Omit` and publish exactly that UA. It must have no transparent receiver. Note the facilitator's exact-recipient rule against zingo-generated UAs.

## 7. Open questions

- Which zingo-cli version supports sending to Ironwood today, and what expiry delta (40 or 120) do its txs carry? Kage records no version; the wallet track should check.
- How long after `SendTransaction` until `GetTransaction` finds the tx on testnet.zec.rocks? Source says immediately on the same node. Measure it with the first real deposit (no deposit was available today).
- Does `@x402/core` 2.28.0's facilitator client accept the non-200 statuses Kage returns (202/404/422)? Probably return 200 with `isValid:false` instead.
- Is stable `0.31.0` a drop-in for Kage's `verify.rs`? Inferred yes from source diffs; not compiled.

## Verification corrections

Fact-check by track `verify-kage` on 2026-10-27, 12:00–12:25 UTC. Sources, all fresh:

- Clones of Kage `0330760` and Hanko `3c7edae`.
- lightwalletd fetched by full SHA `c22ca9ba`.
- Zebra `v7.0.0` (`e8db87e`).
- Crate tarballs from static.crates.io. The pinned ones match the Cargo.lock sha256.
- `@x402/core@2.28.0` via `npm pack`.
- Live grpcurl probes against testnet.zec.rocks.

Of the 18 load-bearing claims, 17 hold and one is partly wrong (C1). C2–C6 correct side statements or answer the open questions in §7.

### C1. The mempool path did run live; only 0-conf acceptance never did

This corrects TL;DR 6 and the last bullet of §2.2.

- **Live log.** Kage's 2026-10-22 LLM run logged, from the real facilitator against testnet.zec.rocks:
  - `verify x402z-ca140754c5e37e36f106ed84 tx f037d597…: pending (0 of 1 confirmations, tip 4529423)`
  - four more such lines for `b75b2415…` at tip 4529426

  Source: `docs/mcp-paid-run.txt:287-292`. The agent saw `payment found (100000 zat) with 0 confirmation(s); need 1` (`:258`).
- **What that line proves.** It is printed only after all of these pass (`main.rs:198-239`):
  - `parse_tx` at tip+1
  - the txid check
  - `verify_payment` (decrypt, memo, recipient, amount)
  - `paid_in_time` with `paid_at = now()`

  So the mempool fetch, NU7 parse, Ironwood decrypt and `now()` expiry path all ran live on mempool txs and matched.
- **What never ran live.** No run used `X402Z_MIN_CONFIRMATIONS=0` to accept a mempool payment (`audit/results-local.md` B-077, B-125: UNTESTED). AUDIT U-084 is a dashboard browser row, not facilitator evidence.
- **The in-process test.** `verify_real_tx.rs:182-187` calls `verify_payment` directly. It covers tip+1 parsing and 0 confirmations, but not `paid_at = now()` (`main.rs:221`).
- **Visibility right after broadcast** (§5 item 4, §7 Q2). In that run, one tool call built `f037d597`, broadcast it via lightwalletd `SendTransaction` (`x402z-agent/src/wallet.rs:233-238`) and presented it for the first time, all in 9.2 s (`docs/mcp-paid-run.jsonl`, `1792683278080` → `1792683287271`). The first facilitator lookup already found it in the mempool. The same happened for `b75b2415`. That is 2 of 2 live cases, with the same lightwalletd used to send and to fetch.

### C2. testnet.zec.rocks runs a zec.rocks fork of lightwalletd, which is why the tip lags

This applies to §5 items 2, 6 and 17.

- **The commit.** `c22ca9ba67676e61cd8ee107538ffd9a77799bab` is "Merge tag 'v0.5.4' into zecrocks-root" (Blake Emerson, 2026-08-28). It is on no branch or tag of github.com/zcash/lightwalletd and can be fetched only by full SHA. It adds 22 commits on top of v0.5.4, including:
  - "Serve the chain tip and lightd info from cache"
  - "Parallel block ingest with connection-pooled RPC client"
  - "Wait for the backend instead of exiting on RPC failure"

  Source: `git log v0.5.4..c22ca9ba`.
- **Cached tip.**
  - `GetLatestBlock` returns the ingestor's cached tip (`frontend/service.go:69-104` @c22ca9ba). Upstream v0.5.4 calls `getblockchaininfo` on every request.
  - When caught up, the ingestor re-polls the node and sleeps 2 s (`common/common.go:604-626`).
  - `GetLightdInfo` is cached for 5 s (`common.go:105, 346-355`).
- **Tx height can run ahead of the tip.** `GetTransaction` still goes straight to the node, so its height can be ahead of `GetLatestBlock`. Seen live today:
  - `c7f45bee…` mined:4547400 while tip=4547399
  - `d38c870d…` and `e5fef74e…` at 4547387 while tip=4547386

  Count confirmations from `max(tip, minedHeight)`, or with Kage's saturating formula. `GetBlock` falls back to the node for heights the cache lacks (`common.go:776-797`), so Kage's `block_time` call is safe.
- **NotFound mapping and retries.**
  - The blanket `NotFound` mapping is confirmed at `service.go:527-532` @c22ca9ba. Upstream v0.5.4 has the same code (`service.go:475-478`).
  - The fork's `RawRequest` first retries transport failures 10 times with linear backoff of 0.5 s × i, about 22.5 s in all (`frontend/rawrequest.go:126-186`). JSON-RPC errors return at once.
  - So a backend outage can hold a `GetTransaction` for about 22 s and then answer `NotFound`.

  Give each gRPC call its own deadline (e.g. 5 s) inside the 15 s window. Treat `DeadlineExceeded`, `Unavailable` and `NotFound` all as retryable.
- **Outage seen live.**
  - From 12:20:19 to 12:22:35 UTC, every call failed with `Failed to dial target host "testnet.zec.rocks:443": context deadline exceeded` or gRPC `DeadlineExceeded` (10 s client deadline).
  - Blocks kept coming the whole time (4547407 → 4547410).
  - My probe opened a new TLS connection per call, so connection-rate limiting can't be ruled out.

  Either way, plan for minutes of unavailability, not just one failed dial in 8. Keep one long-lived channel, as Kage does.

### C3. "The mempool is often empty" (§5 item 7) did not hold today

From 12:12 to 12:19 UTC, `GetMempoolTx` showed 29 distinct txids in 7 minutes:

- 24 came back from `GetTransaction` with no height field, meaning 0, meaning mempool.
- 3 were already mined, though `GetMempoolTx` still listed them (its cache lags).
- 2 calls failed to dial.

Don't assume your deposit is the only mempool tx. Look it up by txid, as Kage does.

### C4. §7 Q1, the expiry delta of zingo-cli txs: answered by parsing all ten payments live

I fetched all ten today and parsed them with `scratchpad/spikes/verify-kage/parse_v6.py`, which follows `zcash_primitives-0.31.0 transaction/mod.rs:1118-1149`. Each parse consumed the whole tx. All ten are alike:

- 9,166 bytes, v6, vgid `0xd884b698`, branch `0x77190ad9`
- no transparent inputs or outputs, no Sapling part
- **0 Orchard actions and 2 Ironwood actions**
- Ironwood valueBalance of 10,000, which is the fee

The expiry deltas split by payer:

| Paid by (Kage `TESTING.md:58-72`) | txids | expiryHeight − mined height |
|---|---|---|
| zingo-cli demo wallet | ccb4214c, 25a8b324, 408aba26, a7c3b0b2, fa011720, d3bf0b49 | 120, 110, 118, 120, 117, 117 |
| Kage agent (`zcash_primitives 0.31.0-pre.2`, delta 40) | 030c3cbf, cd64980a, f037d597, b75b2415 | 37, 33, 38, 40 |

- **zingo-cli.** The zingo-cli Kage used on 2026-10-21 builds with expiry = target + 120 (`NU7_DEFAULT_TX_EXPIRY_DELTA`). Its version is still unrecorded. It sends to Ironwood with no transparent part.
- **Eviction.** Zebra drops a mempool tx once `tip_height >= expiry_height` (`zebrad/src/components/mempool/storage.rs:892-917`, called from `mempool.rs:821-837`). So an unconfirmed zingo-cli deposit can stay pending for up to about 120 blocks, roughly 50 min at 25 s blocks. After eviction, `GetTransaction` answers `NotFound`.
- **Poller rule.** A deposit that was seen and is now NotFound, with `tip >= expiryHeight`, is dead: drop it from D_pend. A conflicting double spend also removes the tx from the mempool, so it shows up as NotFound too.

### C5. §7 Q3, non-200 facilitator statuses: answered from the `@x402/core@2.28.0` source

All line numbers below are in `dist/esm/chunk-FV2JN4FK.mjs`.

- **Timeout.** `HTTPFacilitatorClient` times out after 90 s by default (`:306`).
- **2xx bodies** go through zod:
  - Verify needs `isValid: boolean`. `invalidReason`, `invalidMessage`, `payer`, `extensions` and `extra` are optional (`:329-336`).
  - Settle needs `success: boolean`, **`transaction: string`** and **`network: string`**. `errorReason`, `errorMessage`, `payer`, `amount`, `extensions` and `extra` are optional (`:337-347`).
- **Non-2xx bodies.** A JSON body with `isValid` or `success` is thrown as `VerifyError` or `SettleError` (`:485-500`, `:533-548`). `x402ResourceServer.verifyPayment` rethrows it unless an `onVerifyFailure` hook recovers (`:1301-1326`).
- **Pending settle.** `settleWithPendingRetry` calls `/settle` exactly once more, with no delay, when the result is `{success:false, errorReason:"settlement_pending", transaction:<non-empty>}` (`:673, 1699-1715, 2036-2041`).

What this means for the facilitator:

- Answer every outcome with HTTP 200 and the boolean.
- Always put `transaction` (a string, which may be empty) and `network` in `/settle` responses.
- Don't reuse Kage's `settlement_pending` reason in `/settle`, unless you want that one immediate retry.
- `payer` is optional, so both Kage's `""` and leaving it out pass.

### C6. The `zcash_unstable="nu7"` cfg never helped (clarifies §3)

The 0.10.x line puts `NetworkUpgrade::Nu7`/`BranchId::Nu7` behind `cfg(zcash_unstable = "nu7")` and maps them to the placeholder `0xffff_ffff` (`zcash_protocol-0.10.6/src/consensus.rs:775-776, 798-799`). So even with the cfg, the 0.10.x crates could not parse real testnet NU7 txs with branch `0x77190ad9`. `zcash_primitives 0.30.1` fails with the same `invalid consensus branch id 0x…` message (`transaction/mod.rs:913-931`). Only the 0.11 line works, and it needs no cfg.
