# x402 e2e spike: stock `@x402/*` 2.28.0 with a custom scheme on `zcash:testnet`

Track `x402-e2e-spike` · 2026-10-27 · Spike code and raw logs: `/private/tmp/claude-501/-Users-oynozan-Desktop-Dev-Web3-z402/afbb7c76-d88e-47a4-8a53-fd001155f8ac/scratchpad/spikes/x402-e2e-spike` (below: `$SPIKE`; it lives in a session scratchpad, so everything you need is copied into this file).

## TL;DR

1. A custom scheme (`mockstream`) on `zcash:testnet` runs end to end with unmodified `@x402/fetch` `wrapFetchWithPayment` + `@x402/express` `paymentMiddleware` + `x402Facilitator` 2.28.0. The SDK printed no warnings, and the network id passes every SDK check.
2. **Blocker for the "one `register` line" goal (fixable inside the scheme):** the default `x402Client` spend controls reject any asset they don't recognise, so `paidFetch` throws `Failed to create payment payload: All payment requirements were rejected by spendControls…`. Fix: the client scheme implements `findDefaultAsset()` returning `{asset:"ZEC",decimals:8,symbol:"ZEC"}`. The cap then becomes 1 ZEC (100000000 zat) per payment.
3. Every paid call makes a fresh unpaid request (402), then the paid request. The SDK caches nothing. Server side, each paid request calls `/verify` → handler → `/settle`. That is 4 HTTP exchanges per call. Median is 1.06 ms (150 calls) or 2.0 ms (8 calls) on localhost with logging off. The HTTP hops dominate.
4. The handler's response is buffered until `/settle` returns. If settle returns `success:false` or the facilitator errors, the buffered body is thrown away and the client gets `402` + `PAYMENT-RESPONSE{success:false}`. The handler has still run.
5. To send facilitator state to the client, use `SettleResponse.extra` (or `extensions`). Both reach the client unchanged in `PAYMENT-RESPONSE`, and the client scheme reads them in `schemeHooks.onPaymentResponse`. Unknown top-level fields are stripped. On a refused voucher, only `invalidReason` reaches the client, as `PaymentRequired.error`. `invalidMessage` and the verify `extra` are dropped, unless the server scheme re-emits them (pattern in §7).
6. A refused voucher is **not retried**: `paidFetch` resolves to the 402 `Response` (it doesn't throw). The wrapper makes exactly one more paid attempt, with a new `createPaymentPayload()` and no new 402, only if an `onPaymentResponse` hook returns `{recovered:true}`. That is how the client scheme can deposit and retry inside the stock wrapper.
7. 2.28.0 `SchemeNetworkServer` requires `defaultAssetTransferMethod` and `paymentFlows`. `x402Client` does not serialise concurrent payments: an `await` before the counter increment produced 3 vouchers with the same `cumulativeZat`. Settles also finish out of order.
8. Facilitator wire rules: always reply HTTP 200 with the full schema. `/settle` must always carry `transaction` and `network`. A 500 leaks its raw body into the client-visible `errorReason`, and a malformed 200 becomes a 502 at the API. The API process calls `exit(1)` at boot if `/supported` lacks the route's `(scheme, network)`.

## 1. Surprises (read these first)

| # | Surprise | Consequence for z402 | Evidence |
|---|---|---|---|
| S1 | `new x402Client()` has spend controls on by default (`spendControls = {}`). Only assets returned by the selected scheme's `findDefaultAsset()` pass, capped at `DEFAULT_MAX_AMOUNT_PER_PAYMENT = "$1"`. For any other asset `wrapFetchWithPayment` throws `Error("Failed to create payment payload: All payment requirements were rejected by spendControls: only default assets or entries in spendControls.allowedAssets are allowed. Add an allowedAssets entry for non-default tokens, set allowedAssets: true, or set spendControls: false.")` after 1 hop. | **Client scheme MUST implement `findDefaultAsset`** (returns `{asset:"ZEC",decimals:8,symbol:"ZEC"}` for `zcash:*`). The cap is then `"$1"` read as 1 ZEC = `"100000000"` zat per payment, which is passed to `createPaymentPayload` as `context.maxAmountPerPayment`. The alternatives `client.setSpendControls({allowedAssets:[{network:"zcash:testnet",asset:"ZEC"}]})` or `setSpendControls(false)` both work, but each adds a second line of agent code. | ran: `$SPIKE/logs-final/run.out` scenario `spendcontrols` (4 variants). src: `core/src/client/x402Client.ts:858-960` (`applySpendControls`), `:575` (`maxAmountPerPayment` context) |
| S2 | `SchemeNetworkServer` now has **required** `defaultAssetTransferMethod: string` and `paymentFlows: Record<atm, {supported, default}>`. A missing ATM makes route validation throw `RouteConfigurationError`. | Server scheme: `defaultAssetTransferMethod = "default"`, `paymentFlows = { default: { supported: ["authorization"], default: "authorization" } }`. `"default"` is SDK-only and is stripped from the wire. | src: `core/src/types/mechanisms.ts:246-337`, `server/paymentFlow.ts:9,94-109`; ran: `tsc` type-check |
| S3 | On `isValid:false`, the HTTP layer rebuilds the 402 with `error = verifyResult.invalidReason` **only**. `invalidMessage`, `VerifyResponse.extra` and `VerifyResponse.extensions` never reach the client. | Make `invalidReason` a machine code (`limit_exceeded` …). For richer state, use the WeakMap pattern in §7, or let the client recompute from its last `PAYMENT-RESPONSE`. | ran: scenario `main` seq#6-8; src: `http/x402HTTPResourceServer.ts:668-679` |
| S4 | Resource-server `onAfterVerify` hooks (manual and scheme) **fire for `isValid:false` too**. `onVerifyFailure` fires only when verify *throws* (500, malformed, 4xx, network). On the facilitator, `x402Facilitator.onVerifyFailure` fires for `isValid:false`, and `onAfterSettle` fires for a *returned* `success:false`. | Don't put "success-only" logic in `onAfterVerify` / `onAfterSettle` without checking `result.isValid` / `result.success`. | ran: hook counts in `$SPIKE/logs-final/server.jsonl`, `facilitator.jsonl` (7× rs.onAfterVerify with `limit_exceeded`; facilitator `onAfterSettle` with `mock_settle_rejected`); src: `x402ResourceServer.ts:1092`, `x402Facilitator.ts:351,466` |
| S5 | Settle failure **after** the handler ran: the Express middleware throws away the buffered body and sends `402`, body `{}`, `PAYMENT-RESPONSE` = the failure. Headers the handler set (e.g. its `ETag`) leak onto that 402. | The API handler must be side-effect-safe, or charge only what settles. The voucher for that call is not recorded, so the client must not count it (see §8). | ran: `main` seq#3 (`success:false`), seq#4 (500); src: `http/express/src/index.ts:388-410` |
| S6 | Facilitator error shapes decide what the client sees. A plain 500 gives `errorReason: "Facilitator settle failed (500): {\"error\":\"…\"}"` (raw body leak). A 200 missing `transaction` gives **HTTP 502** `{"error":"Facilitator settle returned invalid data: …"}`. The upstream example facilitator returns exactly that on abort (`examples/typescript/facilitator/basic/index.ts:219-223`). | Facilitator: always `200` + schema-complete JSON. Settle failures look like `{success:false, errorReason, errorMessage, transaction:"", network, payer}`. | ran: scenario `faults` (6 cases, §10); src: `httpFacilitatorClient.ts:165-206, 397-500` |
| S7 | `wrapFetchWithPayment` makes one paid attempt per 402. A scheme/client `onPaymentResponse` hook that returns `{recovered:true}` gets exactly one more attempt, built from the **original** 402. There is no second 402 hop, and a second `{recovered:true}` is ignored. | A refused voucher can be turned into a deposit-plus-retry inside the stock wrapper. Without the hook, the call simply fails (returns the 402). | ran: scenario `recovery` (3 hops, `createCalls` 4 for 3 calls); src: `http/fetch/src/index.ts:122-154` |
| S8 | `x402Client` does no locking. Three concurrent `paidFetch` calls run three `createPaymentPayload`s interleaved. With an `await` before the counter increment, all three sent `cumulativeZat:"1000"`. Facilitator order was verify(1000), settle(1000), verify(2000), verify(3000), settle(2000), settle(3000), and with the async gap the settles finished out of order (tx ids 20, 19, 21). | Client: bump the counter synchronously, or use a mutex. Facilitator: `/settle` must re-check and be monotonic per session, and must reject duplicates (§8). | ran: scenario `concurrent`; `$SPIKE/logs-final/timeline-concurrent.txt` |
| S9 | On startup the API (`paymentMiddleware`, `syncFacilitatorOnStart=true`) calls `GET /supported`. If the result lacks the route's `(scheme, network)` → `RouteConfigurationError` → **`process.exit(1)`**. If the facilitator is unreachable it logs `Failed to fetch supported kinds from facilitator: TypeError: fetch failed`, the first protected request returns `500 {"error":"Internal Server Error"}`, and the next request re-initialises. | Start the facilitator first. Scheme id and network strings must match exactly in all three places. `/supported` is read once per process, so facilitator `extra` changes need an API restart. | ran: `$SPIKE/logs-final/stub-startup.out`, `stub-facdown-startup.out`; src: `core/src/http/backgroundInit.ts:14-33`, `express/src/index.ts:119-146` |
| S10 | A value in `accepts[].extra` that changes on every 402 (e.g. a timestamp or nonce) breaks matching. The paid request gets `402 error:"No matching payment requirements"`, unless the key is listed in the server scheme's `dynamicExtraFields`. | Keep `extra` static: `windowZat`, `creditRatio`, `creditCapZat`. Do not put per-session state in requirements. | ran: scenario `dynamic`; src: `x402ResourceServer.ts:1516-1561, 2100-2120` |
| S11 | `"upfront"` flow (`extra.paymentFlow:"upfront"`): no `/verify` at all (the RS `onBeforeVerify` hooks still run). `/settle` runs *before* the handler. A handler 500 still returns `PAYMENT-RESPONSE success:true` (paid but not served). | Stay on `authorization` (the default; the client prefers it). If you ever use upfront, `/settle` must enforce the whole trust ramp. My mock enforced the limit only in verify, and upfront let 3000 > 2000 through. | ran: scenario `upfront`; src: `server/paymentFlow.ts:18-34` |
| S12 | Settle `errorReason:"settlement_pending"` together with a non-empty `transaction` makes the resource server **call `/settle` a second time** automatically. | Never use `settlement_pending` for "deposit unconfirmed". | src: `x402ResourceServer.ts:158, 1577-1600` |
| S13 | `HTTPFacilitatorClient` parses responses with zod `z.object` (non-strict). Unknown top-level keys are silently dropped (`sessionState` vanished). Kept: verify `{isValid, invalidReason, invalidMessage, payer, extensions, extra}`; settle `{success, errorReason, errorMessage, payer, transaction, network, amount, extensions, extra}`. | Put session state in `extra`, which is the canonical place: the official batch-settlement scheme uses `settleResponse.extra.channelState`. | ran: compare `facilitator.jsonl` `http.settle.response` and `server.jsonl` `facilitatorClient.settle.end`; src: `httpFacilitatorClient.ts:141-206` |

## 2. Setup, versions, commands

- Packages (exact, from `$SPIKE/package-lock.json`): `@x402/core 2.28.0`, `@x402/fetch 2.28.0`, `@x402/express 2.28.0` (pulls `@x402/extensions 2.28.0` → `viem 2.57.12`, `ajv`, `jose`…; the 4 runtime deps install 95 packages; node_modules incl. dev tools = 138 MB), `express 5.3.0`, `zod 3.25.76`, `tsx 4.23.15`, `typescript 5.9.3`, node v26.11.0. npm `latest` for all `@x402/*` is 2.28.0, published 2026-09-29. `@x402/paywall` is an *optional* peer of `@x402/express`; it is not needed.
- Source of truth: the npm sourcemaps' `sourcesContent` are byte-identical to the git tag `npm-@x402/core@v2.28.0` → commit `6b6ee91fee027b540faabcb25774e73851006c3b` (2026-09-29, repo `github.com/x402-foundation/x402`). All `file:line` cites below are `typescript/packages/<pkg>/src/...` at that commit. Repo HEAD `636f5856533e4124c6e733bc377652429952d1d6` (2026-10-27) has unreleased changes (e.g. `AfterSettleAbortError`, a settlement-failure body `{error:"settlement_failed"}`). **Pin `2.28.0` exactly.**
- `npm audit` flags `zod <4.6.6` (memory exhaustion on oversized collections) through all `@x402/*`. Not actionable for the MVP.
- Install: `npm install --ignore-scripts --save-exact @x402/core@2.28.0 @x402/fetch@2.28.0 @x402/express@2.28.0 express@5.3.0` and `npm i -D --ignore-scripts tsx@4.23.15 typescript@5.9.3 @types/express @types/node`. `tsx` works with `--ignore-scripts`. Install `@x402/core` explicitly (needed for `HTTPFacilitatorClient`, `x402Facilitator`, types; required under pnpm).
- Imports that work:
  - agent: `import { x402Client, wrapFetchWithPayment, x402HTTPClient, decodePaymentResponseHeader } from "@x402/fetch"`
  - API: `import { paymentMiddleware, x402ResourceServer } from "@x402/express"; import { HTTPFacilitatorClient } from "@x402/core/server"` (`@x402/express` does **not** re-export `HTTPFacilitatorClient`)
  - facilitator: `import { x402Facilitator } from "@x402/core/facilitator"`
  - types: `import type { SchemeNetworkClient, SchemeNetworkServer, SchemeNetworkFacilitator, … } from "@x402/core/types"`; `import type { SettleResultContext } from "@x402/core/server"`
- tsconfig that type-checks: `"module":"ESNext","moduleResolution":"Bundler","strict":true`, package `"type":"module"`. `NodeNext` needs `.js` suffixes on relative imports.
- Run the spike: `cd $SPIKE && ./run.sh` (all scenarios), `./run.sh main`, `./run.sh --facdown`, `LOG_OFF=1 LAT_N=150 ./run.sh latency`, `node tools/timeline.mjs logs --scenario=main [--full]`. Evidence for this file: `$SPIKE/logs-final/` (`run.out`, `agent|server|server-scheme|client-scheme|facilitator.jsonl`, `timeline-*.txt`).
- Topology: agent → API `127.0.0.1:4021` (`GET /chunk`) → facilitator `127.0.0.1:4402` (`POST /verify`, `POST /settle`, `GET /supported`), with the facilitator in its own process and Express app. Network `zcash:testnet`, scheme `mockstream`, price `{amount:"1000", asset:"ZEC"}`, `payTo:"utest1mockmerchantshieldedonlyunifiedaddress"`, `maxTimeoutSeconds:60`. The facilitator accepts while `cumulativeZat <= 5000`.

## 3. Q1 — HTTP round trips per paid call; caching

- **Every** paid call: (1) `GET /chunk`, no payment headers → `402` with `PAYMENT-REQUIRED`; (2) `GET /chunk` with `PAYMENT-SIGNATURE` → API → `POST /verify` → handler → `POST /settle` → `200` with `PAYMENT-RESPONSE`. `hops:2` for all 8 sequential calls of every scenario. (ran: `logs-final/run.out`; src: `http/fetch/src/index.ts:46-155`)
- **No caching** of requirements: the client caches nothing (the wrapper always sends the original request first), and the API rebuilds requirements on *both* passes (`parsePrice` → `enhancePaymentRequirements` → `enrichPaymentRequiredResponse` run twice per call, see §5 timeline). The 402 carries `Cache-Control: no-store`. A successful paid response gets `Cache-Control: private`. (src: `x402HTTPResourceServer.ts:1358-1364`, `express/src/index.ts:416-423`)
- `/supported` is called once per `x402ResourceServer` at API start (3 resource servers in the spike → 3 calls), not per request.
- A recovery retry (S7) adds 1 client hop plus `/verify` + `/settle` (3 client hops in total). With the `upfront` flow there is 1 facilitator call (no `/verify`).
- With the stock wrapper, the initial 402 cannot be skipped. If the agent pre-sets `PAYMENT-SIGNATURE` itself, the wrapper throws `"Payment already attempted"` on the next 402, and does so *after* calling `createPaymentPayload` (`fetch/src/index.ts:98,109-110`).

## 4. Q2 — exact bytes on every hop (from `logs-final`, call `main` seq#1)

### 4.1 Hop 1 response: `402`
Headers: `content-type: application/json; charset=utf-8`, `cache-control: no-store`, `payment-required: <544 b64 chars>`. Body: `{}` (overridable with route `unpaidResponseBody`). Decoded `PAYMENT-REQUIRED`:
```json
{
  "x402Version": 2,
  "error": "Payment required",
  "resource": { "url": "http://127.0.0.1:4021/chunk", "description": "one chunk", "mimeType": "application/json" },
  "accepts": [{
    "scheme": "mockstream", "network": "zcash:testnet", "amount": "1000", "asset": "ZEC",
    "payTo": "utest1mockmerchantshieldedonlyunifiedaddress", "maxTimeoutSeconds": 60,
    "extra": { "creditRatio": 0.25, "windowZat": 100000, "creditCapZat": 200000, "quoteVersion": 1 }
  }]
}
```
There is no `extensions` key (the route declares none). `resource.url` = `${req.protocol}://${host}${req.originalUrl}`, query string included (`express/src/adapter.ts:49-51`).

### 4.2 Hop 2 request: headers `payment-signature: <672 b64 chars>` and `access-control-expose-headers: PAYMENT-RESPONSE,X-PAYMENT-RESPONSE` (the wrapper sends this as a *request* header; harmless). Decoded `PAYMENT-SIGNATURE` (key order exactly as sent):
```json
{
  "x402Version": 2,
  "payload": { "sessionKey": "1d4577546dcd4059f154fd963b41916014c64c41e4e8e5a68b542601804ba03f", "cumulativeZat": "1000", "sig": "x" },
  "resource": { "url": "http://127.0.0.1:4021/chunk", "description": "one chunk", "mimeType": "application/json" },
  "accepted": { "scheme": "mockstream", "network": "zcash:testnet", "amount": "1000", "asset": "ZEC",
    "payTo": "utest1mockmerchantshieldedonlyunifiedaddress", "maxTimeoutSeconds": 60,
    "extra": { "creditRatio": 0.25, "windowZat": 100000, "creditCapZat": 200000, "quoteVersion": 1 } }
}
```
`extensions` is **absent** here: `mergeExtensions(undefined, undefined)` drops it. `accepted` is the selected 402 entry, byte-for-byte. (src: `x402Client.ts:537-600`)

### 4.3 API → facilitator `POST /verify` and `POST /settle`: identical bodies (`content-type: application/json`, no auth headers unless `createAuthHeaders` is set; 805 bytes here):
```json
{
  "x402Version": 2,
  "paymentPayload": { "...": "the full PAYMENT-SIGNATURE envelope above, unchanged" },
  "paymentRequirements": { "scheme": "mockstream", "network": "zcash:testnet", "amount": "1000", "asset": "ZEC",
    "payTo": "utest1mockmerchantshieldedonlyunifiedaddress", "maxTimeoutSeconds": 60,
    "extra": { "creditRatio": 0.25, "windowZat": 100000, "creditCapZat": 200000, "quoteVersion": 1 } }
}
```
`paymentRequirements` is the **API's freshly rebuilt** requirement that matched `accepted`, not the client's copy. (src: `httpFacilitatorClient.ts:397-445`; `x402HTTPResourceServer.ts:617-660`)

### 4.4 Facilitator replies (as sent by the spike) and what the API keeps
- verify OK: `{"isValid":true,"payer":"<sessionKey>","extra":{"limitZat":5000,"cumulativeZat":"1000","from":"verify.extra"}}`
- verify refused: `{"isValid":false,"invalidReason":"limit_exceeded","invalidMessage":"cumulativeZat 6000 exceeds limit 5000","payer":"<sessionKey>","extra":{…},"extensions":{"z402-session":{…}}}`
- settle OK (raw): `{"success":true,"payer":"<sessionKey>","transaction":"mock-tx-4","network":"zcash:testnet","amount":"1000","extra":{"limitZat":5000,"confirmedZat":0,"cumulativeZat":"1000","from":"settle.extra"},"extensions":{"z402-session":{"limitZat":5000,"from":"settle.extensions"}},"sessionState":{…}}`. After the API's zod parse, `sessionState` is **gone**; everything else is intact.

### 4.5 Hop 2 response: `200`, headers `cache-control: private`, `payment-response: <480 b64 chars>`, body = the handler's JSON. Decoded `PAYMENT-RESPONSE`:
```json
{
  "success": true, "payer": "1d4577546dcd4059f154fd963b41916014c64c41e4e8e5a68b542601804ba03f",
  "transaction": "mock-tx-4", "network": "zcash:testnet", "amount": "1000",
  "extensions": { "z402-session": { "limitZat": 5000, "from": "settle.extensions" } },
  "extra": { "limitZat": 5000, "confirmedZat": 0, "cumulativeZat": "1000", "from": "settle.extra", "serverEnrichedAt": "resource-server" }
}
```
`serverEnrichedAt` was added by the server scheme's `enrichSettlementResponse`, which may only **add** keys: an existing key throws, and core catches the throw and turns it into a warning. `extensionResponses` is stripped before encoding. (src: `http/index.ts:63-68`, `x402ResourceServer.ts:1724-1770`, `hookPolicy.ts` `assertAdditiveSettlementExtra`)

### 4.6 Failure variants (decoded)
- Settle returned `success:false` → `402`, body `{}`, `cache-control: no-store`, `PAYMENT-RESPONSE`:
  `{"success":false,"errorReason":"mock_settle_rejected","errorMessage":"settle refused at cumulativeZat=3000","payer":"<sessionKey>","transaction":"","network":"zcash:testnet","extra":{"limitZat":5000,"confirmedZat":0,"from":"settle.extra(failure)"}}` (the failure `extra` *does* survive).
- Settle 500 `{"error":"mock settle exploded…"}` → `402`, `PAYMENT-RESPONSE`: `{"success":false,"errorReason":"Facilitator settle failed (500): {\"error\":\"mock settle exploded at cumulativeZat=4000\"}","errorMessage":"<same>","network":"zcash:testnet","transaction":""}`
- Verify refused → `402`, body `{}`, **no** `PAYMENT-RESPONSE`, `PAYMENT-REQUIRED`: `{"x402Version":2,"error":"limit_exceeded","resource":{…},"accepts":[{…same terms…,"extra":{"creditRatio":0.25,"windowZat":100000,"creditCapZat":200000,"quoteVersion":1,"session":{"limitZat":5000,"cumulativeZat":"6000","from":"verify.extra"}}}]}`. The `session` key appears only because of the §7 WeakMap pattern; without it, `extra` is identical to the first 402.

## 5. Q3 — ordering and timing (authorization flow)

Merged timeline of `main` seq#1 (`$SPIKE/logs-final/order-seq1.txt`; ms since scenario start, read top to bottom; processes were freshly started, so cross-process clock skew is <0.3 ms. Note: long-running processes drifted ~10 ms apart in an earlier run, so restart them before trusting cross-process order):
```
0.61 agent         hop.request (no payment headers)
0.80 server        http.in
0.85 server-scheme parsePrice
0.89 server-scheme enhancePaymentRequirements
0.93 server-scheme enrichPaymentRequiredResponse   (error:"Payment required", no paymentPayload)
1.06 server        http.out 402
1.16 agent         hop.response 402
1.22 client-scheme findDefaultAsset x2             (spend-control filter)
1.29 client-scheme schemeHooks.onBeforePaymentCreation
1.32 client-scheme findDefaultAsset                (cap -> context.maxAmountPerPayment)
1.35 client-scheme createPaymentPayload
1.39 agent         client.onAfterPaymentCreation (manual hook), 1.41 scheme hook
1.48 agent         hop.request (PAYMENT-SIGNATURE)
1.68 server        http.in
1.75-1.82          server-scheme parsePrice / enhance / enrich again (requirements rebuilt; error undefined)
1.86 server        rs.onBeforeVerify, 1.88 scheme hook
1.91 server        facilitatorClient.verify.start
2.24 facilitator   http.verify.request -> 2.33 scheme.verify -> 2.37 http.verify.response
2.63 server        facilitatorClient.verify.end
2.67 server        rs.onAfterVerify, 2.70 scheme hook
2.76 server        handler.start
2.81 server        handler.end (res.json() buffered by the middleware)
2.85 server        rs.onBeforeSettle (phase "after-handler"), 2.88 scheme hook
2.90 server        facilitatorClient.settle.start
3.21 facilitator   http.settle.request -> 3.29 scheme.settle -> 3.35 http.settle.response
3.57 server        facilitatorClient.settle.end
3.63 server        rs.onAfterSettle, 3.65 scheme hook, 3.69 scheme enrichSettlementResponse
3.81 server        http.out 200 (buffered response flushed with PAYMENT-RESPONSE)
3.95 agent         hop.response 200
4.01 agent         client.onPaymentResponse (manual), 4.04 client-scheme schemeHooks.onPaymentResponse
```
- **verify before the handler, settle after it: yes.** The handler runs only when `isValid:true` (`x402HTTPResourceServer.ts:668-708`).
- **The response is held until settle returns: yes.** In the `hold` scenario the facilitator delayed `/settle` by 500 ms. The handler ended at +2.11 ms, `settle.end` came at +507.74 ms, and the API flushed at +508.96 ms; the client measured 509.81 ms. The middleware buffers `writeHead/write/end/flushHeaders` and waits for `res.end()` before settling (`express/src/index.ts:248-337`).
- **Handler status ≥ 400 (authorization flow):** no settle, `onVerifiedPaymentCanceled(reason:"handler_failed")`, the 500 passes through to the client with no `PAYMENT-RESPONSE`, and the client sees `paymentStatus:"none"` (`express/src/index.ts:340-371`; ran `handlerfail`). The voucher for that call is never settled.
- **Settle returns `success:false`:** `rs.onSettleFailure` runs, and the buffered body is discarded → `402` + failure `PAYMENT-RESPONSE` (ran `main` seq#3). **Settle throws** (facilitator HTTP 500 → `Error`) → same, with `errorReason` = the error message (ran `main` seq#4). The chunk counter shows both handlers ran (chunks 6 and 7 were produced and discarded). A non-`FacilitatorResponseError` exception during settlement → `res.status(402).json({})` (`express/src/index.ts:424-434`). A `FacilitatorResponseError` → `502 {"error": msg}`.
- Hook order is manual hooks first, then the selected scheme's hook, then the extension hooks (`x402Client.ts` `getLabeledHooks`; seen in the timeline above).

## 6. Q4 — verify failure (`cumulativeZat > 5000`)

From `main` seq#6-8 and conc#1-3:
- `paidFetch` **does not throw**. It resolves to the second response: `status 402`, body `{}`, `PAYMENT-REQUIRED.error = "limit_exceeded"`. `hops:2`. **No automatic retry**: `createPaymentPayload` ran once per call (`createCalls: 11` for 11 calls).
- What reaches agent code: `Response.status === 402` plus the `PAYMENT-REQUIRED` header. `await new x402HTTPClient(client).processResponse(res)` → `{status:402, paymentStatus:"payment_required", body:{}, header:{…PaymentRequired, error:"limit_exceeded"}}`. `invalidMessage` is not delivered.
- What reaches the client scheme: `schemeHooks.onPaymentResponse(ctx)` with `ctx.paymentRequired` (the *new* 402, `error:"limit_exceeded"`), `ctx.paymentPayload` (what was sent) and `ctx.requirements` (`= paymentPayload.accepted`), and no `ctx.settleResponse`.
- `invalidMessage` reaches the client only when the facilitator answers **non-2xx with a JSON body containing `isValid`**. That path throws `VerifyError`, and the 402's `error` becomes `"<invalidReason>: <invalidMessage>"` (ran `faults`: HTTP 400 → `error:"bad_sig: signature check failed"`). Not recommended: it routes through `onVerifyFailure` and couples you to error strings.
- Recovery (scenario `recovery`, limit 2000, deposit raises it by 100000): rec#3 sent `cumulativeZat:"3000"` → 402 `limit_exceeded` → the scheme hook set `pendingDepositTxid` and returned `{recovered:true}`. The wrapper immediately called `createPaymentPayload` again with the **first** 402's `PaymentRequired` (callNo 4, `depositTxid` attached) and sent it directly (hop 66, no new 402) → verify OK at the new limit → settle → 200. Total `hops:3`, `createCalls:4` for 3 calls. The client hook saw `paymentRequired.accepts[0].extra.session = {"limitZat":2000,"cumulativeZat":"3000",…}`.

## 7. Q5 — observing the settle result

All four ways work (ran: every scenario logs both hooks; `decodedViaHelperEqual:true` in `run.out`):
```ts
// (a) inside the client scheme: no agent-code change (this is what z402 should use)
readonly schemeHooks: SchemeClientHooks = {
  onPaymentResponse: async ctx => {
    if (ctx.settleResponse?.success) this.applyServerState(ctx.settleResponse.extra);   // e.g. {cumulativeZat, limitZat, confirmedZat}
    else if (ctx.settleResponse) { /* settle failed: voucher not recorded */ }
    else if (ctx.paymentRequired) {                                                     // verify refused
      if (ctx.paymentRequired.error === "limit_exceeded" && (await this.depositNow())) return { recovered: true };
    }
    // neither: handler >=400, 502, transport issue: voucher not recorded
  },
};
// (b) agent level
client.onPaymentResponse(async ctx => console.log(ctx.settleResponse ?? ctx.paymentRequired?.error));
// (c) after the call
const res = await paidFetch(url);
const settle = decodePaymentResponseHeader(res.headers.get("PAYMENT-RESPONSE")!);           // from "@x402/fetch"
// (d) helper
const r = await new x402HTTPClient(client).processResponse(res); // {status, paymentStatus:"settled"|"settle_failed"|"payment_required"|"none", body, header}
```
`onAfterPaymentCreation` / `onBeforePaymentCreation` run *before* the request, so they cannot see the result. `PaymentResponseContext` = `{ paymentPayload, requirements, settleResponse?, paymentRequired?, error? }` (`x402Client.ts:62-68`; `processPaymentResult` in `x402HTTPClient.ts:184-223`).

**Getting a refused verify's state to the client (optional; the official `batch-settlement` EVM scheme uses this pattern, `mechanisms/evm/src/batch-settlement/server/verify.ts:193-251`):** the server scheme stores `ctx.result.extra` in a `WeakMap` keyed by `ctx.paymentPayload` inside `schemeHooks.onAfterVerify`. Core then calls `enrichPaymentRequiredResponse(ctx)` with `ctx.error = invalidReason` and the **same** `ctx.paymentPayload` object. The scheme adds a new key there (additive only, enforced by `assertAcceptsAdditiveExtraAfterSchemeEnrich`). It worked, including under concurrency (each 402 carried its own payload's state). On the success pass, `enrichPaymentRequiredResponse` is called with `error: undefined` and `paymentPayload: undefined`.

## 8. Q8 — concurrency (what the facilitator sees)

- Synchronous `cumulative += amount` in `createPaymentPayload`: three concurrent calls → vouchers 1000/2000/3000. Facilitator order in the fresh run: verify(1000), settle(1000), verify(2000), verify(3000), settle(2000), settle(3000). Another run gave verify×3 then settle×3. **Verifies of later vouchers run before earlier ones settle.**
- `await` (20 ms) before reading and incrementing: **three vouchers with `cumulativeZat:"1000"`**, all verified, all settled (my mock doesn't enforce growth), and the settle responses came back out of order (tx ids 20, 19, 21).
- Implications. The facilitator must assume nothing about order. `/verify` checks against the last *settled* state. `/settle` re-checks atomically, with no `await` between read and write. Suggested rule: accept when `c_new >= c_last + p` and `c_new <= limit`, then set `c_last = c_new`; reject `c_new <= c_last` as `stale_voucher`. The client scheme serialises (a promise-chain mutex around voucher creation) or at least bumps synchronously, and resyncs `c_last` from `PAYMENT-RESPONSE.extra.cumulativeZat`. The spec's 150-call demo is sequential, so this only matters for robustness.

## 9. Q6 — does `zcash:testnet` pass every SDK check?

Yes, with zero warnings: `server.stdout` and `facilitator.stdout` are 0 bytes, and `run.out` has no `[x402]`/warn lines. It passed `x402Client.register`, `x402ResourceServer.register`, `x402Facilitator.register`, route validation at construction and initialize, the `HTTPFacilitatorClient` zod schemas (network is just `typeof value === "string"`), `NetworkSchemaV2` (`min(3)` + contains `:`), and `PaymentRequirementsSchema`/`PaymentRequiredSchema`/`PaymentPayloadSchema` (ran `$SPIKE/tools/check-network.ts` → all `true`). The `Network` type is `` `${string}:${string}` ``. It also matches CAIP-2 syntax `^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$`. Whether `zcash` is a *registered* CAIP-2 namespace was not checked here; the upstream precedent `lnbtc:<first 32 hex of genesis hash>` follows BIP-122 (`specs/schemes/exact/scheme_exact_lnbtc.md`). Network matching is exact or by wildcard (`zcash:*`) in `findSchemesByNetwork` (`core/src/utils/index.ts:118-153`). The facilitator's `caipFamily` (`"zcash:*"`) only groups `signers` in `/supported`.

## 10. Q7 — latency on localhost (Apple M5, arm64, 10 cores, node 26.11.0, HTTP keep-alive)

| Run | Median paid call | Notes |
|---|---|---|
| `LOG_OFF=1`, 8 calls after 1 warm-up, ×3 runs | 1.99 / 2.10 / 1.92 ms | free route `/free`: 0.23 ms |
| `LOG_OFF=1 LAT_N=150` back to back | 1.06 ms (p90 1.49, max 2.84; 150 calls in 169.9 ms) | JIT warm |
| full JSONL logging | 2.90 ms | per-hop breakdown below |

Breakdown (with logging, medians): 402 hop 0.43 ms; paid hop 2.01 ms, of which API-side 1.74 ms = `/verify` round trip 0.56 + `/settle` round trip 0.51 + rebuilding requirements, hooks and base64/zod ≈ 0.67; client payload and hook time ≈ 0.3 ms. **The four sequential HTTP exchanges dominate.** In z402, ed25519 verification (~0.1 ms) won't matter. The real costs will be the client↔API RTT (×2 per call) and, on deposit calls only, the lightwalletd fetch, the trial decryption and the 15 s mempool retry inside `/verify` (`HTTPFacilitatorClient` default timeout is 90 000 ms; `FacilitatorConfig.timeoutMs` overrides it).

## 11. Where `extra` can come from (all reached the client unchanged, types preserved)

| Key | Injected by | Reached 402 + `accepted` + facilitator `paymentRequirements` |
|---|---|---|
| `creditRatio: 0.25` | route `price: {amount, asset, extra}` → scheme `parsePrice` returns `extra` | yes |
| `windowZat: 100000` | route `accepts.extra` | yes (merged after parsePrice's, so it wins on a key clash: `extra: {...parsedPrice.extra, ...resourceConfig.extra}`) |
| `creditCapZat: 200000` | facilitator `getExtra(network)` → `/supported` `kinds[].extra` → **copied by the server scheme** in `enhancePaymentRequirements(req, supportedKind, exts)` | yes (core does NOT auto-merge `supportedKind.extra`) |
| `quoteVersion: 1` | server scheme `enrichPaymentRequiredResponse` (additive only) | yes (static values only, see S10) |

Source order: `x402ResourceServer.ts:761-834` (`buildPaymentRequirements`) → `createPaymentRequiredResponse:890-1000`. Suggested placement: the facilitator owns `{windowZat, creditRatio, creditCapZat}` (it enforces the ramp), advertises them via `getExtra`, and the server scheme copies them in `enhancePaymentRequirements`. One source of truth; the facilitator also sees them back in every `/verify` `paymentRequirements.extra` and can cross-check. Route `extra` works just as well if you prefer config at the API.

## 12. Facilitator response → what the client sees (scenario `faults`, `facdown`, `main`)

| Facilitator does | API returns to client | Client `paymentStatus` / info |
|---|---|---|
| `/verify` 200 `{isValid:false, invalidReason:"limit_exceeded",…}` | 402, `PAYMENT-REQUIRED.error:"limit_exceeded"` | `payment_required` |
| `/verify` 500 `{error:"mock verify exploded"}` | 402, `error:"Facilitator verify failed (500): {\"error\":\"mock verify exploded\"}"` | `payment_required` (raw leak) |
| `/verify` 400 `{isValid:false, invalidReason:"bad_sig", invalidMessage:"signature check failed"}` | 402, `error:"bad_sig: signature check failed"` | `payment_required` |
| `/verify` 200 malformed `{valid:true}` | **502** `{"error":"Facilitator verify returned invalid data: {\"valid\":true}"}` | `none` |
| facilitator down (ECONNREFUSED) | 402, `error:"fetch failed"` | `payment_required` |
| `/settle` 200 `{success:false, errorReason, transaction:"", network}` | 402, `PAYMENT-RESPONSE{success:false, errorReason,…}` (handler output discarded) | `settle_failed` |
| `/settle` 500 SettleResponse-shaped `{success:false, errorReason:"ledger_unavailable", transaction:"", network}` | 402, `PAYMENT-RESPONSE{errorReason:"ledger_unavailable"}` | `settle_failed` |
| `/settle` 500 `{error:"…"}` | 402, `errorReason:"Facilitator settle failed (500): …"` | `settle_failed` (raw leak) |
| `/settle` 200 **without `transaction`** | **502** `{"error":"Facilitator settle returned invalid data: …"}` | `none` |

## 13. Exact 2.28.0 types (published `dist/esm/x402Client-C7_OogbK.d.mts`, same as `core/src/types/*.ts`)

```ts
type Network = `${string}:${string}`;
type PaymentRequirements = { scheme: string; network: Network; asset: string; amount: string; payTo: string; maxTimeoutSeconds: number; extra: Record<string, unknown> };
type PaymentRequired = { x402Version: number; error?: string; resource: ResourceInfo; accepts: PaymentRequirements[]; extensions?: Record<string, unknown> };
type PaymentPayload = { x402Version: number; resource?: ResourceInfo; accepted: PaymentRequirements; payload: Record<string, unknown>; extensions?: Record<string, unknown> };
type VerifyResponse = { isValid: boolean; invalidReason?: string; invalidMessage?: string; payer?: string; extensions?: Record<string, unknown>; extensionResponses?: Record<string, unknown>; extra?: Record<string, unknown> };
type SettleResponse = { success: boolean; errorReason?: string; errorMessage?: string; payer?: string; transaction: string; network: Network; amount?: string; extensions?: Record<string, unknown>; extensionResponses?: Record<string, unknown>; extra?: Record<string, unknown> };
type SupportedKind = { x402Version: number; scheme: string; network: Network; extra?: Record<string, unknown> };
type SupportedResponse = { kinds: SupportedKind[]; extensions: string[]; signers: Record<string, string[]> };
type PaymentPayloadResult = { x402Version: number; payload: Record<string, unknown>; extensions?: Record<string, unknown> };
interface PaymentPayloadContext { extensions?: Record<string, unknown>; maxAmountPerPayment?: string }
interface DefaultAsset { asset: string; decimals: number; symbol: string }

interface SchemeNetworkClient {
  readonly scheme: string;
  readonly schemeHooks?: SchemeClientHooks;   // { onBeforePaymentCreation?, onAfterPaymentCreation?, onPaymentCreationFailure?, onPaymentResponse? }
  findDefaultAsset?: (asset: string, network: Network) => DefaultAsset | undefined;
  createPaymentPayload(x402Version: number, paymentRequirements: PaymentRequirements, context?: PaymentPayloadContext): Promise<PaymentPayloadResult>;
}
interface SchemeNetworkServer {
  readonly scheme: string;
  readonly defaultAssetTransferMethod: string;
  readonly paymentFlows: Readonly<Record<string, { readonly supported: readonly ("authorization"|"upfront"|"escrow")[]; readonly default: "authorization"|"upfront"|"escrow" }>>;
  readonly schemeHooks?: SchemeServerHooks;   // onBeforeVerify/onAfterVerify/onVerifyFailure/onBeforeSettle/onAfterSettle/onSettleFailure/onVerifiedPaymentCanceled
  readonly dynamicExtraFields?: string[];
  enrichPaymentRequiredResponse?: (ctx: SchemePaymentRequiredContext) => Promise<PaymentRequirements[] | void>;
  enrichSettlementPayload?: (ctx: SettleContext) => Promise<Record<string, unknown> | void>;
  enrichSettlementResponse?: (ctx: SettleResultContext) => Promise<Record<string, unknown> | void>;
  settleOnCancel?(context: VerifiedPaymentCanceledContext): PaymentRequirements | void | Promise<PaymentRequirements | void>;
  parsePrice(price: Price, network: Network): Promise<AssetAmount>;             // Price = string | number | { asset; amount; extra? }
  getAssetDecimals?(asset: string, network: Network): number | undefined;
  enhancePaymentRequirements(paymentRequirements: PaymentRequirements, supportedKind: SupportedKind, facilitatorExtensions: string[]): Promise<PaymentRequirements>;
  validateFacilitatorSupport?(network: Network, supportedKind: SupportedKind, facilitatorExtensions: string[]): string | void;
}
interface SchemeNetworkFacilitator {
  readonly scheme: string;
  readonly caipFamily: string;                                                 // e.g. "zcash:*"
  getExtra(network: Network): Record<string, unknown> | undefined;              // → /supported kinds[].extra
  getSigners(network: string): string[];                                        // → /supported signers[caipFamily]
  verify(payload: PaymentPayload, requirements: PaymentRequirements, context?: FacilitatorContext): Promise<VerifyResponse>;
  settle(payload: PaymentPayload, requirements: PaymentRequirements, context?: FacilitatorContext): Promise<SettleResponse>;
}
// x402Facilitator: register(networks: Network | Network[], f): this; getSupported(); verify(payload, req); settle(payload, req);
//   hooks onBeforeVerify/onAfterVerify/onVerifyFailure/onBeforeSettle/onAfterSettle/onSettleFailure. A beforeSettle abort THROWS Error("Settlement aborted: <reason>").
//   It looks up the scheme by paymentPayload.x402Version + paymentRequirements.scheme/network. It does NOT compare payload.accepted with requirements (the API already did, see S10).
```

## 14. Minimal code that worked (trimmed from `$SPIKE/src`; `npx tsc` clean against 2.28.0)

The verify/settle/supported routing, scheme shapes and wiring below ran in the spike. The `catch` branches and the `ZcashStream*` bodies are the recommended production form derived from §12; the spike's own catch branches returned 500 on purpose to test faults.
```ts
// imports: express; { x402Facilitator } from "@x402/core/facilitator"; { paymentMiddleware, x402ResourceServer } from "@x402/express";
//          { HTTPFacilitatorClient } from "@x402/core/server"; type { PaymentResponseContext } from "@x402/core/client";
//          type { AssetAmount, Network, PaymentFlowConfig, PaymentRequirements, Price, SchemeNetworkClient, SchemeNetworkServer, SupportedKind } from "@x402/core/types"
// facilitator.ts: own process and port, merchant side
const facilitator = new x402Facilitator();
facilitator.register("zcash:testnet", new ZcashStreamFacilitator(/* ivk, lightwalletd, sessions */));
const app = express(); app.use(express.json({ limit: "1mb" }));
app.post("/verify", async (req, res) => {
  try { res.json(await facilitator.verify(req.body.paymentPayload, req.body.paymentRequirements)); }        // ALWAYS 200
  catch (e) { res.json({ isValid: false, invalidReason: "unexpected_verify_error", invalidMessage: String(e) }); }
});
app.post("/settle", async (req, res) => {
  const network = req.body?.paymentRequirements?.network ?? "zcash:testnet";
  try { res.json(await facilitator.settle(req.body.paymentPayload, req.body.paymentRequirements)); }
  catch (e) { res.json({ success: false, errorReason: "unexpected_settle_error", errorMessage: String(e), transaction: "", network }); }
});
app.get("/supported", (_req, res) => res.json(facilitator.getSupported()));
// → {"kinds":[{"x402Version":2,"scheme":"<id>","network":"zcash:testnet","extra":{…getExtra…}}],"extensions":[],"signers":{"zcash:*":[]}}

// server scheme (API)
class ZcashStreamServer implements SchemeNetworkServer {
  readonly scheme = "<id>"; readonly defaultAssetTransferMethod = "default";
  readonly paymentFlows = { default: { supported: ["authorization"], default: "authorization" } } as const satisfies Record<string, PaymentFlowConfig>;
  async parsePrice(price: Price, network: Network): Promise<AssetAmount> {
    if (typeof price === "object" && price && "amount" in price) return { amount: price.amount, asset: price.asset, extra: { ...(price.extra ?? {}) } };
    throw new Error("price must be { amount: <zatoshi string>, asset: \"ZEC\" }");             // no USD in MVP
  }
  async enhancePaymentRequirements(r: PaymentRequirements, kind: SupportedKind) {
    const { windowZat, creditRatio, creditCapZat } = kind.extra ?? {};
    return { ...r, extra: { ...r.extra, windowZat, creditRatio, creditCapZat } };
  }
}
// API wiring
const rs = new x402ResourceServer(new HTTPFacilitatorClient({ url: "http://127.0.0.1:4402" })).register("zcash:testnet", new ZcashStreamServer());
app.use(paymentMiddleware({ "GET /chunk": { accepts: { scheme: "<id>", network: "zcash:testnet", payTo: MERCHANT_UA,
  price: { amount: "1000", asset: "ZEC" }, maxTimeoutSeconds: 60 }, description: "one chunk", mimeType: "application/json" } }, rs));
app.get("/chunk", (_req, res) => res.json({ chunk: n++ }));

// client scheme essentials
class ZcashStreamClient implements SchemeNetworkClient {
  readonly scheme = "<id>";
  findDefaultAsset = (asset: string, network: Network) => asset === "ZEC" && network.startsWith("zcash:") ? { asset: "ZEC", decimals: 8, symbol: "ZEC" } : undefined; // REQUIRED (S1)
  readonly schemeHooks = { onPaymentResponse: async (ctx: PaymentResponseContext) => { /* §7 (a) */ } };
  async createPaymentPayload(x402Version: number, req: PaymentRequirements) {
    const c = (this.lastServerCumulative + BigInt(req.amount)).toString();   // compute synchronously (S8)
    return { x402Version, payload: { sessionKey: this.pubHex, cumulativeZat: c, sig: this.sign(req.payTo, c), ...(this.depositTxid ? { depositTxid: this.depositTxid } : {}) } };
  }
}
```

## 15. Wire-contract recommendations for the two build agents (inferred from the observed behaviour)

1. **Requirements `extra`** (static): `{ windowZat: number, creditRatio: number, creditCapZat: number }`. Do not add `paymentFlow` (it would make the flow `upfront`/`escrow`) or `assetTransferMethod`. Do not add per-request or per-session values (S10).
2. **Payload**: as in the MVP doc: `{ sessionKey, cumulativeZat: "<decimal string>", sig, depositTxid? }`. Strings for zat amounts (JSON-safe; the SDK never coerces payload values).
3. **`/verify`**: HTTP 200 always. `{ isValid, invalidReason?: snake_case code, invalidMessage?, payer: sessionKey, extra?: {…} }`. The client gets `invalidReason` only. Pick a closed set of codes, e.g. `limit_exceeded`, `invalid_signature`, `cumulative_not_increased`, `deposit_not_found`, `deposit_invalid`, `invalid_payload` (proposal). Read-only: no session writes (a txid→decryption cache is fine). The handler may not run, and `/settle` may never come (handler ≥400).
4. **`/settle`**: HTTP 200 always. Re-run the checks (state may have moved since verify) and record atomically. Success: `{ success:true, transaction:<depositTxid on deposit calls, else a non-empty voucher id>, network:"zcash:testnet", payer:sessionKey, amount:<requirements.amount>, extra:{ cumulativeZat, limitZat, confirmedZat, pendingZat, … } }`. Failure: `{ success:false, errorReason, errorMessage, transaction:"", network, payer, extra? }`. Never `settlement_pending` (S12).
5. **Client state machine**: treat a call as paid only when `PAYMENT-RESPONSE.success === true`, and take `c_last` from `settleResponse.extra.cumulativeZat`. Keep re-sending `depositTxid` until a successful `PAYMENT-RESPONSE` acknowledges the deposit: if that call's handler fails or its settle fails, the deposit was never recorded. A refused voucher arrives as a 402 with `error:"limit_exceeded"`; the scheme may deposit and return `{recovered:true}` once.
6. **Startup order**: facilitator first, then the API (S9). Use identical scheme id and network strings in all three registrations.

## 16. Open questions (not answered by this spike)

- Scheme id (free-form string; no SDK constraint observed) and whether `zcash` is a registered CAIP-2 namespace (BIP-122-style `zcash:<genesis-prefix>` would follow the `lnbtc` precedent).
- Whether the facilitator should accept a stale or out-of-order settle as "already covered" (serve) or reject it (402 after the handler ran). The demo is sequential, so this is for robustness only.
- How long a real deposit `createPaymentPayload` (zingo-cli send + proving) blocks the paid request. The SDK imposes no client-side timeout; the API→facilitator timeout is 90 s.

## Sources

- x402 repo `github.com/x402-foundation/x402`, tag `npm-@x402/core@v2.28.0` = commit `6b6ee91fee027b540faabcb25774e73851006c3b` (2026-09-29). Files: `typescript/packages/core/src/{client/x402Client.ts, http/x402HTTPClient.ts, http/x402HTTPResourceServer.ts, http/httpFacilitatorClient.ts, http/index.ts, http/backgroundInit.ts, server/x402ResourceServer.ts, server/paymentFlow.ts, server/hookPolicy.ts, facilitator/x402Facilitator.ts, types/{mechanisms,facilitator,payments,index}.ts, utils/index.ts, schemas/index.ts}`, `typescript/packages/http/{fetch,express}/src/index.ts`, `typescript/packages/mechanisms/evm/src/batch-settlement/{client/hooks.ts,server/verify.ts,server/scheme.ts}`, `examples/typescript/facilitator/basic/index.ts`, `specs/x402-specification-v2.md` (§6.1 payment flows, §7 facilitator API, §9 error codes), `specs/transports-v2/http.md`, `specs/schemes/batch-settlement/scheme_batch_settlement.md`, `specs/schemes/exact/scheme_exact_lnbtc.md`. HEAD at research time: `636f5856533e4124c6e733bc377652429952d1d6` (2026-10-27).
- npm: `@x402/fetch@2.28.0` integrity `sha512-kF5IjZIz/izg2TD/Zav+SVj0jtC0zBDfE7WcKCnMZWIsZcLCyL2GgvwXCn7CCSsNjpQ/z3Rz4OqTCA4AaeKySQ==`, `@x402/express@2.28.0` `sha512-/94ZT89ce9Y92TgAxMuBQiS32BbvZOh0ZziMxTR8js2dbroEZ8po5guayy8zHOG79/x0p5GHJ/yoUUC4faMnvA==`.
- Spike runs: `$SPIKE/logs-final/run.out` (all scenario results), `$SPIKE/logs-final/*.jsonl` (raw per-process logs with decoded headers), `$SPIKE/logs-final/timeline-<scenario>.txt`, `$SPIKE/logs-final/order-seq1.txt`, `$SPIKE/logs-final/stub-startup.out`, `$SPIKE/logs-final/stub-facdown-startup.out`; README at `$SPIKE/README.md`.


## Verification corrections

Fact-check of this track on 2026-10-27. Sources: a sparse clone of tag `npm-@x402/core@v2.28.0` (commit `6b6ee91fee027b540faabcb25774e73851006c3b`) and the npm 2.28.0 tarballs. Their integrity hashes match §Sources, and the sourcemap `sourcesContent` files for core, fetch and express (15, 1 and 2 files) are byte-identical to the tag. Line cites are `typescript/packages/core/src/...` at that commit unless marked otherwise. Probe scripts are in `/private/tmp/claude-501/-Users-oynozan-Desktop-Dev-Web3-z402/afbb7c76-d88e-47a4-8a53-fd001155f8ac/scratchpad/spikes/verify-x402-e2e-spike/probe/` and their outputs in `.../verify-x402-e2e-spike/logs/`.

I re-checked three load-bearing claims. All three hold, and each is now confirmed by running code:
- S2 / §13: `SchemeNetworkServer` requires `defaultAssetTransferMethod` and `paymentFlows`. tsc reports `TS2420 … missing the following properties … defaultAssetTransferMethod, paymentFlows`. With ATM `"default"` and the `authorization` flow, the wire `extra` is `{}` (`logs/tsc.out`, `logs/flow-pending.json`).
- S12: a settle result with `success:false`, `errorReason:"settlement_pending"` and a non-empty `transaction` makes the API call `/settle` exactly twice. This happens over HTTP whether the facilitator answers 200 or 500. With `transaction:""` the API calls it once.
- §2 imports: `@x402/express` exports no `HTTPFacilitatorClient`, in either its ESM or CJS runtime exports or its types. `@x402/core/server` and `@x402/core/http` export the same class. `@x402/fetch` re-exports core's own `x402Client`, `x402HTTPClient` and `decodePaymentResponseHeader` objects (`logs/exports.json`).

Corrections and precisions:
1. **§15.4: `transaction` and `amount` on voucher-only settles (correction).** A non-empty voucher id is not needed.
   - `{success:true, transaction:""}` passes the API's zod schema. The client receives `PAYMENT-RESPONSE {"success":true,"transaction":"",…}`, and `x402HTTPClient.processResponse` reports `paymentStatus:"settled"` (ran: `logs/e2e.out` case a).
   - The spec defines `transaction` as "Blockchain transaction hash (empty string if no transaction was broadcast…)" (`specs/x402-specification-v2.md:249`).
   - The closest upstream scheme fixes the response shape. Its "Payment Response Contract" (`specs/schemes/batch-settlement/scheme_batch_settlement_evm.md:259-286`; code at `mechanisms/evm/src/batch-settlement/server/settle.ts:145-160`) says:
     - voucher-only: `transaction:""`, top-level `amount:""`, `extra.chargedAmount` = the request charge, `extra.channelState` = a snapshot;
     - deposit: `transaction` = the deposit tx hash, `amount` = the deposited amount.
   - Use the same shape for z402: voucher-only `{success:true, transaction:"", amount:"", network, payer, extra:{chargedZat, cumulativeZat, …}}`; on the deposit call, `transaction:<depositTxid>` and `amount:<deposit zat>`.
   - An empty `transaction` also rules out the S12 auto-retry.
2. **S2 (precision).** A scheme without `defaultAssetTransferMethod` makes `new x402HTTPResourceServer(...)`, and so `paymentMiddleware(...)`, throw `RouteConfigurationError` synchronously: `… does not support assetTransferMethod "undefined"`. A scheme without `paymentFlows` throws a plain `TypeError: Cannot read properties of undefined (reading 'default')` instead (ran; `http/x402HTTPResourceServer.ts:1166-1182`).
3. **"Authorization flow omits `extra.paymentFlow`" (precision).** Core never adds the key for `authorization`. If the route `extra` sets `paymentFlow:"authorization"` explicitly, core does not strip it, and it reaches the wire (ran). The spec allows this: "`authorization` MAY be omitted or explicit" (`specs/x402-specification-v2.md:289`). `assetTransferMethod:"default"` is deleted even when the route `extra` sets it explicitly (ran; `server/paymentFlow.ts:99-104`). Leave both keys out of the z402 route config.
4. **S12 (precision).** The retry fires only when all three hold: `success === false`, `errorReason === "settlement_pending"` and `transaction` non-empty (`server/x402ResourceServer.ts:2048-2052`). It also fires for a thrown `SettleError` with the same fields (`:2064-2069`), which is what the API raises when the facilitator answers non-2xx with a body containing `success`. There is at most one retry, with the identical payload (`:1577-1597`): if both answers are pending, `/settle` is called twice and the second result is returned.

Additions to §15 (omissions that change what the facilitator must do):
5. **Nothing validates the scheme payload before it reaches the facilitator.**
   - The API only base64-checks and `JSON.parse`s `PAYMENT-SIGNATURE` (`http/index.ts:27-32`). A header that fails to decode is treated as no payment: a fresh 402 with `error:"Payment required"`, plus a `console.warn` stack trace on the API.
   - `x402Facilitator.verify` and `x402Facilitator.settle` run no schema check. They pick the scheme only from `paymentPayload.x402Version` and `paymentRequirements.scheme`/`network` (`facilitator/x402Facilitator.ts:304-332, 423-451`).
   - Ran: a hand-built payload `{sessionKey:7, cumulativeZat:{"$gt":0}, sig:null}` reached the facilitator's `verify` and `settle` unchanged (`logs/e2e.out` case b).
   - The z402 facilitator scheme must check types and formats itself: hex lengths, zat as a decimal string, BigInt parsing. On failure it returns `invalid_payload`, the spec §9 code. `@x402/core/schemas` exports `parsePaymentPayload` and `parsePaymentRequirements` for the envelope.
6. **Trust boundary.**
   - Clients may add keys to `accepted.extra`. Matching uses `deepEqual` on the core fields and only a subset check on `extra` (`server/x402ResourceServer.ts:2100-2120`). The facilitator receives the API's own `paymentRequirements`. Ran: a `clientAdded` key was present in `paymentPayload.accepted.extra` and absent from `paymentRequirements.extra`.
   - So read the terms from `paymentRequirements`, never from `paymentPayload.accepted`.
   - `x402Facilitator` hands whatever `paymentRequirements` the caller posts straight to the scheme, and the endpoints have no authentication. Bind the facilitator to `127.0.0.1`, or set `HTTPFacilitatorClient({ url, createAuthHeaders })`. `createAuthHeaders` must return a path-keyed object, `{verify:{…}, settle:{…}, supported:{…}}`; a flat headers object throws (`http/httpFacilitatorClient.ts:583-620`).
   - Check `payTo`, `amount` and `windowZat`/`creditRatio`/`creditCapZat` against the facilitator's own config.
   - An empty or missing `url` makes `HTTPFacilitatorClient` fall back to `https://x402.org/facilitator` (`:14, :379`).
7. **A settle timeout leaves the outcome unknown.**
   - `FacilitatorTimeoutError` (default 90 000 ms) extends `FacilitatorResponseError`. Express therefore answers `502 {"error":"Facilitator settle request timed out after 90000ms"}`, discards the buffered body and sends no `PAYMENT-RESPONSE` (`types/facilitator.ts:126-155`; `http/express/src/index.ts:53-55, 424-429`).
   - The facilitator may already have recorded the voucher or the deposit.
   - Under §15.5 the client re-sends `depositTxid` until a successful response acknowledges it. So `/verify` and `/settle` must treat a `depositTxid` already credited to the same session as a no-op: no second credit, and no refusal.
