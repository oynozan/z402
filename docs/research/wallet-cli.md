# z402 research: wallet CLI on NU7 testnet (zingo-cli and alternatives)

Track: wallet-cli · 2026-10-27 · feeds the CLIENT wallet adapter and the FACILITATOR merchant keys

## TL;DR

1. NU7 has been live on testnet since block 4,465,026 (2026-10-04 18:21:45 UTC, branch id `0x77190AD9`). Blocks now come about every 25 s: the average over the last 1,000 blocks was 25.8 s. Every transaction is v6, and all shielded activity is in the new **Ironwood** pool, which started at NU6.3 (block 4,134,000).
2. A payment to a unified address's Orchard receiver lands in **Ironwood**, not in Orchard. The facilitator therefore trial-decrypts the Ironwood actions of a v6 transaction, using the merchant's Orchard IVK and note plaintext lead byte `0x03`. librustzcash code older than commit `928592188` (2026-09-22) fails with `invalid consensus branch id 0x77190ad9`.
3. zingo-cli works on NU7 testnet only from zingolib 7.0.0 onward. Pin tag `zingolib_v8.0.0-rc.0` (commit `755c3ada`, NU7 release crates) and build with `cargo build --release --locked -p zingo-cli --no-default-features --features nakednet-test-mode`. The default build sends every transaction through the Nym mixnet, fails closed if it can't, and needs a separate `nym-proxy` binary.
4. Testnet has no default indexer, so always pass `--chain testnet --server https://testnet.zec.rocks:443`.
5. A deposit is `quicksend <payTo> <zat> "<sessionKey>:<idx>"`. On success stdout is `{"txids":["<64 hex>"],"transmissions":[…]}`. On failure stderr gets `Error: …` plus `caused by: …` lines, with exit code 1. The fee for one input and two outputs is 10,000 zat (ZIP 317).
6. zingo-cli prints txids in display order, which is byte-reversed. lightwalletd `GetTransaction` needs protocol order, so reverse the bytes (checked live). In the response, `height` 0 means the transaction is in the mempool.
7. Client adapter: one long-lived zingo-cli REPL process driven over stdin/stdout. It keeps syncing, tracks the mempool, and caches the proving key. Send commands one at a time, use `version` as the end-of-reply marker, and retry the brief `Insufficient balance (have 0, …)` error (issue #2835). Split the wallet into 5 notes with one multi-recipient `quicksend '[…]'` (fee 30,000 zat).
8. Merchant: a new zingo wallet's default address (index 0) is already Orchard-only (`utest1…`), and `export_ufvk` gives the UFVK. zingo-cli can't print a UIVK, so run zcash-devtool `wallet init-fvk --fvk <UFVK>` and then `wallet list-accounts`, which prints `UIVK:`. That is the input Hanko's `verify({uivk,…})` takes.
9. Fallback client wallet: zcash-devtool (pre-release crates that know `0x77190AD9`; has `send --memo`, `fan-out`, `list-tx --json`). Zallet can't be used: its crates predate NU7 and its only backend is Linux-only and needs a local zebrad.
10. **I did not run zingo-cli.** The permission system blocked the build, so every CLI behaviour below comes from the source at the commits named. Chain and lightwalletd facts come from live `grpcurl` probes.

Evidence tags used below: **[ran]** = I ran it and saw the output; **[src]** = read the source at the named commit; **[docs]** = README, changelog or issue; **[inf]** = inferred.

---

## 0. What was and was not verified

- Build attempt (denied by the permission system before running):
  `cargo build --release --locked -p zingo-cli --no-default-features --features nakednet-test-mode`
  The refusal read: *"Permission for this action was denied by the Claude Code auto mode classifier. Reason: [Code from External]"*. I didn't try to work around it. As a result there are no captured zingo-cli outputs and no timings for startup, sync or proving. The output shapes below are reconstructed from the formatting code. Sections 7.5 and 10 list what the client agent should measure first.
- `cargo fetch --locked` did run. It only downloads crates (no build scripts) into `…/scratchpad/spikes/wallet-cli/cargo-home` (1.2 GB). The crate sources quoted below come from there.
- Live probes were run with `grpcurl` against `testnet.zec.rocks:443`. Repro: `cd …/scratchpad/downloads/protos && …/scratchpad/bin/grpcurl -max-time 30 -import-path . -proto service.proto testnet.zec.rocks:443 cash.z.wallet.sdk.rpc.CompactTxStreamer/<Method>`. The probe outputs are saved in `…/scratchpad/spikes/wallet-cli/probes/`.

## 1. Testnet state today (live probes, 2026-10-27 11:12–12:06 UTC) [ran]

| Probe | Result |
|---|---|
| `GetLightdInfo` | `version v0.5.4`, `vendor "ECC LightWalletD"`, `gitCommit c22ca9ba67676e61cd8ee107538ffd9a77799bab`, `buildDate 2026-08-28`, `chainName "test"`, `consensusBranchId "77190ad9"`, `zcashdSubversion "/Zebra:7.0.0/"`, `lightwalletProtocolVersion "v0.5.0"`, `blockHeight 4547235` (11:12:02Z) |
| `GetStandardFee` | `Code: Unimplemented … unknown method GetStandardFee`. The proto is newer than the server, so don't rely on it. |
| NU7 activation | Block 4465025 at 1791138022 (2026-10-04T18:20:22Z), block **4465026** at 1791138105 (**2026-10-04T18:21:45Z**) |
| Block spacing after NU7 | 100 blocks from 4465026: 24.9 s/block. 200 blocks up to 4547235: 26.6 s. Last 1,000 blocks up to 4547369: **25.79 s** |
| Raw tx header (block 4547235, tx index 1) | `header=0x80000006` (v6, overwintered), `versionGroupId=0xD884B698`, `consensusBranchId=0x77190AD9`, `expiry_height=4547271`. Header layout: bytes 0–3 header, 4–7 version group, 8–11 branch id, 12–15 lock_time, 16–19 expiry |
| Compact blocks 4547035 and 4547235 | Each tx has `ironwoodActions` (coinbase 1 action; others 2, 13, 2, …), zero Sapling outputs, zero Orchard actions, no vin/vout |
| `chainMetadata` over 200 blocks | Sapling tree 405251→405251, Orchard tree 249856→249856, **Ironwood tree 764152→764684**. New value goes only into Ironwood. |
| `GetSubtreeRoots` | Sapling 6 roots, Orchard 3, **Ironwood 11** (last completed at 4538317). The server supports Ironwood light-client sync. |
| `GetMempoolTx {}` | Streamed 4 mempool txs at once (0.18 s), all Ironwood-only (`ironwoodActions` 2, 2, 11, 2) |
| `GetTransaction` on a mempool tx | Returns data, and `height` is absent in JSON (0 means mempool) |
| Txid byte order | `CompactTx.txid` base64 `3F3yrXxN…AKrAg=` = protocol-order hex `dc5df2ad…0aac08`. `GetTransaction {hash: <protocol order>}` → `{"height":"4547235"}` (12,224 bytes). The same call with reversed bytes → `NotFound: GetTransaction: getrawtransaction dc5df2ad…0aac08 failed: -5: Transaction not found in mempool or best chain`. **The server reverses the bytes itself, so send protocol order** (= reverse of the display hex that zingo-cli and explorers print). |
| `GetBlockRange` speed | 1 block 0.47 s; 40 blocks 0.60 s (77 KB of JSON); 200 blocks 1.20 s (298 KB). Fetching blocks is cheap for a short sync gap. |

`RawTransaction.height` meaning (from the `service.proto` comment): `0` = in the mempool, `0xffffffffffffffff` = mined on a fork that is not the main chain, any other value = mined at that height. [docs]

## 2. NU6.3, NU7 and Ironwood: what changed and why it matters to both agents

All facts here are [src] from crates.io sources fetched via `Cargo.lock` of zingolib `3fb32d27`.

- **Heights and branch ids** (`zcash_protocol-0.11.0/src/consensus.rs`, released 2026-10-21):

  | Upgrade | Testnet height | Mainnet height | Branch id |
  |---|---|---|---|
  | NU6.2 | 4,052,000 | 3,364,600 | `0x5437F330` |
  | NU6.3 (Ironwood) | 4,134,000 | 3,428,143 | `0x37A5165B` |
  | NU7 | **4,465,026** | 3,543,405 (zingolib tests say "mainnet crosses on 2026-11-05") | **`0x77190AD9`** |
- **Block time:** `POST_NU7_POW_TARGET_SPACING = 25 s` ("from NU7 activation, as defined by ZIP 218"). It was 75 s before. The live average is about 25.8 s. The spec's "about 75 s per payment" is therefore out of date: one confirmation now averages about 25 s, and a 30 s poller is roughly one block.
- **Orchard revision V3** (NU6.3 and NU7): *"cross-address transfers are prohibited for the Orchard value pool and permitted for the Ironwood value pool"* (`OrchardProtocolRevision`).
- **Pool routing** (`zcash_client_backend-0.25.0/src/data_api/wallet/input_selection.rs` ~L1016–1037): for a UA with an Orchard receiver, *"After NU6.3 the Orchard turnstile (a consensus rule) forbids adding value to the Orchard pool, so the payment must be delivered through the Ironwood bundle, which only a version 6 transaction carries"*, and the pool is set to `PoolType::IRONWOOD`. A UA with only a Sapling receiver pays into Sapling.
- **Decrypting Ironwood** (`orchard-0.16.0/src/note_encryption.rs`): `IronwoodDomain` *"is otherwise identical to OrchardDomain, but accepts only NoteVersion::V3 note plaintexts, which use lead byte 0x03"* (Orchard uses `0x02`). V3 is the quantum-recoverable plaintext from ZIP 2005. `pepper-sync/src/scan/transactions.rs:256`: *"Ironwood outputs decrypt with the same orchard key material."* So the merchant's normal Orchard IVK, which is the Orchard item of the UIVK, decrypts deposits.
- **Transaction versions** (`zcash_primitives-0.31.0` changelog, 2026-10-21): under NU7, `TxVersion::suggested_for_branch` gives V6, and V5 and V6 are both valid while V4 is not. The default expiry delta is **120 blocks from NU7** (it was 40), about 50 minutes at 25 s. Sprout is gone at NU7 (`has_sprout` is false).
- **Crate versions that understand NU7 testnet txs:** librustzcash commit `928592188ba9b110fc9a3205d05fc3f6b3cbd61d` (2026-09-22, *"zcash_protocol: expose NU7 with branch ID 0x77190AD9 and align local epochs"*) is the first. Before it, NU7 sat behind `--cfg zcash_unstable="nu7"` with the placeholder `0xFFFFFFFF`, and an earlier proposal used `0x77190AD8` (named `RETIRED_NU7_BRANCH_ID` in tests). Crates.io releases with no cfg flag needed: `zcash_protocol 0.11.0`, `zcash_primitives 0.31.0`, `zcash_client_backend 0.25.0`, `zcash_keys 0.17.0`, `zcash_address 0.14.0` (all 2026-10-21) and `orchard 0.16.0` (2026-09-29). The pre-release `zcash_protocol 0.11.0-pre.0` is also fine. **Facilitator: check what Hanko and Kage pin.** Anything built on `zcash_protocol ≤ 0.10.6` fails, as zingolib issue #2859 shows: *"server returned invalid transaction. invalid consensus branch id 0x77190ad9"* (fixed in zingolib PRs #2903 and #2891, 2026-10-13). [docs]

## 3. zingo-cli: versions, NU7 support, build

**Repo** `github.com/zingolabs/zingolib`, cloned to `…/scratchpad/downloads/wallet-cli/zingolib` [ran]:

- `dev` HEAD is `3fb32d277ef956e75da124c1442526fb4d91d97a` (2026-10-26 18:56 -0700). It is six commits past the tag below.
- **Tag `zingolib_v8.0.0-rc.0` → commit `755c3adaea5906cf55357e69ad1b0a27d746cdb8`** (2026-10-26). Pins `zcash_client_backend =0.25.0`, `zcash_primitives =0.31.0`, `zcash_protocol =0.11.0`, `zcash_keys =0.17.0`, `orchard 0.16.0` (the NU7 release cohort). **Recommended pin.**
- Tag `zingolib_v7.0.0` → `bfb0a2156819ea7f75a9b09b1724abfd06c8925e` (2026-10-15, the "Latest" GitHub release). It uses the NU7 pre-release cohort (`zcash_protocol =0.11.0-pre.0`), which already knows testnet NU7 at 4,465,026 with `0x77190AD9`.
- `zingolib_v6.0.0` (2026-09-08) and older: `zcash_protocol 0.10.x` → **broken on testnet since NU7** (issue #2859).
- Version strings: the zingo-cli crate is `0.4.0`, but `--version` prints `0.1.1` (`zingo-cli/src/version.rs`). The `version` command prints `zl_<zingolib crate version>_<16 hex of commit>`; the zingolib crate is still `7.0.0` at the rc tag.
- **No prebuilt binaries.** Each GitHub release has only `zingolib_v7.0.0.zip` and `.tar.gz` source archives [docs: releases/expanded_assets page].
- The repo doesn't use `zcash_unstable` anywhere; NU7 needs no cfg flag [ran: grep].

**Builds** [src: `zingo-cli/Cargo.toml`, `src/lib.rs`, `tools/workbench/src/bin/run-cli.rs`, `bundle-nym-proxy.rs`]

- Feature `nym` is on by default. In that build, a connected session runs Mixnet Mode *"unconditionally and fails closed: Transmission and the price fetch travel the mixnet, nakednet carries sync alone, and no command routes a Transmission … over nakednet"* (zingo-cli CHANGELOG, Unreleased). Going online runs `start_mixnet_session(Spawn, MixnetStartPolicy::ForcedOn)`, which needs a `nym-proxy` binary. The binary is looked up from `--nym-proxy`, then `$ZINGO_NYM_PROXY`, then beside the zingo-cli binary, then `PATH`. A healthy mixnet round trip takes about 3 s with tails over 15 s; the bounds are `MIXNET_ROUND_TRIP_BOUND` 30 s and `TRANSMIT_READINESS_BUDGET` 90 s (`zingo-netutils/src/time.rs`). That is a poor fit for a demo.
- **Recommended for the demo: a nakednet build.** Without `nym`, going online is refused unless `nakednet-test-mode` is also on. With it, sends go straight to the indexer (`#[cfg(not(feature = "nym"))] let wire = Wire::Nakednet;` in `zingolib/src/lightclient/send.rs`). Every online launch prints this to stderr: *"WARNING: this build carries `nakednet-test-mode`, so it went online with NO mixnet. Every request — sync, and anything else this session makes — travels nakednet, and the indexer sees this machine's IP address. …"*

```bash
git clone https://github.com/zingolabs/zingolib.git && cd zingolib
git checkout 755c3adaea5906cf55357e69ad1b0a27d746cdb8        # tag zingolib_v8.0.0-rc.0
# rust-toolchain.toml pins channel 1.99.0. rustup installs it on first build, or set
# RUSTUP_TOOLCHAIN=stable if your stable is >= 1.99 (this machine has 1.99.1).
cargo build --release --locked -p zingo-cli --no-default-features --features nakednet-test-mode
# -> target/release/zingo-cli   (set CARGO_TARGET_DIR to put it elsewhere)
```

- Default (mixnet) build, for reference: `cargo build --release -p zingo-cli` plus `cargo build --release -p zingo-netutils --features nym --bin nym-proxy`, with `nym-proxy` placed beside `zingo-cli`. `makers run-cli --build-only` does both. `makers run-cli --nakednet` builds without nym but **does not** add `nakednet-test-mode`, so that binary can't go online.
- Build prerequisites [src]:
  - protoc is **not** needed: `lightwallet-protocol 0.4.0` ships committed bindings, *"so a build of zingolib no longer needs protoc"*.
  - A C toolchain is needed for `aws-lc-sys`.
  - zingolib's `build.rs` downloads the Sapling parameters (47,958,396 + 3,592,860 bytes) from `https://download.z.cash/downloads` into `$XDG_DATA_HOME/ZcashParams` (on macOS that is `~/.local/share/ZcashParams`; see `zcash_proofs-0.31.0` `default_params_folder`). It embeds them with `include_bytes!`, so the built binary needs no parameter files at runtime.

## 4. zingo-cli launch flags and modes [src: `zingo-cli/src/lib.rs` `build_clap_app`, `get_communications`, `CliConfigTemplate::fill`, `startup_async`]

Session options must come **before** the command. A session option placed after the command gets `error: <guidance>` and exit code 2.

| Flag | Meaning |
|---|---|
| `-c, --chain <mainnet\|main\|testnet\|test\|regtest>` | Defaults to mainnet. Use one data dir per chain. |
| `--server <URI>` | The session's indexer. Giving it also means consent to go online. A URI without a scheme becomes `https://`, and one without a port gets `:443`. **Testnet has no default indexer**: going online without `--server` fails with `no Default Indexer exists for … ; name an indexer URI`. |
| `--data-dir <PATH>` | The wallet file is `<data-dir>/zingo-wallet.dat`. Default `./wallets`. |
| `-n, --nosync` | Skip the sync at startup. Never use it before a send. |
| `--waitsync` | Block until sync reaches the tip, then run the command. It also sets `shutdown_on_completion=true`, so the sync stops at the tip. |
| `--seed <PHRASE>` / env `ZINGO_SEED` | Restore from seed. Requires `--birthday`. Fails if a wallet already exists. |
| `--viewkey <UFVK>` | Create a view-only wallet. Requires `--birthday`. |
| `--birthday <u32>` | Birthday for a restore. |
| `--online`, `--remember-online`, `--forget-online`, `--offline` | Consent controls. `--online` combined with a command that needs no network is refused (`OnlineGrantUnused`). |
| `--log-file <PATH>` | REPL log file. Default `.zingo-cli/cli.log`, relative to the working directory. |
| `ZINGO_DISABLE_SAVER=1` | Nothing is persisted. Don't set it. |

- **Wallet creation:** if `<data-dir>/zingo-wallet.dat` is missing, a new seed wallet is created. When online, its birthday is the current tip from `GetLatestBlock`, so the first sync is short. When offline, the birthday is `--birthday` or the built-in floor `LIB_BIRTHDAY_TESTNET = 4,134,000` (about 413k blocks to scan). **Always create wallets online.** stderr shows `Creating a new wallet`.
- **Wallet settings** set by the CLI (`build_zingo_config`): `PerformanceLevel::High`, `TransparentAddressDiscovery::default()`, `min_confirmations = 3`, `shutdown_on_completion = --waitsync`.
- **No file locking** on `zingo-wallet.dat` (grep found none). Never run two processes on the same data dir. The adapter must serialize access.

**One-shot mode** (`zingo-cli [opts] <command> [args]`):

- Startup runs `sync run` (unless `--nosync` or offline), then `save run`. With `--waitsync` it then awaits the sync. Then it runs the command, then `quit` (which saves).
- stdout carries only the command's result (`println!`).
- stderr carries everything else:
  - notices: `Launching sync task...`, `Launching save task...`, the nakednet WARNING;
  - heartbeats every 10 s (every 8 s for transmits), formatted `<label>: <detail> (<n>s elapsed)`;
  - the trailer `Save task shutdown successfully.` and `Zingo CLI quit successfully.`;
  - errors.
- Exit codes: `0` ok, `1` the command failed, `2` usage or parse error.
- Error format on stderr: `Error: <top>` followed by one `caused by: <next>` line per source. Example from a unit test: `Send error.\ncaused by: No proposal found in the wallet.` The old in-band `{"error": …}` JSON is gone (ADR 0031).
- A failed `--waitsync` prints `error: <chain>` in lowercase to stderr. The command still runs on whatever state the wallet has.

**REPL mode** (no command): `rustyline` `DefaultEditor`.

- When stdin is **not a TTY**, rustyline 18.0.1 reads lines straight from stdin and **prints no prompt** (`readline_with` → `readline_direct`, "stdin is not a tty").
- Each line is split with `shellwords`, so quote JSON and memos with spaces. A bad line prints `Mismatched Quotes` on stdout, and the loop continues.
- Output is `println!("{output}")`; errors go to stderr through `eprintln!`. Tracing goes to the log file.
- Before each line, the loop polls sync. If sync died it prints `Sync error: Error: …` and `Please restart sync with \`sync run\`.` to stderr. **The nakednet build has no automatic sync recovery**: `SyncRecovery` attempts exist only with `nym`.
- `quit` (alias `exit`) saves and exits. **EOF or Ctrl-D exits without sending `quit`**, so always send `quit` before closing stdin.
- Without `--waitsync`, sync **runs continuously**. It scans new blocks and watches the mempool through `GetMempoolStream` (pepper-sync).
- The send proposal lives only in memory (`send_proposal: None` when the wallet file is read). So `send` followed by `confirm` works only inside one process; one-shot mode needs `quicksend`.

## 5. Command reference with exact output shapes [src: `zingo-cli/src/commands.rs`, `commands/utils.rs`, zingolib `summary/data.rs`, `balance.rs`]

JSON is pretty-printed with 2-space indent unless noted.

| Command | Output (stdout) |
|---|---|
| `addresses` | `[{"account":0,"address_index":0,"has_orchard":true,"has_sapling":false,"has_transparent":false,"encoded_address":"utest1…"}]`. A new spend wallet's index 0 is **Orchard-only** (`default_receivers()` → `ReceiverSelection::orchard_only()`). |
| `new_address <o\|z\|oz>` | `{"account":0,"address_index":N,"has_orchard":…,"has_sapling":…,"has_transparent":false,"encoded_address":"utest1…"}`. Never adds a transparent receiver. |
| `t_addresses`, `new_taddress` | Transparent `tm…` addresses (only for a faucet that requires them) |
| `export_ufvk` | `{"ufvk":"uviewtest1…","birthday":N}`. Encoded at ZIP 316 Revision 0 when that can carry the key, else Revision 2 (`uvftest…`). |
| `recovery_info` | Text: `Wallet backup info:\n{\n    seed phrase: …\n    birthday: N\n    no_of_accounts: 1\n}` |
| `wallet_kind` | 4-space JSON `{"kind":"Loaded from mnemonic (seed or phrase)","transparent":true,"sapling":true,"orchard":true}` |
| `parse_address <addr>` | Single-line JSON. For a UA it adds `"receivers_available":[…]` and `"only_orchard_ua":"utest1…"` (an Orchard-only re-encoding). |
| `parse_viewkey <ufvk>` | 4-space JSON `{"status":"success","chain_name":"test","address_kind":"ufvk","pools_available":["orchard","sapling","transparent"]}` |
| `height` | `{"height":4547xxx}` (the wallet's last known chain height) |
| `info` | `{"version","git_commit","server_uri","vendor","taddr_support","chain_name","sapling_activation_height","consensus_branch_id","latest_block_height"}` |
| `balance` | **Not JSON.** A `[` … `]` block with lines `    confirmed_ironwood_balance: 1_234_000`, `unconfirmed_…`, `total_…` for ironwood, orchard, sapling and transparent. Thousands are separated by `_`. Without a view key the value is `no view capability`. Parse with `/^\s+(\w+): ([\d_]+)$/m` and strip the `_`. "Confirmed" means mined; values at or below 5,000 zat count as dust and are excluded. |
| `spendable_balance` | `{"spendable_balance":N}`. Counts shielded notes that are mined at or below the anchor (tip+1−min_confirmations), above dust, witnessable, and known unspent (see §6.6). |
| `notes [all]` | `{"ironwood_notes":[{"value","status":"confirmed at block height N","spend_status":"unspent\|calculated spent in <txid>\|transmitted spent in …\|mempool spent in …\|confirmed spent in …","memo","time","txid","output_index","account_id","scope":"external\|internal"}],"orchard_notes":[…],"sapling_notes":[…]}` |
| `transactions` | **Not JSON.** One block per tx, each starting on a new line: `{\n    txid: <hex>\n    datetime: 2026-10-27 12:00:00 UTC\n    status: confirmed\|mempool\|transmitted\|calculated\|failed\n    blockheight: N\n    kind: sent\|received\|shield\|send-to-self\n    value: N\n    fee: N\n    zec price: …\n    pools sent from: Ironwood\n    ironwood notes: …\n    … outgoing ironwood notes: …\n}`. For an unmined tx, `blockheight` is the target height (chain tip + 1 when it was created or seen), not a mining height. |
| `value_transfers`, `messages [filter]` | Text and JSON respectively (`messages` is pretty JSON of value transfers that carry memos) |
| `sync run\|pause\|stop\|status\|poll` | `status` → JSON with `scan_ranges[{priority,start_block,end_block}]`, `total_blocks_scanned`, `total_blocks`, `percentage_total_blocks_scanned`, `total_ironwood_outputs_scanned`, … In one-shot mode `sync run` waits for completion and prints `Sync result:\n{…}`. |
| `settings` / `settings min_confirmations <n>` / `settings performance <low\|medium\|high\|maximum>` | Text listing / `Successfully updated settings.` |
| `send <addr> <zat> ["memo"]` or `send '<json array>'` | `{"fee":10000}`. Proposal only. |
| `confirm` | `{"txids":["<hex>"]}`. Builds, proves and transmits the stored proposal, then resumes sync. |
| `calculate` / `transmit [txids…]` | Sign without sending → `{"txids":[…]}` with status `calculated`; `transmit` sends them later. |
| **`quicksend <addr> <zat> ["memo"]`** or **`quicksend '<json array>'`** | `{"txids":["<hex>"],"transmissions":[{"txid":"<hex>","over_mixnet":false,"destination":"testnet.zec.rocks","rtt_ms":N}]}` |
| `send_all <addr> ["memo"]` | `{"amount":N,"fee":N}`, then `confirm` |
| `max_send_value <addr>` | Display only |
| `shield` / `quickshield` | Moves transparent funds into **Ironwood**. `shield` prints `{"value_to_shield","fee"}`; `quickshield` prints `{"txids":[…]}`. |
| `remove_transaction <txid>` | Only for status `failed` |
| `rescan`, `clear` | Recovery tools |
| `version` | `zl_7.0.0_<16 hex>` (good end-of-reply marker) |
| `quit` / `exit` | stdout `Zingo CLI quit successfully.` (in one-shot mode the trailer goes to stderr) |

Send arguments (`commands/utils.rs::parse_send_args`):

- Positional form: 2 or 3 args, `address`, `amount` as a u64 in zatoshis (whitespace trimmed), and an optional `memo`.
- JSON form: exactly 1 arg, a non-empty array of objects with `"address"` (string), `"amount"` (JSON number, u64) and optional `"memo"` (string).
- A memo to a transparent address is refused: `memo's cannot be sent to transparent addresses.`
- A memo that starts with `-` must follow `--`.
- Error strings: `json array has no arguments`, `json array is missing "amount" key.`, `failed to interpret memo. …`, `arguments given are invalid.`, each followed by `Try 'help quicksend' for correct usage and examples.`

## 6. Sends in detail

### 6.1 Memo [src]
`zingolib::wallet::utils::memo_bytes_from_string` takes the **raw UTF-8 bytes** of the string, `MemoBytes::from_bytes` rejects anything over **512 bytes** (`MemoError::TooLong(len)`), and the result is zero-padded to 512. `"<64-hex ed25519 pubkey>:<depositIndex>"` is about 66–70 bytes and its first byte is an ASCII hex digit (below 0xF5), so it parses as a ZIP 302 text memo. Facilitator: strip trailing `0x00` bytes and decode as UTF-8. In V3 (Ironwood) plaintexts the memo is still the 512-byte field (`IronwoodDomain::split_plaintext_at_memo`). zingolib also puts a wallet-internal memo listing recipient UAs on the **change** output, which goes to the sender. The merchant's output carries only our memo.

### 6.2 Multi-recipient send and note splitting [src]
ZIP 321 requests (`zip321-0.10.0` `TransactionRequest::new`) allow up to 9,999 payments and don't forbid repeating an address. zingolib uses `SingleOutputChangeStrategy`, so it never splits change on its own. To split into 5 notes, send to yourself once:

```
quicksend '[{"address":"<own utest1…>","amount":200000},{"address":"<own utest1…>","amount":200000},{"address":"<own utest1…>","amount":200000},{"address":"<own utest1…>","amount":200000},{"address":"<own utest1…>","amount":200000}]'
```

The payments land in Ironwood; a self-send counts as `send-to-self` and its `pools_received` is `[Ironwood]`.

### 6.3 Fees (ZIP 317) [src: `zcash_primitives-0.31.0/src/transaction/fees/zip317.rs`]
`fee = 5000 × max(2, logical_actions)`, where `logical_actions = max(⌈t_in/150⌉, ⌈t_out/34⌉) + max(sapling_in, sapling_out) + orchard_actions + ironwood_actions`. An Orchard or Ironwood bundle has `max(spends, outputs)` actions.

| Transaction | Fee |
|---|---|
| Deposit: 1 Ironwood note in, payment and change out | 2 actions → **10,000 zat** |
| Split: 1 note in, 5 payments and change out | 6 actions → **30,000 zat** |
| Spending an old **Orchard** note to a merchant | Orchard bundle (spend and change) plus Ironwood bundle (payment). Actions of both bundles are charged, so it costs more than 10,000 zat [inf]. Self-send first so the wallet holds only Ironwood notes. |

### 6.4 Pools a zingo send uses [src]
- The payment to an Orchard receiver goes into **Ironwood**.
- Change goes to `payment_pool(chain, height)`, which is `ShieldedPool::Ironwood` from NU6.3 on (`zingolib/src/wallet/propose.rs:58`).
- Spending a legacy Orchard note keeps its change in Orchard (test `orchard_note_send_keeps_change_in_orchard_pool_post_nu6_3`).
- Transparent funds are spent only by `shield`/`quickshield` (README "Note Management"), so a normal send has **no transparent inputs or outputs**.

### 6.5 Txid, transmission, expiry, proving
- **Txid format:** `TxId` `Display` is `ReverseHex`, 64 lowercase hex chars in explorer and RPC order (`zcash_protocol-0.11.0/src/txid.rs`). The CLI parses txids with `txid_from_hex_encoded_str`, which hex-decodes and reverses. After `SendTransaction`, zingolib parses the txid string the server returns and fails with `IncorrectTxidFromServer` if it differs, so the printed txid is the one the node accepted. For lightwalletd `TxFilter.hash` use `Buffer.from(hex,'hex').reverse()` (checked live in §1).
- **Transmission:** a direct gRPC `SendTransaction` to the session indexer. On failure it retries every 1 s (`TRANSMIT_RETRY_INTERVAL`) and checks `GetTransaction` to see whether the server already has the tx. The status becomes `Transmitted(target height)` and the wallet is marked for saving. `quicksend` returns once the server accepts the tx; it doesn't wait for a block.
- **Expiry:** target height + **120** blocks from NU7 (`wallet::expiry::NU7_TX_EXPIRY_DELTA` = `NU7_DEFAULT_TX_EXPIRY_DELTA`), about 50 minutes. When the chain passes the expiry, sync marks the tx `failed` and frees its notes (`remove_transaction <txid>` drops it).
- **Proving:** Orchard and Ironwood share the post-NU6.3 Halo2 circuit. zcash_primitives keeps a process-wide `cached_orchard_proving_key`, and zingolib's test helper calls building it a *"multi-second build"* (`zingolib/src/testutils.rs:588`). A Sapling prover (about 51 MB of parameters) is parsed only when a Sapling spend or output is present. So a **one-shot process pays the proving-key build on every send**, while a REPL pays it on the first send only. I couldn't measure the actual proving time (§0).

### 6.6 Confirmations, spendability and ZIP 315 [src]
- zingolib applies `ConfirmationsPolicy::new_symmetrical(min_confirmations, false)` (`wallet/propose.rs:109`): the same depth for **trusted change and untrusted received notes**, default **3**. ZIP 315 recommends 3 trusted and 10 untrusted; zcash-devtool's default follows that. Change it with `settings min_confirmations 1`, which takes effect at once and is saved.
- A note is spendable when it is mined at a height ≤ `tip + 1 − min_confirmations` (the anchor), its value is above 5,000 zat, a witness can be built, and **every scan range above it has been scanned** (`spend_horizon`, `note_spends_confirmed` in `wallet/propose.rs:360–396`).
- **Known open issue #2835** (testnet.zec.rocks, 2026-10-02, still open): sync ends with `GetBlock: block N is newer than the latest block` when lightwalletd announces a tip block it can't serve yet. A `ChainTip` range stays unscanned, `spendable_balance` drops to 0, and sends fail with `Insufficient balance (have 0, need 10001 including fee)`. During continuous sync the same brief "0 spendable" can show up whenever a new block is still being scanned [inf]. zingolib's own live-testnet harness retries sync up to 5 times (`testutils/chain_generics/networked.rs`).
- Insufficient-funds error as the CLI would render it [src/inf]: `Error: Send error.` / `caused by: Propose send error.` / `caused by: Insufficient balance (have <spendable>, need <amount+fee> including fee)`. For a 100,000 zat deposit from an empty wallet that is `need 110000`.

### 6.7 Status lifecycle [src: `zingo-status/src/confirmation_status.rs`]
`calculated` (signed, not sent) → `transmitted` (the server accepted it, but it hasn't been seen in the mempool) → `mempool` (seen in `GetMempoolStream`) → `confirmed` (`blockheight` = the mining height). The tx becomes `failed` if it is rejected or expires. `notes` mirrors this in `spend_status`.

## 7. CLIENT wallet adapter: recommended design

### 7.1 Setup (once, before the demo)
```bash
Z=/abs/zingo-cli
NET="--chain testnet --server https://testnet.zec.rocks:443"
A=/abs/wallets/agent
$Z $NET --data-dir $A --waitsync height             # creates the wallet (birthday = tip), syncs, prints {"height":…}
$Z --chain testnet --data-dir $A recovery_info      # back up the seed (offline: no --server)
$Z --chain testnet --data-dir $A addresses          # index 0 = Orchard-only utest1… -> fund this
#   (if the faucet only pays t-addresses: t_addresses, then later `$Z $NET --data-dir $A --waitsync quickshield`)
# after funds are mined and have 3 confirmations (about 75 s):
$Z $NET --data-dir $A --waitsync spendable_balance
$Z $NET --data-dir $A --waitsync quicksend '[{"address":"<A utest1>","amount":200000}, … ×5]'   # split
$Z $NET --data-dir $A --waitsync notes              # expect at least 5 unspent ironwood_notes of 200000 once confirmed
```

Budget for 150 calls at W = 100,000: 2–3 deposits × (100,000 + 10,000 fee), plus the 30,000 split fee. Five notes of 200,000 cover it with margin. Each deposit spends one confirmed note, so a deposit never waits for the previous deposit's change.

### 7.2 Long-lived process protocol (preferred) [src-derived; not run]
- Spawn `zingo-cli --chain testnet --server https://testnet.zec.rocks:443 --data-dir <A> --log-file <A>/cli.log` with no command and no `--waitsync`, using pipes for stdin, stdout and stderr. Leave `RUST_LOG` unset.
- Send **one command at a time**. Write `<command>\nversion\n` and collect stdout until a line matches `/^zl_\d/`; everything before it is the result. A JSON result spans several lines; join them and run `JSON.parse`. After the marker, wait about 20 ms and read stderr. A line starting with `Error: ` (and the `caused by: ` lines after it) means the command failed. Ignore the other stderr narration: the WARNING, `Launching …`, `<label>: … (Ns elapsed)` heartbeats, `Sync result:` blocks.
- If stderr shows `Sync error: Error:`, write `sync run` (no auto-recovery in this build).
- Quoting: wrap the JSON array in single quotes, e.g. `quicksend '[…]'`, and wrap the memo in double quotes, e.g. `quicksend utest1… 100000 "abcd…:3"`.
- Shut down with `quit` and wait for the process to exit.

### 7.3 Deposit procedure
1. `spendable_balance`. If it is below `windowZat + 10000`, wait 2 s and retry, up to about 30 s. This covers the scan race in §6.6.
2. `quicksend <payTo> <windowZat> "<sessionKeyHex>:<depositIndex>"`. Read `txids[0]` (64-hex display order) and put it in the payload as `depositTxid`.
3. On `Insufficient balance (have 0` → wait 2 s and retry (at most 5). On `Transmission error.` → retry once. The proposal is rebuilt each time. Never run two deposits at once.

### 7.4 Tracking confirmation (the client's "no deposit pending" check)
- (a) Parse `transactions` and find the block with `txid: <hex>`. `status: confirmed` together with `blockheight: N` means mined at N. `transmitted` or `mempool` means pending; `failed` means expired or rejected.
- (b) Or skip the wallet: call lightwalletd `GetTransaction` with the reversed bytes; `height > 0` means mined.
- (c) Or have the facilitator report deposit status in the settle response. That is a wire-contract option for the two agents to agree on.

At about 25 s per block, the first confirmation arrives after roughly 25 s on average.

### 7.5 One-shot fallback
`$Z $NET --data-dir $A --waitsync quicksend <payTo> <zat> "<memo>"`. Always pass `--waitsync`: without it the background sync and the send race, and the wallet may be stale. Expect a few seconds of startup and sync plus the proving-key build on every call [inf, not measured]. **Measure first:** `time $Z $NET --data-dir $A --waitsync height`, and `time` of one real deposit.

## 8. FACILITATOR side: merchant UA and UIVK

Option A, zingo-cli for the wallet and zcash-devtool for the UIVK [src]:
```bash
M=/abs/wallets/merchant
$Z $NET --data-dir $M --waitsync height                 # create the merchant wallet (birthday = tip)
$Z --chain testnet --data-dir $M addresses              # address_index 0, Orchard-only "utest1…"  -> payTo
#  (or `new_address o` for a fresh Orchard-only UA; `new_address oz` adds Sapling, which the facilitator must then also scan)
$Z --chain testnet --data-dir $M export_ufvk            # {"ufvk":"uviewtest1…","birthday":N}
$Z --chain testnet --data-dir $M recovery_info          # seed backup (keep it away from the facilitator)
# UIVK (zingo-cli has no UIVK command):
DT=/abs/zcash-devtool   # built from github.com/zcash/zcash-devtool @0b3436bb
$DT wallet -w /abs/wallets/merchant-view init-fvk --name merchant --fvk "<uviewtest1…>" --birthday N   # -s defaults to zecrocks (testnet.zec.rocks:443)
$DT wallet -w /abs/wallets/merchant-view list-accounts  # prints "     UIVK: uivktest1…" and "     UFVK: uviewtest1…"
```

Option B, devtool only: `wallet -w M init --name merchant -i M/id.age -n test`, then `wallet -w M list-accounts` for the UIVK and UFVK, then `wallet -w M generate-address --pool orchard` for an Orchard-only `utest1…`.

- **Hanko** `verify({ rail:'zcash', uivk, txid, amountZat, memo }, { lwdUrls })` takes a **UIVK** and trial-decrypts Sapling, Orchard and Ironwood (Hanko README) [docs]. Any diversified address from the same IVK decrypts, so the zingo address index doesn't matter.
- Testnet HRPs (`zcash_address-0.14.0/src/constants.rs`): UA `utest` (R0) / `zutest` (R2); UFVK `uviewtest` / `uvftest`; UIVK `uivktest` / `uvitest` [src].
- Demo step 7 ("decrypt it with the viewing key"): `$Z $NET --data-dir /abs/wallets/merchant-watch --viewkey "<UFVK>" --birthday N --waitsync notes` shows each deposit's value and memo. `messages` lists the memos.
- What the facilitator has to handle:
  - txs are v6 with branch id `0x77190AD9`;
  - deposits arrive in the **Ironwood bundle**;
  - a mempool tx returns `height=0`;
  - txids must be byte-reversed for lightwalletd;
  - an unmined deposit expires at target + 120 blocks (the expiry is at bytes 16–19 of the raw tx).

## 9. Alternatives evaluated

**zcash-devtool**, `github.com/zcash/zcash-devtool` HEAD `0b3436bb8d235c67cd36b800cb45a7b1b489c415` (2026-10-17). Viable fallback for the client [src]:

- **Dependencies:** librustzcash git rev `eb38d7a373661179dbc083a2fd58b3a6c9b25818` (2026-10-15): `zcash_client_backend 0.25.0-pre.2`, `zcash_client_sqlite 0.23.0-pre.2`, `zcash_primitives 0.31.0-pre.2`, `zcash_protocol 0.11.0-pre.1`, `orchard 0.16.0`. At that rev `consensus.rs` sets testnet `Nu7 => Some(BlockHeight(4_465_026))` and `0x7719_0ad9 => Ok(BranchId::Nu7)` with no cfg flag, so NU7 and Ironwood are supported.
- **Caveats:** the README says *"DO NOT USE THIS IN PRODUCTION"*, *"No binary artifacts are provided"*, and *"can and will change at any time"*. Run it with `cargo run --release -- …`.
- **Commands:**
  - `wallet -w D init --name N -i <age identity> -n test` (birthday defaults to the tip; the identity file is created if missing)
  - `wallet -w D sync` (`-s zecrocks` is the default and means `testnet.zec.rocks:443` on testnet; `-s host:port` also works; `--connection direct` is the default and Tor is opt-in)
  - `wallet -w D balance`
  - `wallet -w D send -i <age> --address <ua> --value <zat> --memo "<text>" [--min-confirmations N]`: prints `Creating transaction...`, the proposal, `Sending transaction...`, then **the txid on the last stdout line** (display order). It sends nothing it hasn't synced, so run `sync` first.
  - `wallet -w D fan-out -i <age> --target-note-count 5 --min-split-output-value <zat>`: a built-in note splitter (self-pays `--value` 1000 and splits the change).
  - `wallet -w D list-tx --json`: one-line `[{"txid","mined_height"}]`, with `mined_height` null when unmined.
  - `wallet -w D list-accounts` (UIVK and UFVK), `init-fvk`, `import-ufvk`, `generate-address --pool orchard`.
- **Confirmation policy:** `ConfirmationsPolicy::default()` (3 trusted / 10 untrusted) unless `--min-confirmations N`, which is symmetric.
- **Limits:** no long-lived mode, so every send pays process startup, sync and the proving-key build; no mempool tracking.

**Zallet**, `github.com/zcash/wallet` HEAD `d29642929488685dd14e033e001b2dc9d3b28701` (2026-10-21, latest tag `v0.1.0-beta.3`). **Not usable** [src/docs]:
- It pins librustzcash rev `1f6bb2072e7fcb142b0d90ff7b267a8699a84818` (2026-08-20) with `zcash_protocol 0.10.5`, where NU7 is `#[cfg(zcash_unstable = "nu7")]`, testnet NU7 is `None`, and the branch id is `0xffff_ffff`. It can't build or parse testnet txs after NU7.
- Its changelog has no NU7 entries.
- The Unreleased changelog says it removed the zaino backend and that *"No chain backend currently runs on macOS or Windows, because the zebra backend is Linux-only"*, and the Zebra backend needs a local `zebrad` with the `indexer` feature on the same host.

**Others:**
- zingo-cli from zingolib ≤ 6.0.0 is broken since NU7 (#2859).
- `zaino.testnet.unsafe.zec.rocks:443` *"rejects the Ironwood shielded protocol"* (#2835 text), so use only `testnet.zec.rocks:443`.

**Recommendation**
- Client wallet adapter: **zingo-cli @ `zingolib_v8.0.0-rc.0`, nakednet build, as one long-lived REPL** (continuous sync, mempool status, cached proving key, JSON output). If the REPL framing misbehaves, fall back to one-shot `--waitsync quicksend`. If zingo-cli itself fails, use zcash-devtool `sync`, then `send`, then `list-tx --json`.
- Merchant: UA and UFVK from zingo-cli; **UIVK from zcash-devtool `init-fvk` followed by `list-accounts`**.

## 10. Risks and open questions

- **Unverified:** zingo-cli was not built or run here (permission denied). Startup, sync and proving times, the exact wording of the stderr errors, and the piped-REPL behaviour are all from source. The client agent should measure them in its first hour.
- **Faucet:** `testnet.zecfaucet.com` and `testnet.zecaucet.com` (the latter as listed on ZecHub) don't resolve (`ENOTFOUND`, checked 2026-10-27). The official testnet guide says to ask for TAZ on Zcash Discord. If the faucet that works only pays t-addresses, run `quickshield`.
- **Default build:** the mixnet is fail-closed and sends need `nym-proxy`. The nakednet build exposes the client IP to the indexer, which is acceptable on testnet.
- **Single indexer:** testnet.zec.rocks is one operator. The race in #2835 can zero the spendable balance for a moment, so the adapter must retry.
- **Timing with 25 s blocks:** the first confirmation of a deposit comes about 25 s after broadcast on average (the spec assumes about 75 s). The credit line therefore shows up sooner, and the cheat-mode limit is reached sooner too. A 30 s poller lags by up to one block; 10–15 s would track the chain more closely [inf].
- **Facilitator crates:** Hanko and Kage must use crates that know `0x77190AD9` and Ironwood (≥ librustzcash `928592188` or crates.io `zcash_protocol 0.11.0`, `zcash_primitives 0.31.0`, `orchard 0.16`). Older pins fail on every NU7 testnet tx.
- **Explorer for demo step 7:** v6 and Ironwood support on the testnet explorer (`testnet.zcashexplorer.app`) was not checked.
- **One process per wallet file:** there is no lock, so concurrent zingo-cli processes on one data dir can corrupt or lose state.

## 11. Sources

- zingolib: https://github.com/zingolabs/zingolib at `3fb32d27` (dev) and tags `zingolib_v8.0.0-rc.0` (`755c3ada`) and `zingolib_v7.0.0` (`bfb0a215`). Files: `zingo-cli/{README.md,CHANGELOG.md,Cargo.toml,src/lib.rs,src/commands.rs,src/commands/utils.rs,src/commands/error.rs,src/version.rs}`, `zingolib/{CHANGELOG.md,build.rs,src/config.rs,src/wallet.rs,src/wallet/{balance,propose,send,utils}.rs,src/wallet/summary/data.rs,src/lightclient/send.rs}`, `pepper-sync/src/{keys.rs,scan/transactions.rs}`, `zingo-status/src/confirmation_status.rs`, `zingo-netutils/src/{default_indexer.rs,time.rs}`
- Releases (source archives only): https://github.com/zingolabs/zingolib/releases/expanded_assets/zingolib_v7.0.0
- Issues: https://github.com/zingolabs/zingolib/issues/2835, /2859, /2015
- crates.io sources: zcash_protocol 0.11.0 (`src/consensus.rs`, CHANGELOG), zcash_primitives 0.31.0 (CHANGELOG, `transaction/fees/zip317.rs`), zcash_client_backend 0.25.0 (`data_api/wallet/input_selection.rs`), orchard 0.16.0 (`src/note_encryption.rs`, CHANGELOG), zcash_address 0.14.0 (`src/constants.rs`), zcash_proofs 0.31.0 (`src/lib.rs`), zip321 0.10.0, rustyline 18.0.1 (`src/lib.rs`)
- librustzcash commit `928592188ba9b110fc9a3205d05fc3f6b3cbd61d`; revs `eb38d7a3` and `1f6bb207`: https://github.com/zcash/librustzcash
- zcash-devtool: https://github.com/zcash/zcash-devtool @ `0b3436bb` (`README.md`, `src/commands/wallet/{send,fan_out,list_tx,list_accounts,init_fvk,gen_addr}.rs`, `src/remote.rs`)
- Zallet: https://github.com/zcash/wallet @ `d2964292` (`CHANGELOG.md`, `Cargo.lock`)
- Hanko README: https://github.com/nickthelegend/zec-payment-verify-sdk
- lightwalletd protos: github.com/zcash/lightwallet-protocol `walletrpc/{service,compact_formats}.proto` (local copy in `…/scratchpad/downloads/protos`)
- Zcash testnet guide: https://zcash.readthedocs.io/en/latest/rtd_pages/testnet_guide.html; ZecHub faucets page: https://zechub.wiki/using-zcash/faucets

## Verification corrections

Independent fact-check of this file's load-bearing claims, 2026-10-27. Own sources, not the track's checkout:
- clones under `…/scratchpad/downloads/verify-wallet-cli/`:
  - zingolib `3fb32d27`, with tags `zingolib_v8.0.0-rc.0` = `755c3ada` and `zingolib_v7.0.0` = `bfb0a215`
  - librustzcash `a551fac8` (blobless)
  - zcash-devtool `0b3436bb`
  - Hanko `3c7edae895183b8b0dc1daa395cdb2124ffb20ec` (2026-10-26)
- crates from static.crates.io:
  - zcash_protocol 0.10.6, 0.11.0-pre.0 and 0.11.0
  - zcash_primitives 0.30.1 and 0.31.0
  - zcash_client_backend 0.25.0, orchard 0.16.0, zcash_address 0.14.0, zcash_keys 0.17.0, rustyline 18.0.1
- live grpcurl probes of `testnet.zec.rocks:443`, 12:43–12:50 UTC, tip 4,547,467. Outputs are in `…/scratchpad/spikes/verify-wallet-cli/`.

1. **NU7 crate boundary (§2, TL;DR 2): precision.**
   - Commit `928592188` (committed 2026-09-22) only makes `BranchId::try_from(0x77190AD9)` succeed. Its message says *"Leave public-network activation heights unset"*, and at that commit `TestNetwork` still answers `NetworkUpgrade::Nu7 => None`.
   - The testnet height came later, in `a0c73f6d4` (2026-09-30, *"Set the NU7 testnet activation height to 4465026"*).
   - Code pinned between those two commits still parses NU7 transactions. For v5 and v6, `Transaction::read` reads the branch id from the header and ignores its argument (`zcash_primitives-0.31.0/src/transaction/mod.rs` L973–985).
   - But in that window `BranchId::for_height(testnet, >= 4465026)` still returns `Nu6_3`, so anything that builds transactions on it signs with the wrong branch id.
   - The first crates.io release that has both is `zcash_protocol 0.11.0-pre.0`, published 2026-10-01T02:23:57Z (vcs sha `c47c2f54`). It has `0x7719_0ad9 => Ok(BranchId::Nu7)` and testnet `Nu7 => Some(BlockHeight(4_465_026))`.
   - The mainnet height 3,543,405 is only in `0.11.0` (vcs `c8b579f0`; set by commit `f53a9b46e`, 2026-10-21).
2. **"retired 0x77190AD8" (§2): correction.**
   - No librustzcash release ever mapped NU7 to `0x77190AD8`. In the history of `components/zcash_protocol/src/consensus.rs`, the value first appears in `928592188`, as the test constant `RETIRED_NU7_BRANCH_ID`, and the test asserts that it is *rejected*. `git log -S'0x7719_0ad8' -- components/zcash_protocol/src/consensus.rs` returns only `928592188`.
   - Every release before 0.11 (for example `0.10.6`, vcs `28cf1143`) puts NU7 behind `cfg(zcash_unstable = "nu7")` with the placeholder `0xffff_ffff`.
   - The exact parse error is `invalid consensus branch id 0x77190ad9`. It comes from `read_header_fragment` (with the `std` feature) and is the same in zcash_primitives 0.30.1 and 0.31.0.
3. **Launching without `--server` (§4, TL;DR 4): precision.**
   - The error `no Default Indexer exists for <chain>; name an indexer URI` appears only when consent is given without `--server`, that is with `--online` or `--remember-online`.
   - In the nakednet build, a launch with neither `--server` nor `--online` does **not** fail. `get_communications` returns `UnconsentedOffline`, and the startup sync is skipped (`sync = !nosync && Online`).
   - Every transmitting command (`quicksend`, `confirm`, `quickshield`, `transmit`, and the others in `CliCommand::transmits`) is then refused at dispatch, with exit 1 in one-shot mode. The message is: ``Error: `quicksend` requires network access, and this build has no mixnet capability, so Offline Mode is its only mode. Rebuild with default features (plain `cargo build`, or `makers run-cli`) to go online.``
   - For a nakednet-test-mode build that advice is misleading: the fix is to pass `--server`.
   - Source (rc.0): `zingo-cli/src/lib.rs` L985–1029, L725–750 and L858–866; `zingo-cli/src/commands.rs` L2838–2856 and L2924–2942.
4. **REPL prompt on a pipe (§4 "REPL mode"): correction.**
   - The statement "when stdin is not a TTY rustyline prints no prompt" holds only when `TERM` is not `dumb`, `cons25` or `emacs` (compared case-insensitively).
   - `readline_with` tests `is_unsupported()`, which checks that `TERM` list, **before** the tty check. In that branch it writes the prompt `(test) <status> >> ` to **stdout**, with no newline, even when stdin is a pipe. Source: `rustyline-18.0.1/src/lib.rs` L662–692, `src/tty/mod.rs` L4 and L215–227, `src/tty/unix.rs` L1414.
   - The client adapter should spawn zingo-cli with a `TERM` outside that list (for example `TERM=xterm`), or strip a leading `(test) … >> ` from the output. `TERM` on this machine is `xterm-256color`.
5. **Hanko call (§8, TL;DR 8): correction for the facilitator.**
   - `verify({ rail:'zcash', uivk, txid, amountZat, memo })` as written **refuses every unconfirmed deposit**. `ZcashRequest.minConf` defaults to 1 (`packages/sdk/src/zcash.ts` L19, and L144: `'--min-conf', String(req.minConf ?? 1)`). The core adds the reason `NOT_CONFIRMED` when `confirmations < min_conf` (`packages/core/src/lib.rs` L339).
   - A mempool tx has `confirmations: 0`: `RawTransaction.height == 0` maps to `TxLocation::Mempool` (`lwd.rs` L256).
   - So the zero-conf path must pass **`minConf: 0`**.
   - Other requirements in the same files:
     - `uivk` must start with `uivktest1` (Revision 0). An R2 key `uvitest1…` throws `VerifyError` (`zcash.ts` L116).
     - `txid` must be the 64-hex **display-order** id, parsed with `TxId::from_hex` (`lwd.rs` L297). That is exactly what zingo-cli prints, so pass it through unchanged.
     - `memo` must match the text exactly, after trailing NUL bytes are stripped and the bytes are decoded as a ZIP 302 text memo (`memo_of`, `lib.rs` L175).
     - Any transparent input or output gives the reason `TRANSPARENT_PART`, unless `allowTransparent: true` is set.
   - Each call spawns the Rust binary `zpay-verify`, taken from `ZPV_BIN` or else `packages/core/target/release/zpay-verify`. The default timeout is 90 s (`ZPV_CHECK_TIMEOUT_MS`, L154).
   - The result is `{rail, ok, verdict: 'paid'|'refused'|'unverified', reasons[], paidZat, report, provenance}`.
   - Hanko core pins `zcash_protocol =0.11.0-pre.1`, `zcash_primitives =0.31.0-pre.2`, `zcash_client_backend =0.25.0-pre.2` and `orchard 0.16` (`packages/core/Cargo.toml` L18–25), so it knows NU7 and Ironwood.
   - zcash-devtool's `list-accounts` gives the R0 `uivktest1…` form: at its pinned librustzcash rev `eb38d7a3`, `UnifiedIncomingViewingKey::encode` tries R0 first (`zcash_keys/src/keys.rs` L1872–1877).
6. **Testnet HRPs (§8): correction.**
   - ZIP 316 Revision 2 has two unified-address HRPs, not one: `zutest` (shielded-only) and **`tutest`** (transparent-including, `HRP_UNIFIED_ADDRESS_R2_TI`). Source: `zcash_address-0.14.0/src/constants.rs` L159–167.
   - A shielded-only `payTo` check should accept `utest1…` or `zutest1…` with no p2pkh or p2sh receiver, and reject `tutest1…`.
   - Hanko's `ownsAddress(uivk, ua)` (`zcash.ts` L208) confirms that an address belongs to the key.
7. **Expiry on testnet (§6.5, §8): precision.**
   - `target + 120` holds for transactions built by zingolib 7.0.0 or later and other NU7-cohort builders.
   - Not every testnet wallet does this. Live `GetTransaction` on tx `6dc283f879d746be882833257e6d06a03c25d66041d2115a05b8071a56515a08` (mined at 4,547,467) shows `expiry_height` 4,547,507, which is +40. The header decodes as v6, `0xD884B698`, `0x77190AD9`.
   - A poller should read the expiry from bytes 16–19 of the raw tx rather than assume +120.
8. **Fee of a legacy Orchard spend (§6.3): precision for the row marked [inf].**
   - Orchard V3 bundles (after NU6.3) forbid cross-address transfers. `BundleType::num_actions` then counts `spends + outputs` instead of `max(spends, outputs)`. Source: `orchard-0.16.0/src/builder.rs` L120–130, and `src/bundle.rs` L160–176 (`permits_cross_address_transfers`).
   - Ironwood V3 permits cross-address transfers, so the 10,000 and 30,000 zat figures for Ironwood notes stand.
   - One Orchard note spent with Orchard change, plus the Ironwood payment, is 2 + 2 actions, so 20,000 zat [inferred from source].
9. **Date (§2): minor.** `orchard 0.16.0` was published to crates.io at 2026-09-30T22:13:51Z, not 2026-09-29 (crates.io API).

Checked and confirmed, no change needed:
- **Pool routing:**
  - `input_selection.rs` L1016–1037 routes an Orchard receiver to `PoolType::IRONWOOD` once Ironwood is active, and a Sapling-only UA to Sapling. zingolib calls this through `propose_transfer` with `GreedyInputSelector`.
  - Live, blocks 4,547,417–4,547,467 had 0 Orchard actions, 0 Sapling outputs and 157 Ironwood actions, and the Orchard tree stayed at 249,856.
- **`IronwoodDomain`:** the same IVK and KDF as `OrchardDomain`, but it accepts only V3 plaintexts. V3 notes derive `rcm` with the ZIP 2005 `rcm_v3`; that matters only to a cmx check written outside the Rust crates.
- **zingolib:** the tags, the crate pins and `Cargo.lock`; issue #2859 was closed on 2026-10-13 via PRs #2903 and #2891.
- **The nym default and the nakednet build command.** `run-cli --nakednet` equals `cargo build -p zingo-cli --no-default-features`, and `sync-bench` adds `--features nakednet-test-mode`. zingolib's own default features are empty.
- **quicksend output:** the JSON shape is as described; `destination` is the lowercased host with no port.
- **Errors and exit codes:** error rendering is as described, and exit codes are 0, 1 and 2. A startup error prints `Error: {e}` and exits 1.
- **Sends:**
  - memo bytes;
  - the ZIP 317 formula;
  - no transparent inputs (transparent UTXOs are fetched only in `gather_shielding_inputs`);
  - the 120-block expiry and the `failed` status.
- **Keys and addresses:**
  - index 0 is Orchard-only and R0 `utest1…`, and `new_address` never adds a transparent receiver;
  - `export_ufvk` output;
  - zingo-cli has no UIVK command, and zcash-devtool's `init-fvk` and `list-accounts` work as described;
  - zcash-devtool's `inspect` on a UFVK prints only per-item keys, not a UIVK.
- **Txid byte order** (checked live): the protocol-order hash `085a5156…` returns `height 4547467`, and the display-order hash returns `NotFound`.
