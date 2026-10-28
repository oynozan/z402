# z402 wire contract

**Version: v2.0** (2026-10-28; ACKed by both agents). v2.0 turns the facilitator into a hosted rail for many providers, each with its own `payTo` and its own price per route, and hosts the Bazaar. Nothing the client sends or signs changes: the §3 payload, the §4 voucher, the §5.1 memo, the §7 answers and snapshot, and the §8 codes are kept byte for byte. It is a major version because `/supported` no longer carries `payTo`, and the facilitator accepts any per-route amount, which an API built against v1 refuses at startup. The changes:
- **Per-route price.** `amount` is set per route by the provider, any canonical zat from 1 to `windowZat` (§2, §6, §10). 500 zat is the demo API's price, not a protocol value (§12).
- **Providers.** A resource server authenticates with its provider's API key, and `payTo` must be that provider's (§2, §10, §16). Credit is kept per provider (§5.2).
- **`termsVersion` and `/supported`.** `termsVersion` hashes the rail's terms only, and `/supported` drops `extra.payTo` (§2).
- **Seams.** `FacilitatorOptions.priceZat` is ignored, `providers` is new, and the API's startup check is `checkProvider` (§15).
- **Bazaar.** The facilitator serves `GET /discovery/resources` and `GET /discovery/search` (§17), and `apps/discovery` is retired (§14).

Earlier versions. v1.1 clarified §7.3: only a successful settle acknowledges a deposit, and refusal snapshots are projected and informational. v1.2 does three things:
- **One refusal code.** A found txid that this session cannot use answers `z402_deposit_memo_mismatch` (§5.2), whether no output pays `payTo`, none carries this session's memo, or the txid is credited to another session, so a refusal is no oracle on the merchant's viewing key. A transparent or dead deposit keeps its own code, `z402_deposit_transparent` or `z402_deposit_dead`, which names only what anyone can see on chain.
- **Corrections.** §2, §6, §8 and §10.
- **New facilitator and API rules.** §15: the ledger lock, `onFatal`/`log`, `close()`, token and URL checks, and 405 on paid non-GET requests.

v1.2.1 changes nothing on the wire. It records the facilitator's Wave B rules:
- the startup network check (§11, §15);
- the same answer for an other-session txid as for an uncredited one, for each read outcome (§5.2);
- the heartbeat ledger lock and the ledger header (§15);
- the rules for plaintext URLs and the keys file (§15).

Drafted by the client agent and reviewed by the facilitator agent. Code may rely on every value here; changes need a message, both ACKs, and a version bump.

This is the one contract the client library (`@z402-net/client`) and the merchant side (`@z402/facilitator`, `@z402-net/server`, `apps/api`) both build against. It refines [mvp-build-doc.md](mvp-build-doc.md) with what research found; where they disagree, this file wins.

**Change process.** Propose the change by message, both agents ACK, then edit this file and bump the version line. `v0-*` drafts may change; from `v1` on, code may rely on every value in the current version.

**Evidence.** Facilitator track: `docs/research/*.md`. Client track: `docs/research/client/*.md`. The SDK facts were re-read from the `@x402/core` and `@x402/fetch` 2.28.0 sourcemaps.

---

## 1. Identifiers

| Name | Value | Notes |
|---|---|---|
| x402 version | `2` | Pin `@x402/core`, `@x402/fetch`, `@x402/express` to exactly `2.28.0`. |
| Scheme id | `prepaid-voucher` | No collision found. Taken ids include `exact`, `upto`, `batch-settlement`, `deferred`, `channel`, `escrow`, `zcash-shielded`, `zcash-shielded-tab`; avoid `z402*` (npm `z402` exists). |
| Network id | **config value**: `zcash:regtest` (development on the local Z3 stack, per the user), then `zcash:mainnet`; `zcash:testnet` stays supported | Valid CAIP-2 syntax; passes every 2.28.0 check. Provisional: there is no registered `zcash` CAIP-2 namespace (testnet alternative: `bip122:05a60a92d99d85997cce3b87616c089f`). Each network is one exported constant (`NETWORK_REGTEST`, `NETWORK_TESTNET`, `NETWORK_MAINNET`); the network is part of the signed voucher bytes. |
| Asset | `ZEC` | 8 decimals. Amounts are zatoshi decimal strings. |

## 2. Payment requirements (one `accepts` entry)

```json
{
  "scheme": "prepaid-voucher",
  "network": "zcash:regtest",
  "amount": "500",
  "asset": "ZEC",
  "payTo": "uregtest1…",
  "maxTimeoutSeconds": 60,
  "extra": {
    "windowZat": "100000",
    "creditRatioBps": 2500,
    "creditCapZat": "200000",
    "zeroConfMinExpiryBlocks": 20,
    "termsVersion": "<16 hex>"
  }
}
```

| Field | Rule |
|---|---|
| `amount` | Price of this call, zat, canonical, `1 ≤ amount ≤ extra.windowZat`, set per route by the provider. The facilitator accepts any such amount (v2.0). |
| `payTo` | Merchant shielded-only unified address, validated **per network** with `isValidPayTo(ua, network)`. Allowed HRPs come from `zcash_address` 0.14.0 `src/constants.rs`, as R0 or R2 shielded-only: regtest `uregtest` / `zuregtest`; testnet `utest` / `zutest`; mainnet `u` / `zu`. The body is bech32 lowercase `[02-9ac-hj-np-z]+`. R2 transparent-including HRPs (`turegtest`, `tutest`, `tu`) are always rejected. It must be the `payTo` registered to the API key the resource server presents (§16). |
| `extra.windowZat` | One deposit, zat, decimal string. |
| `extra.creditRatioBps` | Integer basis points, 0–10000 (2500 = 25 %). Replaces the doc's float `creditRatio: 0.25`. |
| `extra.creditCapZat` | Credit cap, zat, decimal string. |
| `extra.zeroConfMinExpiryBlocks` | Integer. A pending deposit earns zero-conf credit only with at least this many blocks before expiry (§5.3). |
| `extra.termsVersion` | The first 16 hex of sha256(JSON `["z402-terms-v2", encodeTerms(terms)]`): the rail's terms only, so it moves with neither `payTo` nor price (v2.0). The facilitator owns it. The server scheme copies it into requirements. The API reads its terms from the facilitator's `/supported`, and its startup check validates only the format of `termsVersion`. The client ignores it (`parseTerms` drops unknown keys) but echoes `extra` unchanged, as the stock client does. |

- `extra` is **static per route**. Per-session values must never appear in requirements: the server matches the client's echo of `extra`, so a changing value breaks matching.
- The facilitator owns these terms, which are rail-wide: every provider gets the same. It advertises them through `getExtra()` → `/supported`, and the server scheme copies them in `enhancePaymentRequirements`. From v2.0, `/supported`'s `extra` carries the terms and `termsVersion`, never `payTo`.
- `extra` must not contain `paymentFlow` or `assetTransferMethod`. The flow is the default `authorization`: verify → handler → settle.
- The facilitator reads terms from the API's `paymentRequirements`, never from `paymentPayload.accepted`, which the client could pad with extra keys.

