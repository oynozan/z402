# x402 v2 spec rules for z402 (track: x402-spec)

## TL;DR

1. Canonical repo is now **x402-foundation/x402**; coinbase/x402 is a dev fork. Spec read at `636f5856` (2026-10-27); SDK in use is **@x402/core 2.28.0** (tag `npm-@x402/core@v2.28.0` = `6b6ee91f`, 2026-09-29). The spec changed only editorially since then.
2. v2 wire: `PAYMENT-REQUIRED` header (402), then `PAYMENT-SIGNATURE` (request), then `PAYMENT-RESPONSE` (response). Each is **standard base64 (not base64url) of UTF-8 JSON**. v1 used a JSON body plus `X-PAYMENT` / `X-PAYMENT-RESPONSE`. `amount` is an atomic-unit decimal string. For a native coin, `asset` is a ticker by precedent (`XRP`, `BTC`, `CCD`). Custom error codes are allowed if namespaced (`invalid_<scheme>_<net>_*`).
3. **Network id: use `zcash:testnet` (and `zcash:mainnet` later).** It is valid CAIP-2 syntax and passes both 2.28.0 and HEAD validation (ran it). No `zcash` CAIP-2 namespace is registered. The registered alternative is `bip122:05a60a92d99d85997cce3b87616c089f` (testnet), and I verified the genesis hashes live. The Zcash x402 community is split: CipherPay, zpay, Frontier and ASH use `zcash:*`, while Erudite and dmarzzz use `bip122:*`. x402 already ships unregistered namespaces (`near:`, `cardano:`, `lnbtc:`, `cloudflare:402`).
4. **Scheme id: `prepaid-voucher`.** It names the semantics, not the chain, as x402 does. I found no collision. Alternatives: `deposit-voucher`, `prepaid-tab`, `zcash-voucher`. These are taken: `exact`, `upto`, `batch-settlement`, `auth-capture`, `deferred`, `channel`, `statechannel`, `escrow`, `dhali`, `zk-relay`, `zcash-shielded`, `zcash-shielded-tab`. Also avoid `z402*`: the npm package `z402` exists, and zec-null-402 uses a `z402:` memo prefix.
5. The closest spec to borrow from is **`batch-settlement`** (EVM v1.1 and SVM): a deposit, cumulative vouchers, a per-channel lock, a voucher-only `SettleResponse` with `transaction:""` plus `extra.chargedAmount`, a `commitmentId`, a corrective 402, and namespaced error codes. Its semantics are value-moves-later, so z402 should not reuse the scheme id.
6. Facilitator rules: `/verify` is read-only and must not commit state. `/settle` commits: it credits the deposit at most once, keyed `zcash:testnet:<txid>`, and advances the cumulative voucher atomically. `SettleResponse` must always carry `transaction` (string, `""` allowed) and `network`, or the stock client throws and the server returns 502. Never return `settlement_pending`, because the SDK auto-retries settle once.
7. Blocker found by running it (other tracks found it too): a stock `new x402Client()` rejects `asset:"ZEC"` through its default `spendControls`. The client scheme must implement `findDefaultAsset`, or the agent must set `spendControls`.
8. Other spec-relevant facts. Testnet has **NU7 active, with about 25 s blocks** (measured 25.3 s over 1000 blocks). Mainnet NU7 is set for height 3,543,405. The 402 `extra` must be static per route: the server matches the client's echo exactly, and the client may add keys but not change or drop them.

---

## 0. Sources and versions

| Source | Version / SHA | Date | Notes |
|---|---|---|---|
| github.com/x402-foundation/x402 | HEAD `636f5856533e4124c6e733bc377652429952d1d6` | 2026-10-27 | canonical repo; README: "We've moved the x402 repo under the x402 Foundation repo… coinbase/x402 is now a development fork" (coinbase/x402 `README.md:1-3`, HEAD `0e6e8c55`, 2026-10-15) |
| x402 v2 spec | `specs/x402-specification-v2.md` (last change `51a0664c`, 2026-10-26) | v2.0 dated 2025-12-9 in its version table (`:729-733`) | changes since the 2.28.0 tag are editorial: headings, `invalidMessage`/`errorMessage` rows, CORS text (`git log npm-@x402/core@v2.28.0..HEAD -- specs/x402-specification-v2.md specs/transports-v2/http.md`) |
| @x402/core, @x402/fetch, @x402/express | 2.28.0, tag `npm-@x402/core@v2.28.0` = `6b6ee91fee027b540faabcb25774e73851006c3b` | published 2026-09-29T19:03:58Z (`npm view @x402/core time`) | tarballs unpacked in `$DL/npm/`; types identical to HEAD source |
| ChainAgnostic/namespaces | `463bae5625aaa8c184ccc74f1db457da8a43e72b` | 2026-09-03 | no `zcash/`; `bip122/`, `monero/` exist |
| ChainAgnostic/CAIPs | `f46c0fe0`; `CAIPs/caip-2.md` last changed `cbee09d2` | 2022-11-18 | CAIP-2 Final |
| ZcashFoundation/zebra | `1e03ee753fbc72d70882cdfd3c8bdd58b80f0f97` | 2026-10-23 | genesis hashes, branch ids, NU7 heights |
| docs.cdp.coinbase.com/x402/buyer/mcp-payments.md | fetched 2026-10-27 | — | MCP loop: `_meta["x402/payment"]` = PAYMENT-SIGNATURE, `_meta["x402/payment-response"]` = PAYMENT-RESPONSE; Python sample `payment.register("eip155:84532", ExactEvmScheme(signer))` |
| Live probes | lightwalletd `testnet.zec.rocks:443` v0.5.4 (`c22ca9ba`), `zec.rocks:443` v0.5.3 (`062e8bfc`) | 2026-10-27 | grpcurl outputs in §3.4 |

`$DL` = `/private/tmp/claude-501/-Users-oynozan-Desktop-Dev-Web3-z402/afbb7c76-d88e-47a4-8a53-fd001155f8ac/scratchpad/downloads/x402-spec`. Repo paths below are relative to `$DL/x402-foundation` unless stated otherwise. `$SPIKE` = `/private/tmp/claude-501/-Users-oynozan-Desktop-Dev-Web3-z402/afbb7c76-d88e-47a4-8a53-fd001155f8ac/scratchpad/spikes/x402-spec`.

---

## 1. v2 types (verbatim), required vs optional, and SDK reality

### 1.1 PaymentRequired (`specs/x402-specification-v2.md:112-118`)

| Field Name    | Type     | Required | Description |
|---|---|---|---|
| `x402Version` | `number` | Required | Protocol version identifier (must be 2) |
| `error`       | `string` | Optional | Human-readable error message explaining why payment is required |
| `resource`    | `object` | Required | ResourceInfo object describing the protected resource |
| `accepts`     | `array`  | Required | Array of payment requirement objects defining acceptable payment methods |
| `extensions`  | `object` | Optional | Protocol extensions data |

ResourceInfo (`:134-141`): `url` (Required); `description`, `mimeType` (Optional); `serviceName` (Optional, "Printable ASCII, max 32 characters"); `tags` (Optional, "Max 5 entries; each printable ASCII, max 32 characters"); `iconUrl` (Optional, max 2048).
Extensions (`:143-150`): each key maps to `{info (Required), schema (Required, JSON Schema)}`. "The client must include at least the info received; it may append additional info but cannot delete or overwrite existing info."

### 1.2 PaymentRequirements (`:122-130`)

| Field Name | Type | Required | Description |
|---|---|---|---|
| `scheme` | `string` | Required | Payment scheme identifier (e.g., "exact") |
| `network` | `string` | Required | Blockchain network identifier in CAIP-2 format (e.g., "eip155:84532") |
| `amount` | `string` | Required | Required payment amount in atomic token units |
| `asset` | `string` | Required | Token contract address or ISO 4217 currency code for fiat |
| `payTo` | `string` | Required | Recipient wallet address or role constant (e.g., "merchant") |
| `maxTimeoutSeconds` | `number` | Required | Maximum time allowed for payment completion |
| `extra` | `object` | Optional | Additional information. Reserved protocol keys: `assetTransferMethod`, `paymentFlow` (section 6.1); other keys are scheme-specific |

