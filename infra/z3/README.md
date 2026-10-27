# Z3 regtest stack

A local Zcash regtest chain for z402: Zebra (node), Zallet (agent wallet) and Zaino
(lightwalletd-compatible gRPC for the facilitator), run from
[ZcashFoundation/z3](https://github.com/ZcashFoundation/z3) at `e84ce9fd`. We mine our own
coins and blocks. Observed behaviour is recorded in
[`docs/research/client/z3-live.md`](../../docs/research/client/z3-live.md).

Requires Docker with Compose v2.24.4+, Node 24.2+ (Node 26 tested), git, `jq` and `openssl`.

## Commands

```bash
bash infra/z3/up.sh                  # bring the stack up, wait until all three answer (idempotent)
bash infra/z3/fund-agent.sh          # fund the agent, print AGENT_UA and its spendable balance
node infra/z3/clock.mjs mine [n]     # mine n blocks now (default 1)
node infra/z3/clock.mjs run --every 25   # block clock, one block every 25 s, prints heights
bash infra/z3/down.sh                # stop, keep chain and wallet
bash infra/z3/down.sh --wipe         # stop and delete every z3-regtest-* volume
```

Nothing confirms or expires unless blocks are mined: keep `clock.mjs run` going while the
facilitator or the demo runs.

`fund-agent.sh` skips funding when the agent already holds at least 1 ZEC (`--force` funds
again). `--probe` also prints Zaino's `GetTransaction` for the shield tx in the mempool and
once mined.

## Endpoints

| Service | URL | Auth |
|---|---|---|
| Zebra JSON-RPC | `http://127.0.0.1:29232` | Basic `zebra:zebra` (accepted, not required) |
| Zallet JSON-RPC | `http://127.0.0.1:50232` | Basic `zebra:zebra` |
| Zaino gRPC (`cash.z.wallet.sdk.rpc.CompactTxStreamer`) | `http://127.0.0.1:28137` | none, plaintext h2c |

The agent is Zallet account 0. `AGENT_UA` is its Orchard-only UA at diversifier index 1:
`z_getaddressforaccount [<account_uuid>, ["orchard"], 1]` returns the same address every time.
After `down.sh --wipe` the seed, account and `AGENT_UA` are new.

## Helpers

- `rpc.mjs`: dependency-free ESM JSON-RPC client. Exports `zebraRpc(method, params)`,
  `zalletRpc(method, params)`, `mineNow(n)` (resolves to the new tip height as a number),
  `rpc(target, method, params)`, `RpcError` and
  `ENDPOINTS = { zebraRpc, zalletRpc, zainoGrpc }`. Env overrides: `Z3_ZEBRA_RPC`,
  `Z3_ZALLET_RPC`, `Z3_ZAINO_GRPC`, `Z3_RPC_USER`, `Z3_RPC_PASSWORD`. As a CLI:
  `node infra/z3/rpc.mjs zallet z_listaccounts`.
- `lwd.mjs`: gRPC probe against Zaino (`info`, `latest`, `block <h>`, `tx <txid>`). It loads
  `@grpc/grpc-js` from `.tools/grpc-probe` and the protos from `.tools/lightwallet-protocol`,
  both installed by `up.sh`. gRPC errors print as `{code, codeName, details}` and exit 3.
- `lib.sh`: shared paths and helpers for the shell scripts.

## What up.sh changes in Z3

Everything lives in the gitignored `.tools/` (Z3 checkout, protos, gRPC deps) and in Docker
volumes named `z3-regtest-*`.

- `Z3_ZAINO_IMAGE=zingodevops/zainod:0.10.2-no-tls` instead of Z3's 0.6.0 pin, which reports
  a mempool transaction at the tip height.
- `config/regtest/zallet.toml`: `require_backup = false` under `[keystore]`.
- `config/regtest/zaino.toml`: `[storage.database] size = 1` (GB). Zaino is amd64-only and
  runs emulated on arm64, where its default 384 GB LMDB map fails with
  `Cannot allocate memory`.
- Runs `scripts/regtest-init.sh` once, guarded by a marker in the wallet volume. Z3's own
  guard looks for `/data/*.age`, which Zallet beta.1 never writes, so a second run of
  `regtest-init.sh` would delete an initialised `wallet.db`.
- Creates account 0 and the transparent miner address with
  `zallet regtest generate-account-and-miner-address` before Zallet's first start, and keeps
  the address in the wallet volume (`z402-miner-address`).
- Starts `zebra zallet`, then `--profile indexer zaino`. The rpc-router is not built.

Override images with `Z3_ZEBRA_IMAGE`, `Z3_ZALLET_IMAGE` or `Z3_ZAINO_IMAGE`.
