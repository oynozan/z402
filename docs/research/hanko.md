# Hanko (`zec-payment-verify-sdk`) for the z402 facilitator

Track: hanko · Researched 2026-10-27 (11:00–11:20 UTC) · Repo HEAD `3c7edae895183b8b0dc1daa395cdb2124ffb20ec` (2026-10-26 16:16 +0530)

## TL;DR

1. Hanko's `verify()` is a thin TypeScript wrapper. It spawns a native Rust CLI, `zpay-verify`, once per check. It has no WASM and does not use grpc-js. The CLI talks to lightwalletd over tonic gRPC with TLS. Neither part is on npm or crates.io, so you build it from source.
2. NU7 is live on testnet: activation height 4,465,026, branch `0x77190ad9`, v6 txs, a new **Ironwood** pool. Hanko already parses this on stock crates.io pre-releases (`zcash_primitives =0.31.0-pre.2` and others). You need no `zcash_unstable` cfg and no protoc. The crate pins Rust 1.89.0.
3. Ran it via Hanko's hosted API, using only published demo keys: the shipped test vector verifies, `paid`, Ironwood, 100,000 zat, memo matched (5.9 s). A **live mempool v6 tx** gives `found:true, height:null, confirmations:0, outputs:[]` (5.8 s). An unknown txid gives `TX_NOT_FOUND` (1.9 s).
4. **The local build was blocked:** the permission classifier denied building this external repo here. The facilitator agent needs the user's OK before it runs `cargo build` on Hanko.
5. Deposit-check coverage. Native: amount ≥ windowZat to the key (`AMOUNT_TOO_LOW`), exact memo (`MEMO_MISMATCH`), no transparent part (`TRANSPARENT_PART`), unconfirmed visibility (`--min-conf 0`), and confirmations. Wrapper code still needed: a 15 s retry on `TX_NOT_FOUND`, the 30 s poller, and drop handling (`TX_NOT_FOUND` also covers evicted, expired and orphaned txs).
6. Receiver matching: Hanko checks "decrypts with the merchant UIVK", not "to this exact UA". It discards the decrypted recipient. Checking "to this exact UA" would need a 3-line fork; at key level, `owns(payTo)` at startup is enough.
7. Cost: every check of a found tx rebuilds the Halo 2 verifying key (about 2 s CPU) and verifies all proofs. A deposit `/verify` takes about 1–3 s locally (not measured), and `TX_NOT_FOUND` returns early.
8. **Recommendation: WRAP.** Pin Hanko at `3c7edae` and build `zpay-verify`. Call it from a ~60-line vendored TS wrapper (MIT attribution) and skip `@zpv/sdk`, which drags in viem and isn't published. Don't fork; don't write a new decryptor unless the build stays forbidden.
9. Wire contract: payTo is a testnet UA with an Orchard receiver owned by the UIVK (Orchard-only is best). The memo is the exact UTF-8 text `<64 lowercase hex>:<decimal index>`. The deposit has no transparent inputs or outputs. The txid is 64 hex chars in display order.

---

## 1. What Hanko is

| Item | Value | Source |
|---|---|---|
| Repo | https://github.com/nickthelegend/zec-payment-verify-sdk (cloned 2026-10-27) | `git clone` |
| HEAD | `3c7edae895183b8b0dc1daa395cdb2124ffb20ec` 2026-10-26 16:16:28 +0530, 111 commits, first `61da66b` 2026-10-20 | `git log` |
| License | MIT, "Copyright (c) 2026 Nivesh Gajengi" | `LICENSE` |
| Published? | **No.** npm returns E404 for `@zpv/sdk`, `@zpv/gateway`, `@zpv/mcp`, `zpay-verify` and `zec-payment-verify-sdk`. crates.io says "crate `zpay-verify` does not exist". The README says "Not published to npm or crates.io … installable from the packed tarball". | `npm view`, `curl crates.io/api/v1/crates/zpay-verify`, README "Honest limits" |
| Layout | pnpm workspace (`packageManager: pnpm@10.29.2`): `packages/core` (Rust crate + CLI `zpay-verify`), `packages/sdk` (`@zpv/sdk` 0.1.0), `packages/gateway` (x402 **v1** paywall), `packages/mcp`, `packages/examples`, `packages/dashboard` | `package.json`, `pnpm-workspace.yaml` |
| Lineage | The core is "extracted from zec-shielded-x402's facilitator `check_uivk`" (Kage, same author) | `packages/core/README.md` |

Runtime model: `@zpv/sdk` `verify({rail:'zcash',…})` → `verifyZcash()` → `child_process.spawn(zpay-verify, ['verify', txid, '--amount', …])`, with the key passed in the child's env as `ZPV_UIVK`. Source: `packages/sdk/src/zcash.ts:142-193`. Each check is one process. The Rust side uses `tonic 0.14.6` (gRPC over HTTP/2) with `ClientTlsConfig::new().with_webpki_roots()` (rustls via `tls-ring`), connect timeout 10 s, per-RPC timeout 60 s, and max decode 32 MiB. Source: `packages/core/src/lwd.rs:188-216`, `Cargo.toml:31`.

## 2. Rust core: crates, toolchain, NU7

`packages/core/Cargo.toml` (lines 19-32). All resolved from crates.io; `Cargo.lock` has **0** `source = "git"` entries:

| Crate | Pin | Locked |
|---|---|---|
| zcash_client_backend | `=0.25.0-pre.2` (features `lightwalletd-tonic`, `orchard`) | 0.25.0-pre.2 |
| zcash_keys | `=0.17.0-pre.2` (`orchard`, `sapling`) | 0.17.0-pre.2 |
| zcash_primitives | `=0.31.0-pre.2` | 0.31.0-pre.2 |
| zcash_protocol | `=0.11.0-pre.1` | 0.11.0-pre.1 |
| zcash_transparent | `=0.11.0-pre.2` | 0.11.0-pre.2 |
| orchard | `0.16` | 0.16.0 |
| sapling-crypto | `0.9` | 0.9.0 |
| zcash_note_encryption | `0.5` | 0.5.1 |
| zcash_address (transitive) | | 0.14.0-pre.2 |
| halo2_proofs / halo2_gadgets (transitive) | | 0.4.0 / 0.6.0 |
| tonic / prost | `0.14` | 0.14.6 / 0.14.4 |

