# z402 design critique: facilitator and wire contract (adversarial review)

Track: design-critique · 2026-10-27 · Inputs: `docs/spec/mvp-build-doc.md` and the eight `docs/research/*.md` notes. My own probes are in `$DC` = `/private/tmp/claude-501/-Users-oynozan-Desktop-Dev-Web3-z402/afbb7c76-d88e-47a4-8a53-fd001155f8ac/scratchpad/spikes/design-critique`. Tags: **[ran]** = I executed it, **[src]** = read source, **[docs]** = spec/README/ZIP, **[inf]** = reasoning.

## TL;DR

1. **Demo claim fails on today's testnet:** at W/p = 100 calls and ~25 s blocks, back-to-back calls burn the zero-conf window in ~0.2 s, then wait 56–58 s median (p90 154–192 s) for deposit 1; at 1 call/s the spec rules still stall every run (2–10 s inline deposit 2; 15–22 % also wait up to 105–463 s) [ran].
2. **Simulated fix, 0 stalls in 4,000 runs per model:** p = 500 zat (same zat exposure), 1–2 calls/s, background deposits, trigger "facilitator reports nothing pending and headroom < W", 5 s tip-driven poller plus refresh-before-refuse.
3. **The bound W + min(C_max, r·D_conf) breaks as specified:** D_pend is uncapped (one 10 W deposit = 10 W at zero-conf), 1-conf deposits are never re-checked (reorgs), and a restart reopens every past deposit and logged voucher; fix: `min(W, Σ live pending)`, demote until 10 conf, persist consumed txids and `c_last`.
4. **Zero-conf is a free option:** Zebra 7.0.0 admits a deposit with `nExpiryHeight = tip+1` and evicts it after one block [src]; 42 % of measured txs missed the next block [ran]; give zero-conf credit only if `expiry == 0 || expiry ≥ tip + 20`.
5. **Liveness traps:** the poller never drops dead deposits (honest client stops depositing forever); a lost PAYMENT-RESPONSE leaves the client one voucher behind forever unless state reaches it; a client hard-gating on its mirror never learns of confirmations; a recovery deposit after poller lag hides deposit 1's credit.
6. **Freeze before coding:** voucher bytes (test vector §2.1), memo rule (index informational, dedupe by lowercase txid), `creditRatioBps` integer, reason codes with client actions (§6.1), snapshot schema and the ack meaning of `transaction` (§6.2).
7. **Ops:** only lightwalletd's `-5: Transaction not found` means not-found; 5 s per-RPC deadline; `chain_unavailable` instead of `deposit_not_found`; rate-limit deposit lookups; use zdecrypt (Hanko build blocked; its `verify()` defaults to minConf 1).

---

## 0. Issue index (severity-ranked; details in the sections named)

