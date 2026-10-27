# z402 server side: facilitator, server scheme, paid API (design)

Date: 2026-10-27 · Owner: facilitator agent · Status: **draft, awaiting review**

This design covers the server half of z402: the x402 v2 facilitator, the server scheme, the paid API route, the lightwalletd client and the Rust decryptor. The client half (client scheme, wallet adapter, agent, fake chain) belongs to the client agent (`z402-08`). The wire contract between them is frozen in `docs/spec/protocol.md`, which the client agent drafts. Section 5 lists what this side needs that contract to say.

Source spec: [`docs/spec/mvp-build-doc.md`](../../spec/mvp-build-doc.md). Evidence for every claim below is in [`docs/research/`](../../research/), and each section names the notes it rests on.

## 1. What research changed

| The MVP doc says | What is true on 2026-10-27 | Consequence | Evidence |
| --- | --- | --- | --- |
| Blocks about 75 s apart | NU7 (testnet height 4,465,026, branch `0x77190ad9`) brought 25 s blocks: mean 25.9 s, median 20 s, p90 53 s, max 164 s | Credit appears about 3× sooner. A 30 s poller lags by more than a block, so we poll every 5 s | zcash-testnet §5 |
| Only pre-release crates parse NU7 | Stable `zcash_primitives 0.31.0`, `zcash_protocol 0.11.0` and `orchard 0.16.0` shipped 2026-10-21 and need no cfg flags. Anything on `zcash_protocol ≤ 0.10.6` fails every live tx | Pin the stable line | decrypt-spike §1 |
| Deposits are Orchard notes | Since NU6.3, consensus forbids new value in the Orchard pool. A payment to a UA's Orchard receiver lands as an **Ironwood** output in a v6 tx, and it decrypts with the Orchard IVK under note plaintext V3 | A decryptor that reads `orchard_bundle()` finds nothing. Ours reads `ironwood_bundle()` | decrypt-spike §2 |
| Use Hanko's `verify()` | Hanko is a Rust CLI that must be built from source (the permission check blocked building it in research). It pins pre-release crates and Rust 1.89, costs about 2 s per check, defaults to `minConf: 1` (which refuses every zero-conf deposit), and reports neither the receiver nor the expiry | Use our own `zdecrypt` instead; see decision D1 | hanko, decrypt-spike §9 |
| `zcash:testnet` network id is provisional | No CAIP-2 `zcash` namespace exists. The SDK accepts the string, and the community is split between `zcash:*` and `bip122:*` | Keep `zcash:testnet` as one exported constant | x402-spec §3 |
| One `register` line is all the agent needs | The stock `x402Client` spend controls reject asset `ZEC` | The client scheme must implement `findDefaultAsset` (client agent's job) | x402-e2e-spike §1 |
| Facilitator checks a deposit, then trusts it | A deposit with `nExpiryHeight = tip + 1` gets zero-conf credit and is evicted unmined 42 % of the time: free service with no double-spend needed | Zero-conf credit only when expiry ≥ tip + 20 | design-critique §3.5 |
| D_pend = newest unconfirmed deposit | Uncapped, one 10 W deposit gives 10 W of zero-conf credit, which breaks the doc's worst-case bound | D_pend = min(W, Σ live pending eligible deposits) | design-critique §4.3 |
| Sessions in memory, forgotten on restart | After a restart every old deposit can be credited again, and every logged voucher replays | Append-only JSONL ledger; see decision D3 | design-critique §7.3 |
| 150 calls back to back at price 1,000 | With 25 s blocks, a run at local speed always stalls at call 101 (median ~57 s). Monte Carlo over 1,000 measured block gaps found no rule tweak that avoids it | Price 500 and 1 call/s give P(no stall) = 1.000; see decision D2 | design-critique §5 |

## 2. Decisions for the user

| # | Decision | Recommendation | Why |
| --- | --- | --- | --- |
| D1 | Deposit decryptor | **zdecrypt** (our Rust CLI, promoted from the research spike) instead of Hanko | Built and tested here (5/5 offline tests, 17 live txs parsed, real Ironwood payments decrypted), stable crates, 2.5 ms per call, exact receiver match and expiry. It does not re-verify proofs, so zero-conf trusts Zebra's mempool and lightwalletd, as Kage does; that risk sits inside the W cap. Kage and Hanko are credited (MIT) |
| D2 | Demo terms | **p = 500 zat**, W = 100,000, 2500 bps, cap 200,000; honest run at 1 call/s; cheat run at local speed | P(no stall) = 1.000 in 4,000 simulated runs; deposit 2 and the credit line appear in 87–92 % of runs. The fallback, keeping p = 1,000, needs deposit 1 confirmed off camera |
| D3 | Restart safety | **JSONL ledger** (about 40 lines, `appendFileSync` in `/settle`, replayed at boot) | Closes double-crediting and voucher replay after a restart. It is not a database; the doc's "no durable storage" still holds for everything else |
| D4 | Builds of external code | Approve building **zingo-cli** at tag `zingolib_v8.0.0-rc.0` (client side). Hanko is not needed if D1 is accepted | Research agents were denied "code from external" builds. The client wallet cannot work without zingo-cli |
| D5 | Merchant keys | Generate them with `zdecrypt keygen` (a seed stored in a gitignored `.secrets/`), payTo = the Orchard-only UA | No zingo-cli is needed on the server side. The facilitator holds only the UIVK |
| D6 | Git | `git init` at the repo root and commit per task | The folder is not a repo yet; the plans commit after every task |

## 3. Architecture

```
agent process (client agent)          API process (mine)                     facilitator process (mine)
x402Client + client scheme  ──HTTP──► Express + paymentMiddleware ──HTTP──►  Express /supported /verify /settle
   wallet: zingo-cli                  x402ResourceServer                     x402Facilitator + PrepaidVoucherFacilitatorScheme
        │                             PrepaidVoucherServerScheme             ├─ SessionBook, DepositBook, Ledger (JSONL)
        │ broadcast deposit           route "/chunk" (verb-less)             ├─ DepositResolver (lookup, retry, single-flight)
        ▼                             127.0.0.1:4021                         ├─ ChainWatcher (5 s tip poll, state machine)
testnet.zec.rocks:443  ◄────────────────── gRPC GetTransaction / GetLatestBlock ───┤  LightwalletdChainView = @z402/lightwalletd
(lightwalletd v0.5.4 on Zebra 7.0.0)                                             └─ + zdecrypt CLI (merchant UIVK in env)
                                                                              127.0.0.1:4022, bearer token
```

| Unit | Path | Owner | One job |
| --- | --- | --- | --- |
| `@z402/protocol` | `packages/protocol` | client drafts, both own from v1 | Wire constants, types, voucher bytes, memo, `limit()`, `ChainView` seam |
| `@z402/lightwalletd` | `packages/lightwalletd` | facilitator | grpc-js client: tip, raw tx by txid, error classification. The client agent also imports it |
| `zdecrypt` | `crates/zdecrypt` | facilitator | Parse a v5/v6 tx and trial-decrypt it with a UIVK; JSON out |
| `@z402/facilitator` | `packages/facilitator` | facilitator | x402 facilitator: sessions, deposits, ramp, watcher, ledger, HTTP |
| `@z402/server` | `packages/server` | facilitator | `SchemeNetworkServer`: price, terms, corrective 402 |
| `@z402/api` | `apps/api` | facilitator | The paid `/chunk` route and `startApi()` |
| `@z402/client`, `@z402/testkit`, agent, e2e | `packages/client`, `packages/testkit`, `apps/agent`, `apps/e2e` | client | Client scheme, wallet, FakeChain, demo, single-process e2e |

Process rules:
- Start the facilitator before the API; the API exits if `/supported` lacks the kind.
- The facilitator binds 127.0.0.1 behind a bearer token.
- `@x402/*` is pinned to exactly 2.28.0.

## 4. Behaviour

### 4.1 Deposit lifecycle

A deposit record is keyed by its lowercase txid and bound to exactly one session (the presenter whose memo matched). Records are never deleted.

| Observation (GetTransaction + zdecrypt) | Status |
| --- | --- |
| in the mempool (height 0) | `pending` |
| mined at h, conf = max(tip, h) − h + 1, between 1 and 9 | `confirmed` |
| conf ≥ 10 | `final` (no longer polled) |
| height = 2^64 − 1 (side chain only) | `orphaned`, counts nowhere |
| unmined, expiry ≠ 0, tip ≥ expiry | `dead` |
| only definitive "-5 not found" answers for ≥ 120 s and ≥ 2 new blocks, unmined. A found answer resets the streak; other errors neither count nor reset | `dead` |

A `dead` deposit is re-inspected for 20 more blocks. If it shows up mined it becomes `confirmed`, never `pending` again. A `confirmed` deposit that reads mempool, orphaned or not-found is demoted.

Zero-conf eligibility is fixed when the deposit is first seen: value ≥ W, and expiry = 0 or expiry − tip ≥ `zeroConfMinExpiryBlocks` (20).

### 4.2 Trust ramp (BigInt, zatoshi)

```
D_conf = Σ value(d)  for credited d with status confirmed | final
D_pend = min(W, Σ value(d) for credited d with status pending and zeroConf)
credit = min(C_max, floor(D_conf × creditRatioBps / 10000))
limit  = D_conf + D_pend + credit
accept ⇔ c_new − c_last ≥ amount  ∧  c_new ≤ limit          (c_last = last settled cumulative)
```

Per-session worst-case loss is min(W, Σ pending) + min(C_max, r·D_conf), plus any 1-conf deposit reorged out before final. That last term is accepted for the MVP and documented.

### 4.3 /verify (read-only toward payment state)

1. Validate the body with `@x402/core/schemas`. Then check that requirements equal the facilitator's own config (scheme, network, asset, payTo, amount = configured price, terms), and parse the payload with protocol regexes. Malformed input gives `invalid_payload` or `invalid_payment_requirements`.
2. Check the ed25519 voucher signature over the received strings. Failure gives `z402_invalid_signature`.
3. Check c_new − c_last ≥ amount; otherwise `z402_cumulative_mismatch`.
4. If `depositTxid` is present and new to this session, check ownership first:
   - Owned by another session gives `z402_deposit_other_session`; recorded dead gives `z402_deposit_dead`.
   - If the voucher fits **without** the deposit, return valid at once and look the deposit up in the background (lazy crediting).
   - Otherwise wait for the lookup, at most 30 s (`depositWaitMs`). Load-balanced lightwalletd backends see a new tx up to about 16 s apart, so the API's facilitator client allows 60 s.
5. If the voucher still does not fit and a live pending deposit exists, refresh that session's deposits from the chain (at most once per 5 s per session) and recompute.
6. If it still does not fit: `z402_awaiting_confirmation` if a live pending deposit exists, else `z402_deposit_required`.
7. Reply HTTP 200 `{isValid, invalidReason?, payer: sessionKey, extra: {session}}`. The snapshot is projected as if the presented deposit were credited.

The lookup behind step 4:
- GetTransaction every 1 s within the budget.
- Only the message `-5: Transaction not found in mempool or best chain` counts as not-found. Other errors are retried, then reported as `z402_chain_unavailable`.
- Concurrent lookups of one txid share one request, at most 4 run at a time, and a txid that came back not-found within the last 10 s gets one quick probe instead of a 15 s wait.
- The verdict comes from zdecrypt output:
  - any transparent part gives `deposit_transparent`;
  - no output to payTo gives `deposit_not_to_merchant`;
  - outputs to payTo with no memo matching `^<sessionKey>:(0|[1-9][0-9]{0,8})$` give `deposit_memo_mismatch`;
  - unmined past its expiry gives `deposit_dead`.
- Otherwise the value is the sum of the matching external outputs. Sub-window and short-expiry deposits are recorded with `zeroConf: false` and count once mined.

### 4.4 /settle (atomic)

Settle repeats steps 1–6 using only results already cached by verify or the background lookup; it never waits on the chain. After the last check, with no `await` in between:
1. `ledger.appendSync(...)`.
2. Commit c_last.
3. Credit the deposit if one was resolved.

Every reply is HTTP 200 and schema-complete: `{success, errorReason?, errorMessage?, transaction, network, payer, amount, extra: {session}}`.
- `transaction` is the `depositTxid` whenever that txid is credited to this session, both on a new credit and on a re-presentation (an idempotent ack); otherwise `""`.
- `amount` is the charged delta.
- Never `settlement_pending`.
- Scheme throws become `unexpected_verify_error` / `unexpected_settle_error`.

### 4.5 Chain watcher

- Every 5 s, `GetLatestBlock`.
- On a tip change, and at least every 30 s, re-inspect every credited deposit whose status is `pending`, `confirmed`, `orphaned`, or `dead` within 20 blocks.
- Write a `status` ledger event for every change.
- `pollNow()` runs one pass at once; tests use it.

### 4.6 Server scheme and API

`PrepaidVoucherServerScheme`:
- `defaultAssetTransferMethod: "default"`, `paymentFlows: { default: { supported: ["authorization"], default: "authorization" } }`.
- `parsePrice` accepts only `{amount: "<zat ≥ 1>", asset: "ZEC"}`.
- `enhancePaymentRequirements` copies the terms from the facilitator's `supportedKind.extra`.
- `validateFacilitatorSupport` fails startup unless the advertised payTo equals the route payTo and the terms parse.
- `onAfterVerify` stashes `VerifyResponse.extra.session` in a WeakMap keyed by the payload. `enrichPaymentRequiredResponse` then adds `accepts[0].extra.session`. This **corrective 402** is the only way a refused client learns state, because a verify refusal otherwise exposes only the bare reason code.

`apps/api`:
- One route keyed `"/chunk"` (verb-less, so unpaid HEAD is gated too).
- Price from config, payTo from config.
- The handler is side-effect free: chunk number = voucher cumulative / price.
- It refuses to start without an explicit facilitator URL. An empty URL would silently fall back to `https://x402.org/facilitator` and ship payloads to a third party.

### 4.7 Startup checks (exit 1 on failure)

1. Config parses: payTo matches `^(utest1|zutest1)[02-9ac-hj-np-z]+$` and the UIVK matches `^(uivktest1|uvitest1)`.
2. `zdecrypt` decrypts the bundled Kage vector `030c3cbf…8351` to Ironwood 100,000 zat with memo `x402z-f19a63da20cbc0749ea800b3`.
3. `zdecrypt owns --address <payTo>` reports `ownedByKey: true` and no transparent receiver.
4. `GetLightdInfo.chainName === "test"`. The branch id is logged.
5. The ledger replays cleanly; a truncated last line is dropped with a warning.

## 5. What the server side needs from `protocol.md`

Proposed to the client agent on 2026-10-27; it is to be frozen as v1 with both ACKs.

| Item | Value |
| --- | --- |
| Identifiers | `SCHEME = "prepaid-voucher"`, `NETWORK = "zcash:testnet"`, `ASSET = "ZEC"`, amounts as zatoshi decimal strings |
| `accepts[0].extra` | `{windowZat: "100000", creditRatioBps: 2500, creditCapZat: "200000", zeroConfMinExpiryBlocks: 20, termsVersion: "<16 hex>"}`, static, from the facilitator's `getExtra` |
| Payload | `{sessionKey ^[0-9a-f]{64}$, cumulativeZat ^(0|[1-9][0-9]{0,15})$ ≤ 2.1e15, sig ^[0-9a-f]{128}$, depositTxid? ^[0-9a-f]{64}$}`. Uppercase is rejected; unknown keys are ignored |
| Voucher bytes | UTF-8 of `["z402-voucher-v1", scheme, network, payTo, sessionKey, cumulativeZat].join("\n")`, pure RFC 8032 Ed25519, with test vectors in `packages/protocol/test/vectors.json` |
| Memo | `<sessionKey>:<index>`, index `^(0|[1-9][0-9]{0,8})$` and informational only. The credit unit is the txid, consumed once; one tx funds one session |
| Ramp | §4.2. The single implementation lives in protocol: `computeLimit({deposits: [{valueZat, status, zeroConf}], terms})` and `zeroConfEligible({valueZat, expiryHeight, referenceTip, terms})`, where the facilitator passes `referenceTip = firstSeenTip` |
| Snapshot | `{sessionKey, cumulativeZat, limitZat, headroomZat, confirmedZat, pendingZat, creditZat, tip, deposits: [{txid, valueZat, status, confirmations, expiryHeight, zeroConf}]}`, where `deposits` holds the non-final entries plus the last 4 final ones |
| Codes (closed; verify and settle use the same list) | Standard: `invalid_payload`, `invalid_payment_requirements`, `invalid_network`, `invalid_scheme`, `unsupported_scheme`, `invalid_x402_version`, `unexpected_verify_error`, `unexpected_settle_error`. Scheme-specific: `z402_invalid_signature`, `z402_cumulative_mismatch`, `z402_awaiting_confirmation`, `z402_deposit_required`, `z402_deposit_not_found`, `z402_chain_unavailable`, `z402_deposit_not_to_merchant`, `z402_deposit_memo_mismatch`, `z402_deposit_transparent`, `z402_deposit_other_session`, `z402_deposit_dead` |
| Seam | `ChainView { tip(); inspect(txid) }`. The `TxInspection` found variant carries `location: "mempool" \| "mined" \| "orphaned"`, `minedHeight`, `expiryHeight`, `hasTransparent` and `outputs[]` (outputs to payTo only). `inspect` throws protocol's `ChainUnavailableError` on anything but a definitive not-found |
| lightwalletd client | `getTransaction(txid)` resolves `{found: false}` or `{found: true, raw: Uint8Array, location, height: number \| null}`, where height is set only when mined; the fork sentinel maps to `orphaned`. The client agent imports it too |

## 6. Testing

- **Rust:** zdecrypt's fixture tests (real txs, Kage and Hanko demo keys, a synthetic v6 deposit), plus a test for R2 UFVK key detection.
- **Unit:** the deposit evaluator, the deposit state machine, the snapshot, the ledger round-trip, the resolver (retry, classification, single-flight, budget), the voucher check, and settle atomicity (20 concurrent settles of one voucher give 1 success).
- **Integration:** the real facilitator HTTP app, the real API with `paymentMiddleware`, and the stock `wrapFetchWithPayment`, with a test-only client scheme and a stub `ChainView`. It covers the deposit, zero-conf, confirmation, credit, refusal, corrective 402, restart replay and HEAD.
- **Live (opt-in, `Z402_LIVE=1`):** the lightwalletd client against testnet.zec.rocks, then the end-to-end deposit with the client agent's wallet.

## 7. Known limits (updated)

- **Zero-conf trust:** an unconfirmed deposit is trusted on Zebra's mempool validation and an honest lightwalletd. Loss is bounded by §4.2.
- **Single lightwalletd:** testnet.zec.rocks is the only working public testnet endpoint. If it goes down, crediting and confirmations stop, but voucher-only calls keep working up to the limit.
  - It load-balances across five backends, which see a new tx up to about 16 s apart. Its tip comes from an edge cache that lags 0–9 s.
  - For the demo, the agent wallet and the facilitator can both point at the same backend (`Z402_LWD_URL=https://na-lax.testnet.zec.rocks:443`, an undocumented name, used as a config switch only).
- **Privacy:** the merchant's targeted `GetTransaction` seconds after the agent's broadcast lets the lightwalletd operator link the two.
- **Unbound vouchers:** vouchers are not bound to a resource, so a leaked `PAYMENT-SIGNATURE` can be raced. TLS is the defence; `PAYMENT-SIGNATURE` is never logged.
- **No refunds:** unused deposit balance stays with the merchant (unchanged from the doc).

## 8. Credits

zdecrypt follows the decrypt-loop shape of Kage `crates/x402z-facilitator/src/verify.rs` (github.com/nickthelegend/zec-shielded-x402 @ `0330760`, MIT) and Hanko `packages/core/src/lib.rs` (github.com/nickthelegend/zec-payment-verify-sdk @ `3c7edae`, MIT). Its tests use their published demo keys and txids.