- Toolchain: `packages/core/rust-toolchain.toml` → `channel = "1.89.0"`. This machine has rustup 1.29.2 with stable 1.99.1 only. Running `cargo` *inside* `packages/core` makes rustup fetch 1.89.0 into `~/.rustup` (rustup auto-installs by default unless `RUSTUP_AUTO_INSTALL=0`; inferred, not run). To use the local stable instead, run with `RUSTUP_TOOLCHAIN=stable` or `--manifest-path` from another cwd. Compiling on 1.99.1 is **untested** because my build was denied.
- **No cfg flags.** The repo has no `.cargo/config.toml`. In `zcash_primitives-0.31.0-pre.2` the only `zcash_unstable` cfgs are `"nutachyon"` and `"zip233"`. `TransactionData::ironwood_bundle()` (`src/transaction/mod.rs:661`) and `TxVersion::V6` (`mod.rs:80`, `BranchId::Nu7 => TxVersion::V6` at `:227`) are not gated.
- NU7 constants in `zcash_protocol-0.11.0-pre.1/src/consensus.rs`: testnet `NetworkUpgrade::Nu7 => Some(BlockHeight(4_465_026))` and mainnet `None`. `BranchId::Nu7` is `0x7719_0AD9`. `constants.rs:40-42`: `V6_TX_VERSION = 6`, `V6_VERSION_GROUP_ID = 0xD884B698`.
- **Ironwood** is the NU7 shielded pool. Its notes go to the UA's **Orchard receiver**, and the Orchard IVK decrypts them with note plaintext version V3 (`orchard-0.16.0/src/note_encryption.rs:131-147`: `OrchardVersion` → `NoteVersion::V2`, `IronwoodVersion` → `NoteVersion::V3`). Hanko decrypts Orchard and Ironwood bundles with `uivk.orchard()` (`lib.rs:213-220`).
- **protoc not needed.** `zcash_client_backend-0.25.0-pre.2/build.rs` only regenerates bindings when `proto/compact_formats.proto` exists *and* protoc is found. The crates.io package ships no `proto/` dir, so the pre-generated `src/proto/*.rs` are used, and they already carry `ironwood_actions` and `ironwood_commitment_tree_size`. Hanko's Dockerfile and CI install `protobuf-compiler` anyway; that is harmless.
- C toolchain: `ring` (via `tls-ring`) compiles C. Xcode CLT is assumed (not checked).
- Author's recorded build and tests (macOS, Rust 1.89): an incremental `cargo test --release` reached "Finished `release` profile … in 51.20s", then 26 tests passed (`audit/reverify-backend/core.txt`). There is no record of a clean-build time; I estimate several minutes (inferred).

## 3. CLI contract (`zpay-verify`): what the facilitator calls

Usage (`packages/core/src/main.rs:34-39`):
```
zpay-verify verify <txid> --amount <zat> [--memo <text>] [--min-conf <n>] [--allow-transparent]
zpay-verify inspect <txid>...
zpay-verify derive
zpay-verify owns <unified address>
env:   ZPV_UIVK (verify, inspect, owns), ZPV_UFVK (derive), ZPV_LWD_URL (default https://testnet.zec.rocks:443),
       ZPV_LWD_PROXY (socks5h://host:port, e.g. Tor), ZPV_ALLOW_INSECURE_LWD=1 (plaintext to a remote host)
```
- Keys come only from the environment, never argv. `--amount` is required. **`--min-conf` defaults to 1** (`main.rs:47`). `shielded_only` defaults to true; `--allow-transparent` turns it off.
- Exit codes: `0` paid, `1` not paid (JSON on stdout either way), `2` could not check (`error: <msg>` on stderr, no JSON) (`main.rs:67-69`, `17-20`).
- `inspect` connects once and prints one `TxReport` JSON per line. The first error kills the whole process with exit 2 (`main.rs:71-80`).
- `derive` prints the `uivktest1…` for `ZPV_UFVK=uviewtest1…` (`lib.rs:142-146`).
- `owns <utest1…>` is offline. It prints `{"owns":bool,"orchard":bool|null,"sapling":bool|null}` and exits 0 yes, 1 no, 2 not a shielded UA (`lib.rs:150-173`).
- Network is hard-coded to testnet: `pub const NETWORK: Network = Network::TestNetwork` (`lib.rs:36`). The key must decode as a testnet **UIVK**. A UFVK must go through `derive` first; raw Sapling or Orchard IVKs are not accepted.
- Plaintext `http://` to a host other than loopback is refused unless `ZPV_ALLOW_INSECURE_LWD=1` (`lwd.rs:185-187`).

stdout schema for `verify` (serde of `Verification`, `lib.rs:77-136`; field names are snake_case):
```json
{"report":{"txid":"<hex>","found":true,"height":4521112,"block_time":1792475145,"confirmations":26117,"tip":4547228,
           "outputs":[{"pool":"Ironwood","value":100000,"memo":"x402z-f19a63da20cbc0749ea800b3","memo_binary":false}],
           "pools":{"sapling":false,"orchard":false,"ironwood":true,"transparent":false}},
 "verdict":{"ok":true,"paid_zat":100000,"reasons":[]},
 "lightwalletd":"https://testnet.zec.rocks:443"}
```
- `height` and `block_time` are `null` while the tx is in the mempool or not found. `confirmations = tip − height + 1` when mined, else 0 (`lib.rs:267`). `tip` comes from `GetLatestBlock` at call time.
- `outputs` lists only outputs that decrypt with the key. Each carries `pool`, `value` (zat), `memo` (text or null), and `memo_binary` (true for a non-text, non-empty memo) (`lib.rs:175-181`). **The recipient address is not reported.** `try_note_decryption` returns `(note, recipient, memo)` and Hanko drops `recipient` (`lib.rs:192`, `207`).
- `pools.transparent` is true when the transparent bundle has any `vin` or `vout` (`lib.rs:261`).

Rules (`lib.rs:324-346`), in this order:

