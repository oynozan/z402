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
| D1 | Deposit decryptor | **zdecrypt** (our Rust CLI, promoted from the research spike) instead of Hanko | Built and tested here (5/5 offline tests, 17 live txs parsed, real Ironwood payments decrypted), stable crates, 2.5 ms per call, exact receiver match and expiry. It does not re-verify proofs, so zero-conf trusts Zebra's mempool and lightwalletd, as Kage does. That risk sits inside the W cap only while the endpoint is honest: zdecrypt checks no proofs, signatures or inclusion, and mined status comes from lightwalletd, so a dishonest endpoint can report a fabricated deposit as mined, and it then counts in D_conf with no cap. Real money needs a node the merchant operates. Kage and Hanko are credited (MIT) |
| D2 | Demo terms | **p = 500 zat**, W = 100,000, 2500 bps, cap 200,000; honest run at 1 call/s; cheat run at local speed | P(no stall) = 1.000 in 4,000 simulated runs; deposit 2 and the credit line appear in 87–92 % of runs. The fallback, keeping p = 1,000, needs deposit 1 confirmed off camera |
| D3 | Restart safety | **JSONL ledger** (about 40 lines, `appendFileSync` in `/settle`, replayed at boot) | Closes double-crediting and voucher replay after a restart. It is not a database; the doc's "no durable storage" still holds for everything else. One writer, through `<ledger>.lock` beside the ledger's canonical path. The holder touches the lock every 5 s, and a lock nobody touched for 15 s was left by a crash, so it is taken over, under an exclusive `<lock>.takeover` that lets only one racing start win. A fresh lock whose pid is alive on this host is refused at once. Any other fresh lock is watched for up to 15 s, so a live holder in another container that shares the volume is never taken over. The holder reads its lock back at every heartbeat and before every write, and once the lock names another start it writes nothing more and exits, so a holder paused past 15 s cannot write after the start that took over. A failed write refuses every later write until a restart replays the file. Appends survive a process crash, not a power loss (nothing calls fsync) |
| D4 | Builds of external code | Approve building **zingo-cli** at tag `zingolib_v8.0.0-rc.0` (client side). Hanko is not needed if D1 is accepted | Research agents were denied "code from external" builds. The client wallet cannot work without zingo-cli |
| D5 | Merchant keys | Generate them with `zdecrypt keygen` (a seed stored in a gitignored `.secrets/`), payTo = the Orchard-only UA | No zingo-cli is needed on the server side. The facilitator holds only the UIVK |
| D6 | Git | `git init` at the repo root and commit per task | The folder is not a repo yet; the plans commit after every task |
| D7 | Target chain (user decision, 2026-10-27) | **Z3 regtest first, mainnet later**: Zebra 6.2.3 + Zaino 0.10.2-no-tls + Zallet beta.1 in Docker, coins mined locally. Public testnet stays a config option | Testnet wallets can't be funded: the faucets are dead. Regtest runs NU6.3 with Ironwood, the same deposit path as mainnet before NU7. Blocks are mined on demand, so the demo is deterministic |

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
   - Owned by another session, it is answered from the same lookup outcome an uncredited txid gets: a read that found it gives `z402_deposit_memo_mismatch`, the one answer for every found deposit this session cannot use, and a failed or unfinished read gives the same `z402_chain_unavailable` or `z402_deposit_not_found`. That parity holds for a voucher that needs the deposit. A voucher that fits without it is the v1.2 known limit: once a read found the txid, it is refused as `z402_deposit_memo_mismatch`, where an uncredited txid this session cannot use passes. A credited deposit of this session recorded dead gives `z402_deposit_dead`. One the watcher last saw unmined, now at a tip at or past its expiry, counts nowhere, is listed in every snapshot as the pending it was last recorded (a client copies a listed `dead`), and is read again first, through a session refresh: dead by that read (gone, or still unmined, at a tip at or past its expiry) gives `z402_deposit_dead`, mined counts, and a read that fails or is not due yet gives `z402_chain_unavailable`. Settle, which never reads, answers `z402_chain_unavailable` for it (R49).
   - If the voucher fits **without** the deposit, return valid at once and look the deposit up in the background (lazy crediting).
   - Otherwise wait for the lookup, at most 30 s (`depositWaitMs`). Load-balanced lightwalletd backends see a new tx up to about 16 s apart, so the API's facilitator client allows 60 s.
   - A found lookup result is evidence for 30 s; settle never credits an older one, and death is judged at the current tip. A deposit read unmined, whose expiry the tip has reached since, is read once more before it is judged: mined below its expiry it counts, gone or still unmined it is `z402_deposit_dead`, and a failed read is `z402_chain_unavailable`. Settle, which never reads, answers `z402_chain_unavailable`.
