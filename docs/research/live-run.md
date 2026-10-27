# Live run on the Z3 regtest stack (Task 12)

> What the server side did against the real Z3 stack on 2026-10-27, measured on this machine. The stack itself is described in `docs/research/client/z3-live.md` and `infra/z3/README.md`. Sections 2 to 4 were run by the server-side agent for Task 12. Section 5 records the first real deposit, which z402-08's agent sent, from the values the controller verified, and the transaction was re-read in this task. Task 13 adds the demo runs.

## 0. Summary

| Fact | Observed |
|---|---|
| Merchant keys | `.secrets/merchant-regtest.json` already existed (file mode 600, directory mode 700), so step 1 was not repeated. `zdecrypt owns` answers `ownedByKey: true`, `hasTransparent: false` |
| `@z402/lightwalletd` live test | 3 live tests pass against Zaino (branch id `37a5165b`, a tip, an unknown txid is a definitive not-found), 1 testnet-only test is skipped. Whole package: 63 passed, 1 skipped |
| Facilitator start (port 4098) | The ready line appeared within 1 s of `pnpm --filter @z402/facilitator start`, after the self-test, ownership and branch checks passed |
| API start (port 4097) | About 1 s after the facilitator, having loaded `/supported` from it |
| Unpaid `GET /chunk` | **402** with a `PAYMENT-REQUIRED` header. `accepts[0]` is `prepaid-voucher` on `zcash:regtest`, 500 ZEC zat, `payTo` the merchant, `windowZat` 100000 |
| Unpaid `HEAD /chunk` | 402 as well |
| Facilitator `GET /supported` | 401 without the bearer token, 200 with it |
| First real deposit | `98e84dab...0eaf`, mined at height 115, expiry 155, one external Ironwood output of 100000 zat to the merchant, memo `<sessionKey>:1`, no transparent part, fee 10,000 zat |
| Zallet `z_sendmany` for it | 5.1 s from the call to `success` (tip 114 at send) |
| Chain visibility | About 0.5 s from broadcast to the first `found` through `@z402/lightwalletd`, about 1.4 s from `mineNow(1)` to mined. Zaino answered with the old tip and height `"0"` for a few seconds after Zebra had the block |
| Decrypting that transaction | `parseMicros` 69 to 91, `decryptMicros` 1484 to 1707, for 9,166 bytes and 2 Ironwood actions |

## 1. Environment

- macOS arm64, Node v26.11.0, pnpm 12.6.0. `crates/zdecrypt/target/release/zdecrypt` was already built.
- The Z3 stack was already up. Zebra 6.2.3 and Zaino 0.10.2 (`ZingoLabs ZainoD`) were queried in this task, and Zallet is beta.1 per `z3-live.md`. Zaino's `GetLightdInfo` gave `chainName "test"`, `consensusBranchId "37a5165b"`, `upgradeName "NU6.3"` and `upgradeHeight "2"`, as in `z3-live.md`.
- Every Z3 port listens on `127.0.0.1` only: `lsof` showed `127.0.0.1:` for 29232 (Zebra RPC), 50232 (Zallet RPC), 28137 (Zaino gRPC), 28237 (Zaino JSON-RPC) and 28080 (Zebra health). This is the loopback overlay of commit `6eb8213`.
- The chain tip was 129 to 132 during these runs: the deposit was mined at 115, and the chain has been mined on since.
- The server side was at commit `45b912a`. The runs started at 2026-10-27T20:52Z.
- The smoke run (section 4) used ports 4098 (facilitator) and 4097 (API), because the demo uses 4022 and 4021, and its own ledger `.data/task12-smoke-ledger.jsonl`, which was deleted afterwards. It only read: no block was mined, no transaction was sent, and `.data/facilitator-ledger.regtest.jsonl` was not opened.

## 2. Merchant keys (steps 1 and 2)

`scripts/merchant-keygen.mjs --network regtest` runs `zdecrypt keygen --network regtest --pretty` and writes `.secrets/merchant-regtest.json`. That file existed already, so the script was only exercised against the real path in its refusal case (`error: refusing to replace .secrets/merchant-regtest.json, ...`, exit 1, file unchanged). The success, `--force`, mode and no-secret-in-output checks used throwaway files outside the repository. The file holds `address`, `addressDiversifierIndex`, `addressReceivers`, `network`, `orchardOnlyAddress`, `orchardOnlyDiversifierIndex`, `seedHex`, `ufvk` and `uivk`.