| Reason | When |
|---|---|
| `TX_NOT_FOUND` | lightwalletd does not know the txid, or knows it only on an orphaned fork; nothing else is checked |
| `NO_OUTPUT_TO_KEY` | found, but zero outputs decrypt with the key |
| `MEMO_MISMATCH` | outputs to the key exist, but none has text memo **exactly** equal to `--memo` |
| `AMOUNT_TOO_LOW` | the sum of outputs whose memo matches is below `--amount` (outputs with any memo count when `--memo` is omitted) |
| `NOT_CONFIRMED` | `confirmations < min_conf` |
| `TRANSPARENT_PART` | `shielded_only` is set and the tx has any transparent input or output |

What one `verify` call does (`lib.rs:235-272`, `349-361`, `auth.rs:148-167`):
1. Connect (TLS).
2. `GetLatestBlock` for the tip.
3. `GetTransaction{hash}`: gRPC `NotFound` or a matching message → not found; `height` 0 → mempool; `u64::MAX` → orphaned, treated as not found (`lwd.rs:254-294`).
4. Parse with `BranchId::for_height(height or tip+1)` and recompute the txid (a mismatch is an error).
5. For each transparent input, fetch its previous tx.
6. **Verify every proof and signature**: the Orchard and Ironwood Halo 2 proofs plus RedPallas signatures, and the Sapling Groth16 proofs plus RedJubjub signatures, all against the recomputed ZIP 244 sighash. The verifying key is built per process with `VerifyingKey::build` (`Params::new(K)` + `keygen_vk`), which the core README puts at "about 2 s per run".
7. If mined, `GetBlock(height)` must list the txid (`check_inclusion`); this gives `block_time`.
8. Trial-decrypt the Sapling, Orchard and Ironwood outputs.
9. Apply the rules.

**Sapling transactions need the Sapling params.** Without `sapling-spend.params` (47,958,396 B) and `sapling-output.params` (3,592,860 B), a tx with a Sapling bundle is `Setup required: ZPV_SAPLING_PARAMS` (exit 2). The search order is `ZPV_SAPLING_PARAMS`, then `~/Library/Application Support/ZcashParams`, `~/.zcash-params`, `~/.local/share/ZcashParams`. The files are checked against BLAKE2b-512 hashes in `auth.rs:113-114`. Download (from `.github/workflows/ci.yml`; sizes from HEAD requests to download.z.cash):
```sh
for f in sapling-spend.params sapling-output.params; do curl -fsSL --retry 3 -o "$DIR/$f" https://download.z.cash/downloads/$f; done
```
Orchard-only and Ironwood-only txs don't need them.

stderr error strings (exit 2) and how the SDK classifies them (`zcash.ts:131-138`):

| stderr (after `error: `) | SDK class |
|---|---|
| `cannot connect to lightwalletd: …`, `lightwalletd RPC failed: <Code>: <msg>` | `LightwalletdUnreachableError` (retry) |
| `lightwalletd answered inconsistently: …`, `lightwalletd returned a transaction whose txid differs from the one requested`, `transaction does not parse: …` | `LightwalletdBadAnswerError` |
| `Setup required: <NAME> (<detail>)` | `SetupRequiredError(missing, detail)` |
| `invalid lightwalletd URL…` | `SetupRequiredError('ZPV_LWD_URL', …)` |
| `not a testnet unified incoming viewing key: …`, `not a txid (64 hex characters): …`, anything else | `VerifyError` |

## 4. TypeScript SDK (`@zpv/sdk` 0.1.0)

`packages/sdk/package.json`: `"type": "module"`, and `exports` has only `import` conditions for `.` and `./null402` (**ESM-only, no CJS**). `engines.node >=22.13`. The only runtime dependency is `viem@2.21.0`, for the null402 rail; `index.ts` re-exports `null402.js`, which imports viem at the top, so importing `@zpv/sdk` loads viem. `dist/` is gitignored and not committed, and there is no `prepare` script, so **a git dependency installs an empty package**. The working install paths are `pnpm --dir packages/sdk build && pnpm pack` (`scripts/clean-install.sh`) or vendoring. Node 26: it uses only `node:child_process`, `node:fs`, `node:path` and `node:url` (inferred compatible; not run).

```ts
// packages/sdk/src/index.ts:16-35
export interface VerifyOptions { lwdUrl?: string; lwdUrls?: string[]; quorum?: number; fujiRpc?: string; limiter?: CheckLimiter }
export function verify(req: ZcashRequest, opts?: VerifyOptions): Promise<ZcashResult>;

// packages/sdk/src/zcash.ts:9-86
export interface ZcashRequest {
  rail: 'zcash';
  uivk: string;                 // must start with 'uivktest1'; no control chars
  txid: string;                 // /^[0-9a-fA-F]{64}$/ (display order)
  amountZat: number | bigint;   // or decimal string; 0..2.1e15
  memo?: string;                // exact text match; <=512 UTF-8 bytes; no NUL
  minConf?: number;             // default 1
  allowTransparent?: boolean;   // default false
}
export interface ZcashOutput { pool: 'Sapling' | 'Orchard' | 'Ironwood'; value: number; memo: string | null; memo_binary: boolean }
export interface ZcashReport { txid: string; found: boolean; height: number | null; block_time: number | null; confirmations: number; tip: number;
  outputs: ZcashOutput[]; pools: { sapling: boolean; orchard: boolean; ironwood: boolean; transparent: boolean } }
export interface ZcashResult { rail: 'zcash'; ok: boolean; verdict: 'paid' | 'refused' | 'unverified'; reasons: string[]; paidZat: number;
  report: ZcashReport | null; provenance: { lightwalletd: string; tip: number; checkedAt: string; via: 'zpay-verify' }; crossCheck?: CrossCheck }
export async function verifyZcash(req: ZcashRequest, opts?: { lwdUrl?: string; bin?: string; limiter?: CheckLimiter }): Promise<ZcashResult>;
export async function ownsAddress(uivk: string, ua: string, opts?: { bin?: string }): Promise<Ownership>; // {owns, orchard, sapling}
export function zpayBinary(env?): string; // ZPV_BIN, else <sdk>/../../core/target/release/zpay-verify, else $CARGO_TARGET_DIR/release/zpay-verify
```
- The child gets only `PATH`, `ZPV_UIVK`, `ZPV_LWD_URL`, `ZPV_LWD_PROXY`, `ZPV_ALLOW_INSECURE_LWD`, `ZPV_SAPLING_PARAMS` and `HOME` (`zcash.ts:148-152`).
- Timeout: `ZPV_CHECK_TIMEOUT_MS`, default 90,000 ms; on expiry the SDK sends SIGKILL and throws `LightwalletdUnreachableError` (`zcash.ts:154-178`).
- Concurrency: `CheckLimiter`, `ZPV_MAX_CHECKS` default 8 running, `ZPV_MAX_QUEUE` default 32 waiting; beyond that it throws `BusyError` (`limiter.ts:19-40`).
- Cross-check: `lwdUrls` + `quorum` gives `verdict:'unverified'` when endpoints disagree (`zcash.ts:264-357`). Not useful here: the only other public testnet indexer has the same operator (README).
- The SDK has no retry loop, no mempool polling and no state. The gateway treats `TX_NOT_FOUND` and `NOT_CONFIRMED` as "keep waiting" (`gateway/src/server.ts:330-348`), and its example loop polls every 30 s (`examples/src/paywall-live.ts:109-125`).