## 3. Payment payload (`PaymentPayload.payload`, inside `PAYMENT-SIGNATURE`)

```json
{
  "sessionKey": "03a107bff3ce10be1d70dd18e74bc09967e4d6309ba50d5f1ddc8664125531b8",
  "cumulativeZat": "53000",
  "sig": "<128 lowercase hex>",
  "depositTxid": "<64 lowercase hex, display order; optional>"
}
```

| Field | Regex / rule |
|---|---|
| `sessionKey` | `^[0-9a-f]{64}$`. Raw 32-byte Ed25519 public key. |
| `cumulativeZat` | `^(0\|[1-9][0-9]{0,15})$` and ≤ 2,100,000,000,000,000 (MAX_MONEY). |
| `sig` | `^[0-9a-f]{128}$`. Ed25519 signature (§4). |
| `depositTxid` | `^[0-9a-f]{64}$`. Display order, as wallets and explorers print it. Optional. |

- Encodings are **canonical or rejected**: uppercase hex, a leading zero or a `+` sign gives `invalid_payload`. Nothing is normalized.
- Unknown keys are ignored.
- The client returns the `x402Version` it was given (2).

## 4. Voucher signature

```
message = UTF-8( [ "z402-voucher-v1", scheme, network, payTo, sessionKey, cumulativeZat ].join("\n") )
sig     = Ed25519 (RFC 8032, pure) over message, 64 bytes, lowercase hex
```

- Every field is regex-checked and none may contain `\n`, so the encoding is injective.
- The facilitator builds the message from the **received strings after validation**. It never re-serializes a parsed number.
- `scheme`, `network` and `payTo` come from the API's `paymentRequirements`.
- One session key per (agent process, `payTo`). Keys are ephemeral, so a restart means a new session with no credit.
- Test vectors live in `packages/protocol/test/vectors.json`: seed, public key, message hex and signature hex for `cumulativeZat` = `"1000"` and `"53000"`. Seed `000102…1f`; fixture payTo from `docs/research/design-critique.md` §2.1. Both sides run them as unit tests.

## 5. Deposits

### 5.1 The deposit transaction
- A shielded payment from the agent's wallet to `payTo`. Today a payment to an Orchard receiver lands as an **Ironwood** output in a v6 transaction; that is a consensus rule since NU6.3.
- Memo = ZIP 302 text memo `"<sessionKey>:<index>"`, exactly. Match against `^<sessionKey>:(0|[1-9][0-9]{0,8})$` after stripping trailing zero bytes. No trimming of anything else.
- The index is **informational**: no uniqueness and no ordering rule. The client counts 1, 2, 3, … per session.
- The client always deposits exactly `windowZat` in one output.

### 5.2 Crediting
- The credit unit is the lowercase txid. It is consumed once **per provider**, under the key `<network>:<payTo>:<txid>` (v2.0).
  - Each provider has its own ledger file. The operator's stays at `Z402_LEDGER` (default `.data/facilitator-ledger.<network>.jsonl`). A registered provider's is `ledgers/<providerId>.jsonl` under `Z402_PROVIDERS_DIR` (default `.data/providers.<network>`).
  - Delete the regtest ledgers after `docker compose down -v`, because regtest heights restart.
  - **A transaction funds at most one session per `payTo`**, and credits each `payTo` with its own outputs only, so nothing is counted twice. The client's deposits have one output, so they fund one session.
- Credited value = the sum of outputs to `payTo` whose memo matches this session's pattern. Outputs with other memos are ignored.
- Rejections:

  | Code | Condition |
  |---|---|
  | `z402_deposit_transparent` | Any transparent input or output. |
  | `z402_deposit_memo_mismatch` | The transaction is found, but this session cannot use it. Any of three cases:<br>- no output decrypts to `payTo`;<br>- no output to `payTo` carries this session's memo;<br>- the txid is already credited to another session.<br>All three get one code and one message, "the deposit cannot be credited". A txid credited to another session gets exactly the answer an uncredited txid gets for the same read outcome. A successful read answers `z402_deposit_memo_mismatch`. A failed read, or a spent read budget, answers the same `z402_chain_unavailable` or `z402_deposit_not_found` (v1.2.1). |
  | `z402_deposit_not_to_merchant`, `z402_deposit_other_session` | Kept in the closed list (§8). Not emitted from v1.2: those cases answer `z402_deposit_memo_mismatch`. |
  | `z402_deposit_dead` | The txid is already known dead, or the presented transaction is unmined and `tip ≥ expiryHeight`. |

- Re-presenting a txid **already credited to the same session** is a no-op: no refetch, no second credit, no refusal.
- Known limit, open for v1.3: when a voucher fits on existing credit, a presented txid that is not credited is ignored and the call is served, but a txid credited to another session is always refused. A session that has paid a real deposit can therefore still tell those two apart.
- A sub-window deposit is credited at full value once mined, but earns no zero-conf credit.
- The facilitator may credit lazily (it answers `/verify` before the lookup finishes when the voucher fits without the deposit). The client therefore resends `depositTxid` until it is acked (§7.3).

### 5.3 Deposit status and zero-conf eligibility

| Observation (lightwalletd `GetTransaction`) | Status |
|---|---|
| `height == 0` (mempool) | `pending` |
| mined at `h`, `confirmations(h, tip) ≥ 1` | `confirmed` |
| `confirmations ≥ 10` | `final` |
| `height == 18446744073709551615` (mined on a non-main fork) | `orphaned` (counts nowhere) |
| unmined, `expiryHeight ≠ 0` and `tip ≥ expiryHeight` | `dead` |
| unmined; every definitive `-5` not-found answer since the first one spans ≥ 120 s **and** the tip advanced ≥ 2 blocks since that first `-5` | `dead` |

- **Not-found streaks.** Any *found* answer resets the streak. Non-definitive answers (any other error, timeouts) neither count nor reset it. Distinct `x-backend` values are recorded when gRPC metadata exposes them but are not required: with 5 balanced backends, a single lagging backend cannot kill a live deposit, because any found answer resets the streak. Both sides use `NOT_FOUND_DEAD_MS = 120000` and `NOT_FOUND_DEAD_BLOCKS = 2`.
- `confirmations(h, tip) = max(tip, h) − h + 1`. A transaction's height can run ahead of `GetLatestBlock`'s cached tip.
- `isDepositDead`: the tip ≥ expiry boundary is exact. Zebra evicts at `tip ≥ expiryHeight`, and block `tip+1` cannot include the transaction.
- `expiryHeight` is a little-endian u32 at bytes 16..20 of the raw v5 or v6 transaction. Default expiry deltas: +40 under NU6.3 (Z3 regtest; mainnet until NU7; Zallet `tx_expiry_delta` 40), and +120 for zingo under NU7. All pass `zeroConfMinExpiryBlocks = 20`.
- Dead records are never deleted. Re-presenting a dead txid gives `z402_deposit_dead`.
- **Zero-conf eligible** ⇔ `valueZat ≥ windowZat` ∧ (`expiryHeight == 0` ∨ `expiryHeight − referenceTip ≥ zeroConfMinExpiryBlocks`). A transparent part is already rejected (§5.2).
  - `referenceTip` = the tip when the facilitator first resolved the deposit (`firstSeenTip`). The facilitator records it in its ledger and never re-evaluates it, so `zeroConf` is fixed per deposit.
  - The client reads `zeroConf` from `session.deposits[]` and never recomputes it.
  - zingo builds +120 blocks, other NU7-era builders +40; both pass with margin.