5. If the voucher still does not fit and the session holds a credited pending deposit, refresh that session's deposits from the chain (at most once per 5 s per session) and recompute. The refresh waits at most 5 s, since it can queue behind a full watcher pass.
6. If it still does not fit: `z402_awaiting_confirmation` if a live pending deposit exists, else `z402_deposit_required`. A presented txid whose lookup is still in flight, or whose cached result is a live deposit for this session, counts as pending. The facilitator never answers `deposit_required` while a presented deposit is unresolved (protocol.md v1.1 §7.3, where only a successful settle acks a deposit).
7. Reply HTTP 200 `{isValid, invalidReason?, payer: sessionKey, extra: {session}}`. The snapshot is projected as if the presented deposit were credited.

The lookup behind step 4:
- Every 1 s within the budget, the tip and then GetTransaction. The tip comes first, so an answer of unmined or not found speaks for a chain at least that high, and a block mined between the two reads cannot make a deposit included in its expiry block look dead.
- Only the definitive not-found answers in the matcher table of protocol.md §15 count as not-found: the lightwalletd, Zaino ≥ 0.10.1 and Zebra ≥ 6.4 rows. Other errors are retried, then reported as `z402_chain_unavailable`.
- Concurrent lookups of one txid share one request. At most 4 reads run at a time, and a lookup holds a slot only while its read is in flight (the GetTransaction, zdecrypt and tip calls of one poll), never while it sleeps between polls. A txid that came back not-found within the last 10 s gets a budget of 0, one read when a slot is free, instead of the full 30 s (`depositWaitMs`).
- A new lookup that finds the 4 slots busy and 16 lookups already waiting answers `z402_chain_unavailable` without reading the chain. A lookup under way that wakes for its next poll joins the wait whatever its length. No lookup waits for a slot past its budget: once the budget runs out in the queue it reads no more, and it answers from its own reads when it made any, else with what is already known for that txid, or else `z402_chain_unavailable`. A verify that waits for a lookup therefore ends within `depositWaitMs` and one read.
- The verdict comes from zdecrypt output:
  - any transparent part gives `deposit_transparent`;
  - no output to payTo, or outputs to payTo with no memo matching `^<sessionKey>:(0|[1-9][0-9]{0,8})$`, give `deposit_memo_mismatch`, one code for both so that the answer never tells whether a transaction pays the merchant;
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

1. Config parses: payTo matches `^(utest1|zutest1)[02-9ac-hj-np-z]+$` and the UIVK matches `^(uivktest1|uvitest1)`. A keys file that holds the spending seed is refused on mainnet and warned about elsewhere, and plaintext `http://` to lightwalletd is refused off regtest unless the host is loopback. A mainnet endpoint that is not loopback, and a listen host that is not loopback, are warned about before the checks below run.
2. `zdecrypt` decrypts the bundled Kage vector `030c3cbf…8351` to Ironwood 100,000 zat with memo `x402z-f19a63da20cbc0749ea800b3`.
3. `zdecrypt owns --address <payTo>` reports `ownedByKey: true` and no transparent receiver.
4. One `GetLightdInfo` serves two checks. `saplingActivationHeight` identifies the network: 419200 on mainnet, 280000 on testnet, and neither of those on regtest (Z3's Zaino reports 1). Then `consensusBranchId` checks the upgrade against the configured expected branch: `37a5165b` on regtest (NU6.3), `77190ad9` on testnet (NU7). On mainnet only the branch check can be skipped, with a warning, when no branch is set; the network check always runs. `chainName` is never trusted, since Zaino reports `"test"` on regtest.
5. The ledger is locked through `<ledger>.lock` and proven writable, then it is replayed in chunks, each event applied as it is read; a truncated last line is dropped with a warning. A new ledger starts with a header that names its network and payTo. A ledger whose header names another network or payTo is refused and left as it is, and one with no header opens on regtest and testnet but not on mainnet.

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

- **Zero-conf trust:** an unconfirmed deposit is trusted on Zebra's mempool validation and an honest lightwalletd. Loss is bounded by §4.2 only for an honest endpoint (see D1).
- **Single lightwalletd:** testnet.zec.rocks is the only working public testnet endpoint. If it goes down, crediting and confirmations stop, but voucher-only calls keep working up to the limit.
  - It load-balances across five backends, which see a new tx up to about 16 s apart. Its tip comes from an edge cache that lags 0–9 s.
  - For the demo, the agent wallet and the facilitator can both point at the same backend (`Z402_LWD_URL=https://na-lax.testnet.zec.rocks:443`, an undocumented name, used as a config switch only).
- **Privacy:** the merchant's targeted `GetTransaction` seconds after the agent's broadcast lets the lightwalletd operator link the two.
- **Unbound vouchers:** vouchers are not bound to a resource, so a leaked `PAYMENT-SIGNATURE` can be raced. TLS is the defence; `PAYMENT-SIGNATURE` is never logged.
- **No refunds:** unused deposit balance stays with the merchant (unchanged from the doc).

## 8. Credits

zdecrypt follows the decrypt-loop shape of Kage `crates/x402z-facilitator/src/verify.rs` (github.com/nickthelegend/zec-shielded-x402 @ `0330760`, MIT) and Hanko `packages/core/src/lib.rs` (github.com/nickthelegend/zec-payment-verify-sdk @ `3c7edae`, MIT). Its tests use their published demo keys and txids.