## 5. Hands-on results

### 5.1 Local build: blocked
I ran this in the background from `spikes/hanko/`:
```sh
CARGO_TARGET_DIR=$SP/spikes/hanko/target RUSTUP_TOOLCHAIN=stable cargo build --release --locked --manifest-path $SP/downloads/hanko/zec-payment-verify-sdk/packages/core/Cargo.toml
```
It was **denied by the Claude Code auto-mode permission classifier**: "[Code from External]". I did not try to work around it. Root cause: a permissions policy. No compiler error happened. The build agents will hit the same gate, so the user has to allow building and running Hanko's `zpay-verify` locally (see Open questions). Instead I verified behavior in two ways: (a) direct lightwalletd probes with grpcurl, and (b) Hanko's own hosted deployment of the same code, which runs `zpay-verify` server-side. I sent it only the repo's published demo keys and public txids. The hosted instance was deployed on Oct 23–24 (`6412afa`); the only later core change is a refactor (`7571cb2`: `parse_transaction` helper), so it behaves like HEAD (inferred from `git diff 6412afa HEAD`).

### 5.2 lightwalletd probes (grpcurl, testnet.zec.rocks:443)
Common: `cd $SP/downloads/protos && $SP/bin/grpcurl -max-time 30 -import-path . -proto service.proto …`. TxFilter `hash` is the txid in **internal (reversed) byte order**, base64 (helper: `$SP/spikes/hanko/probe/txfilter.py`).

| Probe | Result (2026-10-27 UTC) |
|---|---|
| `GetTransaction` fixture `030c3cbf…8351` | `height: 4521112`, 9,166 bytes, header `06000080` (v6, overwintered), versionGroupId `d884b698`, branch `77190ad9` (NU7). 0.24 s wall |
| `GetTransaction` random txid | `Code: NotFound`, `Message: GetTransaction: getrawtransaction <txid> failed: -5: Transaction not found in mempool or best chain` → Hanko maps this to `TX_NOT_FOUND` (`lwd.rs:288-294`) |
| `GetMempoolTx {}` (11:07:30) | 3 txs, each `{"ironwoodActions": 2}`: `3adce537…6a91`, `ab7a044d…68e8`, `cb8692c8…d8bc` |
| `GetTransaction` on those mempool txs | `data` present, **`height` field absent** (proto3 default 0 = mempool), v6/NU7 headers → Hanko: `found:true, height:null, confirmations:0` |
| `GetLatestBlock` | 4547227 at 11:07:07Z; 4547241 at about 11:14 |
| `GetBlockRange` 4547181–4547241 | block gap mean 31.4 s, median 22.5 s, min 4 s, max 155 s; 61 shielded txs in 61 blocks (a steady 2-action Ironwood tx stream) |

### 5.3 Hanko `verify()` via the hosted API (`POST https://hanko-api.201-18-198-162.sslip.io/api/verify`, `content-type: application/json`)
Request and response files are in `$SP/spikes/hanko/probe/req-*.json` and `resp-*.txt`. The times are end to end from this machine and include about 1.8 s of round trip and TLS to that VPS (`/api/health` alone took 1.81 s).

| Case | Request (uivk from repo fixtures) | Response (abridged) | Time |
|---|---|---|---|
| (b) shipped test vector | x402 uivk, `030c3cbf…8351`, 100000, memo `x402z-f19a63da20cbc0749ea800b3`, minConf 1 | `ok:true, verdict:paid, paidZat:100000, height:4521112, confirmations:26117, outputs:[{pool:Ironwood,value:100000,memo:x402z-…b3}]` | 5.94 s |
| (a) live mempool tx (11:08:35) | merchant uivk, `0e1b2842…9864`, memo `deadbeef:0`, **minConf 0** | `reasons:[NO_OUTPUT_TO_KEY], found:true, height:null, block_time:null, confirmations:0, outputs:[], pools.ironwood:true` | 5.78 s |
| just mined (was in mempool at 11:07:30) | merchant uivk, `3adce537…6a91`, minConf 1 | `NO_OUTPUT_TO_KEY, height:4547228, block_time:1793099207, confirmations:1` | 12.21 s |
| unknown txid | merchant uivk, random, minConf 0 | `reasons:[TX_NOT_FOUND], found:false, height:null` | 1.91 s |
| memo one char short | x402 uivk, fixture, memo `…800b` | `reasons:[MEMO_MISMATCH, AMOUNT_TOO_LOW], paidZat:0`; outputs still show the real memo `…800b3` | 6.21 s |
| transparent part | merchant uivk, `bb8d8842…82ec`, 10000, memo `zpv-d7289a63fabd56ff2f8a7261` | `reasons:[TRANSPARENT_PART], paidZat:10000, pools.transparent:true` | 6.00 s |

Recorded evidence of visibility right after broadcast (`deployments/testnet.json` `paywallLive`): zingo-cli `quicksend` returned at `21:09:40.975Z`, and the paywall's first check answered `NOT_CONFIRMED` ("payment seen, 0/1 confirmations") at `21:09:41.567Z`. That is 0.6 s, with the wallet broadcasting through the same lightwalletd. This run predates the proof-check commit `0b57e69` (21:16 UTC that day), so today's checks of found txs are about 2 s slower.