The payTo, which is the file's `orchardOnlyAddress`:

```
uregtest1etwrjmjldyyet5pge876dfxerpgmsmarxg920s50y3dgc3wa36xmemqexfyw87jm3h0cttupk92qkrv8uafvjrl2j73d8nck7g35axkz
```

Ownership check (step 2), with the key in the environment only:

```
$ ZDECRYPT_KEY=$(jq -r .uivk .secrets/merchant-regtest.json) crates/zdecrypt/target/release/zdecrypt owns \
    --network regtest --address $(jq -r .orchardOnlyAddress .secrets/merchant-regtest.json)
{"hasTransparent":false,"orchardOwned":true,"ownedByKey":true,"saplingOwned":null}
```

## 3. `@z402/lightwalletd` against Zaino (step 3)

```
$ Z402_LIVE=1 Z402_LWD_URL=http://127.0.0.1:28137 pnpm --filter @z402/lightwalletd exec vitest run --reporter=verbose test/live.test.ts
```

| Test | Result | Time |
|---|---|---|
| consensus branch id matches the configured network (`37a5165b`) | pass | 16 ms |
| tip is a non-negative integer | pass | 3 ms |
| an unknown txid is a definitive not-found | pass | 5 ms |
| a known testnet transaction is mined | skipped, it runs only against `testnet.zec.rocks` | |

Without the file filter the whole package gives 2 files, 63 tests passed and 1 skipped, in 709 ms.

One more read-only live test exists, the facilitator's `LightwalletdChainView` against the same Zaino:

```
$ Z402_LIVE=1 pnpm --filter @z402/facilitator exec vitest run test/chain/live.test.ts
```

Three tests pass. `inspect("98e84dab...0eaf")` is found, mined at 115, with no transparent part and one Ironwood output of 100000 zat with the memo below (28 ms). An unknown transaction is a definitive not-found (6 ms), and the tip is at least 115 (3 ms). It passes only on a chain that holds that transaction.

## 4. Facilitator and API smoke (step 4)

Started at 20:54:03Z, from the repository root, with a random token (`openssl rand -hex 16`, kept in a shell variable and never printed) and no other `Z402_*` variable in the environment:

```bash
Z402_NETWORK=regtest Z402_MERCHANT_KEYS_FILE=$PWD/.secrets/merchant-regtest.json Z402_FACILITATOR_TOKEN=<token> \
  Z402_LEDGER=$PWD/.data/task12-smoke-ledger.jsonl Z402_FACILITATOR_PORT=4098 pnpm --filter @z402/facilitator start
Z402_NETWORK=regtest Z402_FACILITATOR_URL=http://127.0.0.1:4098 Z402_FACILITATOR_TOKEN=<token> \
  Z402_PAY_TO=$(jq -r .orchardOnlyAddress .secrets/merchant-regtest.json) Z402_API_PORT=4097 pnpm --filter @z402/api start
```

