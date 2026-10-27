# z402 client design (`@z402/client`, testkit, demo agent, e2e harness)

2026-10-27 · client agent

**Inputs**
- [mvp-build-doc.md](../../spec/mvp-build-doc.md): the source spec.
- [protocol.md](../../spec/protocol.md): the wire contract shared with the facilitator agent. This design builds on it and does not repeat it.
- Research: `docs/research/*.md` (facilitator track) and `docs/research/client/*.md` (client track).

## 1. What the client side must deliver

Taken from the build doc's "Done means", restated for this side:

1. **One line.** The agent's code is the stock x402 v2 client plus one `client.register("zcash:testnet", zcashClientScheme)` line, with nothing else.
2. **Only deposits wait.** 150 paid calls run back to back, and only deposits wait on the chain. The client never pays twice for one window and never sends a voucher it already knows will fail.
3. **Credit ramp.** Credit appears as deposits confirm. A cheating client (no more deposits) is refused at the facilitator's limit, with the refusal visible to the agent as a `402` response.

Out of scope (the doc's cut list): mainnet, browser wallets, other languages, MCP, refunds, spend caps beyond a per-deposit sanity cap, durable client state.

## 2. Packages and boundaries

| Package | Job | Depends on |
|---|---|---|
| `@z402/protocol` | Shared contract code (protocol.md §13). It also holds the **client seam types** `ZcashWallet` and `TxStatusSource`, so testkit can implement them without importing the client. | `node:crypto` only |
| `@z402/client` | `PrepaidVoucherScheme` (the x402 `SchemeNetworkClient`), the zingo-cli wallet adapter, the lightwalletd status source | protocol, `@x402/core` 2.28.0 (types and `SchemeNetworkClient`) |
| `@z402/testkit` | `FakeChain` (in-memory chain: broadcast, mine, drop, reorg; serves both `ChainView` and `TxStatusSource`) and `MockWallet` | protocol |
| `apps/agent` | The demo: stock `wrapFetchWithPayment` loop, pacing, cheat flag, one log line per call | client, `@x402/fetch` 2.28.0, `@z402/lightwalletd` |
| `apps/e2e` | Single-process end-to-end tests: FakeChain + the real facilitator and API (the other agent's packages) + the real scheme on MockWallet | everything |

Client seam types, which live in `@z402/protocol` and are owned by the client agent:

```ts
interface DepositRequest { to: string; amountZat: bigint; memo: string }
interface ZcashWallet { sendDeposit(req: DepositRequest): Promise<{ txid: string }>; close?(): Promise<void> }
type TxStatus = { found: false }
              | { found: true; location: "mempool" | "mined" | "orphaned"; minedHeight: number | null; expiryHeight: number };
interface TxStatusSource { tip(): Promise<number>; status(txid: string): Promise<TxStatus> }   // throws ChainUnavailableError
```

## 3. `PrepaidVoucherScheme`

```ts
class PrepaidVoucherScheme implements SchemeNetworkClient {
  readonly scheme = "prepaid-voucher";
  readonly schemeHooks: { onPaymentResponse(ctx: PaymentResponseContext): Promise<void | { recovered: true }> };
  constructor(opts: PrepaidVoucherSchemeOptions);
  findDefaultAsset(asset: string, network: Network): DefaultAsset | undefined;   // ZEC on zcash:* → { asset: "ZEC", decimals: 8, symbol: "ZEC" }
  createPaymentPayload(x402Version: number, req: PaymentRequirements, ctx?: PaymentPayloadContext): Promise<PaymentPayloadResult>;
  session(payTo: string): SessionView | undefined;                               // read-only, for logs and tests
  close(): Promise<void>;                                                        // closes the wallet
}
interface PrepaidVoucherSchemeOptions {
  wallet: ZcashWallet;
  chain: TxStatusSource;
  maxDeposits?: number;          // default Infinity; the demo's --cheat sets 1
  depositTriggerZat?: bigint;    // background deposit when headroom < this; default terms.windowZat
  maxDepositZat?: bigint;        // refuse a 402 whose windowZat is larger; default 1_000_000n
  confirmationWaitMs?: number;   // how long the hook waits on z402_awaiting_confirmation; default 600_000
  pollIntervalMs?: number;       // own chain polling; default 2_000
  facilitatorLagMs?: number;     // pause after seeing the deposit mined, before {recovered:true}; default 6_000
  safetyReleaseMs?: number;      // mutex release when the hook never fires; default 120_000
  onEvent?: (e: ClientEvent) => void;
  seed?: Uint8Array;             // tests only: fixed 32-byte session seed
  clock?: Clock;                 // tests only: { now(): number; sleep(ms: number): Promise<void> }
}
```

### 3.1 Session state (one per `payTo` + network)
- `seed` and `sessionKey`: a fresh random Ed25519 seed per session.
- `terms` and `price`: from the latest requirements.
- `cumulative`: the server's `c_last` as last learned. It resyncs from snapshots and advances on ambiguous outcomes.
- `snapshot`: the last `SessionSnapshot` seen.
- `deposits`: local records `{ index, memo, txid?, state: "sending" | "sent" | "acked" | "dead" | "rejected" | "failed" | "uncertain" }`. A deposit is `uncertain` when the wallet errored after building it (§4).
- `nextIndex` (starts at 1) and `depositsMade`.
- `inflightDeposit`: a single-flight promise, so two triggers never pay twice.
- `mutex`, and the current `attempt`: `{ cumulative, depositTxid?, timer }`.

### 3.2 `createPaymentPayload`

1. **Validate the 402 entry.** Any failure throws, and the stock wrapper turns that into `Failed to create payment payload: …`. Checks:
   - `scheme`;
   - `network` matches `zcash:*`;
   - `isValidPayTo(payTo)`;
   - `price = parseZat(amount) ≥ 1`;
   - `terms = parseTerms(extra)`;
   - `price ≤ windowZat`;
   - `windowZat ≤ maxDepositZat`, and `windowZat ≤ ctx.maxAmountPerPayment` when that is set.
2. **Lock.** Acquire the session mutex, then arm the safety timer.
3. **Decide the deposit.**
   - *Pending* means the snapshot lists a `pending` deposit, **or** we hold a `sent` deposit that is not acked and not dead.
   - **Inline** (awaited before signing) when there is no snapshot and no live deposit (call 1), or when `headroom < price` and nothing is pending.
   - **Background** (fire and forget) when the snapshot shows nothing pending and `headroom < depositTriggerZat`.
   - No deposit at all once `depositsMade ≥ maxDeposits`.
4. **Sign.** `c_new = cumulative + price`. Sign `voucherMessage(...)`. Attach `depositTxid` = the newest deposit still in state `sent`. A deposit becomes `acked`, and is never resent, only on a **successful** settle (`success: true`) where `settle.transaction === txid` or that settle's snapshot lists the txid (protocol.md v1.1 §7.3). Refusal snapshots (corrective 402s, settle `success: false`) are projected: they resync `cumulative` and copy `dead`, but never ack. A snapshot whose `sessionKey` is not ours is ignored and is fatal.
5. **Return.** Record the `attempt`, emit `voucher`, and return `{ x402Version, payload }`.

### 3.3 `onPaymentResponse` (the only place the outcome is visible)

On entry: clear the safety timer. Always release the mutex in `finally`.

**Final attempt.** `isFinal` is true when `ctx.requirements` is in the `recovered` WeakSet. The stock wrapper reuses the same requirements object for its single recovery retry; it was verified in the 2.28.0 source that `paymentPayload.accepted` is the selected requirements object. On the final attempt the hook never waits and never pays inline. It may still start a background deposit.

| `ctx` shape | Meaning | Action |
|---|---|---|
| `settleResponse.success === true` | Paid | Apply `extra.session` (`cumulative = snapshot.cumulativeZat`; else `cumulative = attempt.cumulative`). Ack the txid if `transaction === txid` or it is listed. Copy `dead` statuses. Evaluate the background trigger. Emit `paid`. |
| `settleResponse.success === false` | Settle refused (state moved) | Apply the snapshot if present, then act on `errorReason` (table below). |
| `paymentRequired` | Verify refused | Find our `accepts` entry, apply `extra.session` if present, then act on `paymentRequired.error`. |
| neither | Ambiguous (502, handler ≥ 400, …) | `cumulative = max(cumulative, attempt.cumulative)`; emit `ambiguous`; no recovery. |

| Code | Not final | Final |
|---|---|---|
| `z402_awaiting_confirmation` | `waitForConfirmation(pendingTxid)`. Mined → `{recovered:true}`. Dead → redeposit inline (if allowed) → `{recovered:true}`. Timeout → return. | Return. |
| `z402_deposit_required` | If the attempt presented txid T: halt (`fatal`, never pay again) when the refusal snapshot lists T `pending`, or omits T while listing fewer than 4 `final` deposits (protocol.md v1.1 §7.3 bullet 3; R26/R26a). T listed `confirmed`/`final`/`dead`/`orphaned`, or omitted with ≥4 `final` listed (aged out, §7.2), is accounted: no halt and no ack from the refusal. Then inline deposit if allowed → `{recovered:true}`; in cheat mode → emit `refused` and return. | Same halt rule; otherwise background deposit if allowed; return. |
| `z402_cumulative_mismatch` | Snapshot already resynced `cumulative` → `{recovered:true}` (without a snapshot: return). | Return. |
| `z402_deposit_dead` | Mark it dead → inline deposit if allowed → `{recovered:true}`. | Mark it dead; background deposit. |
| `z402_deposit_not_found` | Own `status(txid)`. Found → sleep 2 s → recover. Not found for ≥ 120 s and ≥ 2 new blocks → treat as dead. | Return. |
| `z402_chain_unavailable`, `unexpected_*_error` | Sleep 5 s / 1 s → `{recovered:true}`. | Return. |
| `z402_deposit_{not_to_merchant,memo_mismatch,transparent,other_session}` | Mark it `rejected` (never resent); emit `fatal`. | same |
| `z402_invalid_signature`, the standard `invalid_*` codes, `unsupported_scheme`, SDK strings, unknown | Emit `fatal`. | same |

When it returns `{recovered:true}`, the hook adds `ctx.requirements` to the `recovered` WeakSet.

### 3.4 Waiting for confirmation

`waitForConfirmation(txid, { timeoutMs, pollMs })` returns `"mined" | "dead" | "timeout"`.
- It polls `chain.status(txid)` every `pollMs`.
- `"mined"`: `location === "mined"`.
- `"dead"`:
  - `isDepositDead({ minedHeight: null, expiryHeight, tip })`;
  - or a not-found streak of definitive answers (`{ found: false }`) spanning ≥ 120 s **and** ≥ 2 new blocks. Any found answer resets the streak, and `ChainUnavailableError` neither counts nor resets it (protocol.md §5.3);
  - or `orphaned` past its expiry.
- `testnet.zec.rocks` load-balances across backends that can lag each other by up to ~16 s, so one not-found means nothing.
- `ChainUnavailableError` is retried until the timeout.
- After `"mined"`, the hook sleeps `facilitatorLagMs` (6 s) before returning `{recovered:true}`. The single recovery retry must not land before the facilitator sees the block:
  - lightwalletd caches its tip for about 2 s;
  - the facilitator's tip poller runs every 5 s;
  - its refresh-before-refuse is rate-limited to once per 5 s per session, and the refusal that started the wait may have just used it.
- Both sides read the same lightwalletd, so 6 s covers both paths.

### 3.5 Deposits
- **Procedure.** `index = nextIndex++`, then `memo = depositMemo(sessionKey, index)`, then `wallet.sendDeposit({ to: payTo, amountZat: windowZat, memo })`.
- **Bookkeeping.** On success: `state = "sent"`, `depositsMade++`, emit `deposit_broadcast` (with the elapsed ms). On a thrown error: `state = "failed"`, emit `deposit_failed`, and rethrow (inline) or swallow (background, retried at the next trigger).
- **Background deposits.** Their txid is attached from the first call made after it resolves.
- **No double payments.** The adapter (§4) reconciles "error after broadcast" by looking the memo up in wallet history, so one window is never paid twice.

### 3.6 Events (`ClientEvent`, for the demo log and tests)

`session`, `deposit_started {index, inline}`, `deposit_broadcast {index, txid, ms}`, `deposit_failed {index, error}`, `deposit_acked {txid}`, `deposit_confirmed {txid, height?}` (height only from the waiting path, which reads our own chain; snapshot-sourced confirmations carry none), `deposit_dead {txid}`, `voucher {cumulativeZat, depositTxid?}`, `paid {cumulativeZat, snapshot?}`, `refused {code, snapshot?, recovering}`, `waiting {txid}`, `ambiguous {attemptedZat}`, `fatal {code, message}`.

## 4. Wallet adapter: zingo-cli, one-shot

**Sources.**
- `docs/research/wallet-cli.md` (facilitator track).
- `docs/research/client/research-digest.md`, gaps 2 and 3.

Every post-NU7 testnet send anyone has observed used **one-shot** `--waitsync quicksend` calls (Hanko's wrapper). The REPL is not used: its framing, prompt and sync-mode behaviour are unproven.

### Build
- **Commit.** zingolib `0a5cb69abf1ea7e516fe50ca57f3fcdc446bd7ed` (v7.0.0+263): the commit used in the only observed post-NU7 testnet sends.
- **Features.** Built Nym-free: `cargo build --release -p zingo-cli --no-default-features --features nakednet-test-mode`, then copied to `.tools/bin/zingo-cli`. Sends then go straight to the pinned `--server`. Each launch prints a WARNING, and testnet.zec.rocks sees the agent's IP.
- **Fallbacks.** First the tag `zingolib_v7.0.0` (`bfb0a215`, same send path), then `zingolib_v8.0.0-rc.0` (`755c3ada`, untested on sends).
- **Approval.** Building external code needs the user's approval.

### `ZingoCli` (one-shot runner)
- `online(args, { timeoutMs })` and `offline(args, { timeoutMs })` prepend the fixed arguments (below) and resolve to `{ code, stdout, stderr, json? }` via `execFile(bin, args, …)`:
  - `cwd` = the wallet dir;
  - env = the parent env **minus `ZINGO_SEED`**, plus `NO_COLOR=1` and `RUST_LOG=off`. In one-shot mode tracing writes ERROR lines to stdout.
- A per-data-dir lock serializes calls: an in-process queue plus a `<dir>/.z402.lock` file created with `wx`. The wallet file has no lock of its own, so two processes on one dir corrupt it.
- A sending process is never killed before its timeout (600 s for `quicksend`).

### Fixed arguments
- Every call: `--chain testnet --data-dir <dir>`.
- Online calls add `--server https://testnet.zec.rocks:443 --waitsync`.
- History lookups add `--offline`.

### `ZingoCliWallet.sendDeposit({ to, amountZat, memo })`
1. **Send.** Run `… --waitsync quicksend '<JSON [{"address":to,"amount":Number(amountZat),"memo":memo}]>'`, passed as one argv element, so no shell quoting is involved.
2. **Exit 0.** Parse the JSON object in stdout, `{"txids":[…],"transmissions":[…]}`, and return `txids[0]`.
   - Warn unless `transmissions[0].over_mixnet === false` and `destination === "testnet.zec.rocks"`; that is the wrong-binary guard.
3. **Exit ≠ 0.** Never parse stderr for a txid. Classify the stderr cause chain:
   - **Pre-broadcast** (`Insufficient balance`, `Propose send error`):
     - nothing was built;
     - wait one block (30 s) and retry, at most 3 times (zingo #2835 briefly reports 0 spendable);
     - then throw `InsufficientFundsError`.
   - **Anything else** (`Transmission error`, `Transmission failed`, a timeout, unknown): **reconcile**:
     1. Run `--offline messages "<memo>"`. Keep `value_transfers` entries with `kind === "sent"` whose memo **exactly** equals ours; the filter itself matches substrings.
     2. No entry: nothing was built, so retrying with the same index is safe (once).
     3. Status `transmitted | mempool | confirmed`: return that txid.
     4. Status `failed`: poll `TxStatusSource.status(txid)` every 3 s for 60 s. Found → return the txid. Still not found → throw `DepositUncertainError { txid }`.
4. **No resend after a transmit error.** The adapter never runs a second `quicksend` with a memo already used after a transmit error. zingo cannot rebroadcast a `failed` transaction.

### Scheme handling of `DepositUncertainError`
- Record the txid as `state: "uncertain"`.
- Count the deposit as not made, so the next trigger sends index + 1.
- Keep checking the uncertain txid in the background until `tip ≥ expiry`. If it appears, promote it to `"sent"` so it is presented and credited. The facilitator credits every distinct txid that carries the session memo, so a late original becomes extra balance, not a loss.

### Wallet setup (Task 12)
- Create the wallet **with `--waitsync` on its first invocation**. `shutdown_on_completion` is fixed at creation, and without it every later `--waitsync` call blocks forever.
- Fund it (§8: no automated faucet is reliable).
- Split it into 5 Ironwood notes of 200,000 zat with one multi-recipient `quicksend` (fee 30,000). Each deposit spends one 3-confirmation note, so it never waits for the previous deposit's change.
- zingo applies a symmetric 3-confirmation spend policy.

## 5. Status source: lightwalletd

`LightwalletdTxStatus` adapts the facilitator agent's `@z402/lightwalletd` client (protocol.md §15). It is typed against a local structural interface, so it compiles before that package lands.
- `status(txid)` → `getTransaction(txid)` → `{ found:false }`, or `{ found:true, location, minedHeight: height, expiryHeight: expiryHeightFromRawTx(raw) }`.
- `tip()` → `getTip()`.
- Reading the same node the same way as the facilitator keeps both views identical.

## 6. Demo agent (`apps/agent`)

- `src/agent.ts` is the code shown on camera: the stock imports, `new x402Client()`, **one** `register` line, `wrapFetchWithPayment`, and a loop.
- `src/zcash.ts` builds `zcashClientScheme` from flags and environment variables:
  - `new ZingoCliWallet({ cli: new ZingoCli({ bin, dataDir }), chain })`;
  - `LightwalletdTxStatus(createLightwalletdClient({ url }))`;
  - `--cheat` → `maxDeposits: 1`.
- Flags: `--api` (default `http://127.0.0.1:4021`), `--calls` (default 150), `--interval-ms` (default 1000), `--cheat`, `--zingo-bin`, `--wallet-dir`, `--lightwalletd` (default `https://testnet.zec.rocks:443`).
- **One log line per call:**
  - status, chunk number, `c`, limit, confirmed, pending, credit and the deposit list, from the decoded `PAYMENT-RESPONSE` (`decodePaymentResponseHeader`) or the corrective 402;
  - deposit, confirmation, waiting and refusal events go on their own lines.
- **Refusals.** Cheat mode stops at the first `z402_deposit_required` refusal and prints `REFUSED at limit …`. The honest loop logs refusals and continues.
- A preflight check refuses to start with fewer than 2 spendable notes.

## 7. Testing strategy

| Layer | How |
|---|---|
| protocol | Unit tests with exact vectors: voucher bytes and signature (also cross-checked with `@noble/curves`), the ramp reference table, expiry boundaries, the snapshot parser. |
| scheme logic | Calls `createPaymentPayload` and `schemeHooks.onPaymentResponse` directly with hand-built contexts, on FakeChain + MockWallet + a fake clock. Covers every row of §3.3. |
| stock wrapper | A real `@x402/fetch` `wrapFetchWithPayment` against a small scripted HTTP merchant (test helper). It proves the one-line registration passes spend controls, that a recovery makes a third hop, and that a final refusal resolves to a 402 `Response`. |
| zingo adapter | A fake `zingo-cli` (a Node script driven by argv and a scripted-response file) replays fixtures captured from the real binary in Task 12. |
| e2e | `apps/e2e`: FakeChain + the real `startFacilitator` and `startApi` + the real scheme. Covers the honest ramp, cheat refusal, a dead deposit leading to a redeposit, and waiting for a confirmation. |
| testnet | A smoke deposit (wallet → lightwalletd status), then the full demo run. |

## 8. Risks

| Risk | Mitigation |
|---|---|
| Nobody has sent with a Nym-free zingo-cli build | The adapter uses the exact one-shot invocation that worked (Hanko's). Task 12 sends first and captures real outputs as fixtures. Fallbacks: the `v7.0.0` tag, then the Nym build with `nym-proxy`, then zcash-devtool (a different adapter). |
| **No automated faucet is reliable on the NU7 chain.** Valar has paid nobody since 2026-10-23; Fauzec is unverified on NU7. The only payments confirmed in the last 72 h are manual sends by ZecHub's `dismad` on forum thread t/57087 (replies in minutes to hours). | **The user requests 0.5–1 TAZ there as soon as the agent address exists** (Task 12), and tries Fauzec's API in parallel. Every receipt is verified with `api.testnet.cipherscan.app` (v6, Ironwood, canonical). 1 TAZ ≈ 400 demo runs. |
| Single operator: testnet.zec.rocks (and its backend na-lax) is the only working NU7 lightwalletd | Optional warm standby: a self-hosted Zebra 7.0.0 (ZFND snapshot) + lightwalletd v0.6.0 `--nocache`. The nakednet zingo build can send to it. This is a joint decision with the facilitator agent; it is not in this plan. |
| A long confirmation wait inside the hook blocks the session | That is intended (calls would be refused anyway). The wait is bounded by `confirmationWaitMs`. |
| A custom x402 policy clones requirements, which breaks final-attempt detection | Worst case is a pointless wait on the final attempt, with no wrong payment. Documented. |
| The facilitator's packages land later than the client's | Client unit and wrapper tests need none of them. `apps/e2e` and the testnet run are the integration milestones. |
