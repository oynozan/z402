# z402 wire contract

**Version: v0-draft** · 2026-10-27 · drafted by the client agent, under review by the facilitator agent.

This is the one contract the client library (`@z402/client`) and the merchant side (`@z402/facilitator`, `@z402/server`, `apps/api`) both build against. It refines [mvp-build-doc.md](mvp-build-doc.md) with what research found; where they disagree, this file wins.

**Change process.** Propose the change by message, both agents ACK, then edit this file and bump the version line. `v0-*` drafts may change; `v1` is frozen, and code may rely on every value in it.

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
  "network": "zcash:testnet",
  "amount": "500",
  "asset": "ZEC",
  "payTo": "utest1…",
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
| `amount` | Price per call, zat, canonical decimal ≥ 1. Demo value pending the user's decision (§12). |
| `payTo` | Merchant shielded-only unified address, validated **per network** with `isValidPayTo(ua, network)`. Allowed HRPs come from `zcash_address` 0.14.0 `src/constants.rs`, as R0 or R2 shielded-only: regtest `uregtest` / `zuregtest`; testnet `utest` / `zutest`; mainnet `u` / `zu`. The body is bech32 lowercase `[02-9ac-hj-np-z]+`. R2 transparent-including HRPs (`turegtest`, `tutest`, `tu`) are always rejected. |
| `extra.windowZat` | One deposit, zat, decimal string. |
| `extra.creditRatioBps` | Integer basis points, 0–10000 (2500 = 25 %). Replaces the doc's float `creditRatio: 0.25`. |
| `extra.creditCapZat` | Credit cap, zat, decimal string. |
| `extra.zeroConfMinExpiryBlocks` | Integer. A pending deposit earns zero-conf credit only with at least this many blocks before expiry (§5.3). |
| `extra.termsVersion` | Opaque 16-hex string owned by the facilitator. The server scheme copies it into requirements, and the startup check uses it to catch drift between the API's and the facilitator's terms. The client ignores it (`parseTerms` drops unknown keys) but echoes `extra` unchanged, as the stock client does. |

- `extra` is **static per route**. Per-session values must never appear in requirements: the server matches the client's echo of `extra`, so a changing value breaks matching.
- The facilitator owns these terms. It advertises them through `getExtra()` → `/supported`, and the server scheme copies them in `enhancePaymentRequirements`.
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
- The credit unit is the lowercase txid. It is consumed once, globally, under the key `zcash:testnet:<txid>`. **One transaction funds one session.**
- Credited value = the sum of outputs to `payTo` whose memo matches this session's pattern. Outputs with other memos are ignored.
- Rejections:

  | Code | Condition |
  |---|---|
  | `z402_deposit_transparent` | Any transparent input or output. |
  | `z402_deposit_memo_mismatch` | No output to `payTo` carries this session's memo. |
  | `z402_deposit_not_to_merchant` | No output decrypts to `payTo` at all. |
  | `z402_deposit_other_session` | The txid is already credited to another session. |
  | `z402_deposit_dead` | The txid is already known dead, or the presented transaction is unmined and `tip ≥ expiryHeight`. |