SDK reality (2.28.0, `typescript/packages/core/src/types/payments.ts:12-20`, identical in the published `dist/cjs/x402Client-C7_OogbK.d.ts:1375-1383`):
```ts
export type PaymentRequirements = {
  scheme: string; network: Network; asset: string; amount: string;
  payTo: string; maxTimeoutSeconds: number; extra: Record<string, unknown>; // extra is NOT optional in TS
};
export type Network = `${string}:${string}`;            // types/index.ts
```
- Always send `extra`, even as `{}`. The spec says optional, but the TS type requires it, and the zod schema accepts `undefined`/`null`.
- **amount**: atomic units, decimal string. Open PR #3828 (not merged) would make it normative: "`amount` MUST match `^[0-9]+$`… no sign, decimal point, exponent, separators, or whitespace". zec: integer **zatoshis** (1 ZEC = 10^8).
- **asset for a native coin**: the spec text only covers token addresses and ISO 4217. Merged bindings use: `"XRP"` with amount in drops (`specs/schemes/exact/scheme_exact_xrpl.md:149,179`); `"BTC"` with amount in millisatoshis (`scheme_exact_lnbtc.md:27-31,85-102`); `"CCD"` (`scheme_exact_concordium.md:40`); `"CC"` (Canton); `"lovelace"` (Cardano, `scheme_exact_cardano.md:182`); `"0.0.0"` for HBAR (docs `core-concepts/network-and-token-support.mdx`). Every prior Zcash x402 implementation uses `"ZEC"` with amounts in zatoshis (§6). **Use `asset: "ZEC"`.**
- **extra rules**: (a) `assetTransferMethod` and `paymentFlow` are protocol-reserved (`:287-291`). (b) If the flow is not `authorization`, `extra.paymentFlow` MUST be present (`:291`). (c) The SDK resource server matches the client's `accepted` to its freshly built requirements as follows. All non-`extra` fields must deep-equal. Every server `extra` key must be present with an equal value; the client MAY add keys. Keys the scheme lists in `dynamicExtraFields` are skipped (`server/x402ResourceServer.ts:1516-1540`, `:2100-2120`). Ran it, §1.8. **Consequence for z402:** the 402 `extra` must be deterministic per route (window, ratio, cap). Do not put per-session state in `extra` unless the server scheme declares it in `dynamicExtraFields`.

### 1.3 PaymentPayload (`:197-203`)

| Field Name | Type | Required | Description |
|---|---|---|---|
| `x402Version` | `number` | Required | Protocol version identifier |
| `resource` | `object` | Optional | ResourceInfo object describing the resource being accessed |
| `accepted` | `object` | Required | PaymentRequirements object indicating the payment method chosen |
| `payload` | `object` | Required | Scheme-specific payment data |
| `extensions` | `object` | Optional | Protocol extensions data |

The SDK client builds `{x402Version, payload, extensions, resource: paymentRequired.resource, accepted: requirements}`. The scheme's `createPaymentPayload` returns only `{x402Version, payload, extensions?}` (`client/x402Client.ts:537-600`, type `PaymentPayloadResult` in `types/mechanisms.ts`).

### 1.4 SettleResponse (`:244-253`)

| Field Name | Type | Required | Description |
|---|---|---|---|
| `success` | `boolean` | Required | Indicates whether the payment settlement was successful |
| `errorReason` | `string` | Optional | Error reason if settlement failed (omitted if successful) |
| `errorMessage` | `string` | Optional | Human-readable explanation of `errorReason` |
| `payer` | `string` | Optional | Address of the payer's wallet |
| `transaction` | `string` | Required | Blockchain transaction hash (empty string if no transaction was broadcast; MUST be non-empty when `errorReason` is `settlement_pending` — see §9 Error Handling) |
| `network` | `string` | Required | Blockchain network identifier in CAIP-2 format |
| `amount` | `string` | Optional | The actual amount settled in atomic units (omitted if not applicable) |
| `extensions` | `object` | Optional | Protocol extensions data |

The SDK type adds `extra?: Record<string, unknown>` and `extensionResponses?` (`types/facilitator.ts`). Batch-settlement puts scheme data in `SettleResponse.extra` (§2.4). The stock `HTTPFacilitatorClient` validates success bodies with zod (`http/httpFacilitatorClient.ts:165-191`):
```ts
success: z.boolean(), errorReason/errorMessage/payer/amount: z.string().nullish(),
transaction: z.string(),                       // REQUIRED, "" allowed
network: z.custom(v => typeof v === "string"), // REQUIRED
extensions/extra: z.record(...).nullish()
```
zod's default `.object` **strips unknown top-level keys**, so a custom top-level `txid` or `previously_verified` is silently dropped. Put scheme data under `extra`. A body missing `transaction` raises `FacilitatorResponseError`, and the express middleware maps that to **HTTP 502** (`@x402/express` `src/index.ts:48-54`).

### 1.5 VerifyResponse (`:262-269`)

| Field Name | Type | Required | Description |
|---|---|---|---|
| `isValid` | `boolean` | Required | Indicates whether the payment authorization is valid |
| `invalidReason` | `string` | Optional | Reason for invalidity (omitted if valid) |
| `invalidMessage` | `string` | Optional | Human-readable explanation of `invalidReason` |
| `payer` | `string` | Optional | Address of the payer's wallet |
| `extensions` | `object` | Optional | Protocol extensions data |
| `extra` | `object` | Optional | Scheme-specific additional data |

"Facilitators MAY expose extension outcomes separately… as `extensionResponses` (populated from the transport sidechannel; never serialized to buyers)" (`:271`). The sidechannel is the HTTP header `EXTENSION-RESPONSES` (base64 JSON, `:428-439`).

### 1.6 Supported (`:441-494`)

```json
{ "kinds": [ { "x402Version": 2, "scheme": "exact", "network": "eip155:84532" } ],
  "extensions": [],
  "signers": { "eip155:*": ["0x1234..."], "solana:*": ["CKPK..."] } }
```
`kinds` (Required, array of `{x402Version (Req), scheme (Req), network (Req), extra (Opt)}`), `extensions` (Required, `string[]`), `signers` (Required, "Map of CAIP-2 patterns (e.g., `eip155:*`) to public signer addresses"). The SDK `x402Facilitator.getSupported()` builds `signers` from each scheme's `caipFamily` and `getSigners(network)` (`facilitator/x402Facilitator.ts:219-273`). A facilitator that signs nothing gives `"signers": {"zcash:*": []}`, which the schema accepts (`httpFacilitatorClient.ts:208-212`). **The resource server refuses to build a route's 402 if `/supported` lacks that exact `(scheme, network)`**: "Facilitator does not support <scheme> on <network>" (`server/x402ResourceServer.ts:780-790`).

### 1.7 Error codes (`:591-612`)

"The optional `invalidMessage` and `errorMessage` fields provide human-readable diagnostics… clients MUST use the corresponding `invalidReason` or `errorReason` code and MUST NOT rely on message text." (`:595`)

Standard codes, verbatim names: `insufficient_funds`, `invalid_exact_evm_payload_authorization_valid_after`, `invalid_exact_evm_payload_authorization_valid_before`, `invalid_exact_evm_payload_authorization_value_mismatch`, `invalid_exact_evm_payload_signature`, `invalid_exact_evm_payload_recipient_mismatch`, `invalid_network`, `invalid_payload`, `invalid_payment_requirements`, `invalid_scheme`, `unsupported_scheme`, `invalid_x402_version`, `invalid_transaction_state`, `unexpected_verify_error`, `unexpected_settle_error`, `settlement_pending` (non-terminal; "MUST carry a non-empty `transaction`").

**Custom codes are allowed and namespaced.** auth-capture: "The scheme uses the standard x402 error codes plus the following. Every reason this binding defines is namespaced `invalid_auth_capture_evm_*`; standard reasons it also returns, such as `invalid_network`, keep their canonical names." (`specs/schemes/auth-capture/scheme_auth_capture_evm.md:575`). Batch-settlement uses `invalid_batch_settlement_evm_*` and `_svm_*` (`scheme_batch_settlement_evm.md:754-828`). lnbtc uses `invalid_exact_lnbtc_*`. Zcash precedents: zpay uses `zcash_exact_*`, dmarzzz uses `invalid_exact_zcash_*`. The core has no central code enum; codes are plain strings (grep of `typescript/packages/core/src`). For z402, use `invalid_prepaid_voucher_zcash_<reason>` (§8.6).

### 1.8 Ran it: SDK acceptance (`$SPIKE/sdkcheck/check.mjs`, output `check.out`, @x402/core 2.28.0)