## 6. Trust ramp

```
D_conf  = Σ valueZat of deposits with status confirmed | final
D_pend  = min(windowZat, Σ valueZat of deposits with status pending ∧ zeroConf)
credit  = min(creditCapZat, ⌊ D_conf × creditRatioBps / 10000 ⌋)
limit   = D_conf + D_pend + credit                         (BigInt, zatoshi)
accept  ⇔ c_new − c_last ≥ amount  ∧  c_new ≤ limit           (c_last = last SETTLED voucher; amount = this call's requirements.amount)
```

- The limit is inclusive.
- `amount` is the price of the call being paid (v2.0). Routes of one provider with different prices share one session, and each voucher must advance by its own call's price.
- The increment rule is lenient (`≥`): a client that overshoots by one price is still accepted, which absorbs lost responses.
- A new session has `c_last = 0` and limit 0, so its first voucher must carry a deposit.
- One implementation, `computeLimit()` in `@z402-net/protocol`, is imported by both sides.
- Worst-case merchant loss per session is `min(W, Σ live pending) + min(C_max, r·D_conf)`, plus the value of any credited deposit that a reorg removes before it is final. The MVP accepts that reorg term; see facilitator design §4.2.

Reference values (W = 100,000, 2500 bps, cap 200,000):

| State | limit |
|---|---|
| new session | 0 |
| D1 pending | 100,000 |
| D1 confirmed | 125,000 |
| D1 confirmed + D2 pending | 225,000 |
| D1, D2 confirmed | 250,000 |
| D1, D2 both pending | 100,000 |
| 8 confirmed (credit at cap) | 1,000,000 |
| 100,001 confirmed | 125,001 |
| 1,000,000 pending (over-deposit) | 100,000 |

## 7. Facilitator responses

### 7.1 Always HTTP 200, always schema-complete
- `/verify` replies `{ isValid, invalidReason?, invalidMessage?, payer: sessionKey, extra: { session } }`.
- `/settle` replies `{ success, errorReason?, errorMessage?, transaction, network, payer: sessionKey, amount?, extra: { session } }`:
  - `transaction` is always a string (§7.3);
  - `amount` is the charged delta `c_new − c_last` on success, and is **omitted** on failure.
- `payer` and `extra.session` are present on every verify and settle response **after the voucher signature verifies**. They are **absent** on `invalid_payload`, `invalid_payment_requirements`, `invalid_network`, `invalid_scheme`, `unsupported_scheme`, `invalid_x402_version`, `z402_invalid_signature` and `unexpected_*`. Those answers are unauthenticated or pre-parse, and the client treats them as fatal or retryable without needing state.
- Never `settlement_pending`: the SDK would call `/settle` again.
- Never a non-200 status once the key check passes (a missing or unknown key is `401`, §16): a 500 leaks its body into the client-visible error, and a 200 missing `transaction` becomes a 502.

### 7.2 Session snapshot (`extra.session`)

```json
{
  "sessionKey": "<64 hex>",
  "cumulativeZat": "53000", "limitZat": "125000", "headroomZat": "72000",
  "confirmedZat": "100000", "pendingZat": "0", "creditZat": "25000",
  "tip": 4547331,
  "deposits": [
    { "txid": "<64 hex>", "valueZat": "100000", "status": "pending|confirmed|final|orphaned|dead",
      "confirmations": 2, "expiryHeight": 4547450, "zeroConf": true }
  ]
}
```

- All amounts are zat decimal strings; `tip`, `confirmations` and `expiryHeight` are numbers.
- `deposits` holds every non-final entry plus the last 4 final ones, so the header stays well under 16 KB.
- It is present in every post-signature `SettleResponse.extra.session`, success or failure, and in every post-signature corrective 402 (§7.1 lists when it is absent).
- **Corrective 402:** on every verify refusal, `PAYMENT-REQUIRED.accepts[0].extra.session` carries the snapshot. The server scheme does this with an `onAfterVerify` WeakMap plus `enrichPaymentRequiredResponse`; the pattern was proven in the e2e spike. Without it, a verify refusal exposes only the bare `invalidReason`.
- Both sides validate snapshots with `parseSessionSnapshot()` from `@z402-net/protocol`.

### 7.3 Deposit acknowledgement
- `SettleResponse.transaction = depositTxid` whenever the payload's `depositTxid` is credited to this session. That covers a new credit and a re-presentation, so a lost ack can be re-acked. Otherwise `""`.
- **A deposit is acknowledged ONLY by a successful settle** (`success: true`): `settle.transaction === depositTxid`, or the txid is listed in `session.deposits` of that successful `SettleResponse`. Until then the client resends the txid.
- Snapshots carried by refusals (corrective 402s, and settle `success: false`) are **projected and informational**. The facilitator may list a presented, not-yet-credited txid in them "as if credited". The client resyncs `cumulative` and copies `dead` statuses from them, but never treats a listing there as an acknowledgement. Re-presenting an already-credited txid is an idempotent no-op ack on the facilitator.
- The facilitator never answers `z402_deposit_required` while a presented deposit's lookup is in flight, or while its cached result is a live pending deposit; that case is `z402_awaiting_confirmation`. A client that receives `z402_deposit_required` for an attempt that presented an unaccounted txid treats it as a facilitator fault and halts, rather than paying again.

## 8. Reason codes and client actions

Only `invalidReason` (verify) or `errorReason` (settle) reaches the client, so **the code carries the action**. Settle failures use the same codes as verify refusals.

