# @z402/facilitator

The x402 facilitator for the `prepaid-voucher` scheme on Zcash. It answers `GET /supported`, `POST /verify` and `POST /settle` for the paid API, finds each deposit through a lightwalletd-compatible endpoint, reads it with the merchant's viewing key (`crates/zdecrypt`), and keeps the ledger of sessions and deposits. The design is in `docs/superpowers/specs/2026-10-27-z402-facilitator-design.md` and the wire format in `docs/spec/protocol.md`.

Every `Z402_*` variable of the facilitator is listed in [Environment](#environment) below, and the API's are in `apps/api/README.md`.

## Run it against the Z3 regtest stack

Run these from the repository root. Docker, Node 24.2 or later (the Z3 helpers need it), pnpm, `jq`, `curl`, `openssl` and a Rust toolchain are needed.

Set up once, in any terminal:

```bash
pnpm install
pnpm --filter @z402/facilitator build:native          # builds crates/zdecrypt
node scripts/merchant-keygen.mjs --network regtest    # .secrets/merchant-regtest.json, prints the payTo
bash infra/z3/up.sh                                   # Zebra, Zallet and Zaino
mkdir -p .data && (umask 077; openssl rand -hex 16 > .data/manual-token)
```

`merchant-keygen.mjs` refuses to replace an existing keys file, so on a machine that has one it exits 1 and changes nothing. `up.sh` publishes every port on `127.0.0.1`, with one gap: Zebra listens on every interface for about a minute on the first run and again after `down.sh --wipe`, while the wallet initialises (`infra/z3/README.md`, section Endpoints). Add `bash infra/z3/fund-agent.sh` if an agent will pay deposits. `infra/z3/README.md` has the stack's commands and ports.

The last line creates the bearer token in `.data/manual-token`, which only you can read (`.data/` is gitignored). The facilitator and the API both read the token from that file, so run the line once. A second run writes a new token that the running processes do not have.

The block clock, the facilitator and the API each run until you stop them, so each gets its own terminal, opened in the repository root.

Terminal 1, the block clock (nothing confirms or expires unless blocks are mined):

```bash
node infra/z3/clock.mjs run --every 25
```

Terminal 2, the facilitator:

```bash
export Z402_FACILITATOR_TOKEN="$(cat .data/manual-token)"
Z402_NETWORK=regtest \
Z402_MERCHANT_KEYS_FILE=.secrets/merchant-regtest.json \
pnpm --filter @z402/facilitator start
```

Wait for the ready line on stdout, which names the full network id and the payTo:

```
facilitator listening on http://127.0.0.1:4022 network=zcash:regtest payTo=uregtest1...
```

Everything else the process prints goes to stderr: one line per request (`GET /supported 200`) and the diagnostics. Neither stream carries the token or the viewing key.

Terminal 3, the API (`apps/api/README.md`), which reads the same token from the same file.

Check the facilitator from any terminal. The token goes in on stdin, so it never shows in `ps`, and without it the answer is 401:

```bash
curl -s -K - http://127.0.0.1:4022/supported <<<"header = \"authorization: Bearer $(cat .data/manual-token)\"" | jq
```

Stop each process with SIGINT or SIGTERM (Ctrl-C). The facilitator closes the server and exits 0, or exits 1 after 5 s if that hangs. `scripts/demo.sh up` starts the stack, the facilitator and the API for the demo on ports 4022 and 4021, and keeps their logs and the token in `.data/demo/`.

To run a second facilitator next to the demo, give it its own port and its own ledger, and never the demo's ledger file: the ledger has no lock, so two facilitators must not share one. In a terminal of its own:

```bash
export Z402_FACILITATOR_TOKEN="$(cat .data/manual-token)"
Z402_NETWORK=regtest \
Z402_MERCHANT_KEYS_FILE=.secrets/merchant-regtest.json \
Z402_FACILITATOR_PORT=4098 \
Z402_LEDGER=.data/scratch-ledger.jsonl \
pnpm --filter @z402/facilitator start
```

## Environment

An empty variable counts as unset. A path that is not absolute is relative to the repository root, whatever directory `pnpm` runs the package from. A problem is printed as one `facilitator: ...` line on stderr, and the process exits 1. The line names the variable at fault, the start-up check that failed, or, for the ledger and the port, the option (`ledgerPath:` and `port:`) rather than the variable. No message quotes the keys file, the viewing key or the token.

| Variable | Default | Meaning |
| --- | --- | --- |
| `Z402_NETWORK` | `regtest` | `regtest`, `testnet` or `mainnet`. Picks the defaults of `Z402_LWD_URL` and `Z402_EXPECTED_BRANCH_ID`, and the address and key prefixes that are accepted. |
| `Z402_MERCHANT_KEYS_FILE` | none | The JSON that `zdecrypt keygen` prints, which `scripts/merchant-keygen.mjs` writes. The whole file is read and parsed, seed included, but only `orchardOnlyAddress` and `uivk` are used, and only for the two variables below that are not set. Set those two instead wherever the process should not be able to read the seed. |
| `Z402_PAY_TO` | `orchardOnlyAddress` of the keys file | The shielded-only unified address deposits go to (`uregtest1...`, `utest1...` or `u1...`, and the ZIP 316 revision 2 `zu...` forms). Required unless the keys file has it. The API needs the same address. |
| `Z402_UIVK` | `uivk` of the keys file | The merchant's unified incoming viewing key (`uivkregtest1...`, `uivktest1...` or `uivk1...`, and the revision 2 `uvi...` forms). Required unless the keys file has it. It can see deposits and cannot spend. |
| `Z402_FACILITATOR_TOKEN` | none | Required. The bearer token every caller must present. |
| `Z402_LWD_URL` | regtest `http://127.0.0.1:28137`, testnet `https://testnet.zec.rocks:443`, mainnet none | A lightwalletd-compatible gRPC endpoint. `http://` is plaintext and `https://` is TLS. Required on mainnet, where no public default is trusted. |
| `Z402_EXPECTED_BRANCH_ID` | regtest `37a5165b`, testnet `77190ad9`, mainnet none | Eight hex digits. Start-up compares them with the endpoint's `consensusBranchId`. Left unset on mainnet, the check is skipped with a warning. |
| `Z402_ZDECRYPT_BIN` | `crates/zdecrypt/target/release/zdecrypt` | The decryptor. `pnpm --filter @z402/facilitator build:native` builds the default. |
| `Z402_LEDGER` | `.data/facilitator-ledger.<network>.jsonl` | The append-only JSON Lines ledger, replayed at start. |
| `Z402_FACILITATOR_HOST` | `127.0.0.1` | The address to listen on. Keep it on loopback, since the only protection is the token. |
| `Z402_FACILITATOR_PORT` | `4022` | 0 to 65535, where 0 picks a free port. |
| `Z402_PRICE_ZAT` | `500` | The price of one call in zatoshi, at least 1. Give the API the same `Z402_PRICE_ZAT`. Nothing checks that at start, and with different prices every paid call is refused with `invalid_payment_requirements`. |
| `Z402_WINDOW_ZAT` | `100000` | The size of one deposit, which is also the cap on unconfirmed exposure. |
| `Z402_CREDIT_RATIO_BPS` | `2500` | Credit on confirmed deposits, in basis points, 0 to 10000. |
| `Z402_CREDIT_CAP_ZAT` | `200000` | The most credit a session can hold. |
| `Z402_ZERO_CONF_MIN_EXPIRY_BLOCKS` | `20` | An unconfirmed deposit earns zero-conf credit only with at least this many blocks left before it expires. |

The last four are the `extra` terms that `/supported` advertises and the API copies into each 402 (`docs/spec/protocol.md` section 2).

`Z402_LIVE` is not a setting of the process. It switches on the live tests below.

## Start-up checks

The process exits 1 at the first failure. The message names the check, and the variable or option to look at where one is behind it:

1. The configuration parses, and the address and key match the network.
2. `zdecrypt` decrypts a bundled real transaction (the Kage vector `030c3cbf...8351`) to the output it is known to hold.
3. `zdecrypt owns` says the viewing key owns the payTo address (`ownedByKey: true`) and that the address has no transparent receiver (`hasTransparent: false`).
4. `GetLightdInfo.consensusBranchId` equals `Z402_EXPECTED_BRANCH_ID`. `chainName` is never compared, because Zaino reports `test` on regtest.
5. The ledger replays. A truncated last line is dropped with a warning.

After the checks it polls the chain once, then listens. A failed first poll does not stop the start. The watcher then checks the tip every 5 s.

A failed ledger write exits 1, so that a restart replays the file. The ledger belongs to one chain: after `bash infra/z3/down.sh --wipe` the chain starts again from height 0, so delete the ledger too (`scripts/demo.sh down --wipe-ledger` does).

## Merchant keys

```bash
node scripts/merchant-keygen.mjs --network regtest     # or testnet, or mainnet
```

It runs `zdecrypt keygen` and writes `.secrets/merchant-<network>.json` with mode 0600, inside a 0700 directory. The file holds `seedHex`, `ufvk`, `uivk`, `address`, `orchardOnlyAddress` and a few more fields. The seed is the only backup of the account, and `.secrets/` is gitignored.

- The script prints the `orchardOnlyAddress` on stdout and a backup reminder on stderr. Nothing else leaves the file.
- It refuses to replace an existing file. `--force` replaces it and keeps the old one as `<file>.replaced-<UTC time>` (for example `merchant-regtest.json.replaced-20261027T205936Z`, mode 0600), so a replaced seed is never destroyed. The script prints that path, never the contents.
- On `mainnet` the seed controls real money and the script says so. A server needs only `Z402_UIVK` and `Z402_PAY_TO`, so keep the seed off it.
- `--out <absolute path>` writes somewhere else, but only outside the repository or inside its `.secrets/` directory (symlinks are resolved first). Any other path in the work tree exits 2, since a key file there can be committed by accident. The binary and the default output are found from the script's own location, so the working directory does not matter.

Check that the key owns the address. The key goes through the environment, never an argument:

```bash
ZDECRYPT_KEY=$(jq -r .uivk .secrets/merchant-regtest.json) crates/zdecrypt/target/release/zdecrypt owns \
  --network regtest --address $(jq -r .orchardOnlyAddress .secrets/merchant-regtest.json)
# {"hasTransparent":false,"orchardOwned":true,"ownedByKey":true,"saplingOwned":null}
```

## Look at a deposit

```bash
scripts/show-deposit.sh <txid> [--network regtest] [--keys <file>]
```

It fetches the raw transaction from Zebra (`getrawtransaction <txid> 1` at `Z3_ZEBRA_RPC`, default `http://127.0.0.1:29232`, Basic auth `Z3_RPC_USER:Z3_RPC_PASSWORD`, default `zebra:zebra`), then decrypts it with the viewing key from the keys file (default `.secrets/merchant-<network>.json`). A mined transaction is judged at its height and a mempool one at the tip plus one. The key reaches `zdecrypt` through `ZDECRYPT_KEY` only and is never printed. The JSON report is on stdout and the commentary is on stderr, so `scripts/show-deposit.sh <txid> 2>/dev/null | jq` works. `scripts/demo.sh show` runs it.

## Testnet

The same process runs against the public testnet. Only `testnet.zec.rocks:443` answers there. It is a shared lightwalletd behind several backends, which see a new transaction up to about 16 s apart, and its tip can lag by 0 to 9 s (section 7 of the design, `docs/research/zcash-testnet.md`).

```bash
node scripts/merchant-keygen.mjs --network testnet
Z402_NETWORK=testnet \
Z402_MERCHANT_KEYS_FILE=.secrets/merchant-testnet.json \
pnpm --filter @z402/facilitator start
```

The defaults become `https://testnet.zec.rocks:443` and branch id `77190ad9` (NU7). The paying wallet needs testnet funds, which come from a faucet. Blocks arrive about every 25 s and are not mined by you. Keep the ledger of each network apart: the default path already includes the network name.

## Tests

```bash
pnpm --filter @z402/facilitator test
pnpm --filter @z402/facilitator typecheck
```

The live tests are off unless `Z402_LIVE` is set. They only read, and they need the Z3 stack to be up:

```bash
Z402_LIVE=1 pnpm --filter @z402/lightwalletd exec vitest run
Z402_LIVE=1 pnpm --filter @z402/facilitator exec vitest run test/chain/live.test.ts
```

The first checks Zaino's branch id, tip and not-found answer (`Z402_LWD_URL` overrides the endpoint). The second reads the first real regtest deposit, `98e84dab...0eaf`, so it passes only on the chain that holds that transaction and fails after `down.sh --wipe`. The measurements from both are in `docs/research/live-run.md`.