- Re-presenting a txid **already credited to the same session** is a no-op: no refetch, no second credit, no refusal.
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
- `expiryHeight` is a little-endian u32 at bytes 16..20 of the raw v5 or v6 transaction.
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
accept  ⇔ c_new − c_last ≥ amount  ∧  c_new ≤ limit           (c_last = last SETTLED voucher)
```

- The limit is inclusive.
- The increment rule is lenient (`≥`): a client that overshoots by one price is still accepted, which absorbs lost responses.
- A new session has `c_last = 0` and limit 0, so its first voucher must carry a deposit.
- One implementation, `computeLimit()` in `@z402/protocol`, is imported by both sides.
- Worst-case merchant loss per session: `min(W, Σ live pending) + min(C_max, r·D_conf)`, assuming no reorg deeper than one block before finality.

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
- Never a non-200 status: a 500 leaks its body into the client-visible error, and a 200 missing `transaction` becomes a 502.

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
- Both sides validate snapshots with `parseSessionSnapshot()` from `@z402/protocol`.

### 7.3 Deposit acknowledgement
- `SettleResponse.transaction = depositTxid` whenever the payload's `depositTxid` is credited to this session. That covers a new credit and a re-presentation, so a lost ack can be re-acked. Otherwise `""`.
- The client resends `depositTxid` until it sees `transaction === depositTxid` or the txid listed in `session.deposits`.

## 8. Reason codes and client actions

Only `invalidReason` (verify) or `errorReason` (settle) reaches the client, so **the code carries the action**. Settle failures use the same codes as verify refusals.

| Code | Meaning | Client action (the stock wrapper allows one `{recovered:true}` per call) |
|---|---|---|
| `z402_awaiting_confirmation` | `c_new > limit`; a live pending deposit exists | Never deposit. Wait until the pending deposit has ≥ 1 confirmation (own lightwalletd check), then recover. On the final attempt, return. |
| `z402_deposit_required` | `c_new > limit`; nothing pending | Deposit (inline), then recover. On the final attempt, start a background deposit. In cheat mode (`maxDeposits` reached), return. |
| `z402_cumulative_mismatch` | `c_new − c_last < amount` | Resync `c` from `session.cumulativeZat`, then recover. |
| `z402_invalid_signature` | Signature fails | Fatal: report it. |
| `z402_deposit_not_found` | Definitive not-found answers for 15 s | Keep the txid. Check own status: if seen, recover. If the wallet marked it failed, treat it as dead. Otherwise back off and recover. |
| `z402_chain_unavailable` | lightwalletd errors, no definitive answer | Keep the txid, back off 5 s, recover. |
| `z402_deposit_not_to_merchant`, `z402_deposit_memo_mismatch`, `z402_deposit_transparent`, `z402_deposit_other_session` | Deposit unusable | Drop the txid from the resend set. Fatal: report it (wrong `payTo` or a bug). |
| `z402_deposit_dead` | Expired, dropped or orphaned | Drop the txid, make a new deposit (next index), recover. |
| `invalid_payload`, `invalid_payment_requirements`, `invalid_network`, `invalid_scheme` (payload and requirements disagree on the scheme), `unsupported_scheme` (no registered version, scheme and network), `invalid_x402_version` | Bug or configuration drift | Fatal. |
| `unexpected_verify_error`, `unexpected_settle_error` | Facilitator bug | Back off 1 s, recover once. |
| anything else | Unknown | Fatal. |

**The list is closed: 8 standard and 11 scheme codes.** The facilitator emits nothing else. The SDK and the API can still put their own strings in `PAYMENT-REQUIRED.error`. None of these are facilitator codes, and the client treats them as fatal:
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

- Bind to `127.0.0.1`. Start before the API (the API exits if `/supported` lacks the route's scheme and network).
- `/verify` is read-only; `/settle` re-checks and commits synchronously, with no `await` between check and write.
- Tip-driven poller: `GetLatestBlock` every 5 s, re-checking deposits on each tip change.
- Refresh-before-refuse: before refusing a session that has a pending deposit, re-query it. Bounded by one RPC deadline (5 s), at most once per 5 s per session.
- 5 s deadline per RPC. Transport errors map to `z402_chain_unavailable`; only lightwalletd's `-5: Transaction not found in mempool or best chain` means not-found.
- Check `payTo`, `amount` and the terms against its own config: `invalid_payment_requirements` on mismatch.

## 11. Chain access facts (live-verified 2026-10-27)

- **Endpoint.** The only working public testnet endpoint is `testnet.zec.rocks:443` (TLS). It runs a zec.rocks fork of lightwalletd v0.5.4 on Zebra 7.0.0. Protos: `github.com/zcash/lightwallet-protocol`.
- **Load balancing.** It balances `GetTransaction` per request across about 5 backends; first-sight skew reaches about 16 s. `GetLatestBlock` and `GetLightdInfo` come from an edge cache that lags 0–9 s.
- **Demo option.** Both sides can point at the same direct backend, `na-lax.testnet.zec.rocks:443`: the wallet broadcasts there and the facilitator reads there, so first sight is immediate. It is a config switch, not the default, because that name is undocumented.
- **Timeouts.** The API's `HTTPFacilitatorClient` timeout is 60 s, so a paid request may legitimately take up to about 60 s.
- **Network upgrades.** NU7 has been active on testnet since height 4,465,026, branch `0x77190ad9`. Blocks average ~25 s (median 20 s, p90 53 s, max 164 s), and mempool → mined has a median of 22 s.
- **`TxFilter.hash`.** Takes the **byte-reversed** display txid. Display order returns NotFound.
- **`RawTransaction.height`.** 0 for the mempool, `h` once mined, `2^64−1` on a fork. Read it as a string or BigInt.
- **Not-found.** Only the message `-5: Transaction not found in mempool or best chain` means not-found. The fork maps every backend error to NotFound and retries for about 22 s first.
- **`SendTransaction`.** Returns OK even on rejection; check `errorCode`.
- **Crates.** Only crates on the `zcash_protocol 0.11` / `zcash_primitives 0.31` / `orchard 0.16` line parse NU7 transactions; `zcash_protocol ≤ 0.10.6` fails on every transaction.

## 12. Demo terms (pending the user's decision)

| Option | Price `p` | Honest run | Cheat run | Simulated |
|---|---|---|---|---|
| **A (recommended)** | 500 zat | 1 call/s, 150 calls ≈ 156 s, no stall. Credit line and D2 appear in 87–92 % of runs. | Local speed: refused at cumulative 125,000. | 0 stalls in 4,000 runs |
| B | 1,000 zat (the doc's value) | Pre-confirm D1 off camera, then run at local speed; D2 at call 1 shows zero-conf. | Same refusal at 125,000. | 0 stalls, but "served on an unconfirmed deposit" is shown by D2, not D1 |

W = 100,000, 2500 bps, C_max = 200,000 and `zeroConfMinExpiryBlocks` = 20 in both options.

## 13. Shared code: `@z402/protocol`

The client agent drafts it; both agents own it from v1. Pure TypeScript, no network. Exports:

```ts
// constants
SCHEME = "prepaid-voucher"; ASSET = "ZEC"; ZEC_DECIMALS = 8
NETWORK_REGTEST = "zcash:regtest"; NETWORK_TESTNET = "zcash:testnet"; NETWORK_MAINNET = "zcash:mainnet"
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
  // thrown by every chain reader on transport errors: FakeChain, @z402/lightwalletd, the client's TxStatusSource
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
| `packages/protocol` | `@z402/protocol` | client agent drafts; shared from v1 |
| `packages/client` | `@z402/client` | client agent |
| `packages/testkit` | `@z402/testkit` (FakeChain, MockWallet) | client agent; `ChainView` shape owned by the facilitator agent |
| `packages/lightwalletd` | `@z402/lightwalletd` | facilitator agent |
| `packages/facilitator` | `@z402/facilitator` | facilitator agent |
| `packages/server` | `@z402/server` | facilitator agent |
| `apps/api` | `@z402/api` | facilitator agent |
| `apps/agent` | `@z402/agent` (demo loop) | client agent |
| `apps/e2e` | `@z402/e2e` (single-process harness) | client agent |
| `crates/zdecrypt` | Rust decryptor | facilitator agent |
| `.tools/bin/` (gitignored) | locally built binaries (`zingo-cli`, `zdecrypt`) | whoever builds them |