Ready lines (stdout; the rest of the two logs was pnpm's `$ tsx src/main.ts` echo and one line per request, such as `GET /supported 200`):

```
facilitator listening on http://127.0.0.1:4098 network=zcash:regtest payTo=uregtest1etwr...vjrl2j73d8nck7g35axkz
api listening on http://127.0.0.1:4097 network=zcash:regtest
```

The facilitator printed its ready line within the first second, and the API within about 1 s of its own start (the script counts whole seconds). The ready lines print the full network id, `zcash:regtest`. Neither log, nor any output of the run, contained the token or the viewing key (checked with `grep -F`).

```
$ curl -s -D - -o /dev/null http://127.0.0.1:4097/chunk
HTTP/1.1 402 Payment Required
Content-Type: application/json; charset=utf-8
PAYMENT-REQUIRED: eyJ4NDAyVmVyc2lvbiI6MiwiZXJyb3IiOiJQYXltZW50IHJlcXVpcmVkIiwi...
Cache-Control: no-store
Content-Length: 2
```

The body is `{}`. The decoded header has the keys `accepts`, `error`, `resource` and `x402Version`:

```json
{"x402Version":2,"error":"Payment required","resource":{"url":"http://127.0.0.1:4097/chunk","description":"","mimeType":"application/json"}}
```

`accepts` has one entry. `accepts[0]`:

```json
{
  "scheme": "prepaid-voucher",
  "network": "zcash:regtest",
  "amount": "500",
  "asset": "ZEC",
  "payTo": "uregtest1etwrjmjldyyet5pge876dfxerpgmsmarxg920s50y3dgc3wa36xmemqexfyw87jm3h0cttupk92qkrv8uafvjrl2j73d8nck7g35axkz",
  "maxTimeoutSeconds": 60,
  "extra": {
    "windowZat": "100000",
    "creditRatioBps": 2500,
    "creditCapZat": "200000",
    "zeroConfMinExpiryBlocks": 20,
    "termsVersion": "c455cfbbe728c486"
  }
}
```

`payTo` equals the merchant's address, as the API and the facilitator's `/supported` agree. Two more checks on the same processes:

- `GET http://127.0.0.1:4098/supported` answered 401 without the token and 200 with it, with one kind: `prepaid-voucher` on `zcash:regtest` and the same terms and `payTo`.
- `HEAD http://127.0.0.1:4097/chunk` answered 402.

`scripts/show-deposit.sh 98e84dab...` ran against the live Zebra while both processes were up. The commentary is on stderr:

```
==> Deposit 98e84dabd476c1a59543ca3c51b9040e0080252abdd1c6b25c7eec1255df0eaf
    mined at height 115, 18 confirmations
    raw transaction: 9166 bytes (18332 hex characters)
    starts with:     0600008098b684d85b16a537000000009b0000000000000000023354ca5f0ff8698735494b8ebf8e7d335e5491994702...
    That hex is all a block explorer has. It carries no plaintext amount and no address, only ciphertext.

==> Decrypted with the merchant's viewing key (UIVK, not printed)
```

and the report is on stdout:

```json
{
  "branch": "Nu6_3",
  "branchId": "0x37a5165b",
  "branchMatchesHeight": true,
  "coinbase": false,
  "decryptMicros": 1707,
  "expired": false,
  "expiryHeight": 155,
  "heightKind": "mined",
  "heightUsed": 115,
  "ironwood": {
    "actions": 2,
    "crossAddressEnabled": true,
    "outputsEnabled": true,
    "spendsEnabled": true,
    "valueBalanceZat": 10000
  },
  "keyKind": "uivk",
  "lockTime": 0,
  "orchard": null,
  "outputs": [
    {
      "diversifierIndex": "0",
      "index": 0,
      "memoHex": null,
      "memoKind": "text",
      "memoText": "aa80f78d384bdfad5a714585bac5ce6628110234f48a50476c81d92389c92046:1",
      "noteVersion": 3,
      "pool": "ironwood",
      "receiverHex": "639739bfe58fe5133feebc0642ed3f2080dc27cb3f26f6fd4530e266fc70375668b51501b7864d4de07934",
      "recipient": "uregtest1etwrjmjldyyet5pge876dfxerpgmsmarxg920s50y3dgc3wa36xmemqexfyw87jm3h0cttupk92qkrv8uafvjrl2j73d8nck7g35axkz",
      "scope": "external",
      "toPayTo": true,
      "valueZat": 100000
    }
  ],
  "parseMicros": 91,
  "payTo": {
    "hasTransparent": false,
    "orchardOwned": true,
    "ownedByKey": true,
    "saplingOwned": null
  },
  "sapling": null,
  "sizeBytes": 9166,
  "transparentIn": 0,
  "transparentOut": 0,
  "txid": "98e84dabd476c1a59543ca3c51b9040e0080252abdd1c6b25c7eec1255df0eaf",
  "version": 6,
  "versionGroupId": "0xd884b698"
}
```

Both processes were then stopped with SIGINT, sent to the two node servers (found by their listening ports). The ports closed at once, and the `pnpm` and `tsx` wrappers exited by themselves. The smoke ledger had not been created, since nothing was presented to the facilitator and so it wrote no event, and the script removed the path anyway.

## 5. The first real deposit (step 5, with z402-08)

These values come from the joint run of the controller and z402-08's agent. The agent paid with Zallet `z_sendmany` and a hex memo. Section 4 re-read the transaction itself, and every on-chain fact below agrees with it.

| Measurement | Value |
|---|---|
| Deposit txid | `98e84dabd476c1a59543ca3c51b9040e0080252abdd1c6b25c7eec1255df0eaf` |
| `z_sendmany` call to `success` | 5.1 s |
| Tip at send | 114 |
| Memo | `aa80f78d384bdfad5a714585bac5ce6628110234f48a50476c81d92389c92046:1` (session key, then deposit index) |
| Broadcast to the first `found` lookup through `@z402/lightwalletd` | about 0.5 s |
| `mineNow(1)` to mined, as seen through `@z402/lightwalletd` | about 1.4 s |
| Fee | 10,000 zat (2 Ironwood actions, `valueBalance` 10000) |

At send, before any block (zero-conf):

| Check | Value |
|---|---|
| Transaction | v6, branch `0x37a5165b` |
| Zaino `GetTransaction` height | `"0"` (mempool) |
| Outputs | one external Ironwood output of 100000 zat |
| `toPayTo` | true |
| Transparent in and out | 0 and 0 |
| `expiryHeight` | 155, which is a margin of 41 blocks over the tip of 114 and passes `zeroConfMinExpiryBlocks` of 20 |
| zdecrypt verdict | ok |

After one mined block: Zebra reported height 115 with 1 confirmation immediately. Zaino still answered height `"0"` and tip 114 for a few seconds, and then reported 115 and 115.

Fees seen for deposits of this shape:

- 10,000 zat when the wallet makes one recipient output and one change output (2 Ironwood actions), as for this deposit.
- 25,000 zat for the Zallet sends that split the change into 4 notes (5 actions), which the client agent also saw (`z3-live.md` section 2, item 4).

Later deposits from the client's live tests, all harmless:

| Txid | Value | Mined | Expiry |
|---|---|---|---|
| `0fcb6eae...54df` | 100000 zat | 117 | 157 |
| `e984638e...8eb9` | 100000 zat | 118 | |
| `ffc61849...50e5` | 0 zat | 116 | |

The 0-zat transaction pays nobody and is not a deposit.

An unknown txid is gRPC 13 INTERNAL from Zaino, with `RPC error: LegacyRpcError { code: -5, message: "No such mempool or main chain transaction" }`. Zebra's `getrawtransaction` answers the same unknown txid with JSON-RPC error -5 and `No such mempool or main chain transaction`.

Not in the recorded values: the HTTP status of the agent's call 1, and the time from `mineNow()` until the facilitator's snapshot shows `confirmedZat` of at least 100000. The zero-conf verdict was ok before the block, which is what lets call 1 be served unconfirmed. The snapshot lags the chain by the few seconds Zaino lags Zebra plus the watcher's 5 s poll. Task 13's rehearsals record both.

## 6. What this means for the next tasks

- The facilitator sees the chain through Zaino only. Zebra had the block with 1 confirmation at once, while Zaino stayed on the old tip for a few seconds, so a deposit stays `pending` for that long after it is mined. A confirmation that arrives after the lag plus one poll interval (5 s) is normal.
- The first lookup right after a broadcast can be a not-found, because of the 0.5 s or so that the mempool takes to show a transaction. Zallet also needs 5 to 10 s to build the proof before any txid exists. The facilitator's resolver retries a not-found within its wait for an unseen deposit (30 s by default), so one early not-found is normal.
- Zallet's default expiry is the tip at build plus 41, so the margin of 41 passes the zero-conf rule of 20 with room to spare.
- A deposit costs 10,000 zat in fees when the change is one note, and 25,000 when Zallet splits it. Two deposits of 100,000 at the worst-case fee come to 250,000 zat in all, which is the demo's floor in `scripts/demo.sh`.
- `termsVersion` `c455cfbbe728c486` is what the default terms, the price of 500 and the regtest payTo give. It changes when any of them does.

## 7. Reproduce

```bash
# step 2: ownership of the payTo
ZDECRYPT_KEY=$(jq -r .uivk .secrets/merchant-regtest.json) crates/zdecrypt/target/release/zdecrypt owns \
  --network regtest --address $(jq -r .orchardOnlyAddress .secrets/merchant-regtest.json)

# step 3: the live tests (read-only, Z3 stack up)
Z402_LIVE=1 Z402_LWD_URL=http://127.0.0.1:28137 pnpm --filter @z402/lightwalletd exec vitest run --reporter=verbose test/live.test.ts
Z402_LIVE=1 pnpm --filter @z402/facilitator exec vitest run test/chain/live.test.ts

# step 4: facilitator and API on spare ports (see packages/facilitator/README.md and apps/api/README.md), then
curl -s -D - -o /dev/null http://127.0.0.1:4097/chunk | tr -d '\r' \
  | awk -F': ' 'tolower($1) == "payment-required" { print $2 }' | base64 -d | jq '.accepts[0]'

# step 5: the deposit as the chain stores it and as the viewing key reads it
scripts/show-deposit.sh 98e84dabd476c1a59543ca3c51b9040e0080252abdd1c6b25c7eec1255df0eaf
```