```
1. stock new x402Client(), scheme WITHOUT findDefaultAsset → ERROR All payment requirements were rejected by spendControls: only default assets or entries in spendControls.allowedAssets are allowed...
2. stock new x402Client(), scheme WITH findDefaultAsset(ZEC, 8) → OK; context.maxAmountPerPayment = 100000000
3. fromConfig spendControls.allowedAssets=[{network:zcash:testnet, asset:ZEC, maxAmountPerPayment:"200000"}] → OK; cap 200000
4. register("zcash:*") wildcard → OK
5. header name=PAYMENT-SIGNATURE base64url-chars-present=false
6. zcash:testnet / zcash:mainnet / bip122:<32hex>: 2.28.0-schema=true HEAD-regex=true; "zcash-testnet": false/false; bip122:<64hex>: true/false
7. server findMatchingRequirements: exact echo MATCH; client adds extra key MATCH; client changes extra value no match; drops extra key no match; changes amount no match
```
Spend-control defaults are `spendControls = {}` (`client/x402Client.ts:330`) and `DEFAULT_MAX_AMOUNT_PER_PAYMENT = "$1"` (`:156`). Filtering is in `applySpendControls` (`:858-965`). They were introduced in core 2.23.0 (`typescript/packages/core/CHANGELOG.md:39`, PR #3124). The "$1" is converted with the default asset's `decimals`, so a ZEC entry with decimals 8 gives a 1 ZEC per-payment cap. The cap checks only `requirements.amount`, not the deposit, so **the client scheme must enforce `deposit ≤ context.maxAmountPerPayment` itself**. CHANGELOG `:18` (2.26.0): "capital-locking schemes can reuse client policy".

---

## 2. Schemes: how they are specified, what exists, what to borrow

### 2.1 Layout and required sections

- Overview `specs/schemes/<scheme-id>/scheme_<id_with_underscores>.md`; per-network binding `scheme_<id>_<network-kind>.md` (`specs/CONTRIBUTING.md:13-37,41-46,89-92`). Examples: `exact/scheme_exact_lnbtc.md`, `batch-settlement/scheme_batch_settlement_cloudflare.md`. A z402 binding would be `specs/schemes/prepaid-voucher/scheme_prepaid_voucher_zcash.md`.
- Overview template `specs/scheme_template.md`: `# Scheme: <name>` / `## Summary` / `## Use Cases` / `## Appendix`.
- Binding template `specs/scheme_impl_template.md`: `# Scheme: <name> <network kind>` / `## Summary` / `## Payment payload` / `## Verification` / `## Settlement` / `## Appendix`.
- Guidelines (`specs/CONTRIBUTING.md:160-201`): RFC 2119 words; examples in every section; reference core types rather than redefining them; a security section on "Replay attack prevention / Authorization scope / Settlement atomicity" (`:188-194`). Process: open an issue or discussion first, then a spec PR (`:69-92`). Open PR #3801 (not merged) proposes an XP process where "a new scheme" needs an Extensions-Track XP and "a new network implementation of an existing scheme… A normal PR is enough".
- Scheme-level checklists that bindings MUST answer. batch-settlement lists 7 items: commitment format, verification rules, storage behavior, double-spend prevention, commitment expiry, redemption, trust model (`scheme_batch_settlement.md:57-67`). auth-capture lists 8 (`scheme_auth_capture.md`, Appendix). `exact` has family rules (§5.3).
- Naming: **kebab-case ids that name semantics**. `authCapture` was renamed `auth-capture` on the wire in `1321c395` (2026-05-20, PR #2391: `-"scheme": "authCapture"` → `+"scheme": "auth-capture"`). Docs: "The `scheme` names the payment semantics and `network` names the network implementation." (`docs/schemes/overview.mdx`).

### 2.2 Scheme ids: complete list (x402-foundation/x402, as of 2026-10-27)

Merged in `main`: grep of `"scheme": "…"` in `specs/` gives exact ×96, upto ×12, batch-settlement ×12, auth-capture ×7, and deferred ×2 (only as an example in `extensions/extension-auth-hints.md:82,293`). Grepping `SCHEME = "…"` constants in `typescript/packages` finds `auth-capture`, `batch-settlement`, `exact` (upto is not defined that way).

| id | status | bindings / link |
|---|---|---|
| `exact` | merged | evm, svm, algo, aptos, canton, cardano, casper, concordium, hedera, keeta, lnbtc, near, starknet, stellar, sui, ton, xrpl (`specs/schemes/exact/`) |
| `upto` | merged | evm, svm, xrpl (`specs/schemes/upto/`) |
| `batch-settlement` | merged (Cloudflare `2a690c7e` 2026-04-15 #1145; EVM `c763d05a` 2026-05-05 #2051; EVM v1.1 facilitator-managed vouchers 2026-10-06) | evm, svm, cloudflare |
| `auth-capture` | merged (v1.0 2026-05-13 #1425; renamed 2026-05-20) | evm |
| `deferred` | closed (PR #426, tmigone, closed 2026-05-15) | https://github.com/x402-foundation/x402/pull/426 |
| `channel` | closed (PR #537, jolestar, closed 2026-05-15) | https://github.com/x402-foundation/x402/pull/537 |
| `escrow` | closed (PR #873, closed 2026-05-15); **also a paymentFlow name** | https://github.com/x402-foundation/x402/pull/873 |
| `statechannel` | closed (PR #1907, closed 2026-05-14) | https://github.com/x402-foundation/x402/pull/1907 |
| `upfront` | closed as a scheme (PR #2520, closed 2026-08-24); became a **paymentFlow** (PR #3145, merged `23173acb` 2026-09-02) | https://github.com/x402-foundation/x402/pull/2520 |
| `dhali` | open (PR #1302, 2026-02-22; file mis-placed under `exact/`) | https://github.com/x402-foundation/x402/pull/1302 |
| `zk-relay` | open (PR #1205, 2026-02-16) | https://github.com/x402-foundation/x402/pull/1205 |
| `exact` + ATM `txid` | open draft (PR #1004) | client-submitted txid proofs on any chain |
| `exact` + ATM `shielded` (EVM privacy pools) | open (PR #1951) | — |
| `exact` on Zcash | open (PR #1634, CipherPay); closed (PR #1501, Erudite) | §6 |
| batch-settlement "credit" binding | open draft (PR #2612) | fiat credit |
| proposals in issues (no spec) | `credit-bundle` (#2126), `metered-session` extension (#2273), `agreement-session` (#3646), `clawpay-cny/-dcep/-cross` (#2134) | — |

PaymentFlow names (reserved values of `extra.paymentFlow`): `authorization`, `upfront`, `escrow` (`x402-specification-v2.md:293-299`; SDK `PaymentFlowName`). Batch-settlement `payload.type` values: `deposit`, `voucher`, `refund`, `claim`, `settle` (EVM) and `authorization`, `seal` (SVM).

### 2.3 Deferred, voucher and channel mechanics (summary)

| proposal | deposit / backing | per-request commitment | who settles, when | replay protection | session id |
|---|---|---|---|---|---|
| **batch-settlement EVM** (merged; `scheme_batch_settlement_evm.md`) | onchain escrow channel, deposit via ERC-3009/Permit2, facilitator-sponsored | EIP-712 **cumulative** voucher `maxClaimableAmount`; server rule `maxClaimableAmount == chargedCumulativeAmount + amount` (`:295`) | server (self-managed) or facilitator (managed, `extra.voucherManager:"facilitator"`) claims and settles later, periodic/threshold/on-withdraw (`:632-683`) | "The cumulative model makes nonces unnecessary" (`:834`); per-channel lock; managed repeated settle "is not idempotent… Callers MUST NOT auto-retry `POST /settle`" (`:440`) | `channelId = EIP712Hash(ChannelConfig)` (`:22-33`) |
| **batch-settlement SVM** (merged) | payment-channels program, `open`/`top_up` | **Ed25519** cumulative voucher, message `0x56 0x01 ‖ channelId ‖ u64le(maxClaimableAmount) ‖ i64le(expiresAt)` (50 bytes); `expiresAt` MUST be 0 | server stores latest; `claim`/`settle`/`seal` later | floor `maxClaimableAmount ≥ settled + amount` and `> settled`; domain-separated close auth `UTF8("x402:batch-settlement:svm:close:v1") ‖ 0x00 ‖ u16le(len(network)) ‖ network ‖ …` | channel PDA |
| batch-settlement Cloudflare (merged) | credit-backed billing identity | RFC 9421 HTTP message signature; payload `{amount, asset}`; `payTo:"merchant"`, `asset:"USD"`, `network:"cloudflare:402"` | Cloudflare bills later | timestamp freshness ~30 s | Signature-Agent |
| deferred (#426, closed) | EVM escrow with thawing | EIP-712 voucher `{id, buyer, seller, valueAggregate (monotonic), asset, timestamp, nonce++, escrow, chainId}`; `PAYER-IDENTIFIER` header; per-buyer state injected in `extra` | seller or facilitator collects later | aggregate monotonic plus nonce | voucher `id` |
| channel (#537, closed) | lazy-opened channel, collateral | receipt `{channelId, epoch, subChannelId, accumulatedAmount, nonce, payeeId, chainId?, payerSignature}`; postpaid server "proposal" | async per delta | nonce monotonic per sub-channel; "off-chain accepts equality as idempotent"; chainId in signature | `subChannelId` per device or session |
| dhali (#1302, open) | Dhali payment channels | cumulative `authorized_to_claim` claim | Dhali, ~24 h cadence | "Claims are **cumulative**… once they have been spent, they intrinsically have no further value" | `channel_id` |
| statechannel (#1907, closed) | bidirectional channel / hub | signed balance state, `stateNonce` strictly increasing | dispute/close | nonce, balance conservation, EIP-712 chainId | channelId |
| Kage Tab (`zcash-shielded-tab`, v1; §6) | one shielded payment (memo = nonce) | RFC 9474 blind-RSA token per call | n/a (already paid) | spent-set of `SHA-256(randomizer‖msg)` | none (unlinkable) |

### 2.4 What z402 can borrow (with the source rule)

1. **Cumulative voucher as the replay primitive.** Store the last committed cumulative c_last per session. Accept only if `c_new − c_last ≥ amount` (the MVP rule). batch-settlement requires `==`; `≥` tolerates drift without a corrective 402. Vouchers carry no expiry ("Vouchers carry no expiry field", `scheme_batch_settlement_evm.md:840`).
2. **Ed25519 domain-separated signed message**, modelled on the SVM byte layouts (`scheme_batch_settlement_svm.md` §4.2). Proposal in §8.4.
3. **Per-session lock and settle-time re-check.** "The server must serialize request processing per channel and must not update voucher state until the resource handler has succeeded" (EVM `:292`). On handler failure the state stays unchanged and the client can retry the same voucher (`:303`).
4. **Voucher-only PAYMENT-RESPONSE contract** (EVM `:309-336`, SVM §4.4): `transaction:""`, `amount:""` (or omitted), `extra.chargedAmount`, `extra.channelState` snapshot. SVM: `extra.commitmentId` "MUST be non-empty for voucher acceptance, e.g. `channelId:maxClaimableAmount`". batch-settlement overview: "The settlement result MUST include a non-empty commitment identifier on success" (`scheme_batch_settlement.md:21`).
5. **Treat the snapshot as untrusted on the client.** "PAYMENT-RESPONSE extra is untrusted. The client updates local state from its own previous state plus `extra.chargedAmount`… It MUST NOT copy `extra.channelState` into that local state" (EVM `:691-701`).
6. **Corrective 402 for desync.** Use `error = <code>` plus `accepts[].extra.<state>`, have the client verify its own signature on the server's latest voucher, then retry once (`:716-750`). SDK hook: `schemeHooks.onPaymentResponse` returns `{recovered:true}` (batch-settlement client `client/hooks.ts`, §4.4).
7. **`minDeposit`-style hint plus a local client cap**: "Clients SHOULD… enforce a local maximum deposit so a 402 cannot lock unbounded escrow" (EVM `:129`). This maps to `windowZat` plus `context.maxAmountPerPayment`.
8. **Flow declaration.** batch-settlement EVM declares `paymentFlows = { eip3009: {supported:["authorization"], default:"authorization"}, permit2: {…} }` (`@x402/evm 2.28.0 batch-settlement/server/scheme.ts:63-67`). z402 needs no on-wire ATM: use the SDK sentinel `defaultAssetTransferMethod = "default"` and `paymentFlows = { default: { supported: ["authorization"], default: "authorization" } }`. Core strips `"default"` from the wire (`server/paymentFlow.ts`, `SDK_DEFAULT_ASSET_TRANSFER_METHOD`).

### 2.5 Names taken (do not use as the z402 scheme id)

`exact`, `upto`, `batch-settlement`, `auth-capture`, `deferred`, `channel`, `statechannel`, `escrow`, `upfront`, `authorization`, `dhali`, `zk-relay`; `zcash-shielded` (Kage v1 and ASH v2), `zcash-shielded-tab` (Kage); `zip321` (zpay internal); `mockstream` (only a spike placeholder in this project). Brand: npm `z402` exists ("Zero Trust x402 protocol", Solana, chickstudi0/z402, 0.1.1, 2025-11-11, `npm view z402`). nickthelegend/zec-null-402 ("Kippu", live on testnet Oct 20/22 2026) uses `@z402/*` workspace names, `Z402Client`, `z402-mcp` and the memo prefixes `z402:<commitment>` / `z402:anchor:` (README `:8-95`, HEAD `84b78b8a`, 2026-10-26). z402.cash returned 404 "Application not found" on 2026-10-27.

---

## 3. Network identifiers

### 3.1 Rules

- x402 v2: "Networks in x402 v2 use CAIP-2… `{namespace}:{reference}`… Non-blockchain networks are encouraged to follow the CAIP-2 format (e.g., `ach:us`, `sepa:eu`)" (`x402-specification-v2.md:631-646`). There is no registration requirement.
- CAIP-2 (Final; `CAIPs/caip-2.md`): `namespace: [-a-z0-9]{3,8}`, `reference: [-_a-zA-Z0-9]{1,32}`. "One namespace should refer to one resolution method".
- SDK: `type Network = \`${string}:${string}\``. Registration accepts patterns with `*` (`utils/index.ts`, `networkMatchesPattern`). Network matching is **exact string** everywhere else (facilitator dispatch `x402Facilitator.ts:309-330`, server matching, `/supported` kinds).
- Validation. 2.28.0: `NetworkSchemaV2 = z.string().min(3).refine(v => v.includes(":"))` (dist `schemas/index.js:63`). HEAD (unreleased, `3ca54cb2` 2026-10-21, PR #3285): `/^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/`, plus a temporary legacy-Algorand exception. At runtime the zod schemas are used only by `@x402/mcp` (`parsePaymentRequired`), not by the fetch/express path (`git grep` at the 2.28.0 tag).

### 3.2 What x402 uses today (merged specs and docs)

`eip155:<chainId>`, `solana:<genesis32>`, `tvm:-239`/`tvm:-3`, `algorand:<32 chars>`, `stellar:pubnet|testnet`, `aptos:1|2`, `hedera:mainnet|testnet`, `keeta:21378|1413829460`, `near:mainnet|testnet`, `ccd:9dd9ca4d19e9393877d2c44b70f89acb`, `xrpl:0|1`, `cardano:mainnet|preprod|preview`, `sui:mainnet|testnet|devnet`, `starknet:SN_SEPOLIA`, `casper:casper-test`, `canton:mainnet`, `lnbtc:000000000019d6689c085ae165831e93`, `cloudflare:402` (docs `core-concepts/network-and-token-support.mdx`; grep tally of `specs/`).
Registered in ChainAgnostic/namespaces (`463bae56`): eip155, solana, tvm, algorand, stellar, aptos, hedera, ccd, xrpl, sui, starknet, casper, bip122, monero. **Not registered: keeta, near, cardano, canton, lnbtc, cloudflare, zcash.** x402 therefore already accepts unregistered namespaces in merged specs. lnbtc defines its own namespace inside the scheme doc with a bip122-style reference: "The `lnbtc` namespace identifies Bitcoin Lightning networks. Its reference MUST be the first 32 characters of the underlying Bitcoin network's genesis block hash…" (`scheme_exact_lnbtc.md:20-34`).

### 3.3 Zcash CAIP-2 status

- No `zcash/` directory in ChainAgnostic/namespaces. GitHub search returned no zcash issues or PRs there (2026-10-27). CAIPs issue #4 ("The Bitcoin interface", closed 2020-01-19): webmaster128 wrote "ZCash: BIP122 excluded explicitely by […zcash/zips#87]". Then daira (2024-06-18): "Zcash excluded that BIP from its specification because it was in Draft at the time (2016-10-02)." The question was left open.
- `bip122` profile: "a 32-character prefix from the hash of the genesis block… lowercase hex", resolved with `getblockhash 0` (`namespaces/bip122/caip2.md`). Its CAIP-10 text only covers Bitcoin address types. CAIP-10 caps `account_address` at 128 chars (`CAIPs/caip-10.md:48`); a mainnet Orchard-only UA is 106 chars (lightwalletd donation address), but multi-receiver UAs are longer.
- The `monero` namespace (privacy-chain analogue) uses its own namespace with the genesis-hash prefix as reference (`namespaces/monero/caip2.md`). A registered `zcash` namespace in that style would be `zcash:00040fe8ec8471911baa1db1266ea15d`. Nobody uses that form.

### 3.4 Genesis hashes (verified two ways)

```
# testnet: block 1 prevHash = genesis (lightwalletd returns internal byte order; reversed for display)
grpcurl -max-time 30 -import-path . -proto service.proto -d '{"height": 1}' testnet.zec.rocks:443 cash.z.wallet.sdk.rpc.CompactTxStreamer/GetBlock
→ prevHash "OCxKMyZhx+0GcfMqNNckYZ8IbGGHO858mYWd2ZIKpgU=" → 05a60a92d99d85997cce3b87616c089f6124d7342af37106edc76126334a2c38
# mainnet
… zec.rocks:443 … GetBlock {"height":1} → prevHash "CM49lzGwAMCDOEVcikpr0F2hbiaxHaobkXGE7OgPBAA=" → 00040fe8ec8471911baa1db1266ea15dd06b4a8a5c453883c000b031973dce08
```
(`GetBlock {"height":0}` fails with "request for unspecified identifier", because proto3 drops the zero value.) Zebra source agrees: testnet `zebra-chain/src/parameters/network/testnet.rs:60` and mainnet `checkpoint/list.rs:59` (`1e03ee75`). dmarzzz/x402-zcash lists regtest `029f11d80ef9765602235e1bc9727e3e` (not verified here).

| network | `zcash:` form | `bip122:` form (32 hex) |
|---|---|---|
| testnet | `zcash:testnet` | `bip122:05a60a92d99d85997cce3b87616c089f` |
| mainnet | `zcash:mainnet` | `bip122:00040fe8ec8471911baa1db1266ea15d` |

Who uses what: `zcash:mainnet|testnet` is used by CipherPay (@cipherpay/x402 0.6.0 default `zcash:mainnet`; PR #1634), zpay ADR 0011 (also `zcash:regtest`), Frontier PR #1990, ASH (v2), and the MVP doc. `bip122:…` is used by Erudite PR #1501 (v1, transparent) and dmarzzz/x402-zcash (v2). Kage uses v1 `zcash-testnet`, which is invalid as a v2 network id (ran it, §1.8). Node chain names are `main`/`test` (lightwalletd `chainName`); zpay's wallet RAR uses `zcash:main`/`zcash:test` internally.

### 3.5 Recommendation

**`zcash:testnet` now and `zcash:mainnet` later.** Rationale:
- It is valid CAIP-2 and passes both 2.28.0 and HEAD validation.
- It is readable in `client.register("zcash:testnet", …)` and matches the MVP doc.
- It matches most Zcash x402 implementations, so it interoperates with them on the network axis.
- x402 merged specs already use unregistered namespaces with named references (`near:testnet`, `cardano:preprod`).
- `bip122:*` patterns would also match Bitcoin chains if a facilitator ever served both.

Mark it provisional. Optionally file a ChainAgnostic `zcash` namespace PR later. A namespace PR would naturally pick the genesis-prefix reference, not `testnet`.

**Cost of changing later.** Every component matches network strings exactly. The touchpoints:
1. Agent `register(...)` (a `zcash:*` wildcard survives a reference change but not a namespace change).
2. Server route `accepts[].network` and `server.register`.
3. Facilitator `register([...])` and the `/supported` kinds; the server refuses routes otherwise, see §1.6.
4. `SettleResponse.network`.
5. The voucher signing domain if `network` is in the signed bytes (§8.4); in-memory sessions just restart.

Algorand is the precedent. Its move from `algorand:<full hash>` to canonical 32-char references took `@x402/avm` 2.10 → 2.28, dual-advertising facilitators, a temporary core schema exception, and a migration guide (PR #3948 docs; PR #3894 proposes removing the aliases): "AVM normalization alone cannot bypass core schema validation or a facilitator's exact-string network matching." Mitigations: keep one shared constant, and have the facilitator advertise both ids during a migration (`register(["zcash:testnet","bip122:05a6…"], scheme)`).

---

## 4. HTTP transport

### 4.1 Headers and encodings (`specs/transports-v2/http.md:164-170`; v1 `transports-v1/http.md`)

| | v2 | v1 |
|---|---|---|
| 402 challenge | HTTP 402 + `PAYMENT-REQUIRED` header = base64(JSON PaymentRequired). Body is server-defined ("Response bodies are a server implementation concern", `:233-235`); the SDK sends `{}` or a custom body | HTTP 402 + **JSON body** `{x402Version:1, error, accepts:[{scheme, network:"base-sepolia", maxAmountRequired, asset, payTo, resource, description, mimeType, outputSchema, maxTimeoutSeconds, extra}]}` |
| client payment | `PAYMENT-SIGNATURE` = base64(JSON PaymentPayload with `accepted`) | `X-PAYMENT` = base64(JSON `{x402Version:1, scheme, network, payload}`) |
| settlement receipt | `PAYMENT-RESPONSE` = base64(JSON SettleResponse) | `X-PAYMENT-RESPONSE` |
| network ids | CAIP-2 | free strings (`base-sepolia`) |

Encoding: `safeBase64Encode` / `safeBase64Decode` of UTF-8 JSON; decoders require `/^[A-Za-z0-9+/]*={0,2}$/` (`utils/index.ts` `Base64EncodedRegex`; `http/index.ts:27-55`). **This is standard base64, not base64url.**
Telling v1 and v2 apart (SDK `x402HTTPClient.getPaymentRequiredResponse`, `http/x402HTTPClient.ts:113-135`): a `PAYMENT-REQUIRED` header means v2. Otherwise a body with `x402Version === 1` means v1; anything else throws "Invalid payment required response". The resource server (2.28.0) reads only `payment-signature`/`PAYMENT-SIGNATURE` (`x402HTTPResourceServer.ts:1274-1286`). An undecodable header is logged and treated as **no payment**, so the server returns a fresh 402, not a 400.
Header size (open PR #3805, not merged): keep `PAYMENT-REQUIRED` ≤ 8,190 bytes (aiohttp limit); undici fails above 16 KB of headers.
CORS (merged `58a5d7d3`): browser clients need `Access-Control-Expose-Headers: PAYMENT-REQUIRED, PAYMENT-RESPONSE` and `Access-Control-Allow-Headers: PAYMENT-SIGNATURE`. Not relevant to a Node agent.

### 4.2 Status codes (`transports-v2/http.md:237-247`)

| x402 Error | HTTP Status | Description |
|---|---|---|
| Payment Required | 402 | Payment needed to access resource |
| Invalid Payment | 400 | Malformed payment payload or requirements |
| Payment Failed | 402 | Payment verification or settlement failed |
| Server Error | 500 | Internal server error during payment processing |
| Success | 200 | Payment verified and settled successfully |

SDK reality (2.28.0):
- Verify failure: 402 with a new `PAYMENT-REQUIRED` whose `error` = `invalidReason` (`x402HTTPResourceServer.ts:669-682`).
- Settle failure: 402 with `PAYMENT-RESPONSE {success:false, errorReason, errorMessage, transaction, network}`, and the buffered handler output is discarded (`@x402/express src/index.ts:397-410`; `x402HTTPResourceServer.ts:1043-1070`).
- Handler status ≥ 400: no settle (cancel path, `:339-372`).
- Facilitator boundary error: 502. Unexpected error: 500.
- No matching requirements: 402 "No matching payment requirements".

### 4.3 Rejected payments: retries

Spec: no generic client retry rule. `settlement_pending` is non-terminal: "the caller can reconcile on chain before deciding whether to retry" (`x402-specification-v2.md:612`). Batch-settlement managed mode: "Callers MUST NOT auto-retry `POST /settle`" (`scheme_batch_settlement_evm.md:440`). Idempotent retries use the `payment-identifier` extension: same `id` + same payload returns the cached response; same `id` + different payload returns 409 (`specs/extensions/payment_identifier.md:80-90`).

### 4.4 What the stock clients do (@x402/fetch 2.28.0 `src/index.ts:40-160`; core `x402HTTPClient.processPaymentResult`)

1. Unpaid request. A non-402 response is returned as-is.
2. On 402, parse it (header first, then the v1 body). Optional `onPaymentRequired` hooks may retry with extra headers.
3. `client.createPaymentPayload`, then **one** paid request. If the original request already carried `PAYMENT-SIGNATURE` or `X-PAYMENT`, it throws "Payment already attempted".
4. `processPaymentResult` fires `onPaymentResponse` hooks (v2 only). If a scheme hook returns `{recovered: true}`, the wrapper builds **one** fresh payload and retries once more ("bounded to one recovery"). The hook context has `settleResponse` on a settle result, or `paymentRequired` on a verify-failure 402 (`client/x402Client.ts:53-76`).
5. Otherwise the 402 `Response` is **returned, not thrown**. The demo loop must check `res.status`.

The resource server retries `/settle` exactly once, and only on `settlement_pending` with a non-empty `transaction` (`x402ResourceServer.ts:1559-1600`). The core `HTTPFacilitatorClient` per-call timeout is **90 s** (`httpFacilitatorClient.ts:16`). A timeout during settle is indeterminate (docs `core-concepts/facilitator.md`).

---

## 5. Facilitator duties per spec

- **/verify is read-only.** "`/verify` is **read-only**: it validates payment state but MUST NOT commit payment state or write onchain state" (`x402-specification-v2.md:309`).
- **/settle commits.** It "Durably commits payment state for the request… Commitment need not be an onchain write: for client-prepaid methods, settle MAY bind a payment proof to the request (for example, consuming a challenge or marking a transaction as used) after read-only observation of ledger or backend state" (`:397`). This sentence covers z402: settle = credit the deposit plus advance the voucher. Request bodies are the same for verify and settle (`:399-401`). A scheme with several settles must say how they are told apart (`:403`).
- **Flows** (`:285-301`): `authorization` = verify → resource → settle (default); `upfront` = settle → resource; `escrow` = settle → resource → settle. "Invariant: at least one check… MUST run before the resource executes." The SDK prefers `authorization` when several are offered (`client/x402Client.ts:835-844`). **z402: use `authorization`** and omit `extra.paymentFlow`.
- **Client-submitted proofs** (the `exact` family rules; not binding on a new scheme, but they are the spec's guidance for a client-broadcast txid; `specs/schemes/exact/scheme_exact.md:44-56`):
  - "Methods in this family MUST use `upfront`."
  - Request binding.
  - **Single-use claim**: "Methods MUST define a canonical consumption key for the payment, formed as a CAIP-2 network identifier joined to the network's canonical payment identifier", which for z402 is `zcash:testnet:<txid>`.
  - Retention bound; amount acceptance (state over- and under-payment handling).
  - **Finality**: "declare the observable event that makes a payment final and which party owns confirmation-depth policy".
  - Failure disposition: "Clients MUST NOT assume a return path exists".
  - z402 deviates on purpose: it admits a zero-conf deposit, capped by the trust ramp. The z402 binding doc must say so explicitly.
- **Idempotency.** There is no generic rule; schemes define it. Options: (a) cumulative monotonicity makes a replayed voucher fail verify, which is the batch-settlement approach; (b) the `payment-identifier` extension. The SDK auto-retries settle only on `settlement_pending`, so **z402 should never return `settlement_pending`**: nothing is broadcast at settle.
- **Timeouts.** "Maximum time allowed for payment completion" (`:129`). The core SDK does **not** enforce it on the server; it only defaults it to 300 when a route omits it (`x402ResourceServer.ts:813`). Each scheme gives it meaning. EVM validBefore = now + maxTimeoutSeconds (`@x402/evm batch-settlement/client/eip3009.ts:66`). lnbtc invoice expiry must equal it. TXID PR: "advisory payment offer lifetime". batch-settlement SVM: "HTTP completion window". For z402: the window from the 402 to the paid retry. Keep the facilitator's mempool wait (MVP: 15 s) and total verify time **below** both `maxTimeoutSeconds` (60) and the 90 s HTTP client timeout.
- **Replay guidance in core** (`:616-623`): EIP-3009 nonce, onchain nonce, time windows, signatures. That text is EVM-centric; for other designs, see the scheme rules above.
- **`payer` and `transaction` when settle is bookkeeping** (z402: the client already broadcast the deposit):
  - `transaction`: a deposit-crediting settle returns **the deposit txid** (display-order hex). Precedents: batch-settlement deposit response "`transaction` is the deposit transaction hash, top-level `amount` is the deposited amount" (`scheme_batch_settlement_evm.md:312`); CipherPay `{success:true, transaction:<client txid>, network}` (dist `middleware.js:204-210`); dmarzzz `transaction:"txid"`. A voucher-only settle returns `transaction: ""` (spec: "empty string if no transaction was broadcast"; batch-settlement voucher-only response).
  - `payer`: optional. A shielded payer has no address. Use the **session key** consistently in verify and settle; precedent is Cloudflare `payer: "mycrawler.com"`, a non-address identity (`scheme_batch_settlement_cloudflare.md:252-262`). Or omit it.
  - `amount`: the decrypted deposit value on deposit-crediting settles; omit (or `""`) on voucher-only. Put the per-call charge in `extra.chargedAmount`.
- **HTTP conventions of the reference facilitator** (`examples/typescript/facilitator/basic/index.ts`, `02a5c749`): invalid payment → **200** `{isValid:false, invalidReason}`; unsupported kind → 200 `{isValid:false, invalidReason:"unsupported_scheme"}` or `{success:false, errorReason:"unsupported_scheme", transaction:"", network}`; malformed body → 400 `{error}`; exception → 500 `{error}`. A non-2xx response with an `isValid` or `success` body becomes `VerifyError`/`SettleError` on the server (`httpFacilitatorClient.ts:423-497`). Prefer 200 with `isValid:false`.

---

## 6. Prior Zcash x402 work (besides Kage)

| project | what it does | wire | ids | status (evidence) |
|---|---|---|---|---|
| **CipherPay** `@cipherpay/x402` (atmospherelabs-dev/cipherpay-x402) | paywall middleware; the hosted CipherPay facilitator verifies a client-broadcast txid by Orchard trial decryption with the merchant viewing key; replay rejection; MPP; **prepaid "sessions"** via `Authorization: Bearer cps_…` and `/api/sessions/{prepare,validate,deduct}` (outside x402) | **v2** (PAYMENT-REQUIRED header + JSON body, PAYMENT-SIGNATURE `{payload:{txid}}`, PAYMENT-RESPONSE `{success, transaction:txid, network}`); legacy X-PAYMENT | `scheme:"exact"`, `zcash:mainnet` default, `asset:"ZEC"`, amount zats | npm 0.6.0, 2026-04-27 (`npm view`); spec PR #1634 open, no reviews (2026-03-16); issue #1633 open |
| **zpay** (gustavovalverde/zpay) | Rust facilitator: `/x402/v2/supported`, `/verify`, `/settle`; client sends a **PCZT** that zpay verifies (recipient and amount) **before** broadcasting itself | v2, ADR 0011 "x402-zcash-exact-v1" | `exact`, `zcash:mainnet\|testnet\|regtest`, `ZEC`, `extra.binding`, `extra.amountUnit:"zat"`, payload `{format:"pczt-v2-extractable", pczt}`, codes `zcash_exact_*` | HEAD `94828c78` 2026-07-21 |
| **x402-zcash** (dmarzzz) | TS exact support via Zallet PCZTs, Zakura settlement | v2, `assetTransferMethod:"zcash-pczt"`, `paymentFlow:"upfront"` | `exact`, **`bip122:00040fe8…`/`bip122:05a60a92…`**, `ZEC`; codes `invalid_exact_zcash_*` | HEAD `85dfc2e7` 2026-09-01 |
| **Erudite** `@erudite-intelligence/x402-zec` | transparent-only exact; client-signed raw tx; facilitator broadcasts via Blockchair | v1 | `exact`, `bip122:00040fe8ec8471911baa1db1266ea15d` | npm 1.0.0 2026-03-07; PR #1501 closed 2026-03-09 |
| **Frontier Compute** zcash-402 / `@frontiercompute/zcash-402` / x402-zec; ZAP1 | MCP facilitator, memo payment-id matching, "split-key MPC signing", ZAP1 Merkle receipts anchored to Zcash | v1 (X-PAYMENT) | `zcash:mainnet` (PR #1990 stub) | npm 0.1.0 2026-04-10; PR #1990 closed 2026-07-29; repo `d59cde45` 2026-08-03 |
| **ASH** (devIykee/ash) | agent commerce on shielded Zcash: 402 challenge, one-time fulfilment, TS SDK | v2 (PAYMENT-SIGNATURE) | `zcash-shielded`, `zcash:testnet\|mainnet`, `ZEC` | HEAD `352babb7` 2026-10-27 |
| **Hanko** (nickthelegend/zec-payment-verify-sdk) | IVK verification SDK; gateway with the x402 v1 paywall format | v1 | — | see `hanko.md` (other track) |
| **zec-null-402 "Kippu"** (nickthelegend) | one shielded deposit funds N notes; each call pays with a Groth16 proof; nullifiers; signed anchors in memos | own (`X-PAYMENT`, `x402Version:1` mentions) | memo `z402:<commitment>` | live testnet runs 2026-10-20/22 (README) |
| **Rill** (userill.com, `@userill/accept` 0.1.0) | multi-rail 402; shielded ZIP-321 URI with `memo = resource_id`; would consume the CipherPay, zpay and x402-zcash dialects | MPP + x402 | — | ZCG grant declined 2026-09-30 (forum t/57595) |
| **Shielded x402** (ZCG #445/#446, baby-zack-agent) | spec plus `x402-shielded` crate; the spec is not x402-wire (`{"payment":{"type":"shielded-x402",…}}`, PR #446 head `901ca6a2` `docs/specs/shielded-x402.md`) | non-x402 | — | ZCG "Declined" in the 2026-09-28 meeting minutes (forum t/57928); application thread t/57826 |
| x402-Compatible Payment Bridge (Krish) | proposal only | — | — | ZCG declined 2026-02-16 (forum t/54644) |
| zimppy (betterclever) | MPP (not x402) for Zcash | MPP | — | npm 0.5.0 2026-04-06 |
| x402_treazury (mikeperry-tor), seneschal-data-api (Rotwang9000) | peripheral: Tor plus ZEC→USDC funding; view-key payment watching | x402 on other rails | — | HEAD 2026-10-27 / 2026-08-01 |

Forum pointers (DrVelvetFog, t/57826 #4, 2026-09-28, who runs an x402 facilitator on Sui): "Who holds the viewing key… If that's a shared facilitator, the facilitator sees every payment that seller receives". On binding: "The 402 flow has to tie each payment to one resource and one nonce… Rill uses the memo for the resource id and zpay uses a PCZT binding." z402 answers both: the facilitator is merchant-run, and the memo binds the deposit to the session while the voucher signature binds each call.

---

## 7. Scheme id recommendation

**Primary: `prepaid-voucher`.**
- It names the semantics. The client prepays a window onchain directly to `payTo`, then draws it down with cumulative signed vouchers; the trust ramp is server policy carried in `extra`.
- kebab-case and chain-agnostic, like `batch-settlement`/`auth-capture` (§2.1). The binding doc would be `scheme_prepaid_voucher_zcash.md`.
- Collision checks (2026-10-27): no exact-phrase hits in x402-foundation/x402 issues or PRs (GitHub search `"prepaid-voucher"`: 0 results). No web hits. Not a paymentFlow, ATM, or batch-settlement `payload.type` value. "prepaid" alone appears only as a hypothetical in PR #1004: "Other payment schemes (e.g., `deferred`, `prepaid`) may define different replay semantics where a single `txRef` can authorize multiple service deliveries by tracking and decrementing a balance" (`scheme_exact_txid.md` §6.3).

Alternatives:
1. `deposit-voucher`: same meaning. "deposit" is also a batch-settlement `payload.type`, a word-level clash only. No exact match found.
2. `prepaid-tab`: suggests a running total with credit. Possible confusion with Kage's `zcash-shielded-tab` (blind tokens).
3. `zcash-voucher` (suggested by the kage track): collision-proof, but it puts the chain in the scheme id, against x402 convention (the `zcash-*` ids are v1-era Kage/ASH style).

Rejected:
- `batch-settlement` with a Zcash binding: semantic mismatch ("value moves later, through the network binding's redemption process", `scheme_batch_settlement.md:15-17`; z402's value moves first). SDK implementations already exist under that id. A future official Zcash binding could conflict.
- `deferred`, `channel`, `statechannel`, `escrow`, `upfront`: taken, closed, or flow names.
- `stream`/`zcash-stream`: `upto` lists "Multi-settlement / streaming" as a future scheme, so collision risk.
- `session`/`zcash-session`: CipherPay "sessions", plus the `metered-session`/`agreement-session` proposals.
- `tab`: Kage.
- `z402*`: npm `z402`, Kippu.

---

## 8. Proposed z402 wire contract (derived from the rules above; for the build agents to confirm)

### 8.1 402 entry (server → client, in `PAYMENT-REQUIRED`)
```json
{
  "scheme": "prepaid-voucher",
  "network": "zcash:testnet",
  "amount": "1000",
  "asset": "ZEC",
  "payTo": "<merchant Orchard-only UA, utest1…>",
  "maxTimeoutSeconds": 60,
  "extra": { "windowZat": "100000", "creditRatioBps": 2500, "creditCapZat": "200000", "minConfirmations": 1 }
}
```
Static per route. Zat values are strings (`^[0-9]+$`, like `amount` and batch-settlement `minDeposit`). An integer basis-point ratio avoids float arithmetic in the limit rule and cross-language number formatting. The MVP's `0.25` would still deep-equal in JS, so this is hygiene, not a requirement. No `assetTransferMethod`/`paymentFlow` keys.

### 8.2 `PaymentPayload.payload` (client → server, in `PAYMENT-SIGNATURE`)
```json
{ "sessionKey": "<64 lowercase hex ed25519 pubkey>", "cumulativeZat": "53000",
  "sig": "<128 lowercase hex ed25519 sig over VoucherMessage>", "depositTxid": "<64 hex, display order; optional>" }
```
- Deposit memo `<sessionKey>:<depositIndex>` (MVP). This is the request binding.
- **Resend `depositTxid` on every call until a successful PAYMENT-RESPONSE acknowledges it.** If the handler of the depositing call fails, `/settle` never runs (§4.2), so the deposit is not credited yet.

### 8.3 Facilitator behaviour
- `/verify` (read-only):
  - `accepted` deep-equals `paymentRequirements`; `x402Version === 2`; scheme and network supported.
  - Decode the payload and check the signature.
  - If `depositTxid` is present: fetch it (mempool wait ≤ 15 s), trial-decrypt with the IVK, and require ≥ `windowZat` to `payTo`, the memo, and no transparent part. Evaluate the limit **as if** credited, without writing.
  - Check `c_new − c_last ≥ amount` and `c_new ≤ limit`.
  - Return `{isValid, invalidReason?, invalidMessage?, payer: sessionKey, extra: {limitZat, headroomZat}}`.
- `/settle`:
  - Under a per-session lock, re-run the checks.
  - Credit the deposit idempotently, keyed `zcash:testnet:<txid>`. Reject it if it is already bound to another session.
  - Set `c_last = c_new`.
  - Return `{success:true, transaction: depositTxid|"" , network, payer: sessionKey, amount?: depositValue, extra: {chargedAmount: amount, commitmentId: "<sessionKey>:<c_new>", session: {confirmedZat, pendingZat, creditZat, limitZat, cumulativeZat, headroomZat, deposits:[{txid, valueZat, confirmations}]}}}`.
  - Failures: `{success:false, errorReason, errorMessage, transaction:"", network, payer}`.
- `/supported`: `{"kinds":[{"x402Version":2,"scheme":"prepaid-voucher","network":"zcash:testnet"}],"extensions":[],"signers":{"zcash:*":[]}}`.

### 8.4 VoucherMessage (proposal, modelled on the SVM byte layouts)
```
UTF8("x402:prepaid-voucher:zcash:voucher:v1") ‖ 0x00 ‖
u16le(len(network)) ‖ UTF8(network) ‖ u16le(len(payTo)) ‖ UTF8(payTo) ‖
sessionKey[32] ‖ u64le(cumulativeZat)
```
The MVP's "payTo + cumulativeZat" works too. The domain tag plus network stop cross-scheme and cross-network reuse.

### 8.5 Client rules
- Update local state only from its own state plus `extra.chargedAmount`, treating the snapshot as untrusted (borrowed rule, §2.4).
- Serialize calls per session.
- Implement `findDefaultAsset`, or document a `spendControls` line.
- Enforce `windowZat ≤ context.maxAmountPerPayment`.
- Optionally handle a corrective 402 in `onPaymentResponse` and return `{recovered:true}`.

### 8.6 Error codes
Standard codes where they fit: `invalid_x402_version`, `unsupported_scheme`, `invalid_network`, `invalid_payload`, `invalid_payment_requirements`, `unexpected_verify_error`, `unexpected_settle_error`.

Scheme codes, all prefixed `invalid_prepaid_voucher_zcash_`:
- `requirements_mismatch`, `session_key`, `signature`
- `cumulative_not_increased`, `limit_exceeded` (the client reads this as "deposit now")
- `deposit_not_found`, `deposit_not_decryptable`, `deposit_amount_too_low`, `deposit_memo_mismatch`
- `deposit_transparent`, `deposit_session_mismatch`, `deposit_conflicted`

---

## 9. Cross-track facts found here (so others need not redo them)

- **Testnet runs NU7 with ~25 s blocks.**
  - Branch id `77190ad9` is `Nu7` ("ZIP 259, matching zcash_protocol's `BranchId::Nu7`"), and `37a5165b` is `Nu6_3` "Ironwood" (`zebra-chain/src/parameters/network_upgrade.rs:232-246`).
  - `POST_NU7_POW_TARGET_SPACING = 25` (`:261`).
  - NU7 heights: testnet `4_465_026`, mainnet `3_543_405` (`constants.rs:76,106`).
  - Measured spacing: testnet blocks 4,546,000→4,547,000 averaged **25.32 s**; mainnet 3,532,000→3,532,200 averaged **70.8 s**.
  - Mainnet lightwalletd reports `"upgradeName":"NU7","upgradeHeight":"3543405"` at height 3,532,346, about 11k blocks (~9.6 days at 75 s) away. Testnet reports no pending upgrade.
  - The MVP doc's "~75 s per payment" is outdated for testnet.
- **The stock client spend-control blocker** (§1.8). The x402-sdk-server and x402-e2e-spike notes found the same.

## Open questions

- Will x402 maintainers accept `zcash:` (an unregistered namespace) in a future spec PR, or ask for `bip122:` or a registered `zcash:<genesis32>`? PR #1634 got no review in 7 months.
- Should `payer` carry the session key (pseudonymous, aids logs) or be omitted (more private)?
- Exact-equality (`==`, batch-settlement) or lenient (`≥`, MVP) increment rule? `≥` avoids corrective 402s. `==` detects client desync early.
- Should the voucher also bind `resource.url`? Batch-settlement vouchers do not; a leaked voucher is redeemable at any route of the same merchant.

---

## Verification corrections

This is the fact-check of this file's load-bearing claims, done 2026-10-27 by the verify-x402-spec track. Of the 18 claims checked, 17 hold and one holds only in part (item 1). Items 2-9 correct or add to statements elsewhere in this file that the build relies on.

Sources and probes:
- x402-foundation/x402 HEAD `1148309d` (2026-10-27). `specs/` and `docs/` are unchanged since `636f5856`. Tag `npm-@x402/core@v2.28.0` = `6b6ee91f`.
- The npm tarballs @x402/core, @x402/fetch and @x402/express 2.28.0. The core tarball's sha1 is `22ed0e4e…`, and its `dist/` is byte-identical to the one the probes ran.
- The probes run the real SDK (zod 3.25.76, express 5.1.0) with dummy schemes and no chain. `$VSPIKE` = `/private/tmp/claude-501/-Users-oynozan-Desktop-Dev-Web3-z402/afbb7c76-d88e-47a4-8a53-fd001155f8ac/scratchpad/spikes/verify-x402-spec`.
  - `$VSPIKE/probe.mjs` writes `probe.out`.
  - `probe2.mjs` writes `probe2.out`.
  - `startup.mjs` writes `startup-missing.out` and `startup-down.out`.
- Core paths below are relative to `typescript/packages/core/src`, at the tag.

1. **Partly right: "Every prior Zcash x402 implementation uses `"ZEC"` with amounts in zatoshis" (§1.2, §6).**
   - The exception is Kippu (nickthelegend/zec-null-402 @`84b78b8a`). Its x402-v1-styled challenge has no `asset` field and prices in note units through `requiredAmount` (`packages/gateway/src/gateway.ts:82-96`, `unitZat` at `:48-49`). README `:35`: "1 unit = 1,000 zat; a call costs 10 units".
   - Every x402-wire implementation does use `"ZEC"` with zatoshis:
     - CipherPay 0.6.0, `dist/middleware.js:86-103`.
     - zpay, ADR 0011 `:36-43`.
     - dmarzzz, `specs/exact-zcash.md:21`.
     - Erudite, PR #1501 `scheme_exact_zec.md:17,50`.
     - ASH, `src/services/x402.ts:39-42`.
     - Kage and Hanko (both v1, `zcash-testnet`).
   - The recommendation `asset: "ZEC"` stands.

2. **Network matching is not exact-string everywhere (§3.1).**
   - Facilitator dispatch first checks the set of registered networks. It then tries a derived `namespace:*` pattern when one `register([...])` call names two or more networks of the same namespace (`facilitator/x402Facilitator.ts:313-326`; `derivePattern` at `:542-557`).
     - So `register(["zcash:testnet","zcash:mainnet"], s)` would also send `zcash:regtest` to `s`. The scheme must check `requirements.network` itself.
   - Server and client scheme lookup try the exact key, then any registered pattern key (`utils/index.ts:127-153`).
   - Only two lookups are exact:
     - the `/supported` kind lookup (`server/x402ResourceServer.ts:733-736` compares `x402Version`, `network` and `scheme` with `===`);
     - the match of `accepted` against requirements.
   - Ran it (probe T1b): a `/supported` kind whose network is `"zcash:*"` is refused. The facilitator must advertise the concrete `zcash:testnet` kind.

3. **A missing kind kills the API server at startup (§1.6).**
   - `paymentMiddleware()` calls `httpServer.initialize()` as soon as it is constructed, because `syncFacilitatorOnStart` defaults to true (`@x402/express src/index.ts:110-124,480-495`).
   - Route validation then throws `RouteConfigurationError`: `Route "GET /chunk": Facilitator does not support scheme "prepaid-voucher" on network "zcash:testnet"` (`http/x402HTTPResourceServer.ts:1211-1226`).
   - `attachBackgroundInitHandler` responds with `process.exit(1)` (`http/backgroundInit.ts:27-33`). Ran it: `startup-missing.out` ends in exit=1.
   - The `:788` message quoted in §1.6 appears only when requirements are built without that kind.
   - An unreachable facilitator is not fatal. Protected requests get HTTP 500 `{"error":"Internal Server Error"}` until `/supported` answers, then the server recovers on its own (`startup-down.out`).
   - **Start the facilitator before the API server.**

4. **The facilitator's HTTP status is part of the contract (§5, "Prefer 200 with isValid:false").**
   - On `/verify`, a non-2xx response with an `isValid` body becomes a `VerifyError` whose message is `<invalidReason>: <invalidMessage>` (`types/facilitator.ts:56-71`).
   - The resource server puts that whole string into the new `PAYMENT-REQUIRED.error` (`http/x402HTTPResourceServer.ts:739-753`).
   - Ran it (`probe2.out`):
     - HTTP 200 gives the client `error:"invalid_prepaid_voucher_zcash_signature"`.
     - HTTP 400 gives it `error:"invalid_prepaid_voucher_zcash_signature: bad sig"`.
     - A non-2xx response without `isValid` gives it `error:"Facilitator verify failed (<status>): <body excerpt>"`.
   - On `/settle`, a non-2xx response with a `success` body keeps the bare `errorReason` in PAYMENT-RESPONSE.
   - **So `/verify` must answer HTTP 200 for every `isValid:false`.** Otherwise clients that match on codes break.

5. **The reference facilitator has a branch that the stock client turns into a 502 (§5).**
   - The "Settlement aborted" branch of `examples/typescript/facilitator/basic/index.ts:294-304` (@`02a5c749`) returns `{success:false, errorReason, network}` with no `transaction`.
   - It reads `network` from `req.body.paymentPayload.network`. v2 payloads have no such field, so the value is `"unknown"`.
   - Ran it (`probe2.out`, "S200 reference-example abort shape"): through the stock client this is HTTP 502.
   - Always send `transaction: ""` and take `network` from `paymentRequirements.network`.

6. **Facilitator timeouts become 502, not 402 (§4.2).**
   - `FacilitatorTimeoutError` extends `FacilitatorResponseError` (`types/facilitator.ts:114,137`).
   - Ran it (probe T12): `timeoutMs:300` against an 800 ms `/verify` gave HTTP 502 `{"error":"Facilitator verify request timed out after 300ms"}`. The stock wrapper hands that 502 to the agent as-is.
   - Other non-402 statuses that 2.28.0 emits:
     - 403 when an `onProtectedRequest` hook aborts (`http/x402HTTPResourceServer.ts:550-557`).
     - 412 when `error === "permit2_allowance_required"` (`:1318-1320`).
     - 500 for unexpected errors.
   - It never emits 400. A malformed `PAYMENT-SIGNATURE`, or a payload sent only as `X-PAYMENT`, gets a fresh 402 with `error:"Payment required"`, and `/verify` is not called (probe T3, T3b).

7. **The client never sees `/verify`'s `extra` (§8.3).**
   - On a verify failure, only `invalidReason` reaches the client, as `PaymentRequired.error` (`http/x402HTTPResourceServer.ts:669-682`). `invalidMessage` and `extra` are dropped (probe T4: the client hook sees only `paymentRequired.error`).
   - On success, no part of the VerifyResponse is sent to the client.
   - The SettleResponse does reach the client, `extra` included, in PAYMENT-RESPONSE. Only `extensionResponses` is stripped (`http/index.ts:63-68`; probe T6b).
   - **Put the session snapshot in the settle `extra`.**
   - For a corrective 402 that carries state, the server scheme must add the state itself through `enrichPaymentRequiredResponse`.
     - That hook receives `error` and `paymentPayload` but not the VerifyResponse, and may only add `extra` keys (`server/x402ResourceServer.ts:890-949`).
     - One way is to capture `VerifyResponse.extra` in `schemeHooks.onAfterVerify`, which runs for invalid results too (`:1089-1092`, `:1669-1712`).

8. **"Payment already attempted" is thrown only after the scheme has already run (§4.4 step 3).**
   - The check is at `@x402/fetch src/index.ts:109`, after `client.createPaymentPayload()` at `:98`.
   - Ran it (probe T10): `createPaymentPayload` ran once before the throw. If the z402 client scheme sends a deposit inside `createPaymentPayload`, the deposit has already gone out when this error fires.
   - When the scheme itself throws, the wrapper rethrows the error as `Failed to create payment payload: …` (`:99-103`) instead of returning a Response.

9. **The SDK client is more lenient than the spec on `/supported` (§1.6).**
   - `HTTPFacilitatorClient` defaults `extensions` to `[]` and `signers` to `{}` when they are omitted (`http/httpFacilitatorClient.ts:208-212`; probe T0b).
   - The signers key is the facilitator scheme's `caipFamily` (`facilitator/x402Facilitator.ts:253-258`). So `{"zcash:*": []}` requires `caipFamily: "zcash:*"`.
   - Ran it (T0): `x402Facilitator.getSupported()` returned `{"kinds":[{"x402Version":2,"scheme":"prepaid-voucher","network":"zcash:testnet"}],"extensions":[],"signers":{"zcash:*":[]}}`.

These were confirmed by running them, so no correction is needed:
- T11: the default timeout is 90 s.
- T5: a failed settle gives 402 with PAYMENT-RESPONSE `success:false` and body `{}`. The handler output is discarded, although the handler did run.
- T6: a settle body without `transaction` gives 502.
- T6b: unknown top-level keys are stripped.
- T7: a handler 500 means no `/settle`, and the handler's own response passes through.
- T8 and T8b: `settlement_pending` with a txid gives two settles; with `""` it gives one.
- T9 and T9b: the client recovers at most once.
- T13: the facilitator receives `{x402Version, paymentPayload:{x402Version,payload,resource,accepted}, paymentRequirements}`, and `accepted` deep-equals `paymentRequirements`.

One line-number nit: `getPaymentRequiredResponse` is at `http/x402HTTPClient.ts:117-138`.