Neither agent edits the other's paths; requests go by message.

## 15. Integration seams (owned by the facilitator agent; consumed by the client agent's e2e harness and status check)

```ts
// @z402/lightwalletd
type RawTx = { found: false }
           | { found: true; raw: Uint8Array; location: "mempool" | "mined" | "orphaned"; height: number | null };
createLightwalletdClient(opts: { url: string; rpcDeadlineMs?: number /* 5000 */ }): {
  getTip(): Promise<number>;
  getTransaction(txid: string): Promise<RawTx>;   // txid = 64 lowercase hex, display order; TypeError otherwise
  getLightdInfo(): Promise<{ chainName: string; consensusBranchId: string; blockHeight: number; version: string }>;
  close(): void;
}
```

`getTransaction` mapping:

| lightwalletd answer | Result |
|---|---|
| proto height `"0"` | `location: "mempool"`, `height: null` |
| proto height `"18446744073709551615"` | `location: "orphaned"`, `height: null` |
| any other proto height `h` | `location: "mined"`, `height: Number(h)` |
| gRPC NotFound whose details contain `-5: Transaction not found in mempool or best chain` | `{ found: false }` (the only source of it) |
| anything else | throws `ChainUnavailableError` |

```ts
// @z402/facilitator
interface FacilitatorOptions {
  chain: ChainView; payTo: string; priceZat: bigint; terms: Terms;
  authToken?: string; ledgerPath?: string; host?: string /* 127.0.0.1 */; port?: number /* 0 */;
  pollIntervalMs?: number /* 5000 */; depositWaitMs?: number /* 30000: cross-backend first-sight skew reaches ~16 s */;
}
startFacilitator(o: FacilitatorOptions): Promise<{ url: string; pollNow(): Promise<void>; close(): Promise<void> }>

// @z402/api
interface ApiOptions { facilitatorUrl: string /* "" throws */; facilitatorToken?: string; payTo: string; priceZat: bigint; host?: string; port?: number }
startApi(o: ApiOptions): Promise<{ url: string; close(): Promise<void> }>
```

- The paid route is `GET /chunk`. Its body is `{ chunk: number, cumulativeZat: string, data: string }` with `chunk = cumulativeZat / price`, so it never moves on refused or `HEAD` calls.
- The API reads its terms from the facilitator's `/supported`.
- Start order: `await startFacilitator(...)`, then `startApi(...)`.
