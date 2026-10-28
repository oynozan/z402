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

Every port the stack publishes (Zebra RPC 29232 and health 28080, Zaino gRPC 28137 and
JSON-RPC 28237, Zallet RPC 50232) binds to `127.0.0.1` only, through
[`compose.loopback.yml`](compose.loopback.yml). Z3's own compose files publish them on every
interface, which put Zebra's unauthenticated RPC and Zallet's `zebra:zebra` RPC on the LAN.
One gap remains. Z3's `scripts/regtest-init.sh` starts Zebra once with Z3's own two files. That
happens on the first run, and again on the first `up.sh` after `down.sh --wipe`. Zebra then
listens on every interface for the minute the wallet takes to initialise, until `up.sh` recreates
it with the loopback binding. If `regtest-init.sh` fails part-way, Zebra stays on every interface
until `bash infra/z3/down.sh` runs.

### Applying the loopback binding to a running stack

Docker fixes a container's port bindings when it creates the container, so a stack started
before `compose.loopback.yml` existed keeps listening on every interface until its containers
are recreated. The next `bash infra/z3/up.sh` does that: Compose sees the changed ports and
recreates zebra, zallet and zaino. The volumes persist, so the chain, the wallet and Zaino's
index survive, and `up.sh` skips the wallet initialisation as usual. Zebra, Zallet and Zaino are
down while that runs, so stop anything that uses them first (`scripts/demo.sh down` stops the
clock, the API and the facilitator). Afterwards
`lsof -nP -iTCP -sTCP:LISTEN | grep -E ':(29232|28080|28137|28237|50232) '` shows
`127.0.0.1:<port>` instead of `*:<port>`. Colima's port forwarder maps a port bound to
`127.0.0.1` in the VM to `127.0.0.1` on the host, and one bound to `0.0.0.0` to every host
interface.

The agent is Zallet account 0. `AGENT_UA` is its Orchard-only UA at the lowest diversifier index
from 1 to 16 that accepts one. Zallet puts the account's default (p2pkh+sapling+orchard) address on
the first Sapling-valid index, which depends on the seed, and refuses an Orchard-only request there.
`fund-agent.sh` and the client's `ZalletRpcWallet` apply the same rule, and
`z_getaddressforaccount [<account_uuid>, ["orchard"], <index>]` returns the same address every
time. `fund-agent.sh` prints the index it chose. After `down.sh --wipe`, the seed, the account and
`AGENT_UA` are all new.

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
- `compose.loopback.yml`: the third compose file, which binds the published ports to `127.0.0.1`.
- `test/guard.sh`: regression checks for the wallet-init guard, the compose project pin and
  the loopback binding. It runs `up.sh` and `down.sh --wipe` against a fake `docker` with
  `DOCKER_HOST` pointed at a dead socket, and reads the merged config with the real
  `docker compose config` against that same dead socket, so it cannot touch the live stack.

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
  `regtest-init.sh` would delete an initialised `wallet.db`. The guard fails closed: if Docker
  cannot list the volume or read the marker, or if `wallet.db` exists with no marker,
  `up.sh` stops before `regtest-init.sh` runs.
- Creates account 0 and the transparent miner address with
  `zallet regtest generate-account-and-miner-address` before Zallet's first start, and keeps
  the address in the wallet volume (`z402-miner-address`).
- Starts `zebra zallet`, then `--profile indexer zaino`. The rpc-router is not built, and
  `compose.loopback.yml` leaves its port 8181 alone, so it would listen on every interface if
  anyone started it.
- Every compose call is pinned to project `z3-regtest` and three compose files (`-p` and
  `-f`): the two Z3 regtest files, then `infra/z3/compose.loopback.yml` by absolute path, which
  re-lists the zebra, zaino and zallet ports bound to `127.0.0.1`. Ambient `COMPOSE_*` and
  `Z3_*` variables are dropped, except the image overrides. A shell `COMPOSE_PROJECT_NAME` or `COMPOSE_FILE` therefore cannot point
  `down --volumes` at another project on the same Docker host. `down.sh --wipe` also removes
  any leftover `z3-regtest-*` volume by name.

Override images with `Z3_ZEBRA_IMAGE`, `Z3_ZALLET_IMAGE` or `Z3_ZAINO_IMAGE`.