| Code | Meaning | Client action (the stock wrapper allows one `{recovered:true}` per call) |
|---|---|---|
| `z402_awaiting_confirmation` | `c_new > limit`; a live pending deposit exists | Never deposit. Wait until the pending deposit has ≥ 1 confirmation (own lightwalletd check), then recover. On the final attempt, return. |
| `z402_deposit_required` | `c_new > limit`; nothing pending | Deposit (inline), then recover. On the final attempt, start a background deposit. In cheat mode (`maxDeposits` reached), return. |
| `z402_cumulative_mismatch` | `c_new − c_last < amount` | Resync `c` from `session.cumulativeZat`, then recover. |
| `z402_invalid_signature` | Signature fails | Fatal: report it. |
| `z402_deposit_not_found` | Definitive not-found answers for `depositWaitMs` (30 s by default) | Keep the txid. Check own status: if seen, recover. If the wallet marked it failed, treat it as dead. Otherwise back off and recover. |
| `z402_chain_unavailable` | lightwalletd errors, no definitive answer | Keep the txid, back off 5 s, recover. |
| `z402_deposit_not_to_merchant`, `z402_deposit_memo_mismatch`, `z402_deposit_transparent`, `z402_deposit_other_session` | Deposit unusable | Drop the txid from the resend set. Fatal: report it (wrong `payTo` or a bug). |
| `z402_deposit_dead` | Expired, dropped or orphaned | Drop the txid, make a new deposit (next index), recover. |
| `invalid_payload`, `invalid_payment_requirements`, `invalid_network`, `invalid_scheme` (payload and requirements disagree on the scheme), `unsupported_scheme` (no registered version, scheme and network), `invalid_x402_version` | Bug or configuration drift | Fatal. |
| `unexpected_verify_error`, `unexpected_settle_error` | Facilitator bug | Back off 1 s, recover once. |
| anything else | Unknown | Fatal. |

**The list is closed: 8 standard and 11 scheme codes.** The facilitator emits nothing else. From v1.2 it emits `z402_deposit_memo_mismatch` in all three cases of its §5.2 row, while `z402_deposit_transparent` and `z402_deposit_dead` keep their own codes. `z402_deposit_not_to_merchant` and `z402_deposit_other_session` stay in the list, and the client handles them the same way. The SDK and the API can still put their own strings in `PAYMENT-REQUIRED.error`. None of these are facilitator codes, and the client treats them as fatal:
- `"Payment required"`: the `PAYMENT-SIGNATURE` was undecodable or absent;
- `"No matching payment requirements"`: `accepted` was altered;
- `"Facilitator … failed (<status>)"`: only after a 401 from a misconfigured token.

A facilitator timeout reaches the client as HTTP 502 with **neither** header, which is an ambiguous outcome (§9.4), not a refusal.

## 9. Client rules

1. **Scheme object.** Implement `findDefaultAsset(asset, network)`, returning `{ asset: "ZEC", decimals: 8, symbol: "ZEC" }` for `ZEC` on `zcash:*`. Without it the stock `x402Client` spend controls reject every call.
2. **Spend safety.** Refuse requirements whose `windowZat` exceeds `context.maxAmountPerPayment` (default `"100000000"`) or the client's own `maxDepositZat`, or whose `payTo` fails the regex.
3. **Sequential per session.** Hold a per-session mutex from `createPaymentPayload` until `onPaymentResponse` ends. Cancel the 120 s safety release on hook entry. A safety trip counts as an ambiguous outcome.
4. **Counting.** A call is paid only on `settleResponse.success === true`, and `c` resyncs from `session.cumulativeZat`.
   - On an explicit refusal (a corrective 402, or settle `success:false`), `c` does not advance.
   - On an ambiguous outcome (the hook fires with neither header, or the safety release trips), `c` advances to the attempted value.
5. **Deposit trigger.** The mirror only decides *when* to deposit; the client always sends the voucher.
   - **Inline** before the call when there is no snapshot yet (call 1), or when the voucher cannot fit and nothing is pending.
   - **In the background** when the last snapshot shows nothing pending and `headroomZat < trigger` (default `windowZat`).
   - **In the hook** on `z402_deposit_required`.
   - Never on `z402_awaiting_confirmation`.
6. **Resend.** Attach the newest non-dead, unacked deposit's txid to every call until it is acked (§7.3).
7. **Wallet errors.** Before re-sending a deposit after a wallet error, look the memo up in the wallet history and present the txid found instead of paying twice.

## 10. Facilitator rules (summary; detail in the facilitator's own spec)