## 6. Gap analysis against the z402 deposit check

| # | z402 requirement | Hanko | Verdict |
|---|---|---|---|
| 1 | ≥ windowZat received to merchant payTo | `--amount windowZat` + `--memo` → `AMOUNT_TOO_LOW`. Only outputs with the matching memo are summed (`paid_zat`). "To payTo" means **decrypts with the merchant UIVK** (any diversified address of that key; external scope only). The recipient is not exposed. | **Native at key level.** At startup, assert `zpay-verify owns <payTo>` exits 0. Exact UA receiver matching needs a **small fork**: keep `recipient` from `try_note_decryption` and compare it with `UnifiedAddress::orchard()`/`sapling()`. Not needed for the MVP, because the memo already binds the session. |
| 2 | memo exactly `<sessionKey>:<depositIndex>` | Exact equality on `Memo::Text` (`lib.rs:329`). Trailing zero padding is stripped by the memo decoding. A prefix doesn't match (live). The SDK rejects >512 bytes or a NUL. | **Native.** Both agents must fix the formatting (see §7.4). |
| 3 | no transparent inputs or outputs | `shielded_only` is the default (`TRANSPARENT_PART` when vin or vout is non-empty). | **Native** (live) |
| 4 | visible within ~15 s while unconfirmed | lightwalletd/Zebra `getrawtransaction` returns mempool txs. Hanko reports `found:true, confirmations:0`. With `--min-conf 0` the verdict is ok (live). Seen 0.6 s after broadcast (recorded). There is **no retry**: an early `TX_NOT_FOUND` is final for that call. | **Wrapper:** retry while `reasons == ['TX_NOT_FOUND']` (or on `LightwalletdUnreachable`) about every 1 s until 15 s. Each found-tx check costs ~1–3 s locally (estimate); `TX_NOT_FOUND` costs less (no proof check). |
| 5 | confirmation status for a 30 s poller | `report.confirmations`, `report.height`, `report.block_time`, and `NOT_CONFIRMED` against `--min-conf`. | **Native data, wrapper loop.** Use `--min-conf 1`: ok means confirmed, `[NOT_CONFIRMED]` means still pending. To amortize the VK build, batch with `zpay-verify inspect <txid…>` (one process; `OnceLock` caches the VK, `auth.rs:100-110`). |
| 6 | tx unknown or expired | Unknown, evicted, expired and orphaned txs all return `TX_NOT_FOUND` (`lib.rs:240-247`). No expiry height is exposed. Network failures are errors (exit 2), never verdicts. | **Wrapper:** at `/verify`, keep `TX_NOT_FOUND` after 15 s → invalid. In the poller, a previously seen deposit that turns `TX_NOT_FOUND` (suggest 2 consecutive polls) → drop it from D_pend. Optionally compare the tip with first-seen tip + 40 (librustzcash default expiry delta; inferred). |
| — | NU7 / v6 / Ironwood parsing | Live v6 mempool and mined txs parse and pass proof checks (live). | **Native** |
| — | Sapling-bundle deposits | Need `ZPV_SAPLING_PARAMS`, otherwise SetupRequired. | **Setup:** download the params, or keep deposits Orchard/Ironwood-only (Orchard-only payTo, agent funds in Orchard/Ironwood). |
| — | replay or reuse of a txid across sessions | Stateless | **Facilitator state:** credit each txid and each `(sessionKey, depositIndex)` once. |

Options weighed:
- **Use `@zpv/sdk` as-is.** Not on npm, ESM-only, pulls viem, needs a pack step. It works, but it adds weight for nothing.
- **Wrap the CLI.** Recommended. Vendor a ~60-line spawn wrapper, or vendor `zcash.ts` + `errors.ts` + `limiter.ts` with MIT attribution.
- **Fork.** Only for exact receiver matching or to drop the per-call proof check.
- **Replace with our own Rust decryptor.** Only if the user won't allow building Hanko. It would use the same crates and copy `decrypt_outputs` + `memo_of` (~80 lines), and would also need a build approval.

## 7. Recommended facilitator integration

### 7.1 Build once (needs user approval to build external code)
```sh
git clone https://github.com/nickthelegend/zec-payment-verify-sdk vendor/hanko && git -C vendor/hanko checkout 3c7edae895183b8b0dc1daa395cdb2124ffb20ec
cargo build --release --locked --manifest-path vendor/hanko/packages/core/Cargo.toml   # Rust 1.89 per rust-toolchain.toml (rustup fetches it if cwd is inside the crate)
export ZPV_BIN=$PWD/vendor/hanko/packages/core/target/release/zpay-verify
export ZPV_LWD_URL=https://testnet.zec.rocks:443
# merchant key: UFVK from zingo-cli `export_ufvk` (uviewtest1…) → UIVK
ZPV_UFVK=uviewtest1… $ZPV_BIN derive                     # prints uivktest1…
ZPV_UIVK=uivktest1… $ZPV_BIN owns utest1…  ; echo $?     # must print {"owns":true,…} and exit 0 before advertising payTo
```