| # | Sev | Owner | Issue | § |
|---|---|---|---|---|
| Z1 | blocker | both | 150 back-to-back calls cannot avoid waiting on a block at W/p = 100; "never stalls" is false at local speed and often false at 1 call/s | 5 |
| Z2 | blocker | contract | Voucher bytes unspecified ("payTo + cumulativeZat") | 2.1 |
| Z3 | blocker | client | Stock `x402Client` spend controls reject `ZEC` unless the scheme implements `findDefaultAsset` (known; restated because it breaks Done #1) | 7.6 |
| Z4 | high | facilitator | D_pend uncapped: an over-window deposit multiplies zero-conf exposure | 4.3 |
| Z5 | high | facilitator | Short-expiry "free option": `nExpiryHeight = tip+1` deposits are admitted and evicted after one block | 3.5 |
| Z6 | high | facilitator | Restart replay: in-memory state lets old deposits and logged vouchers be reused | 7.3 |
| Z7 | high | facilitator | Poller only promotes: dead deposits stay "pending" (liveness), reorged deposits keep credit (loss) | 3.5, 3.6 |
| Z8 | high | both | 30 s poller lag + newest-only rule: refusals the client's mirror says cannot happen; a recovery deposit makes it worse | 3.8 |
| Z9 | high | contract | Lost PAYMENT-RESPONSE leaves the client permanently behind unless state reaches it | 2.4 |
| Z10 | high | facilitator | Decryptor: Hanko build blocked, `verify()` minConf=1 default; Orchard-domain decryptors miss Ironwood deposits silently | 3.4 |
| Z11 | high | client | Hard client-side gate on the mirrored limit deadlocks after the zero-conf window | 4.4 |
| Z12 | medium | contract | Memo index uniqueness loses honest deposits (zingo "Transmission error" after a real broadcast) | 3.1 |
| Z13 | medium | facilitator | lightwalletd maps every backend error to NotFound; an outage becomes `deposit_not_found` | 7.1 |
| Z14 | medium | facilitator | `/verify` DoS amplification: a bogus `depositTxid` costs ~10 lightwalletd calls over 15 s | 7.5 |
| Z15 | medium | facilitator | Later deposits block the call that carries them, even when the voucher fits without them | 3.8 |
| Z16 | medium | contract | `creditRatio: 0.25` float: client/facilitator rounding can diverge by 1 zat at the limit | 4.1 |
| Z17 | medium | facilitator | `"GET /chunk"` route: unpaid `HEAD` runs the handler (verifier C2) | 7.6 |
| Z18 | medium | facilitator | Non-200 or schema-incomplete facilitator replies change or leak the client-visible error | 6.3 |
| Z19 | medium | client | `x402Client` does not serialize; out-of-order settles overcharge the client | 2.3 |
| Z20 | medium | contract | Deposit "ack" undefined: the client cannot tell credited from uncredited deposits | 6.2 |
| Z21 | medium | client | A malicious 402 can make the client deposit up to the 1 ZEC spend cap; payTo not validated | 7.6 |
| Z22 | medium | client | Agent wallet spendability (3-conf change, zingo #2835 zero-balance race) can block deposit 2 | 5.4 |
| Z23 | medium | facilitator | payTo/terms drift between API and facilitator fails silently (deposits "not to merchant") | 7.6 |
| Z24 | medium | contract | Multi-output / multi-session deposit txs have no defined crediting rule | 3.2 |
| Z25 | low | contract | Sub-window deposits are refused and lost | 3.3 |
| Z26 | low | facilitator | Canonicalization gaps (uppercase hex, MAX_MONEY, memo `.trim()`, index `Number()` overflow) | 2.5 |
| Z27 | low | facilitator | Session snapshot can outgrow the 16 KB header budget on long sessions | 6.2 |
| Z28 | low | both | Voucher not bound to the resource; a leaked PAYMENT-SIGNATURE can be raced | 2.2 |
| Z29 | low | facilitator | Targeted `GetTransaction` lets the lightwalletd operator link the agent and the merchant | 7.4 |
| Z30 | low | facilitator | Handler side effects (chunk counter) run on refused settles and HEAD; the demo log shows gaps | 7.6 |

---

## 1. Ground truth this review leans on (all re-derived from captured data) [ran]

- **Block gaps.** 1,000 consecutive gaps over blocks 4,546,338–4,547,338 (`zcash-testnet` capture, re-parsed by `$DC/parse_blocks.py`):
  - mean 25.9 s, median 20 s, p90 53 s, p99 112 s, max 164 s;
  - only 204 of 1,001 blocks contain a non-coinbase shielded tx;
  - the longest run with none is 18 blocks.
- **Mempool → mined.** 24 txs from the zcash-testnet poll log, re-parsed by `$DC/mempool_depth.py` and `$DC/mempool_latency_offline.py`.
  - Blocks waited: 14 txs in the next block, 5 in two, 1 in three, 3 in five, 1 in seven.
  - First-seen → block time: median 22 s, max 131 s.
  - The verify-zcash-testnet pass also saw 2 txs wait through 7 coinbase-only blocks (~2.5 min).
  - **So 10/24 = 42 % of txs were not in the next block.**
- **Local paid-call cost.** 1.06 ms median; 150 calls in 169.9 ms (x402-e2e-spike §10).
- **lightwalletd.** One public testnet server (zcash-testnet §6). It is a zec.rocks fork `c22ca9ba`:
  - cached tip;
  - 10× transport retry ≈ 22.5 s before answering;
  - every backend error maps to NotFound (kage C2).
- Calls to it take 0.24 s typically, 0.75–11.6 s at worst. A 2-minute outage was seen live (decrypt-spike §6, kage C2).

---

## 2. Voucher protocol

### 2.1 Exact bytes (Z2): freeze this, with a test vector

The spec says "ed25519 signature over payTo + cumulativeZat". Two notes propose different encodings:
- x402-sdk-server §8.3: `z402-voucher:v1|…`
- x402-spec §8.4: binary, `u16le` length prefixes, `u64le`.

If the agents pick differently, every call fails `invalid_signature`.

**Proposal (string form, injective because every field is regex-checked and none may contain `|`):**

```
UTF8( "x402/" + scheme + "/zcash/voucher/v1|" + network + "|" + payTo + "|" + sessionKey + "|" + cumulativeZat )
scheme        ^[a-z0-9-]{1,64}$                 (the frozen scheme id constant)
network       ^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$   ("zcash:testnet")
payTo         ^(utest1|zutest1)[02-9ac-hj-np-z]{20,500}$  (never tutest1)
sessionKey    ^[0-9a-f]{64}$                    (raw 32-byte ed25519 public key, lowercase)
cumulativeZat ^(0|[1-9][0-9]{0,15})$ and ≤ 2_100_000_000_000_000 (MAX_MONEY)
signature     raw RFC 8032 ed25519, 64 bytes, lowercase hex (^[0-9a-f]{128}$)
```

- The facilitator builds the message from the **received strings after validation**. It never re-serializes a parsed BigInt.
- It **rejects** non-lowercase hex rather than normalizing it.

**Test vector** [ran]: `$DC/vectors.mjs` on node v26.11.0 / OpenSSL 4.0.3. It was checked independently with a pure-Python RFC 8032 implementation, `$DC/ed25519_ref.py`, which gives identical signatures and verify = true.

```
seed (RFC 8032 secret)  000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f
sessionKey              03a107bff3ce10be1d70dd18e74bc09967e4d6309ba50d5f1ddc8664125531b8
scheme / network        prepaid-voucher / zcash:testnet   (scheme id still to be frozen; vector changes with it)
payTo                   utest1q97m3j4x8x3mfw52ye4r8nx9ye7nuyt54ra0qnf79h2j0v76dqvl2arf9955zk620sjhe3954kc6x364r8rgn4xa6l7nwyr9nyqua6f9
cumulativeZat "1000"    msg sha256 673d0a7ec3f798eabb4e7e782326eb57cc1f2f5416b18888b679e97351f5b351
                        sig 638b3f70208056fdc17b175b492506426194fefa51dd0fe3b46caa5182a651970246dbbd19b812bd3e638fc43582f138ae2aeb615d51979da858700989a7710c
cumulativeZat "53000"   msg sha256 e672e81dd093c663ba2c4c187ec244b520661da23bcb6fa7b270cc6c18c041c6
                        sig cb75e63ce6a4b0a6a9d4354e18e031ccaada76fbb0479b985795423487aee5e26ab22bdfbe166c9b635e5f5bf277a80031e05690118e8373f9dd59a980494104
deposit memo, index 0   "03a107bff3ce10be1d70dd18e74bc09967e4d6309ba50d5f1ddc8664125531b8:0"  (66 bytes)
```

(The payTo is a throwaway Orchard-only UA from the decrypt-spike `keygen`. It is safe to use as a fixture.)

### 2.2 Replay analysis

| Replay | Outcome with the 2.1 message and the `c_new − c_last ≥ amount` rule | Evidence |
|---|---|---|
| Same voucher twice, same session | Second use: delta 0 < p → refused | ran by the sdk-server track (`probe-roundtrip.log` "replayed voucher") |
| Voucher from session A used for session B | Signature fails: B's key differs and the message carries `sessionKey` | [inf] |
| Same key bytes, different hex case | Node verifies an uppercase-hex key as the same key ([ran] `$DC/ed25519_edges.mjs`: "same key, UPPERCASE hex → true"). Without the lowercase rule, `ABC…` and `abc…` would be two sessions sharing one key. With the spec's minimal message (no sessionKey), vouchers would replay across them | [ran] + [inf] |
| Across merchants or networks | payTo is in the message, and the UA HRP encodes the network | [inf] |
| Across routes of one merchant (Z28) | Not bound. A leaked PAYMENT-SIGNATURE can be raced to any route with price ≤ delta; the first settle wins and the victim gets a 402. Same as batch-settlement; TLS is the defence. Accept for the MVP and document | [docs] x402-spec Open questions |
| After a facilitator restart (Z6) | **Replayable.** `c_last` resets to 0, so every logged voucher (c = 1000, 2000, …) is valid again against re-credited deposits. See §7.3 | [inf] |
| Malleated signature (S + L) | Rejected by Node 26 / OpenSSL 4.0.3 | [ran] `$DC/ed25519_edges.mjs`: "malleated S+L → false" |
| Small-order public key with trivial signature (R = identity, S = 0) | Rejected (identity and order-2 keys → false) | [ran] same script |

Never derive IDs (e.g. `commitmentId`) from signature bytes; use `(sessionKey, cumulativeZat)`.

### 2.3 Concurrency: verify is read-only, settle must be atomic (Z19)

Facts:
- The stock `x402Client` does not serialize. 3 concurrent calls produced 3 vouchers with the same `cumulativeZat`, and settles finished out of order (x402-e2e-spike S8) [ran by that track].
- The sdk-server skeleton commits synchronously after its last `await`. 20 concurrent settles of one voucher gave exactly 1 success [ran by that track].

Scenarios:
- **Same `c_new` twice.** Both verify, both handlers run, one settle wins, and the other gets a 402 after its handler ran. The output is discarded; no money is lost.
- **`c+p` and `c+2p` in flight, settled as `c+2p` then `c+p`.** `c_last` jumps to `c+2p`, and the `c+p` settle fails (delta < 0). The client paid 2p for one delivered response. The lenient `≥` rule makes this a client overcharge, not a merchant loss.
- **Two concurrent calls with the same new `depositTxid`.** Settle #1 credits it. Settle #2 must treat "already credited to this session" as a no-op, not as `deposit_already_used`. The skeleton does this (`check()` skips deposits already in the session) [src].

Fix:
- Client: a per-session mutex held from `createPaymentPayload` until `onPaymentResponse`, with a 120 s safety release because the hook never fires when `fetch` throws. Compute `c_new` synchronously.
- Facilitator: keep the synchronous check-and-commit. Any persistence write inside `/settle` must be synchronous (`appendFileSync`); an `await` between check and commit reopens the race.

### 2.4 Handler served but settle fails; settle committed but the client never hears (Z9)

- **Settle fails after the handler.** The buffered body is discarded. The client gets 402 + PAYMENT-RESPONSE `{success:false, errorReason, extra.session}` (x402-e2e-spike §5, S5). The voucher was not recorded, so the client must not advance. A deposit carried on that call is **not credited**, so the client must resend `depositTxid` (x402-spec §8.2).
- **Settle committed, response lost.** Causes:
  - `FacilitatorTimeoutError` after the facilitator committed (HTTP 502, no PAYMENT-RESPONSE; x402-e2e-spike verification 7);
  - a TCP reset between the API and the agent;
  - an API crash after settle.

  Without state, the client's next voucher is the committed `c` again. Delta 0 → `cumulative_too_low`, and the client re-sends the same value forever.

Fix, both parts:
- (a) **Client rule.** On an *ambiguous* outcome, advance the local cumulative to the attempted value. Ambiguous means 502, a network error, or a 5xx with no PAYMENT-RESPONSE and no PAYMENT-REQUIRED. Only an *explicit* refusal leaves it unchanged: a PAYMENT-REQUIRED with `error`, or a PAYMENT-RESPONSE with `success:false`. The `≥` rule absorbs the at most one-price overpay.
- (b) **Facilitator and server scheme.** State must always reach the client:
  - `PAYMENT-RESPONSE.extra.session` on every settle reply, success or failure;
  - `accepts[0].extra.session` on every verify refusal, via the server scheme's `onAfterVerify` WeakMap plus `enrichPaymentRequiredResponse`. This pattern ran in sdk-server §8.4. Resource-server hook exceptions are only logged (sdk-server verifier), so add a unit test asserting `extra.session` is present for every refusal code.
  - The client resyncs to `session.cumulativeZat` and returns `{recovered:true}`. The stock wrapper gives exactly one retry ([src] `http/fetch/src/index.ts`, `processPaymentResult` at `core/src/http/x402HTTPClient.ts:184-223`). The hooks fire on any status, including a 502 with neither header.

Trusting the server's `c_last` is safe in z402, unlike in batch-settlement. Vouchers move no money; the deposit already paid the merchant. A lying server can only refuse service it could refuse anyway [inf].

### 2.5 Canonicalization details (Z26)

- `Buffer.from(hex,'hex')` silently stops at the first non-hex character (`'abzz'` → 1 byte) [ran]. Regex first, always.
- `cumulativeZat` must match `^(0|[1-9][0-9]{0,15})$` and be ≤ MAX_MONEY. That keeps it u64-safe if anyone switches to the binary layout.
- The skeleton does `check.memo.trim()` and `Number(memo[2])` [src x402-sdk-server §9 `prepare()`].
  - Drop `.trim()`: ZIP 302 says strip trailing zeros only, compare exactly, and Hanko compares exactly.
  - Cap the index at 9 digits so `Number()` cannot collapse two indexes.
- `depositTxid`: require lowercase. Hanko accepts mixed case, and its `TxReport.txid` echoes the input (hanko verification 6), so case variants would otherwise dedupe as different txids. After fetching, require recomputed `tx.txid() == depositTxid` (zcash-testnet verification 6; zdecrypt reports it).

### 2.6 Session key format

- 32 raw ed25519 public-key bytes, as 64 lowercase hex.
- One key per (agent process, payTo).
- A new key means a new session with no credit (spec Known limits).
- After a facilitator restart without persistence, clients **must** rotate keys (§7.3).
- Node 26 does not throw on a 32-byte invalid point (`ff…ff` → `false`). It throws only on the wrong length (`ERR_CRYPTO_INVALID_JWK`) [ran]. The 64-hex regex makes that unreachable; still wrap `createPublicKey` in try/catch.

---

## 3. Deposits

### 3.1 Memo and index rules (Z12)

Spec: memo = `<sessionKey>:<depositIndex>`. The payload carries no `depositIndex`, and nobody defined the index rule. The skeleton refuses a reused index (`z402_deposit_index_reused`) [src].

What the index protects: nothing.
- The memo binds a deposit to a session.
- Dedupe by txid stops double crediting.
- A stranger depositing with your memo only gifts you money [inf].

What the uniqueness rule breaks:
- zingo-cli `quicksend` can exit 1 with `Transmission error` *after* the tx reached the network (kage §5 item 9, Kage `docs/tab-live-run.txt:17-21`).
- A client that retries with the same memo `<sk>:1` creates a second real tx.
- The skeleton refuses the whole call on presentation (index reused), and the second 100,000 zat is never credited.
- A strictly sequential rule loses any deposit whose call failed and was then skipped.

Fix (contract):
- The index is informational: `^(0|[1-9][0-9]{0,8})$`, with no uniqueness and no ordering.
- Credit unit = **txid**. Consumption key: `zcash:testnet:<lowercase txid>` → sessionKey. This is the x402 single-use-claim rule (x402-spec §5).
- Credited amount = Σ of external-scope outputs to payTo's Orchard receiver whose ZIP 302 text memo matches `^<sessionKey>:(0|[1-9][0-9]{0,8})$`.
- The facilitator therefore decrypts **all** outputs and filters in TypeScript. zdecrypt without `--expect-memo` lists them; Hanko would need `--memo` per guess. The payload does not need a `depositIndex` field.
- Client: before re-sending a deposit after an error, look up the "failed" txid (wallet `transactions` status, or `GetTransaction`). If found, present it instead of paying again.

### 3.2 Several outputs to the merchant in one tx; one tx for several sessions (Z24)

- **Two outputs, same session** (`<sk>:0` 60,000 + `<sk>:7` 40,000): sum = 100,000 ≥ W → credit 100,000 once.
- **Outputs for sessions A and B in one tx:** under the single-owner rule, the first presenter (A) consumes the txid, and B's outputs are lost. Contract: **one deposit tx funds one session**. The client scheme never batches sessions. Document it as a known limit.
- **Outputs to payTo with unrelated memos** (other merchant flows on the same UA): ignored. A domain prefix such as `pv1:` is optional hygiene; Kippu uses `z402:` as a memo prefix (x402-spec §2.5).

### 3.3 Below and above `windowZat` (Z25, Z4)

- **Below W.** The spec refuses it. The merchant keeps real money and the client gets nothing.
  - Fix: credit the exact amount once confirmed. Grant zero-conf credit only to deposits ≥ W.
- **Above W.** The spec accepts it and counts the whole amount as D_pend.
  - This breaks the loss bound (§4.3).
  - Fix: zero-conf credit is `min(W, Σ live unconfirmed credited deposits)`. The full amount enters D_conf when mined.

### 3.4 Pools, receivers, transparent parts (Z10)

- Since NU6.3, a payment to a UA's Orchard receiver can only be an **Ironwood** output (consensus rule; decrypt-spike verification 8). A decryptor that reads `orchard_bundle()`, or uses zcash_protocol ≤ 0.10.6, finds nothing. Every deposit then looks like `NO_OUTPUT_TO_KEY` *after the client paid* (zcash-testnet §2.3, decrypt-spike §1.2).
- **payTo:** an Orchard-only `utest1…` (R0) or `zutest1…` UA. Reject `tutest1…` and any UA with p2pkh/p2sh. Hanko's `owns` ignores transparent receivers (hanko verification 5).
- **Startup assertion:** `zdecrypt owns --address <payTo>` → `ownedByKey:true` (or `zcash_keys` `UnifiedAddress::decode` + `IncomingViewingKey::diversifier_index`, zcash-testnet verification).
- **Startup self-test:** decrypt Kage's published vector `030c3cbf…8351` with Kage's published UIVK → Ironwood, 100,000 zat, memo `x402z-f19a63da20cbc0749ea800b3` (decrypt-spike §4.3). Exit 1 if it fails.
- **Transparent:** require `transparentIn == 0 && transparentOut == 0`. Kage does not check this (kage §2.6); zdecrypt and Hanko do.
- **Decryptor choice (facilitator):**
  - The spec names Hanko `verify()`. That needs a user-approved build of external code; the classifier denied it (hanko §5.1).
  - Its `verify()` defaults to `minConf: 1`, so it **refuses every zero-conf deposit** unless `minConf: 0` is passed (wallet-cli verification 5).
  - It accepts only `uivktest1…` keys and costs ~2 s per check for the Halo 2 VK.
  - Use **zdecrypt** instead: own code, built, 5/5 offline tests, stable crates, 2.4–2.7 ms per spawn (decrypt-spike §5). Node owns gRPC. Credit Kage and Hanko.
  - Trade-off: no proof re-verification, so zero-conf trusts Zebra's mempool and lightwalletd. That risk sits inside the W cap.

### 3.5 Expiry, double-spend, and the short-expiry free option (Z5, Z7)

**Zebra 7.0.0 (`e8db87eb`, the live backend) mempool rules** [src] (`$S/downloads/verify-zcash-testnet/zebra-v7.0.0`):
- `sendrawtransaction` queues the tx into the mempool (`zebra-rpc/src/methods.rs:1532`). It is verified at `next_height = tip + 1` (`zebrad/src/components/mempool/downloads.rs:417-422, 473`).
- The expiry check rejects only `block_height > expiry_height` (`zebra-consensus/src/transaction/check.rs:607-613`).
- There is no "expiring soon" admission rule anywhere in the tree (grep for `expiring_soon`/`EXPIRING_SOON`: no match).
- Eviction: `if tip_height >= expiry_height` (`zebrad/src/components/mempool/storage.rs:901`).
- `BLOCK_UNPAID_ACTION_LIMIT = 0` (`zebra-chain/src/transaction/unmined/zip317.rs:50,189`). A below-conventional-fee tx never enters the mempool, so the low-fee variant is blocked by Zebra itself.

**Attack:**
1. A fresh session builds a correct-fee deposit with `nExpiryHeight = tip + 1` (any wallet built on librustzcash can set it).
2. `/verify` credits D_pend = W.
3. The attacker spends 100 calls in ~0.2 s.
4. If the next block skips it (42 % in the measured sample; coinbase-only runs are common), Zebra evicts it and it can never be mined. **W was served for free.** If it is mined, the attacker just paid for what it used.

The spec's "an unconfirmed deposit can be double-spent" understates this. No race and no miner collusion are needed, and it repeats with every new session key [inf from src plus ran data].

**Fix (facilitator):** zero-conf credit requires `expiryHeight == 0 || expiryHeight − tip ≥ 20`. Read it from zdecrypt `expiryHeight` (bytes 16..20 LE of v5/v6).
- zingo builds `+120` (wallet-cli §6.5; kage C4: 6/6 zingo txs +110…+120). Older builders use `+40`. Honest deposits pass.
- Otherwise accept the deposit as "unconfirmed, not counted", code `deposit_expiry_too_soon`. Count it once mined.
- Advertise the margin in `extra` (`zeroConfMinExpiryBlocks: 20`) so the client can check its wallet.

**Dead-deposit handling (Z7).** The skeleton poller only sets `confirmed = true` [src]. Failure scenario:
1. An honest D2 is evicted. Causes: a second zingo process on the same wallet spends the same note (there is no wallet lock; wallet-cli §4), or a conflict.
2. The facilitator reports `pendingZat = 100,000` forever.
3. The client's rule "no unconfirmed deposit" never fires.
4. At the limit, every call is refused forever.

Fix:
- A deposit state machine:

  | Observation | New status |
  |---|---|
  | `height == 0` | `pending` |
  | real `h > 0`, conf = `max(tip,h) − h + 1` ≥ 1 | `confirmed` |
  | conf ≥ 10 | `final` (~4 min at 25 s blocks) |
  | sentinel `18446744073709551615` | `orphaned` (counts nowhere) |
  | unmined and `tip ≥ expiryHeight` (expiry ≠ 0) | `dead` |
  | ≥ 3 consecutive `-5` answers spanning ≥ 60 s | `dead` |

  The last row is needed for double-spends, which otherwise wait up to 120 blocks.
- Zebra resets its mempool on chain switches, so a single NotFound is not death (zcash-testnet verification 2).
- The `tip ≥ expiryHeight` form is the corrected boundary (zcash-testnet verification 1, decrypt-spike verification 6).
- Never delete records. Refuse re-presentation of `dead` txids (`deposit_dead`). The skeleton's positive-result cache would otherwise re-credit a dropped deposit if the record were removed [src + inf].

### 3.6 Reorgs

- D_conf is "≥ 1 confirmation", and the skeleton never re-checks confirmed deposits.
- On a reorg, Zebra re-verifies only its old mempool, not orphaned-block txs. An orphaned deposit stays at the sentinel until it is rebroadcast or expires (zcash-testnet verification 3).
- With 25 s blocks, 1-conf reorgs are likelier than at 75 s [inf].
- Fix: keep polling `confirmed` deposits until `final`. Demote on sentinel, NotFound or a height change. The MVP may keep 1-conf crediting, but the loss bound must say "assuming no reorg deeper than 1 block before finality".

### 3.7 lightwalletd lag

- The live server is the zec.rocks fork `c22ca9ba`. `GetLatestBlock` returns a cached tip (refresh ~2 s), so `GetTransaction` heights can be ahead of the tip (kage C2, seen live).
- So confirmations = `max(tip, h) − h + 1`.
- (zcash-testnet verification 7 describes upstream v0.5.4 as a direct call. The live server runs the fork, but the formula is right either way.)
- Use the **same** lightwalletd as the client wallet. A tx is in Zebra's mempool when `sendrawtransaction` returns (kage §5 item 4). Measured: found on the first lookup 2/2 for Kage, 0.6 s after quicksend for Hanko.

### 3.8 The facilitator's and the client's views of confirmation disagree (Z8, Z15)

**Scenario at local speed, spec rules, 30 s poller:**

| t | Event |
|---|---|
| ~5 s | D1 broadcast and credited as pending (limit 100,000) |
| ~5.2 s | Calls 1–100 done |
| ~30 s | D1 mined (median 22 s) |
| ~31 s | The client's own wallet or chain check says "confirmed". Its mirror gives limit 125,000, so it sends `c = 101,000` |
| | The facilitator has not polled yet (lag 0–30 s), so its limit is 100,000 → `limit_exceeded` |
| | A client hook that "recovers" by depositing D2 and returning `{recovered:true}` leaves two unconfirmed deposits. Newest-only counts D2 only, so the limit is still 100,000 |
| | **The single allowed retry is refused**, and the client spent 110,000 zat for nothing |
| ≤ 60 s | The next poller tick promotes D1. Only then does limit = 100,000 + 100,000 + 25,000 = 225,000 |

**Fixes:**
- **Facilitator (both halves needed):**
  - (1) A tip-driven poller: `GetLatestBlock` every 5 s, and re-check unconfirmed deposits on each tip change.
  - (2) **Refresh-before-refuse:** before returning a limit refusal for a session with an unconfirmed deposit, re-query that session's unconfirmed deposits (≤ once per 5 s per session; 5 s RPC deadline) and recompute.
- **Reason codes:** split the refusal into `awaiting_confirmation` ("a deposit is pending: do not deposit, wait") and `deposit_required` (§6.1).
- **Client:** take "pending" only from the facilitator snapshot, and never deposit on `awaiting_confirmation`.
- **Lazy crediting (Z15):**
  - Today the call that carries a later deposit blocks on `GetTransaction` (0.24–11.6 s, up to 15 s on NotFound), even when the voucher fits the current limit without the deposit.
  - If it fits without the new deposit, return `isValid:true` at once and resolve the deposit in the background (bounded concurrency).
  - Credit it at the first settle after the lookup completes. The client re-sends the txid until acknowledged (§6.2).
  - Only a voucher that *needs* the deposit (call 1, or after exhaustion) waits ≤ 15 s.

### 3.9 Two unconfirmed deposits (the "newest only" rule)

- With equal W deposits, "newest unconfirmed only" and `min(W, Σ pending)` give the same number. The older pending deposit contributes nothing until mined, so a second pending deposit never raises the limit.
- Prefer **`min(W, Σ live pending)`**:
  - it needs no ordering ("newest" by credit time? broadcast time? first-seen?);
  - it ignores `dead` and `orphaned` deposits;
  - it caps over-window deposits (Z4) in the same rule.
- Contract consequence: a client gains nothing by depositing while the facilitator reports a pending deposit.

---

## 4. Trust-ramp math

### 4.1 Integer formula (Z16)

```
D_conf  = Σ value(d) for d in session, status ∈ {confirmed, final}
D_pend  = min(windowZat, Σ value(d) for d in session, status = pending, zeroConfEligible(d))
credit  = min(creditCapZat, floor(D_conf × creditRatioBps / 10_000))
limit   = D_conf + D_pend + credit                         (all BigInt, zatoshi)
accept  ⇔ c_new − c_last ≥ amount  ∧  c_new ≤ limit           (c_last = last *settled* voucher)
zeroConfEligible(d) ⇔ value(d) ≥ windowZat ∧ (expiry(d) = 0 ∨ expiry(d) − tipAtFirstSight ≥ 20) ∧ no transparent part
```

- Transmit `creditRatioBps: 2500`, not `creditRatio: 0.25`.
- The skeleton turns the float into ppm with `Math.round` (sdk-server §9 `sessionLimitZat`). A JS client doing `Math.floor(D_conf * r)` with floats diverges by 1 zat [ran]:
  - r = 0.29, D_conf = 100,000: `100000*0.29 = 28999.999999999996`, so the float floor is 28,999 while the integer result is 29,000;
  - r = 0.57 gives 56,999 vs 57,000;
  - 0.25 happens to agree.

  A client whose mirror is 1 zat *above* the facilitator's sends `limit+1` and gets refused. One whose mirror is below deposits one call early.
- Zat terms go as decimal strings, like `amount`.

**Reference table** [ran] (`$DC/vectors.mjs`; W = 100,000, 2500 bps, cap 200,000):

| State | Spec rule | Capped rule |
|---|---|---|
| new session | 0 | 0 |
| D1 pending | 100,000 | 100,000 |
| D1 confirmed | 125,000 | 125,000 |
| D1 confirmed + D2 pending | 225,000 | 225,000 |
| D1, D2 confirmed | 250,000 | 250,000 |
| D1, D2 pending (D1 mined, not yet polled) | 100,000 | 100,000 |
| 8 confirmed (credit hits cap) | 1,000,000 | 1,000,000 |
| 9 confirmed | 1,100,000 | 1,100,000 |
| 100,001 confirmed (floor) | 125,001 | 125,001 |
| **1,000,000 pending (over-deposit)** | **1,000,000** | **100,000** |

### 4.2 Boundaries

- The limit is inclusive (`≤`). The spec's prose says "under", but its formula uses `≤`; choose `≤`.
- Trigger in integers: `2 × (limit − c_last) < trigger × W`.
  - Spec: trigger = 1 (headroom < W/2).
  - Recommended for the demo: trigger = 2 (headroom < W), with "nothing pending" taken from the facilitator snapshot.
- First voucher of a session: `c_last = 0`, `c_new ≥ amount`, and it must carry a deposit (limit 0).
- `amount` must be ≥ 1. A route with `amount: "0"` makes delta ≥ 0 always true, so one voucher replays forever. `parsePrice` rejects 0 (sdk-server §9), but the facilitator should also refuse `requirements.amount` ≠ its configured price list (`invalid_payment_requirements`).

### 4.3 Is the worst-case loss W + min(C_max, r·D_conf) right? (Z4)

Merchant loss = value served − value finally received ≤ `limit − D_received`. As specified, the bound breaks in four places:

1. **Over-window pending deposit.** D_pend = full amount. A 10 W zero-conf deposit that is then double-spent or expired loses 10 W + credit. *Fix: cap at W (4.1).*
2. **Non-final D_conf.** A 1-conf deposit reorged out keeps both its D_conf and its credit share. *Fix: demote until final, or count only final deposits toward credit.*
3. **Restart.** Every past deposit can be credited again (§7.3). *Fix: persist.*
4. **Per-session, not per-attacker.** Every new key gets a fresh zero-conf W. With the short-expiry trick (3.5), that costs the attacker nothing about 42 % of the time. *Fix: the expiry margin removes the free option. What remains is the real double-spend risk the spec accepts.*

With the fixes, per session: **loss ≤ min(W, Σ pending) + min(C_max, r·D_conf) + Σ (confirmed-but-not-final deposits later reorged out and double-spent)**.

The last term disappears only if deposits below k confirmations count *inside* the pending cap, i.e. `D_pend = min(W, Σ deposits with < k conf)`, and credit uses only final deposits. The price is that credit appears after k blocks (~4 min at k = 10), which slows the ramp.

For the MVP, keep 1-conf crediting (the spec's choice) and state the reorg term explicitly.

### 4.4 How the client's mirror diverges (Z11)

Sources of divergence:
- poller lag (3.8);
- a deposit the client broadcast but the facilitator never credited (its call failed);
- a dropped or dead deposit;
- float rounding (4.1);
- an optimistic local `c` (2.4);
- a facilitator restart (§7.3);
- terms changed, which needs an API restart because `/supported` is cached for the process lifetime (sdk-server C1).

The deadlock trap: the spec says the client "never sends a voucher the server would refuse". Implemented as a hard gate in `createPaymentPayload`, this makes the client refuse `c = 101,000` until it sees credit. But it learns about credit only from a PAYMENT-RESPONSE, which needs a sent voucher, so it stalls forever (or depends on its own chain polling).

Fix (client):
- Use the mirror only to decide **when to deposit**.
- Always send the voucher.
- On `awaiting_confirmation`, wait inside `onPaymentResponse` (poll the pending txid's height every 2 s for ≤ 60 s, then sleep 6 s for the facilitator tick) and return `{recovered:true}`.
- Otherwise return the 402 and let the loop back off 1 s.

---

## 5. Demo pacing vs block time (Z1)

### 5.1 Model

`$DC/pacing_sim.py` (+ `run_all.py`, `pvis.py`) runs 4,000 Monte Carlo runs per scenario under two latency models:
- **Structural:** a uniform broadcast point inside a length-biased empirical gap, then the empirical inclusion depth walked through the following real gaps. This is pessimistic, because coinbase-only runs are often fast blocks.
- **Empirical:** bootstrap of the 24 measured first-seen→mined latencies plus the two ~160 s cases, + U(0, 6) s for poll granularity.

Assumptions:
- Client deposit build time: U(2, 10) s. This is unmeasured for zingo-cli; a synthetic v6 deposit with real Halo 2 proofs took 0.565 s after a 1.5 s proving-key build (decrypt-spike §4.4), and Kage's agent took 9.2 s from build to first lookup (kage C1).
- Facilitator tip lag: 2 s. Local call: 2 ms. Retry backoff on refusal: 1 s.
- The client sees the facilitator snapshot after every call.

A "stall" is any time a call waits beyond normal pacing: an inline deposit build, or refusals while waiting. Call 1's own deposit is excluded.

### 5.2 Results [ran]

| Scenario | Total for 150 calls (median / p90) | Stall after call 1 (median / p90 / max) | P(no stall) |
|---|---|---|---|
| **A1 spec, local speed**, inline deposit, 30 s poller, p = 1,000 | 62–65 s / 160–198 s | 56–58 s / 154–192 s / 205–562 s | **0.000** |
| **A2 spec, 1 call/s** | 163–164 s / 210–249 s | 7 s / 54–92 s / 105–463 s | **0.000** (deposit 2 built inline: 2–10 s) |
| B2 1 call/s, background deposit, 5 s poller + refresh, p = 1,000 | 157 s / 192–226 s | 0 / 36–68 s / 68–444 s | 0.78–0.85 |
| **F1 1 call/s, p = 500, trigger headroom < W, background, 5 s poller + refresh** | **156 s / 160 s** | **0 / 0 / 0** | **1.000** |
| F5 same at 2 calls/s | 81 s / 85 s | 0 / 0 / 0 | 1.000 |
| F2 local speed, D1 pre-confirmed before the loop, trigger headroom < 1.5 W, p = 1,000 | 6.3 s / 9.5 s | 0 | 1.000 (D2 at call 1 → limit 225,000 ≥ 150,000) |
| C1 local speed, p = 500 (all 150 calls inside the first zero-conf window) | 6.3 s / 9.5 s | 0 | 1.000 (no block lands during the run) |

Ranges give the two models (empirical first). Broadcast → facilitator-visible confirmation:

| Poller | Median | p90 | P(≤ 100 s) |
|---|---|---|---|
| 30 s | 49–51 s | 149–186 s | 0.74–0.78 |
| 5 s | 34–38 s | 138–172 s | 0.77–0.84 |
| refresh-on-demand | 35–36 s | 136–166 s | 0.78–0.84 |

Why the spec stalls:
- At local speed the zero-conf window (W/p = 100 calls ≈ 0.1–0.2 s) is about 200× shorter than one confirmation, so **no trigger rule** can hide it.
- At 1 call/s the window is 100 s. That is shorter than the confirmation tail: 15–26 % of first confirmations take longer than ~100 s once the poller lag is added.
- The spec's inline deposit stalls the call that triggers it.

Why F1 never stalls without weakening security:
- 150 × 500 = 75,000 zat fits inside D1's zero-conf window, so no call depends on a confirmation.
- Exposure in zat is unchanged: W = 100,000, r = 25 %, C_max = 200,000.
- The narrative still happens: D1 becomes visible-confirmed around call 33–37 (median; p90 137–173). The credit line appears, and D2 goes out in the background (trigger "headroom < W"). P(narrative appears within the 150 calls) = 0.87–0.92 at 1 call/s, 0.70–0.73 at 2 calls/s (`$DC/pvis.py`).
- With the spec trigger (W/2) at p = 500, D2 never fires inside 150 calls, because credit pushes the trigger past call 150.

### 5.3 Cheat mode [ran] (`$DC/pacing_sim2.py`, structural latency model, 5 s poller + refresh)

| Cheat starts | Price, pacing | Refused permanently from | Time to that refusal (median / p90) | Merchant exposure |
|---|---|---|---|---|
| after D1 | p = 1,000, local speed | call 126 (c = 125,000) | 42 s / 171 s (waiting for D1) | 25,000 credit |
| after D1 | p = 1,000, 1 call/s | call 126 | 132 s / 196 s | 25,000 |
| after D2 | p = 1,000, local speed | call 251 (c = 250,000) | 110 s / 280 s | 50,000 |
| after D1 | p = 500, local speed | call 251 (c = 125,000) | 42 s / 171 s | 25,000 |

- While D1 is pending, refusals carry `awaiting_confirmation`. After the credit is used, they carry `deposit_required`.
- The client's hook must not deposit when the cheat flag is set.
- With a double-spent or short-expiry D1 under the spec rules, exposure is 100,000 (W) with no credit. With the expiry margin, that requires a real double-spend.

### 5.4 Recommended demo script (Z22 included)

| Step | What |
|---|---|
| Before recording | Agent wallet: ≥ 5 Ironwood notes of ≥ 110,000 zat, each with ≥ 3 confirmations. zingo spends only 3-conf notes (wallet-cli §6.6), and the #2835 zero-balance race needs retries. Merchant UA Orchard-only. zdecrypt self-test passes. Start the facilitator, then the API. |
| Terms | W = 100,000; **p = 500**; creditRatioBps = 2500; C_max = 200,000; zeroConfMinExpiryBlocks = 20. |
| Run 1 (honest) | **1 call/s**, 150 calls (~156 s). Call 1 builds D1 inline (2–10 s) and is served at zero-conf. Around call 33–37, D1 is visible-confirmed, "credit +25,000" appears and D2 goes out in the background. The stream never pauses. |
| Run 2 (cheat) | **Local speed**, cheat flag. Calls 1–200 in < 1 s on D1 zero-conf. `awaiting_confirmation` until D1 confirms (~35–50 s). 50 calls on credit. Refused permanently at cumulative 125,000. |
| Run 2 alternative | Continue run 1 with the cheat flag at local speed until refused at 225,000 (D2 pending) or 250,000 (D2 confirmed). |
| Fallback (if the price must stay 1,000) | Pre-confirm D1 off camera and use F2 (local speed, no stall). The "served on an unconfirmed deposit" claim is then shown by D2 at call 1. |

---

## 6. Refusals: what the facilitator tells the client

### 6.1 Code vocabulary with client actions (contract)

Only `invalidReason` reaches the client on a verify refusal; `invalidMessage` and `VerifyResponse.extra` are dropped (x402-e2e-spike S3; x402-spec verification 7). So the **code itself must carry the action**.

Prefix: either `invalid_<scheme_snake>_zcash_` (x402 §9 convention, x402-spec §8.6) or `z402_`. Pick one; reasons below without the prefix.

| Reason | Where | Meaning | Client action (stock wrapper: one `{recovered:true}`) |
|---|---|---|---|
| `awaiting_confirmation` | verify, settle | `c_new > limit` and the session has a live pending deposit | Do **not** deposit. Wait (≤ 60 s chain poll + 6 s), then `{recovered:true}`; else back off 1 s |
| `deposit_required` | verify, settle | `c_new > limit`, nothing pending | Deposit (background if headroom remains; here it doesn't), attach the txid, `{recovered:true}` |
| `cumulative_mismatch` | verify, settle | `c_new − c_last < amount` | Resync to `session.cumulativeZat`, re-sign, `{recovered:true}` |
| `invalid_signature`, `invalid_payload` | verify | client bug | Fatal; surface |
| `deposit_not_found` | verify | 15 s of definitive `-5` answers | Keep the txid. Check the wallet: if `failed`, re-deposit; else retry later |
| `chain_unavailable` | verify | lightwalletd errors, no definitive answer | Keep the txid; back off 5–30 s. Voucher-only calls still work |
| `deposit_memo_mismatch`, `deposit_not_to_merchant`, `deposit_amount_too_low`, `deposit_transparent`, `deposit_expired`, `deposit_dead`, `deposit_other_session` | verify | deposit unusable | Drop the txid from the resend list; deposit again if needed |
| `deposit_expiry_too_soon` | verify | expiry < tip + 20 | Counted only when mined; fix the wallet's expiry delta |
| `invalid_payment_requirements`, `invalid_network`, `invalid_scheme`, `invalid_x402_version` | verify, settle | config drift | Fatal |
| `unexpected_verify_error`, `unexpected_settle_error` | either | facilitator bug | Back off and retry once |

Never `settlement_pending`: the SDK re-settles automatically (x402-e2e-spike S12; kage C5).

### 6.2 Snapshot schema and deposit ack (Z20, Z27)

```json
{ "sessionKey": "03a1…31b8", "cumulativeZat": "53000", "limitZat": "125000", "headroomZat": "72000",
  "confirmedZat": "100000", "pendingZat": "0", "creditZat": "25000", "tip": 4547331,
  "deposits": [ { "txid": "<64 hex>", "valueZat": "100000", "status": "pending|confirmed|final|orphaned|dead",
                  "confirmations": 2, "expiryHeight": 4547450, "zeroConf": true } ] }
```

- Sent in every SettleResponse `extra.session` and every corrective 402 `accepts[0].extra.session`.
- `deposits` is bounded to all non-final entries plus the last 4 final ones. Headers above ~16 KB fail in undici (x402-spec §4.1).
- **Ack rule:** `SettleResponse.transaction = depositTxid` whenever the payload's `depositTxid` is credited to this session. This holds for a new credit *and* a re-presentation, so a lost ack can be re-acked. Otherwise `""`. `amount` = the charged delta.
- The client re-sends a txid until it sees it acked or listed in `deposits`.

### 6.3 Wire-level must-haves (Z18)

- Always HTTP 200 with a schema-complete body. Settle replies always carry `transaction` (string) and `network`.
- A plain 500 leaks the raw body into `errorReason`. A 4xx with an `isValid` body turns the code into `"<code>: <message>"`. A settle reply missing `transaction` becomes a 502 (x402-e2e-spike §12; x402-spec verification 4).
- Catch scheme throws and return `unexpected_*_error` with 200. The skeleton's `/verify` catch returns 500 and its `parseBody` returns 400 (sdk-server §9); fix both.

---

## 7. Operations

### 7.1 lightwalletd down or slow (Z13)

- Every `getrawtransaction` error is `NotFound`. Only the message `-5: Transaction not found in mempool or best chain` means unknown (zcash-testnet verification 2).
- The fork retries transport failures 10× (~22.5 s) before answering (kage C2). Without client deadlines, one lookup eats the whole 15 s window.
- Rules:
  - one long-lived TLS channel (grpc-js, `longs: String, defaults: true`);
  - a 5 s deadline per RPC;
  - retry `-5`/`DeadlineExceeded`/`Unavailable` every 1 s within 15 s;
  - then return `deposit_not_found` only if every answer was a definitive `-5`, else `chain_unavailable`.
- The API's `HTTPFacilitatorClient.timeoutMs` (skeleton: 30 s) must exceed 15 s + one RPC + decrypt. Keep it at 30 s.
- During an outage, voucher-only calls keep working until the limit, because they never touch the chain. Only crediting and confirmations stop.

### 7.2 Decryption latency

| Path | Cost | Source |
|---|---|---|
| zdecrypt one-shot | 2.4–2.7 ms p50 per spawn | decrypt-spike §5 |
| Hanko | ~2 s VK build plus proof checks per found-tx check, and its own TLS connection per spawn | hanko §1, §3 |

The dominant cost is lightwalletd (0.24–11.6 s), so keep decrypt off the critical path where possible (3.8 lazy crediting).

### 7.3 In-memory state loss (Z6)

After a restart the facilitator has no sessions and no txid→owner map.
- (a) The client presents its old confirmed D1 again. The memo still matches its key, so D1 is credited again: W + 25 % credit of service for money already consumed. Then D2, D3, …
- (b) Anyone with logged PAYMENT-SIGNATURE headers (API access logs, a proxy) replays `c = 1000, 2000, …` against those re-credits, or against an honest client's new deposit if it reuses its key.

Fix (facilitator, ~40 lines):
- An append-only JSONL ledger: `deposit_credited {txid, sessionKey, valueZat}`, `voucher_settled {sessionKey, cumulativeZat}`, `deposit_status {txid, status, height}`.
- Write it with `appendFileSync` inside `/settle` after the checks and before responding. Replay it at startup.
- This is not a database; the spec's "no durable storage" can keep sessions ephemeral in spirit while closing the replay.
- Minimum alternative:
  - refuse deposits mined below the facilitator's start tip;
  - advertise a random `facilitatorEpoch` in `getExtra`, have the client sign it, and restart the API with the facilitator;
  - clients rotate keys when the epoch changes.

### 7.4 Clock and time assumptions; privacy (Z29)

Time:
- No logic should use wall-clock time except RPC deadlines, the 15 s window and the NotFound streak.
- Expiry uses heights: `tip ≥ expiryHeight` means dead.
- Vouchers carry no expiry, which is fine.
- `maxTimeoutSeconds` (60) is unenforced by the SDK (x402-spec §5). Treat it as documentation.
- The 30 s poller in the spec is longer than a block (25 s target); replace it with the 5 s tip-driven poller.

Privacy:
- Targeted `GetTransaction` from the merchant seconds after the agent's `SendTransaction`, on the same operator, links the two IPs.
- Accept it for the testnet MVP. Later options: an own node, Tor (Hanko's `ZPV_LWD_PROXY` pattern), or scanning `GetMempoolStream` with the IVK instead of targeted lookups.

### 7.5 DoS (Z14)

- Anyone can sign a voucher with a fresh key and attach a random txid. The skeleton then polls lightwalletd ~10 times over 15 s per request (`DEPOSIT_RETRY_MS 15_000`, `DEPOSIT_POLL_MS 1_500`) and caches only positive results [src].
- Fixes:
  - a negative cache (txid → `not_found` for 30 s);
  - a global semaphore (≤ 4 concurrent deposit lookups) and 1 per session key;
  - per-IP rate limiting at the API;
  - lazy crediting so voucher-only traffic never waits on lookups.

### 7.6 Startup and config consistency; API route; client hygiene (Z3, Z17, Z21, Z23, Z30)

Startup:
- Start the facilitator first. A missing kind or terms makes the API `exit(1)` (sdk-server §5.5).
- Advertise `payTo` and a `termsVersion` in `getExtra`. The server scheme's `validateFacilitatorSupport` then compares the route `payTo` and refuses to start on a mismatch (`exit(1)`) instead of every deposit failing as "not to merchant".
- Bind to 127.0.0.1 with a bearer token. `createAuthHeaders` returns `{verify, settle, supported}` (x402-e2e-spike verification 6).

API route:
- Key the route `"/chunk"`, not `"GET /chunk"`, or add `app.head('/chunk') → 405`. Unpaid HEAD otherwise runs the handler for free (sdk-server C2) [ran by the verifier].
- Make the handler idempotent: derive the chunk index from the settled cumulative, not a counter. The counter also advances on refused settles and HEADs.

Client:
- `findDefaultAsset` (or `setSpendControls`).
- Return the received `x402Version`.
- Cap `windowZat` with its own config (e.g. ≤ 1,000,000). With `findDefaultAsset`, the per-payment cap is 1 ZEC and it checks only `amount` (x402-spec §1.8).
- Accept only Orchard-only `utest1`/`zutest1` payTo.
- Check `res.status`: a final 402 is returned, not thrown.
- Catch `Failed to create payment payload: …`.
- Never return `{recovered:true}` on a successful response.

---

## 8. Facilitator algorithm (reference, TypeScript-like)

```ts
// verify(payload, req)  — read-only; may cache lookups
assertEnvelope(req)            // scheme/network/asset/payTo/amount == config, x402Version 2 → invalid_payment_requirements
p = parsePayload(payload.payload)               // regexes of §2.1 → invalid_payload
if (!ed25519Verify(p.sessionKey, voucherMessage(cfg, p), p.sig)) → invalid_signature
s = sessions.get(p.sessionKey) ?? empty(p.sessionKey)
if (BigInt(p.cumulativeZat) - s.cLast < BigInt(req.amount)) → cumulative_mismatch (+snapshot)
proj = s
if (p.depositTxid) {
  owner = consumed.get(p.depositTxid)
  if (owner && owner !== p.sessionKey) → deposit_other_session
  else if (!owner && dead.has(p.depositTxid)) → deposit_dead
  else if (!owner) {
    if (fits(s, p) && LAZY) startBackgroundLookup(p.depositTxid, p.sessionKey)   // credit later
    else { r = await lookup(p.depositTxid, p.sessionKey, {budgetMs: 15_000}) // GetTransaction + zdecrypt, cached
           if (!r.ok) → r.code ; proj = withDeposit(s, r) }
  }
}
if (!fits(proj, p) && hasLivePending(proj) && refreshAllowed(s)) { await refreshPending(s); proj = recompute(...) }
if (!fits(proj, p)) → hasLivePending(proj) ? awaiting_confirmation : deposit_required   (+snapshot)
return { isValid: true, payer: p.sessionKey, extra: { session: snapshot(proj) } }

// settle(payload, req) — same checks using ONLY cached lookups (no waits), then synchronously:
ledger.appendSync(...); s.cLast = c_new; if (newDeposit) { consumed.set(txid, key); s.deposits.push(dep) }
return { success: true, transaction: creditedToThisSession(txid) ? txid : "", network: req.network,
         payer: key, amount: (c_new - cLastBefore).toString(), extra: { session: snapshot(s) } }

// poller: every 5 s GetLatestBlock; on tip change re-check all deposits with status pending|confirmed|orphaned (§3.5 table)
```

---

## 9. Contract freeze checklist (both agents sign off before coding)

1. **Identifiers.** One shared constant module:
   - scheme id (suggest `prepaid-voucher`, per x402-spec §7);
   - `network = "zcash:testnet"`, `asset = "ZEC"`;
   - `amount` = zat decimal string.
2. **`accepts[0].extra`** (static, from facilitator `getExtra`):
   ```json
   {"windowZat": "100000", "creditRatioBps": 2500, "creditCapZat": "200000", "zeroConfMinExpiryBlocks": 20, "termsVersion": "<hash>"}
   ```
   - No `paymentFlow` or `assetTransferMethod`.
   - The server scheme's `validateFacilitatorSupport` also checks `payTo`.
3. **Payload** `{sessionKey, cumulativeZat, sig, depositTxid?}` with the regexes of §2.1. Reject uppercase; ignore unknown keys.
4. **Voucher bytes** as in §2.1, with the test vector as a unit test on both sides.
5. **Memo** `<sessionKey>:<depositIndex>`:
   - exact ZIP 302 text; the index is informational;
   - credit unit = lowercase txid, consumed once under `zcash:testnet:<txid>`;
   - one tx funds one session.
6. **Deposit validity:**
   - v5/v6, recomputed txid equals `depositTxid`, no transparent in/out;
   - Σ matching outputs to payTo's Orchard receiver: ≥ windowZat for zero-conf; any amount once confirmed;
   - expiry 0 or ≥ tip + 20 for zero-conf.
7. **Trust ramp** in BigInt as in §4.1:
   - lenient increment `c_new − c_last ≥ amount`;
   - inclusive limit;
   - pending capped at W;
   - D_conf = facilitator-observed ≥ 1 conf, demoted until 10.
8. **Responses** always HTTP 200:
   - VerifyResponse `{isValid, invalidReason?, payer, extra.session}`;
   - SettleResponse `{success, errorReason?, errorMessage?, transaction (ack rule §6.2), network, payer, amount (charged delta), extra.session}`;
   - never `settlement_pending`.
9. **State delivery:** the corrective 402 (`accepts[0].extra.session`) on every verify refusal; the snapshot schema of §6.2.
10. **Codes** of §6.1, with one prefix.
11. **Client rules:**
    - sequential per session;
    - advance on success or an ambiguous outcome, resync from snapshots;
    - resend `depositTxid` until acked;
    - deposit only on `deposit_required`, or when the trigger holds and no pending deposit is reported;
    - deposits after the first in the background;
    - `findDefaultAsset`; pass `x402Version` through; cap `windowZat`.
12. **Facilitator ops rules:**
    - 127.0.0.1 with a bearer token; start before the API;
    - a 5 s tip-driven poller; refresh-before-refuse;
    - 5 s RPC deadlines and `chain_unavailable`;
    - a persisted ledger (or start-height fence + epoch);
    - rate limits.
13. **Demo terms** (§5.4): p = 500, 1 call/s honest run, local-speed cheat run.

---

## 10. Sources

Research notes:
- `docs/research/x402-sdk-server.md`: §5.3–5.5, §8, §9 skeleton (`prepare`, `check`, `pollConfirmations`, `lookupDeposit`, `sessionLimitZat`), C1, C2.
- `docs/research/x402-e2e-spike.md`: S1–S13, §5, §8, §10, §12, verification 1–7.
- `docs/research/x402-spec.md`: §1.4–1.8, §2.4, §4, §5, §8, verification 2–9.
- `docs/research/kage.md`: §2, §5, C1–C5.
- `docs/research/hanko.md`: §3, §6, verification 2, 5, 6, 8.
- `docs/research/zcash-testnet.md`: §4–§5, §8.2, verification 1–7.
- `docs/research/decrypt-spike.md`: §3, §5, §8, verification 4–8.
- `docs/research/wallet-cli.md`: §4, §6.5–6.6, verification 5–7.

Source code:
- @x402 2.28.0 (`x402-foundation/x402` @ `6b6ee91f`), read locally at `$S/downloads/x402-sdk-server/repo-v2.28.0/typescript/packages/`:
  - `http/fetch/src/index.ts` (one paid attempt; one recovery retry built from the original 402);
  - `core/src/http/x402HTTPClient.ts:184-223` (hooks run on any status);
  - `core/src/client/x402Client.ts:511-526` (first `{recovered:true}` wins).
- Zebra v7.0.0 `e8db87eb69254e0d4eedd058eadd48bdfa09065a` (the live backend's `zcashdBuild`), read locally at `$S/downloads/verify-zcash-testnet/zebra-v7.0.0`:
  - `zebra-rpc/src/methods.rs:1509-1532`;
  - `zebrad/src/components/mempool/downloads.rs:417-473`;
  - `zebra-consensus/src/transaction/check.rs:607-613`;
  - `zebrad/src/components/mempool/storage.rs:892-917`;
  - `zebra-chain/src/transaction/unmined/zip317.rs:50,177-226`.

My probes (all [ran], in `$DC`):
- `parse_blocks.py` → `blocks1000.json`;
- `mempool_depth.py`, `mempool_latency_offline.py` → `latency_samples.json`;
- `pacing_sim.py`, `pacing_sim2.py`, `pacing_sim3.py`, `pacing_sim4.py`, `run_all.py` (set `Z402_SIM_MODEL=empirical|depth`), `pvis.py`, `trace.py`;
- `ed25519_edges.mjs` (node v26.11.0, OpenSSL 4.0.3), `vectors.mjs`, `ed25519_ref.py`.

`$S` = `/private/tmp/claude-501/-Users-oynozan-Desktop-Dev-Web3-z402/afbb7c76-d88e-47a4-8a53-fd001155f8ac/scratchpad`.