- Bind to `127.0.0.1`. Start before the API (the API exits if `checkProvider` fails, §16, or if `/supported` lacks the route's scheme and network).
- `/verify` writes no payment state: it commits no voucher and credits no deposit, though its refresh may record a deposit's chain status. `/settle` re-checks and commits synchronously, with no `await` between check and write.
- Tip-driven poller: `GetLatestBlock` every 5 s, re-checking deposits on each tip change.
- Refresh-before-refuse: before refusing a session that has a pending deposit, re-query it. Bounded by one RPC deadline (5 s), at most once per 5 s per session.
- 5 s deadline per RPC. Transport errors map to `z402_chain_unavailable`. Only the three definitive not-found rows of the §15 `getTransaction` table (`isDefinitiveNotFound()`) mean not-found.
- The bearer API key picks the provider. `payTo` must be that provider's; `amount` a canonical zat in [1, `windowZat`]; the terms equal to the rail's. Anything else answers `invalid_payment_requirements` (v2.0).

## 11. Chain access facts

### 11.0 Z3 regtest (the development network; source-derived, see `docs/research/client/z3.md`; live values in `docs/research/client/z3-live.md`)

- **Stack.** Z3 `ZcashFoundation/z3@e84ce9fd`: Zebra 6.2.3 and Zallet `v0.1.0-beta.1`, with Zaino overridden to `zingodevops/zainod:0.10.2-no-tls` (Zaino < 0.8 reports a mempool tx at the tip height and is unsupported). It is owned by the client agent under `infra/z3/`.
- **Endpoints.**
  - Zaino CompactTxStreamer: `http://127.0.0.1:28137` (plaintext h2c; TLS follows the URL scheme).
  - Zebra RPC: `http://127.0.0.1:29232`.
  - Zallet RPC: `http://127.0.0.1:50232` (Basic `zebra:zebra`).
- **Heights.** Overwinter…Canopy at 1, NU5…NU6.3 at 2, NU7 not active. Deposits are Ironwood outputs in v6 transactions, branch `0x37a5165b`.
- **Blocks** exist only when mined: `infra/z3/rpc.mjs` exports `mineNow(n)`, and `infra/z3/clock.mjs run --every 25` mines on a clock. Without the clock nothing confirms or expires.
- **`GetLightdInfo.chainName`** is `"test"` on regtest. Never derive the network from `chainName`. The facilitator identifies the network by `saplingActivationHeight` and checks the upgrade by `consensusBranchId` (§15). Z3's Zaino reports `saplingActivationHeight` 1.
- Zaino polls the mempool every 500 ms, so one not-found right after a broadcast is normal.

### 11.1 Mainnet (Phase 2)

- NU6.3 (Ironwood) is active, branch `0x37a5165b`. NU7 activates at 3,543,405 (branch `0x77190ad9`), about 2026-11-05/06, after the deadline.
- Endpoint: `zec.rocks:443` (TLS) or a regional `na|eu|ap|sa.zec.rocks:443`. Use one host for both wallet and facilitator. Blocks average about 75 s.
- For real money, the facilitator needs a lightwalletd its operator runs, not the public zec.rocks. It trusts the endpoint on whether a deposit exists and how deep it is mined, for every provider it serves. A mainnet facilitator warns at startup when `Z402_LWD_URL` is not a loopback host.

### 11.2 Public testnet (research record, live-verified 2026-10-27; unusable for funding)


- **Endpoint.** The only working public testnet endpoint is `testnet.zec.rocks:443` (TLS). It runs a zec.rocks fork of lightwalletd v0.5.4 on Zebra 7.0.0. Protos: `github.com/zcash/lightwallet-protocol`.
- **Load balancing.** It balances `GetTransaction` per request across about 5 backends; first-sight skew reaches about 16 s. `GetLatestBlock` and `GetLightdInfo` come from an edge cache that lags 0–9 s.
- **Demo option.** Both sides can point at the same direct backend, `na-lax.testnet.zec.rocks:443`: the wallet broadcasts there and the facilitator reads there, so first sight is immediate. It is a config switch, not the default, because that name is undocumented.
- **Timeouts.** The API's `HTTPFacilitatorClient` timeout is 60 s, so a paid request may legitimately take up to about 60 s.
- **Network upgrades.** NU7 has been active on testnet since height 4,465,026, branch `0x77190ad9`. Blocks average ~25 s (median 20 s, p90 53 s, max 164 s), and mempool → mined has a median of 22 s.
- **`TxFilter.hash`.** Takes the **byte-reversed** display txid. Display order returns NotFound.
- **`RawTransaction.height`.** 0 for the mempool, `h` once mined, `2^64−1` on a fork. Read it as a string or BigInt.
- **Not-found.** See the matcher table in §15. On lightwalletd only NOT_FOUND + `-5: Transaction not found in mempool or best chain` means not-found; the fork maps every backend error to NotFound and retries for about 22 s first.
- **`SendTransaction`.** Returns OK even on rejection; check `errorCode`.
- **Crates.** Only crates on the `zcash_protocol 0.11` / `zcash_primitives 0.31` / `orchard 0.16` line parse NU7 transactions; `zcash_protocol ≤ 0.10.6` fails on every transaction.

## 12. Demo terms (option A chosen by the user, 2026-10-27)

From v2.0 the price is per route (§2), and each service sets its own (the starter services charge 100 to 1,000 zat). 500 zat stays the demo API's `GET /chunk` price, which the table below chose; it is not a protocol value. The live two-provider check pays 500 at provider 1 and 800 at provider 2.

| Option | Price `p` | Honest run | Cheat run | Simulated |
|---|---|---|---|---|
| **A (chosen)** | 500 zat | 1 call/s, 150 calls ≈ 156 s, no stall. Credit line and D2 appear in 87–92 % of runs. | Local speed: refused at cumulative 125,000. | 0 stalls in 4,000 runs |
| B | 1,000 zat (the doc's value) | Pre-confirm D1 off camera, then run at local speed; D2 at call 1 shows zero-conf. | Same refusal at 125,000. | 0 stalls, but "served on an unconfirmed deposit" is shown by D2, not D1 |

W = 100,000, 2500 bps, C_max = 200,000 and `zeroConfMinExpiryBlocks` = 20 in both options.

## 13. Shared code: `@z402-net/protocol`

The client agent drafts it; both agents own it from v1. Pure TypeScript, no network. Exports:

```ts
// constants
SCHEME = "prepaid-voucher"; ASSET = "ZEC"; ZEC_DECIMALS = 8
NETWORK_REGTEST = "zcash:regtest"; NETWORK_TESTNET = "zcash:testnet"; NETWORK_MAINNET = "zcash:mainnet"
type ZcashNetwork = typeof NETWORK_REGTEST | typeof NETWORK_TESTNET | typeof NETWORK_MAINNET
ZCASH_NETWORKS: readonly ZcashNetwork[]; isZcashNetwork(s: string): s is ZcashNetwork
VOUCHER_DOMAIN = "z402-voucher-v1"; MAX_MONEY_ZAT = 2_100_000_000_000_000n; FINAL_CONFIRMATIONS = 10
NOT_FOUND_DEAD_MS = 120_000; NOT_FOUND_DEAD_BLOCKS = 2                // §5.3 not-found streak
// validation
SESSION_KEY_RE, ZAT_RE, SIG_RE, TXID_RE, DEPOSIT_INDEX_RE
PAY_TO_RES: Readonly<Record<"zcash:regtest" | "zcash:testnet" | "zcash:mainnet", RegExp>>
parseZat(s: string): bigint                                   // throws ProtocolError("invalid_payload")
isValidPayTo(ua: string, network: string): boolean            // PAY_TO_RES[network]; unknown network → false
// terms
interface PrepaidVoucherExtra { windowZat: string; creditRatioBps: number; creditCapZat: string; zeroConfMinExpiryBlocks: number }
interface Terms { windowZat: bigint; creditRatioBps: number; creditCapZat: bigint; zeroConfMinExpiryBlocks: number }
DEMO_TERMS: Terms = { windowZat: 100000n, creditRatioBps: 2500, creditCapZat: 200000n, zeroConfMinExpiryBlocks: 20 }
parseTerms(extra: unknown): Terms                             // throws ProtocolError; ignores unknown keys (e.g. termsVersion)
encodeTerms(t: Terms): PrepaidVoucherExtra
// payload + voucher
interface VoucherPayload { sessionKey: string; cumulativeZat: string; sig: string; depositTxid?: string }
parseVoucherPayload(p: unknown): VoucherPayload               // throws ProtocolError("invalid_payload")
interface VoucherFields { scheme: string; network: string; payTo: string; sessionKey: string; cumulativeZat: string }
voucherMessage(f: VoucherFields): Uint8Array
signVoucher(seed: Uint8Array, f: VoucherFields): string        // 32-byte RFC 8032 seed → 128-hex sig
verifyVoucher(p: Pick<VoucherPayload, "sessionKey" | "cumulativeZat" | "sig">,
              ctx: { scheme: string; network: string; payTo: string }): boolean
publicKeyFromSeed(seed: Uint8Array): string                    // → 64-hex sessionKey
generateSeed(): Uint8Array                                     // 32 random bytes (client sessions)
// memo
depositMemo(sessionKey: string, index: number): string
parseDepositMemo(memo: string): { sessionKey: string; index: number } | null
// ramp
type DepositStatus = "pending" | "confirmed" | "final" | "orphaned" | "dead"
interface RampDeposit { valueZat: bigint; status: DepositStatus; zeroConf: boolean }
interface Ramp { confirmedZat: bigint; pendingZat: bigint; creditZat: bigint; limitZat: bigint }
computeLimit(deposits: RampDeposit[], terms: Terms): Ramp     // orphaned and dead count nowhere
zeroConfEligible(a: { valueZat: bigint; expiryHeight: number; referenceTip: number; terms: Terms }): boolean
confirmations(minedHeight: number, tip: number): number
isDepositDead(d: { minedHeight: number | null; expiryHeight: number; tip: number }): boolean
checkVoucher(v: { cLast: bigint; cNew: bigint; price: bigint; limit: bigint }): "ok" | "cumulative_mismatch" | "over_limit"
// snapshot
interface SnapshotDeposit { txid: string; valueZat: string; status: DepositStatus; confirmations: number; expiryHeight: number; zeroConf: boolean }
interface SessionSnapshot { sessionKey: string; cumulativeZat: string; limitZat: string; headroomZat: string; confirmedZat: string;
  pendingZat: string; creditZat: string; tip: number; deposits: SnapshotDeposit[] }
parseSessionSnapshot(x: unknown): SessionSnapshot | null
// reasons
REASON: { awaitingConfirmation: "z402_awaiting_confirmation", … }   // the closed list of §8 (19 codes)
type ReasonCode; isReasonCode(s: string): s is ReasonCode
class ProtocolError extends Error { readonly code: ReasonCode }
class ChainUnavailableError extends Error { constructor(message: string, options?: { cause?: unknown }) }
  // thrown by every chain reader on transport errors: FakeChain, @z402-net/lightwalletd, the client's TxStatusSource
// raw tx + chain seam (facilitator owns these shapes)
expiryHeightFromRawTx(raw: Uint8Array): number                 // v5/v6 only, else throws
type TxInspection = { found: false } | { found: true; txid: string; location: "mempool" | "mined" | "orphaned";
  minedHeight: number | null /* set only when location === "mined" */; expiryHeight: number;
  hasTransparent: boolean; outputs: Array<{ pool: "orchard" | "sapling" | "ironwood"; valueZat: bigint; memo: string | null }> }
type FoundInspection = Extract<TxInspection, { found: true }>
interface ChainView { tip(): Promise<number>; inspect(txid: string): Promise<TxInspection> }   // throws on transport errors
// client seams (the client agent owns these shapes; FakeChain and MockWallet implement them)
interface DepositRequest { to: string; amountZat: bigint; memo: string }
interface ZcashWallet { sendDeposit(req: DepositRequest): Promise<{ txid: string }>; close?(): Promise<void> }
type TxStatus = { found: false }
              | { found: true; location: "mempool" | "mined" | "orphaned"; minedHeight: number | null; expiryHeight: number }
interface TxStatusSource { tip(): Promise<number>; status(txid: string): Promise<TxStatus> }   // throws ChainUnavailableError
```

*Implementation note: Ed25519 uses `node:crypto` (OpenSSL, strict RFC 8032). `@noble/curves` cross-checks the vectors in tests only.*

## 14. Repository layout and ownership

pnpm workspace, ESM (`"type": "module"`), TypeScript strict with `NodeNext` (relative imports carry `.js`), vitest, tsx; packages depend on each other with `workspace:*`.

| Path | Package | Owner |
|---|---|---|
| `/` root config (`package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.gitignore`) | — | client agent (scaffolds first) |
| `packages/protocol` | `@z402-net/protocol` | client agent drafts; shared from v1 |
| `packages/client` | `@z402-net/client` | client agent |
| `packages/testkit` | `@z402/testkit` (FakeChain, MockWallet) | client agent; `ChainView` shape owned by the facilitator agent |
| `packages/lightwalletd` | `@z402-net/lightwalletd` | facilitator agent |
| `packages/facilitator` | `@z402/facilitator` | facilitator agent |
| `packages/server` | `@z402-net/server` | facilitator agent |
| `apps/api` | `@z402/api` | facilitator agent |
| `apps/agent` | `@z402/agent` (demo loop) | client agent |
| `apps/e2e` | `@z402/e2e` (single-process harness) | client agent |
| `crates/zdecrypt` | Rust decryptor | facilitator agent |
| `.tools/bin/` (gitignored) | locally built binaries (`zingo-cli`, `zdecrypt`) | whoever builds them |

The services agent owns `services/*`, `packages/service-kit`, `apps/web`, `apps/smoke`, `docker/` and `compose.yaml`. From v2.0 `apps/discovery` is retired: the Bazaar is the facilitator's (§17).

No agent edits another's paths; requests go by message.

## 15. Integration seams (owned by the facilitator agent; consumed by the client agent's e2e harness and status check, and by the services agent's kit)

```ts
// @z402-net/lightwalletd
type RawTx = { found: false }
           | { found: true; raw: Uint8Array; location: "mempool" | "mined" | "orphaned"; height: number | null };
createLightwalletdClient(opts: { url: string /* http:// = plaintext, https:// = TLS */; rpcDeadlineMs?: number /* 5000 */ }): {
  getTip(): Promise<number>;
  getTransaction(txid: string): Promise<RawTx>;   // txid = 64 lowercase hex, display order; TypeError otherwise
  getLightdInfo(): Promise<{ chainName: string; consensusBranchId: string; blockHeight: number; version: string; saplingActivationHeight: number }>;
  close(): void;
}
```

`getTransaction` mapping:

| lightwalletd answer | Result |
|---|---|
| proto height `"0"` | `location: "mempool"`, `height: null` |
| proto height `"18446744073709551615"` | `location: "orphaned"`, `height: null` |
| any other proto height `h` | `location: "mined"`, `height: Number(h)` |
| **definitive not-found** (`isDefinitiveNotFound()`, exactly these three rows) | `{ found: false }` (its only source) |
| · lightwalletd: gRPC `NOT_FOUND` (5), details contain `-5: Transaction not found in mempool or best chain` | |
| · Zaino ≥ 0.10.1: gRPC `INTERNAL` (13), details contain `LegacyRpcError { code: -5, message: "No such mempool or main chain transaction" }` | |
| · Zebra ≥ 6.4 built-in gRPC (fallback): gRPC `NOT_FOUND`, details contain `transaction not found` | |
| anything else (other codes or texts, `UNAVAILABLE`, deadline) | throws `ChainUnavailableError` |

```ts
// @z402/facilitator
interface FacilitatorOptions {
  network: ZcashNetwork; chain: ChainView /* the operator's */; payTo: string /* the operator's */; terms: Terms;
  priceZat?: bigint /* ignored from v2.0: each provider prices its own routes */;
  providers?: {   /* registered providers (§16); without it, POST /providers answers 403 registration_disabled */
    dir: string; chainFor(p: { payTo: string; uivk: string }): ChainView; owns(p: { payTo: string; uivk: string }): Promise<boolean>;
    max?: number /* 32, the operator not counted; 0 turns away new providers only */; registrationToken?: string;
  };
  authToken?: string; ledgerPath?: string; host?: string /* 127.0.0.1 */; port?: number /* 0 */;
  pollIntervalMs?: number /* 5000 */; depositWaitMs?: number /* 30000: cross-backend first-sight skew reaches ~16 s */;
  onFatal?: (err: unknown) => void /* once, on the first failed ledger write; the host should exit and restart to replay the file */;
  log?: (msg: string, err?: unknown) => void /* one line per request plus diagnostics; diagnostics default to stderr */;
}
startFacilitator(o: FacilitatorOptions): Promise<{ url: string; pollNow(): Promise<void>; close(): Promise<void> }>

// @z402/api
interface ApiOptions { network: ZcashNetwork; facilitatorUrl: string /* "" throws */; facilitatorToken?: string; payTo: string; priceZat: bigint; host?: string; port?: number }
startApi(o: ApiOptions): Promise<{ url: string; close(): Promise<void> }>
// both throw unless isValidPayTo(payTo, network); apps/e2e passes NETWORK_REGTEST

// @z402-net/server
checkProvider(o: { facilitatorUrl: string; token?: string /* the API key, sent as a bearer */; payTo: string; network: string;
  fetch?: typeof fetch; timeoutMs?: number /* 5000 */ }): Promise<void>   // calls GET /providers/me (§16)
class ProviderCheckError extends Error { readonly field: "facilitatorToken" | "payTo" | "facilitatorUrl"; readonly retryable: boolean }
```

`checkProvider` outcomes. Callers branch on `field` and `retryable`, never on the message, which never echoes the token:

| Outcome | `field` | `retryable` |
|---|---|---|
| connection error, timeout, a body that breaks off, 5xx, 408 or 429 | `facilitatorUrl` | true |
| 404 (a facilitator without the route), any other status, or an unreadable 200 | `facilitatorUrl` | false |
| 401 or 403 | `facilitatorToken` | false |
| 200, but another `payTo` or network | `payTo` | false |
| before any request: a `facilitatorUrl` that is not http(s) or carries credentials | `facilitatorUrl` | false |
| before any request: a `token` that is not a b64token | `facilitatorToken` | false |

- The paid route is `GET /chunk`. Its body is `{ chunk: number, cumulativeZat: string, data: string }` with `chunk = cumulativeZat / price`, so it never moves on refused calls.
- Other methods:
  - An unpaid request gets 402, whatever the method.
  - A paid request with any method other than GET, `HEAD` and `OPTIONS` included, gets 405 with `Allow: GET` after verification. It is never settled, so the same voucher still buys a GET.
- **The ledger lock.** `startFacilitator` takes `<ledger>.lock` and touches it every 5 s (the heartbeat). A clean stop removes it.
  - **Taking over a stale lock.** A lock nobody has touched for 15 s was left by a crash, whatever pid or host it names, and is taken over. A crash takeover completes in about 15.25 s: the 15 s, plus one 250 ms poll.
  - **Refusing a held lock.** A fresh lock whose pid is alive on this host is refused at once, with an error whose message starts with `ledgerPath:`. Any other fresh lock (a dead pid, this pid, another host, or unreadable content) is watched: a heartbeat means a live holder, and the start is refused.
  - **Losing the lock.** The holder reads its lock again at every heartbeat and before every ledger write. Once it has lost the lock, it refuses every write.
  - **A known gap.** The fencing has a measured window: after a takeover, one batch can pass between the ownership check and the append. Closing it needs flock or a lease, which is a mainnet item.
- **The ledger header.** A new ledger starts with a header line that names its network and `payTo`. Startup refuses a ledger whose header names another network or `payTo`, with `ledgerPath: … is the ledger of …`. A ledger without a header (created before v1.2.1) still replays and is never rewritten. The exception is mainnet, where a facilitator opens only a ledger it created itself.
- **The startup network check.** `getLightdInfo().saplingActivationHeight` must be 419200 on mainnet and 280000 on testnet. On regtest it must be neither (Z3 reports 1). `consensusBranchId` must equal the expected branch; that is the upgrade check. A mismatch on either refuses startup.
- **Plaintext URLs.** Off regtest, `http://` is allowed only to a loopback host, both for the facilitator's `Z402_LWD_URL` and for the API's `facilitatorUrl`; use `https://` otherwise. Regtest keeps plaintext to any host, for compose networks.
- **The keys file.** Startup refuses a `Z402_MERCHANT_KEYS_FILE` on mainnet when it holds the spending seed (`seedHex`) or the full viewing key (`ufvk`). On other networks it warns once instead. Give the facilitator only `uivk` and `orchardOnlyAddress`, or set `Z402_UIVK` and `Z402_PAY_TO`. A non-loopback `Z402_FACILITATOR_HOST` also warns.
- **`close()`** closes idle connections at once and resolves once in-flight requests have finished. A connection that was busy when `close()` ran can hold it for up to the 5 s keep-alive timeout after its response (about 3.3 s with undici). After it resolves, nothing writes the ledger. A settle that is already being served while `close()` runs is still recorded.
- **The token.** `authToken`, the API's `facilitatorToken`, every API key and the registration token must be an RFC 6750 b64token: letters, digits and `-._~+/`, optionally followed by `=` padding. Any other value makes startup refuse it. The operator's API key is `authToken` (`Z402_FACILITATOR_TOKEN`).
- **The facilitator URL.** `startApi` refuses a `facilitatorUrl` that carries credentials; pass `facilitatorToken` instead.
- The API calls `checkProvider` at startup, before it reads its terms from the facilitator's `/supported`, and refuses to start on any `ProviderCheckError`. A kit service retries while `retryable`.
- Start order: `await startFacilitator(...)`, then `startApi(...)`.

## 16. Providers and API keys (v2.0)

A provider is one `payTo` with its own view-only key (UIVK), API key, runtime and ledger. Each provider, the operator included, prices its own routes and never runs a facilitator.

- **The operator** is the provider configured at startup: `Z402_MERCHANT_KEYS_FILE`, or `Z402_PAY_TO` + `Z402_UIVK`. Its API key is `Z402_FACILITATOR_TOKEN`, and its ledger stays at `Z402_LEDGER`. A facilitator started without `authToken` (embedded tests) treats a request with no `Authorization` header as the operator's. Registered providers always need their key.
- **Provider id.** The first 16 hex of sha256(`"z402-provider-v1\n" + network + "\n" + payTo`). It is fixed by `payTo`, so a key rotation keeps the provider's ledger and catalog entries.
- **API key.** `z402_` followed by 43 base64url characters (32 random bytes), a valid b64token. It is shown once, stored only as its sha256, never logged (access-log lines name the `providerId`), and sent as `Authorization: Bearer <apiKey>` on `/verify`, `/settle`, `GET /providers/me` and `POST /discovery/resources`. A request to these routes without a valid key gets `401` with `WWW-Authenticate: Bearer`.
- **Keyless routes.** `GET /supported`, `GET /discovery/resources` and `GET /discovery/search` need no key. A request to them that presents a bearer naming no provider (an unknown key, or one rotated out) gets `401` with `WWW-Authenticate: Bearer`, so a stale key is noticed rather than treated as anonymous.
- **`POST /providers`.** Public unless `Z402_REGISTRATION_TOKEN` (at least 32 characters) is set, in which case `Authorization: Bearer <registration token>` is required. While registration is open, every start logs a warning. On mainnet, open registration is off unless `Z402_REGISTRATION_OPEN=1`; without a token or that opt-in, the operator still serves and `POST /providers` answers `403 registration_disabled`. `payTo` is at most 1024 characters, here and in the operator's `Z402_PAY_TO` (v2.0).
  - Body: `{"payTo": "<UA>", "uivk": "<UIVK>", "network"?: "<network>"}`. `payTo` must pass `isValidPayTo`, `uivk` must match the network's UIVK pattern, and `network`, if given, must be the facilitator's.
  - The UIVK must own `payTo` (zdecrypt `owns`: `ownedByKey: true`, `hasTransparent: false`).
  - Registrations run one at a time. A new provider's runtime (ledger lock, header, replay, first poll, watcher) opens before the registry is written, and only then is the key issued.
  - Answer: `201 {"providerId","network","payTo","apiKey"}`. The UIVK is never echoed.
  - **Rotation.** Registering a registered `payTo` again, with a key that owns it, answers `200` with the same shape and a new key. The old key stops working at once, on every route. This is also how a lost key is recovered.
  - **Refusals**, with body `{"error": "<code>", "message": "<text>"}`: `400 invalid_request` (the message names the field), `401 unauthorized` (registration token missing), `403 not_owner` (the UIVK does not own `payTo`, or `payTo` has a transparent receiver), `403 provider_limit` (`Z402_MAX_PROVIDERS`, default 32, operator not counted; it applies to a new `payTo` only, so with `0` a registered provider can still rotate its key), `403 registration_disabled` (no providers directory), and `409 operator` (`payTo` is the operator's).
  - `scripts/register-provider.mjs --keys <view-only keys file> --facilitator <url> --out <key file>` does this from a merchant-keygen file and saves the key with mode 0600. It never prints the key, the UIVK or the registration token.
- **`GET /providers/me`.** Authenticated with the API key. Answers `200 {"providerId","network","payTo"}`, or `401 {"error":"unauthorized"}` for an unknown key and for a rotated-out key from the moment it is rotated. `checkProvider` (§15) calls it.
- **Isolation.** The key picks the provider's runtime, and a `paymentRequirements.payTo` other than that provider's answers `invalid_payment_requirements` (§10). Deposits decrypt only with that provider's UIVK, and credits live in that provider's ledger.
- **On disk** (`Z402_PROVIDERS_DIR`, mode 0700): `registry.json` (0600; written atomically, under the same heartbeat lock as ledgers), `ledgers/<providerId>.jsonl` with their locks, and `discovery.json` (§17). A malformed registry, one for another network, or an entry whose UIVK no longer owns its `payTo` refuses startup.
- **Failure scope.** `onFatal` is process-wide: a failed ledger write or a lost lock in any runtime exits the process, and the restart replays every ledger.

## 17. Discovery, the Bazaar (v2.0)

The facilitator hosts the x402 Bazaar with the exact `@x402/extensions` 2.28.0 shapes: what `withBazaar(client).extensions.bazaar.listResources()` and `search()` call. `/supported` lists `"bazaar"` in `extensions`.

- **`GET /discovery/resources`** (no key needed, §16). Query: `type`, `payTo`, `scheme`, `network`, `extensions` (one key name the item must carry), `limit` (default 20, clamped to 1–100) and `offset` (default 0); `limit` and `offset` must be non-negative decimal integers, else `400`. Answer: `{"x402Version":2,"items":[…],"pagination":{"limit","offset","total"}}`, ordered by resource, then method, then provider id.
- **`GET /discovery/search`** (no key needed, §16). `query` (required, 1–256 characters) is a case-insensitive substring of `resource`, `description`, `serviceName` or any tag; the same filters and `limit` apply; `cursor` is an opaque decimal offset. Answer: `{"x402Version":2,"resources":[…],"partialResults":false,"pagination":{"limit","cursor": <next or null>}}`.
- **`POST /discovery/resources`** (API key). Body `{"items":[…]}`, 1–32 standard `DiscoveryResource` entries without `lastUpdated`. One bad item refuses the whole call with `400 {"error":"invalid_request","index":i,"message":…}`. A valid item is upserted, its `lastSeen` set to now, and the answer is the items as served. The kit re-declares every 30 s, which is the liveness signal. The facilitator never fetches a provider URL.
- **Served item.** The standard `DiscoveryResource` (`resource`, `type: "http"`, `x402Version: 2`, `accepts`, `lastUpdated`, and the optional `description`, `mimeType`, `serviceName`, `tags`, `iconUrl`, `extensions`), plus two fields beyond the standard:
  - `lastSeen` (ISO 8601): the provider's latest declaration of the item, absent for items listed only from payments. Readers derive up (under 90 s), stale (under 10 min) and down (older).
  - `paidCallsToday`: the successful settles for the item since 00:00 UTC. It is an aggregate only; no session, key or amount per call is ever exposed.
- **Sources.**
  1. **Declarations** by the provider, as above.
  2. **Settled payments.** Each successful settle bumps `lastUpdated` and `paidCallsToday` on the provider's item whose canonical resource and method match: the resource from `paymentPayload.resource.url` and `extensions.bazaar.routeTemplate`, the method from `extensions.bazaar.info.input.method`. The stock client copies the 402's `extensions` into the payment. A provider that has never declared anything is listed from its payments, as standard Bazaar facilitators do. Such an item holds only the canonical URL, `accepts` from the server's `paymentRequirements` (the one part the server vouches for), and the `mimeType` and `bazaar` extension the payer echoed, each kept only if it passes the field checks below. A payment never supplies `description`, `serviceName`, `tags` or `iconUrl`, and at most 8 payment-sourced items exist per provider, which bounds what a payer can list under a provider that does not declare (v2.0). Once a provider has declared anything, its payments only update matching declared items and never create one, and client-echoed data never overwrites a declared item.
  3. **The first declaration.** A provider's first declaration removes its payment-sourced items that the declaration does not itself declare. The catalog writes that declaration to disk (fsync, then rename) before it answers. A declaring flag lost to a crash or a corrupt file therefore lets a payment-created item live only until the provider's next heartbeat.
- **Keying.** The catalog is keyed by (`providerId`, canonical resource, HTTP method). The canonical resource is the URL's origin plus the bazaar `routeTemplate` when it is valid, else the URL's path; query and fragment are dropped. Two providers listing the same URL get two items, each with its own `payTo`. The resource's own 402 stays authoritative: clients pay what it says, not what the catalog says.
- **Validation.** `resource` is an absolute http(s) URL of at most 2048 characters with no userinfo. Each of 1–4 `accepts` entries must be `prepaid-voucher` on the facilitator's network, asset `ZEC`, the provider's `payTo`, an `amount` as in §2, and the rail's terms and `termsVersion`, so the catalog never advertises a payment the facilitator would refuse. Metadata sizes are capped (`description` 512, `mimeType` 128, `serviceName` 1–32 printable ASCII, at most 5 tags of 1–32, `extensions` at most 8 KB), and so are counts: 128 items per provider and 4096 in all, within a 16 MiB budget for the whole catalog.
- **Privacy.** The access log records the path only, never a query string, so what agents search for stays private.
- **Persistence.** In memory, written to `discovery.json` at most every 2 s, except a provider's first declaration, which is written before it is answered; items neither declared nor paid for 7 days are dropped at load. A corrupt file is set aside and the catalog starts empty.