### 7.2 Wrapper (sketch for `facilitator/src/deposit/zpay.ts`)
```ts
// Calls Hanko's zpay-verify CLI (MIT, github.com/nickthelegend/zec-payment-verify-sdk @3c7edae).
import { spawn } from 'node:child_process';
export type Reason = 'TX_NOT_FOUND'|'NO_OUTPUT_TO_KEY'|'MEMO_MISMATCH'|'AMOUNT_TOO_LOW'|'NOT_CONFIRMED'|'TRANSPARENT_PART';
export interface Verification {
  report: { txid: string; found: boolean; height: number|null; block_time: number|null; confirmations: number; tip: number;
            outputs: { pool: 'Sapling'|'Orchard'|'Ironwood'; value: number; memo: string|null; memo_binary: boolean }[];
            pools: { sapling: boolean; orchard: boolean; ironwood: boolean; transparent: boolean } };
  verdict: { ok: boolean; paid_zat: number; reasons: Reason[] };
  lightwalletd: string;
}
export class ZpayError extends Error {
  constructor(msg: string, readonly retryable: boolean) { super(msg); }
}
export function zpayVerify(o: { bin: string; uivk: string; txid: string; amountZat: bigint; memo: string; minConf: number;
                                lwdUrl?: string; saplingParams?: string; timeoutMs?: number }): Promise<Verification> {
  const args = ['verify', o.txid, '--amount', o.amountZat.toString(), '--memo', o.memo, '--min-conf', String(o.minConf)];
  const env: Record<string, string> = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ZPV_UIVK: o.uivk };
  if (o.lwdUrl) env.ZPV_LWD_URL = o.lwdUrl;
  if (o.saplingParams) env.ZPV_SAPLING_PARAMS = o.saplingParams;
  return new Promise((resolve, reject) => {
    const p = spawn(o.bin, args, { env }); let out = '', err = '';
    const t = setTimeout(() => p.kill('SIGKILL'), o.timeoutMs ?? 20_000);
    p.stdout.on('data', d => (out += d)); p.stderr.on('data', d => (err += d));
    p.on('error', e => { clearTimeout(t); reject(e); });
    p.on('close', code => {
      clearTimeout(t);
      if (code === 0 || code === 1) {
        try { return resolve(JSON.parse(out) as Verification); } catch (e) { return reject(e); }
      }
      const msg = err.replace(/^error: /, '').trim() || `zpay-verify exited ${code}`;
      reject(new ZpayError(msg, code === null || /^(cannot connect to lightwalletd|lightwalletd RPC failed)/.test(msg)));
    });
  });
}
```

### 7.3 Algorithms
- **`/verify` with `depositTxid`.** `memo = `${sessionKey}:${depositIndex}``; `deadline = now + 15 s`. Loop: call `zpayVerify({…, amountZat: BigInt(extra.windowZat), memo, minConf: 0, timeoutMs: remaining})`.
  - If `reasons` is exactly `['TX_NOT_FOUND']`, or a retryable `ZpayError` was thrown, and time remains: sleep 1 s and loop.
  - Otherwise `ok:true` → valid deposit, with `confirmations > 0` → D_conf and `0` → D_pend (at most one counts). Any other reasons → invalid. Map them to `invalidReason` strings, which are a wire-contract choice; suggested: `deposit_not_found`, `deposit_not_to_merchant`, `deposit_memo_mismatch`, `deposit_amount_too_low`, `deposit_transparent`. `report.outputs[].memo` shows the memo that was actually sent, for diagnostics.
- **Poller every 30 s.** For each pending deposit, call with `minConf: 1`.
  - `ok` → confirmed; record `report.height`.
  - `reasons == ['NOT_CONFIRMED']` → still pending.
  - `TX_NOT_FOUND` on 2 consecutive polls → dropped (expired, evicted, double-spent or reorged).
  - `ZpayError` → keep and retry next tick.
  - Alternative: one `zpay-verify inspect t1 t2 …` per tick, reading `found` and `confirmations`.
- Serialize or limit spawns. Hanko's own default is 8 parallel. Allow ≥ 20 s on the resource-server → facilitator HTTP timeout for deposit calls (15 s retry plus ~3 s per check).

### 7.4 Wire-contract items this imposes (for the client agent)
- `payTo`: a testnet UA (`utest1…`) whose Orchard receiver belongs to the merchant UIVK. Prefer an **Orchard-only** UA so deposits never have a Sapling bundle; otherwise ship the Sapling params.
- Deposit tx: exactly the memo text `<sessionKey>:<depositIndex>`. Suggested format: `sessionKey` = 64 lowercase hex chars (ed25519 public key), `depositIndex` = decimal from 0 with no padding, total ≤ 512 bytes. At least `windowZat` to `payTo` in outputs carrying that memo. Shielded inputs only, with shielded change. The fee is on top (10,000 zat for 2 actions under ZIP 317, per the spec).
- `depositTxid`: 64 hex chars in display (explorer) order, as zingo-cli `quicksend` prints it (`"txids": [...]`, `examples/src/zingo.ts:65-73`). The facilitator either derives `depositIndex` from session state or the payload carries it explicitly. The two agents must agree on which.
- How Hanko's examples drive zingo-cli (reference for the client): `zingo-cli --chain testnet --server https://testnet.zec.rocks:443 --data-dir <dir> --waitsync quicksend '[{"address":"utest1…","amount":100000,"memo":"<sessionKey>:0"}]'` (`examples/src/zingo.ts:31`, `65-73`). They built zingo-cli from source (`~/src/zingolib/target/release/zingo-cli`) and paid Ironwood txs on Oct 20–22. No zingolib version is recorded.

## 8. Risks and open questions
- **Build permission.** The auto-mode classifier denied building Hanko. The user must allow `cargo build` and running `zpay-verify`, or z402 writes its own decryptor, which also needs a build of crates.io code. The hosted Hanko API is **not** an option for the facilitator: it would hand the merchant UIVK to a third party, which is exactly what the spec rules out.
- Rust 1.99.1 compatibility is untested; the pinned toolchain is 1.89.0. The clean-build time is unknown.
- Per-check cost of ~2 s for the Halo 2 VK is the core README's claim; I did not measure it locally. Hosted timings are 5.8–12.2 s end to end, including about 1.8 s of round trip.
- `TX_NOT_FOUND` can't tell "not propagated yet" from "expired/evicted/orphaned". testnet.zec.rocks may be a load-balanced pool, in which case mempool visibility can differ per request (not verified).
- Only one public testnet indexer operator exists, so there is no cross-check and lightwalletd stays trusted for anchors, transparent prevouts and chain position (README "Honest limits").
- Testnet block spacing today has median 22.5 s and max 155 s. Plan the poller and the demo around minute-scale gaps.

## Sources
- Clone: `$SP/downloads/hanko/zec-payment-verify-sdk` (`$SP` = `/private/tmp/claude-501/-Users-oynozan-Desktop-Dev-Web3-z402/afbb7c76-d88e-47a4-8a53-fd001155f8ac/scratchpad`). Files cited: `packages/core/{Cargo.toml,Cargo.lock,rust-toolchain.toml,src/lib.rs,src/lwd.rs,src/auth.rs,src/main.rs,tests/live.rs,README.md}`, `packages/sdk/{package.json,src/index.ts,src/zcash.ts,src/errors.ts,src/limiter.ts,README.md}`, `packages/gateway/src/{server.ts,main.ts,api.ts}`, `packages/examples/src/{zingo.ts,paywall-live.ts}`, `fixtures/testnet.json`, `deployments/testnet.json`, `Dockerfile`, `.github/workflows/ci.yml`, `scripts/clean-install.sh`, `audit/reverify-backend/core.txt`.
- Crate sources read (static.crates.io): `$SP/downloads/hanko/crates/{zcash_primitives-0.31.0-pre.2,zcash_protocol-0.11.0-pre.1,orchard-0.16.0,zcash_client_backend-0.25.0-pre.2,zcash_keys-0.17.0-pre.2}`.
- Probe outputs: `$SP/spikes/hanko/probe/` (grpcurl JSON, hosted-API requests and responses).
- lightwalletd proto: `$SP/downloads/protos/service.proto` (`RawTransaction.height` semantics, `PoolType.IRONWOOD = 4`).
- Hosted Hanko API: https://hanko-api.201-18-198-162.sslip.io/api/health and `/api/verify` (README "Live").

## Verification corrections

I fact-checked this file on 2026-10-27, 12:00–12:25 UTC. Sources:
- A fresh clone at the same HEAD `3c7edae`: `$SP/downloads/verify-hanko/repo`.
- Crate tarballs from static.crates.io whose SHA-256 match `Cargo.lock`: `$SP/downloads/verify-hanko/crates/`.
- The stable crates released 2026-10-21: `$SP/downloads/verify-hanko/crates-stable/`.
- ZIP 218: `$SP/downloads/verify-hanko/zips/zip-0218.html`.
- Read-only grpcurl probes of testnet.zec.rocks.

16 of the 18 load-bearing claims hold as written. Items 3 and 4 below are the other two. The remaining items correct statements in the body above.

1. **Ironwood and v6 transactions arrived with NU6.3, not NU7.** This corrects TL;DR 2 and §2 ("Ironwood is the NU7 shielded pool").
   - Heights and branch IDs (`zcash_protocol-0.11.0-pre.1/src/consensus.rs`): testnet NU6.3 is at 4,134,000 and NU7 at 4,465,026 (:582-583); mainnet NU6.3 is at 3,428,143 (:548). `BranchId::Nu6_3` is `0x37a5_165b` and `Nu7` is `0x7719_0ad9` (:815-816). Line :660 reads "The Ironwood / NU6.3 network upgrade".
   - The `OrchardProtocolRevision::V3` doc (:1001-1004) says it was "deployed at NU6.3, which introduces the Ironwood value pool … cross-address transfers are prohibited for the Orchard value pool and permitted for the Ironwood value pool".
   - In `zcash_primitives-0.31.0-pre.2/src/transaction/mod.rs`, V6 is valid from `Nu6_3` (:260, "Ironwood / NU6.3"), and :261 says "NU7 retains the existing v6 transaction format". What NU7 adds is the 25 s block spacing (ZIP 218) and the end of v4 transactions (ZIP 2003; `Nu7 => false` at :245).
   - Consequence: the merchant receives the payment as an **Ironwood** output to the UA's Orchard receiver. An Orchard-pool action cannot pay a different address. Hanko decrypts both bundles with the same Orchard IVK, so the wrapper needs no change.

2. **NU7 blocks are 25 s apart, and the NU7 default expiry delta is 120 blocks, not 40.** This corrects §6 row 6 and §7.3 ("first-seen tip + 40"), and gives the reason for the §8 spacing.
   - ZIP 218, "25-second Block Target Spacing" (https://zips.z.cash/zip-0218, Status: Proposed, fetched 2026-10-27), specifies a "change in the block target spacing from 75 seconds to 25 seconds in NU7" and says "The default expiry delta of 40 blocks … is tripled from NU7 activation".
   - Stable `zcash_protocol 0.11.0` has `POST_NU7_POW_TARGET_SPACING = 25 s` (consensus.rs:781). Stable `zcash_primitives 0.31.0` has `NU7_DEFAULT_TX_EXPIRY_DELTA = 3 × 40 = 120` (builder.rs:61-93).
   - Hanko's pinned `0.31.0-pre.2` still has `DEFAULT_TX_EXPIRY_DELTA = 40` (builder.rs:53). A wallet built on the pre-release therefore uses 40, and one built on the stable line uses 120.
   - Live, 2026-10-27 12:03 UTC: v6 txs `352589d2…d86f` and `4569aaa8…b58f` were both mined at 4,547,362, with `expiry_height` 4,547,397 (+35) and 4,547,476 (+114). The fixture `030c3cbf…8351` was mined at 4,521,112 with expiry 4,521,149 (+37).
   - Block spacing measured over 4,547,257–4,547,377: mean 22.6 s, median 18.5 s, min 4 s, max 111 s. The 30 s poller sees about one block per tick.
   - Don't infer expiry from +40. The tx carries `expiry_height` as a u32 LE at bytes 16..20 of `RawTransaction.data` for v5 and v6: header, versionGroupId, branchId, lock_time, then expiry_height (`zcash_primitives-0.31.0-pre.2/src/transaction/mod.rs:1143-1159`).
   - Record the expiry when the deposit is first seen, with one extra `GetTransaction` from the facilitator or a fork that adds `expiry_height` to `TxReport`. Once `tip > expiry_height`, an unmined deposit is dead.

3. **Claim "verify() spawns once per check": partly true. It spawns once per check per endpoint.** This refines the §1 runtime model.
   - `packages/sdk/src/index.ts:39,47`: if `opts.lwdUrls` is passed **or env `ZPV_LWD_URLS` is set**, `verify()` switches to `verifyZcashCrossChecked`.
   - That path spawns one `zpay-verify` per endpoint in parallel (`zcash.ts:277`), and its verdict can be `'unverified'`. The default path spawns once.
   - This doesn't matter if the facilitator calls the CLI directly (§7.2). If the SDK is ever used, keep `ZPV_LWD_URLS` unset.

4. **Claim "only a uivktest1… key is accepted": partly true. The `uivktest1` prefix is an SDK rule, not a CLI rule.** This refines §3 and §4.
   - The CLI's `parse_uivk` calls `UnifiedIncomingViewingKey::decode` (`zcash_keys-0.17.0-pre.2/src/keys.rs:1739-1751`), which calls `Uivk::decode`. Its `hrp_network` (`zcash_address-0.14.0-pre.2/src/kind/unified.rs:642-662`) accepts both ZIP 316 revisions.
   - Testnet HRPs (`zcash_address-0.14.0-pre.2/src/constants.rs:138-181`):
     - UA: `utest` (R0), `zutest` (R2, shielded-only), `tutest` (R2, with transparent).
     - UFVK: `uviewtest` (R0), `uvftest` (R2).
     - UIVK: `uivktest` (R0), `uvitest` (R2).
   - Only `zcash.ts:116` (`startsWith('uivktest1')`) rejects R2 keys.
   - `derive` accepts either UFVK form. It prints R0 `uivktest1…` unless the key carries expiry metadata or a P2SH item; then it prints R2 `uvitest1…` (`keys.rs:1863-1878`).
   - `owns` decodes both R0 and R2 UAs.
   - The rest of the claim holds: the network is hard-coded to TestNetwork, a UFVK must go through `derive`, and raw Sapling or Orchard IVKs are rejected.
   - Don't hard-code `utest1` when validating `payTo`.

5. **`owns` does not prove that a UA is shielded-only.** This applies to §6 row 1 and §7.1.
   - `owns = orchard.unwrap_or(true) && sapling.unwrap_or(true)` (`packages/core/src/lib.rs:167-172`). It never checks transparent receivers, so a UA that also has a P2PKH receiver still returns `owns:true`.
   - The spec requires a shielded-only payTo, so create one on purpose: an Orchard-only UA.
   - Hanko's own zingo-cli merchant address is one. `deployments/testnet.json` `wallets.merchant.address` is 110 chars, or 61 raw bytes: one 43-byte receiver, its 2-byte typecode and length, and 16 bytes of padding. `tests/cli.rs:82-92` asserts `orchard:true` for it.

6. **Normalize the txid before deduplicating.** This applies to §6 ("credit each txid … once") and §7.4 (`depositTxid`).
   - The CLI parses with `TxId::from_hex`, which goes through `zcash_encoding::ReverseHex::decode` to `hex::decode_to_slice`. hex 0.4.3 accepts both `A-F` and `a-f` (`hex-0.4.3/src/lib.rs:175-185`).
   - `TxReport.txid` echoes the input string exactly as given (`lib.rs:237,263`). The SDK regex is `/^[0-9a-fA-F]{64}$/`.
   - Without normalization, one deposit can be credited twice under two spellings. The wire contract should require lowercase hex, or the facilitator should lowercase the txid before any lookup.

7. **Stable librustzcash releases exist.** This updates TL;DR 2, §2 and the spec's "only pre-release librustzcash crates parse its transactions".
   - On 2026-10-27, crates.io lists `zcash_primitives 0.31.0`, `zcash_protocol 0.11.0`, `zcash_client_backend 0.25.0`, `zcash_keys 0.17.0`, `zcash_transparent 0.11.0` and `zcash_address 0.14.0`. All were released 2026-10-21 with MSRV 1.89, and NU7 needs no cfg flag in them (testnet 4,465,026, `0x7719_0ad9`). `zcash_protocol 0.11.0` also sets mainnet NU7 to 3,543,405.
   - Hanko's pinned 2026-10-14 pre-releases are not yanked, so `--locked` builds still resolve.
   - Keep Hanko's lock unchanged. Any new Rust code, whether a fork or our own decryptor, should use the stable line.

8. **`TX_NOT_FOUND` can also come from a failing upstream.** This applies to §6 rows 4 and 6.
   - `is_not_found` (`lwd.rs:288-294`) treats any gRPC status whose message contains "not found" as not-found, whatever its code. A transient backend error with that text therefore surfaces as a verdict (exit 1) rather than exit 2.
   - The 15 s retry at `/verify` already absorbs this.
   - In the poller, also require `tip > expiry_height` (item 2) before applying the "2 consecutive `TX_NOT_FOUND` → dropped" rule.

These held as written:
- HEAD, 111 commits, MIT license.
- The Cargo pins, and 0 git sources in `Cargo.lock`. All 11 tarballs I checked match its checksums.
- The 1.89.0 toolchain pin. Inside `packages/core`, `rustup show active-toolchain` reports the uninstalled override `1.89.0-aarch64-apple-darwin`. Crate MSRVs are 1.88, and Hanko's own code has no `#![deny]`. Compiling on 1.99.1 is still untested.
- No `zcash_unstable` cfg is needed. The check-cfg list is `values("nutachyon", "zip233")` (`zcash_primitives` Cargo.toml:261), and the CHANGELOG says "`BranchId::Nu7` is available without a custom compiler configuration".
- The NU7 constants.
- protoc is not needed.
- The transport: tonic with `tls-ring` and `tls-webpki-roots`, a 10 s connect timeout and a 60 s per-request timeout.
- The CLI exit codes and defaults.
- The decrypted recipient is discarded.
- The amount and memo rule. One nuance: `AMOUNT_TOO_LOW` is only added when at least one output decrypts; with no outputs the only such reason is `NO_OUTPUT_TO_KEY`.
- An orphaned tx counts as not found. The proto comment confirms that height `0` means mempool and `u64::MAX` means a side chain.
- The proof checks and VK build: `K = 11`, `Params::new(K)` plus `keygen_vk`. Under protocol V3, Orchard and Ironwood bundles both map to `PostNu6_3`, so each process builds one VK.
- Ironwood uses V3 note plaintext and the Orchard IVK. `zcash_keys` address.rs:847 says "Ironwood shares the Orchard receiver", and there is no Ironwood UA typecode.
- The `owns` exit codes.
- The SDK packaging.
- The limiter defaults.
- Live checks:
  - `GetLightdInfo` reports v0.5.4, Zebra 7.0.0 and `77190ad9`.
  - The fixture tx is v6 (`d884b698`, `77190ad9`) at 4,521,112.
  - Mempool txs come back from `GetTransaction` with no `height` field.
  - A random txid returns `NotFound … -5: Transaction not found in mempool or best chain`.
  - `npm view @zpv/sdk` and `npm view zpay-verify` both return E404, and crates.io returns 404 for `zpay-verify`.
