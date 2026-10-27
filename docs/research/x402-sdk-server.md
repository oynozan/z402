# x402 SDK: server and facilitator side (track x402-sdk-server)

z402 research notes, 2026-10-27. Scope: how to build a custom x402 v2 scheme on the resource-server and facilitator side with `@x402/*` 2.28.0, and the exact HTTP facilitator API. Every statement cites the 2.28.0 source, the published dist, a spec, or a local run. Anything labelled **Proposal** is a design suggestion for the two build agents, not SDK behaviour.

## TL;DR

1. A custom scheme is three classes on `@x402/core` 2.28.0: `SchemeNetworkServer` (2.22.0+ also **requires** `defaultAssetTransferMethod` and `paymentFlows`), `SchemeNetworkFacilitator` (`scheme`, `caipFamily`, `getExtra`, `getSigners`, `verify`, `settle`), and the client's `SchemeNetworkClient`. The skeleton in section 9 compiles under tsc 7.0.2 and 5.9.3. A local round trip through a stock `@x402/fetch` client ran 74 voucher calls in about 85 ms.
2. The facilitator speaks plain HTTP. `POST /verify` and `POST /settle` receive `{x402Version, paymentPayload, paymentRequirements}` and should answer 200 with a `VerifyResponse` or `SettleResponse`. A settle reply that lacks `transaction` (a string, `""` allowed) or `network` makes the API return **502**. Never use errorReason `settlement_pending`: it triggers one automatic re-settle. `GET /supported` returns `{kinds:[{x402Version:2,scheme,network:"zcash:testnet",extra}],extensions:[],signers:{"zcash:*":[]}}`.
3. Express runs the `authorization` flow: verify, then the handler (its output is buffered), then settle, then the response goes out with `PAYMENT-RESPONSE`. A handler status of 400 or more skips settle. A failed settle returns 402 with `PAYMENT-RESPONSE{success:false,errorReason,errorMessage}` and **no** `PAYMENT-REQUIRED`. A failed verify returns 402 with `PAYMENT-REQUIRED` whose `error` is `invalidReason` only; `invalidMessage` is dropped.
4. Startup: the middleware fetches `/supported` once, when it is constructed, and caches the result. If the facilitator is down, protected routes return 500 until it comes up (init is retried per request). If the facilitator is up but lacks our kind or terms, the process calls `exit(1)`.
5. The client's `accepted` must deep-equal the server-built requirement on scheme, network, amount, asset, payTo and maxTimeoutSeconds, and its `extra` must be a superset, so keep requirements deterministic. Proposal: the facilitator owns the trust-ramp terms and exposes them through `getExtra()` and `/supported`; the server's `enhancePaymentRequirements` copies them into `accepts[].extra`.
6. **Blocker for "one register line":** a stock `x402Client` rejects non-default assets through its default `spendControls`. The zcash client scheme must implement `findDefaultAsset("ZEC","zcash:testnet")`, which makes the cap "$1" = 1e8 zat. The alternative is for the agent to call `setSpendControls(...)`. Both paths ran.
7. Price is `{ amount: "1000", asset: "ZEC" }`, which `parsePrice` passes through. A `$` price would need a custom money parser, since no USD default asset exists for Zcash, and USD pricing is out of MVP scope anyway.
8. A failed verify can carry session state: `VerifyResponse.extra`, then a scheme `onAfterVerify` hook, then a corrective 402 with `accepts[0].extra.session`. A client `onPaymentResponse` hook that returns `{recovered:true}` then gets exactly one automatic retry from the stock wrapper. This ran end to end.
9. The SDK accepts the network id `zcash:testnet` (`${string}:${string}`). The CAIP registry has no zcash namespace; the CAIP-compliant alternative would be `bip122:05a60a92d99d85997cce3b87616c089f` (testnet genesis prefix, probed).

## 0. Sources, versions, reproduction

Path variables used below:

- `$X402` = `/private/tmp/claude-501/-Users-oynozan-Desktop-Dev-Web3-z402/afbb7c76-d88e-47a4-8a53-fd001155f8ac/scratchpad/downloads/x402-sdk-server/repo-v2.28.0`. This is a shallow clone of `github.com/x402-foundation/x402` at tag `npm-@x402/core@v2.28.0`, commit `6b6ee91fee027b540faabcb25774e73851006c3b` (2026-09-29 21:01 +0200, "chore(go): release (#3629)"). The same commit carries the 2.28.0 tags for express, fetch, extensions and evm (`git ls-remote --tags https://github.com/x402-foundation/x402.git`). Every npm `package.json` gives `"repository": "https://github.com/x402-foundation/x402"`.
- `github.com/coinbase/x402`, as the task named it, is now a downstream mirror: HEAD `0e6e8c55d86b4f14234fb6e49a4052074fb93e57`, "chore: sync upstream main (#413)", 2026-10-15. It is cloned at `.../downloads/x402-sdk-server/repo`. Against the tag, its core `src/` differs in one place only: an unreleased HEAD-to-GET route fallback in `x402HTTPResourceServer.getRouteConfig` (`diff -rq`).
- `$NPM` = `/private/tmp/claude-501/-Users-oynozan-Desktop-Dev-Web3-z402/afbb7c76-d88e-47a4-8a53-fd001155f8ac/scratchpad/downloads/x402-sdk-server/npm` holds the `npm pack` tarballs, extracted:
  - `@x402/core@2.28.0`: sha1 `22ed0e4e49fdd3dda30b0d6a93289b647f46b533`, integrity `sha512-Da/7zKxCKqpBoB4Msc9tFgkAv7tJTD8nG+DSSm+QdXAyJS4PQsmgVSKe17rDJTtlu0pwNbLcOje6MyQ6kaDkig==`. Its only runtime dependency is `zod ^3.24.2`.
  - `@x402/express@2.28.0`: sha1 `cfc3b298359e5fb6ff26f57f553d8ddf6969190a`. Dependencies: `@x402/core ~2.28.0` and `@x402/extensions ~2.28.0`. Peer dependencies: `express ^4 || ^5` and an optional `@x402/paywall`.
  - `@x402/fetch@2.28.0`: sha1 `a80210e45dc1f1af4658149bfcb9d25760646b1a`. Dependency: `@x402/core ~2.28.0`.
  - npm `time.modified` is 2026-09-29T19:03:58Z and `latest` is 2.28.0 for all three.
- The published dist matches the tag's source on every behaviour quoted here. Spot checks in `$NPM/x402-core-2.28.0/package/dist/cjs`: `this.spendControls = {}` at client/index.js:222, `DEFAULT_TIMEOUT_MS = 9e4` at server/index.js:600, the settle zod schema at :631-641, `maxTimeoutSeconds || 300` at :1377, and `SETTLEMENT_PENDING_REASON` at :970. Express dist: `res.statusCode >= 400` at :293, `res.status(402).json({})` at :373. Fetch dist: "Payment already attempted" at :53.
- `$SPIKE` = `/private/tmp/claude-501/-Users-oynozan-Desktop-Dev-Web3-z402/afbb7c76-d88e-47a4-8a53-fd001155f8ac/scratchpad/spikes/x402-sdk-server` holds the compiled skeleton and the probes. Installed there: `@x402/core|express|fetch@2.28.0` (with `@x402/extensions@2.28.0` transitively), `express@5.3.0`, `@types/express@5.0.6`, `@types/node@26.6.5`, `typescript@7.0.2`, `typescript@5.9.3` (aliased `typescript5`), `tsx@4.23.15`, on node v26.11.0.

Reproduce (results from the final run are in `$SPIKE/typecheck-ts7.log`, `$SPIKE/typecheck-ts5.log` and `$SPIKE/probe-*.log`):

```sh
cd "$SPIKE"
./node_modules/.bin/tsc --noEmit -p tsconfig.json                 # TS 7.0.2  -> exit 0
node node_modules/typescript5/bin/tsc --noEmit -p tsconfig.json   # TS 5.9.3  -> exit 0
./node_modules/.bin/tsx src/probe/roundtrip.ts     # real facilitator app + API + stock @x402/fetch, stub chain
./node_modules/.bin/tsx src/probe/failures.ts      # API <-> fake facilitator failure modes
./node_modules/.bin/tsx src/probe/recovery.ts      # corrective 402 + onPaymentResponse auto-retry
./node_modules/.bin/tsx src/probe/concurrency.ts   # 20 concurrent settles of one voucher
./node_modules/.bin/tsx src/probe/startupFatal.ts wrong-scheme   # exit 1
./node_modules/.bin/tsx src/probe/startupFatal.ts no-terms       # exit 1
./node_modules/.bin/tsx src/probe/startupFatal.ts down           # stays up, exit 0 after 3 s
```

Import paths (from `$NPM/x402-core-2.28.0/package/package.json` `exports`): `@x402/core` (exports only `x402Version = 2`), `@x402/core/types`, `@x402/core/facilitator`, `@x402/core/server`, `@x402/core/http`, `@x402/core/client`, `@x402/core/utils`, `@x402/core/schemas`, `@x402/core/types/v1`. `PaymentOption` is exported from `@x402/core/http` only, not from `/server` (checked against the `.d.mts` export lists).

## 1. Core types (verbatim)

### 1.1 Network, Money, AssetAmount, Price

Source: `$X402/typescript/packages/core/src/types/index.ts:62-70`

```ts
export type Network = `${string}:${string}`;

export type Money = string | number;
export type AssetAmount = {
  asset: string;
  amount: string;
  extra?: Record<string, unknown>;
};
export type Price = Money | AssetAmount;
```

### 1.2 ResourceInfo, PaymentRequirements, PaymentRequired, PaymentPayload (the v2 envelope)

Source: `$X402/typescript/packages/core/src/types/payments.ts:3-36`

```ts
export interface ResourceInfo {
  url: string;
  description?: string;
  mimeType?: string;
  serviceName?: string;
  tags?: string[];
  iconUrl?: string;
}

export type PaymentRequirements = {
  scheme: string;
  network: Network;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: Record<string, unknown>;
};

export type PaymentRequired = {
  x402Version: number;
  error?: string;
  resource: ResourceInfo;
  accepts: PaymentRequirements[];
  extensions?: Record<string, unknown>;
};

export type PaymentPayload = {
  x402Version: number;
  resource?: ResourceInfo;
  accepted: PaymentRequirements;
  payload: Record<string, unknown>;
  extensions?: Record<string, unknown>;
};
```

Version placement. `PaymentRequired.x402Version` and `PaymentPayload.x402Version` are 2. `PaymentRequirements` carries no version. In `/supported`, each `kinds[]` entry carries its own `x402Version`. The `/verify` and `/settle` request bodies repeat it at top level, copied from `paymentPayload.x402Version` (section 3.1).

### 1.3 VerifyRequest/Response, SettleRequest/Response, SupportedKind, SupportedResponse

Source: `$X402/typescript/packages/core/src/types/facilitator.ts:4-51`

```ts
export type VerifyRequest = {
  x402Version: number;
  paymentPayload: PaymentPayload;
  paymentRequirements: PaymentRequirements;
};

export type VerifyResponse = {
  isValid: boolean;
  invalidReason?: string;
  invalidMessage?: string;
  payer?: string;
  extensions?: Record<string, unknown>;
  extensionResponses?: Record<string, unknown>;
  extra?: Record<string, unknown>;
};

export type SettleRequest = {
  x402Version: number;
  paymentPayload: PaymentPayload;
  paymentRequirements: PaymentRequirements;
};

export type SettleResponse = {
  success: boolean;
  errorReason?: string;
  errorMessage?: string;
  payer?: string;
  transaction: string;
  network: Network;
  /** Actual amount settled in atomic token units. Present for schemes like `upto` where settlement amount may differ from the authorized maximum. */
  amount?: string;
  extensions?: Record<string, unknown>;
  extensionResponses?: Record<string, unknown>;
  extra?: Record<string, unknown>;
};

export type SupportedKind = {
  x402Version: number;
  scheme: string;
  network: Network;
  extra?: Record<string, unknown>;
};

export type SupportedResponse = {
  kinds: SupportedKind[];
  extensions: string[];
  signers: Record<string, string[]>; // CAIP family pattern → Signer addresses
};
```

Error classes in the same file (lines 56-175):
- `VerifyError(statusCode, VerifyResponse)` has the message `` `${invalidReason}: ${invalidMessage}` ``.
- `SettleError(statusCode, SettleResponse)`.
- `FacilitatorResponseError(message)`, used for malformed facilitator replies.
- `FacilitatorTimeoutError(operation, timeoutMs)`, which extends `FacilitatorResponseError`.
- `FacilitatorCapabilityError(problems[])`.
- `getFacilitatorResponseError(err)` walks the `cause` chain looking for a `FacilitatorResponseError`.

### 1.4 Scheme interfaces (types/mechanisms.ts)

Source: `$X402/typescript/packages/core/src/types/mechanisms.ts:25-57`

```ts
/**
 * Money parser that converts a decimal amount to an AssetAmount.
 * `parsePrice` always passes the decimal string produced by parseMoney.
 * Returns null to indicate "cannot handle this amount", causing fallback to next parser.
 * Always returns a Promise for consistency - use async/await
 *
 * @param amount - Decimal amount as a string (or number, if the parser is called directly)
 * @param network - The network identifier for context
 * @returns AssetAmount or null to try next parser
 */
export type MoneyParser = (
  amount: string | number,
  network: Network,
) => Promise<AssetAmount | null>;

/**
 * Result of createPaymentPayload - the core payload fields.
 * Contains the x402 version, scheme-specific payload data, and optional extension data.
 * Schemes may return extensions (e.g., EIP-2612 gas sponsoring) that get merged
 * with server-declared extensions in the final PaymentPayload.
 */
export type PaymentPayloadResult = Pick<PaymentPayload, "x402Version" | "payload"> & {
  extensions?: Record<string, unknown>;
};

/**
 * Context passed to scheme `createPaymentPayload`.
 * `maxAmountPerPayment` is the resolved atomic spend cap; omitted when uncapped.
 */
export interface PaymentPayloadContext {
  extensions?: Record<string, unknown>;
  maxAmountPerPayment?: string;
}
```

Source: `$X402/typescript/packages/core/src/types/mechanisms.ts:66-102`

```ts
/** USD-pegged asset for money strings and client spend caps. See DEFAULT_ASSETS.md. */
export interface DefaultAsset {
  /** Asset id as advertised in payment requirements. */
  asset: string;
  decimals: number;
  /** Ticker for suffixed prices (e.g. `"0.10 USDC"`). */
  symbol: string;
}

/** Per-network default assets; index 0 is the bare `"$0.10"` default. */
export type DefaultAssetTable<T extends DefaultAsset = DefaultAsset> = Record<string, readonly T[]>;

/** `(network, symbol?) => entry`; throws when unknown. */
export type GetDefaultAsset<T extends DefaultAsset = DefaultAsset> = (
  network: Network,
  symbol?: string,
) => T;

/** `(asset, network) => entry | undefined`. */
export type FindDefaultAsset<T extends DefaultAsset = DefaultAsset> = (
  asset: string,
  network: Network,
) => T | undefined;

export interface SchemeNetworkClient {
  readonly scheme: string;
  readonly schemeHooks?: SchemeClientHooks;

  /** Optional reverse lookup for USD spend caps. Not the same as `getAssetDecimals`. */
  findDefaultAsset?: FindDefaultAsset;

  createPaymentPayload(
    x402Version: number,
    paymentRequirements: PaymentRequirements,
    context?: PaymentPayloadContext,
  ): Promise<PaymentPayloadResult>;
}
```

Source: `$X402/typescript/packages/core/src/types/mechanisms.ts:104-185`

```ts
/**
 * Context passed to SchemeNetworkFacilitator.verify/settle, providing
 * access to registered facilitator extensions. Mechanism implementations
 * use this to retrieve extension-provided capabilities (e.g., a batch signer).
 */
export interface FacilitatorContext {
  getExtension<T extends FacilitatorExtension = FacilitatorExtension>(key: string): T | undefined;
}

export interface SchemeNetworkFacilitator {
  readonly scheme: string;

  /**
   * CAIP family pattern that this facilitator supports.
   * Used to group signers by blockchain family in the supported response.
   *
   * @example
   * // EVM facilitators
   * readonly caipFamily = "eip155:*";
   *
   * @example
   * // SVM facilitators
   * readonly caipFamily = "solana:*";
   */
  readonly caipFamily: string;

  /**
   * Get mechanism-specific extra data needed for the supported kinds endpoint.
   * This method is called when building the facilitator's supported response.
   *
   * @param network - The network identifier for context
   * @returns Extra data object or undefined if no extra data is needed
   *
   * @example
   * // EVM schemes return undefined (no extra data needed)
   * getExtra(network: Network): undefined {
   *   return undefined;
   * }
   *
   * @example
   * // SVM schemes return feePayer address
   * getExtra(network: Network): Record<string, unknown> | undefined {
   *   return { feePayer: this.signer.address };
   * }
   */
  getExtra(network: Network): Record<string, unknown> | undefined;

  /**
   * Get signer addresses used by this facilitator for a given network.
   * These are included in the supported response to help clients understand
   * which addresses might sign/pay for transactions.
   *
   * Supports multiple addresses for load balancing, key rotation, and high availability.
   *
   * @param network - The network identifier
   * @returns Array of signer addresses (wallet addresses, fee payer addresses, etc.)
   *
   * @example
   * // EVM facilitator
   * getSigners(network: string): string[] {
   *   return [...this.signer.getAddresses()];
   * }
   *
   * @example
   * // SVM facilitator
   * getSigners(network: string): string[] {
   *   return [...this.signer.getAddresses()];
   * }
   */
  getSigners(network: string): string[];

  verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    context?: FacilitatorContext,
  ): Promise<VerifyResponse>;
  settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    context?: FacilitatorContext,
  ): Promise<SettleResponse>;
}
```

Source: `$X402/typescript/packages/core/src/types/mechanisms.ts:187-244`

```ts
export interface SchemeServerHooks {
  onBeforeVerify?: BeforeVerifyHook;
  onAfterVerify?: AfterVerifyHook;
  onBeforeSettle?: BeforeSettleHook;
  onAfterSettle?: AfterSettleHook;
  onVerifyFailure?: OnVerifyFailureHook;
  onSettleFailure?: OnSettleFailureHook;
  onVerifiedPaymentCanceled?: OnVerifiedPaymentCanceledHook;
}

export type SchemeEnrichSettlementPayloadHook = (
  ctx: SettleContext,
) => Promise<Record<string, unknown> | void>;

export type SchemeEnrichSettlementResponseHook = (
  ctx: SettleResultContext,
) => Promise<Record<string, unknown> | void>;

export interface SchemePaymentRequiredContext {
  requirements: PaymentRequirements[];
  paymentPayload?: DeepReadonly<PaymentPayload>;
  resourceInfo: ResourceInfo;
  error?: string;
  paymentRequiredResponse: PaymentRequired;
  transportContext?: unknown;
}

export type SchemeEnrichPaymentRequiredResponseHook = (
  ctx: SchemePaymentRequiredContext,
) => Promise<PaymentRequirements[] | void>;

/**
 * Named payment flow declared by a scheme. Controls whether core verifies and/or
 * settles before the resource handler, and whether it settles after.
 *
 * Multi-settle flows (`escrow`) fire settle lifecycle hooks once per settle.
 * Side-effecting hooks should branch on {@link SettleContext.phase}.
 */
export type PaymentFlowName = "authorization" | "upfront" | "escrow";

/**
 * Phase flags for a {@link PaymentFlowName}.
 */
export interface PaymentFlowPhases {
  verifyBeforeHandler: boolean;
  settleBeforeHandler: boolean;
  settleAfterHandler: boolean;
}

/**
 * Supported payment flows for one assetTransferMethod, plus the default when
 * `extra.paymentFlow` is omitted.
 */
export interface PaymentFlowConfig {
  readonly supported: readonly PaymentFlowName[];
  /** Must be a member of {@link PaymentFlowConfig.supported}. */
  readonly default: PaymentFlowName;
}
```

Source: `$X402/typescript/packages/core/src/types/mechanisms.ts:246-337`

```ts
export interface SchemeNetworkServer {
  readonly scheme: string;
  /**
   * ATM used when `requirements.extra.assetTransferMethod` is absent.
   * Use `"default"` only as SDK plumbing when the scheme has no on-wire ATM.
   */
  readonly defaultAssetTransferMethod: string;
  /**
   * Payment flows supported per assetTransferMethod.
   * Every ATM the scheme accepts must appear here.
   */
  readonly paymentFlows: Readonly<Record<string, PaymentFlowConfig>>;
  readonly schemeHooks?: SchemeServerHooks;
  readonly dynamicExtraFields?: string[];
  enrichPaymentRequiredResponse?: SchemeEnrichPaymentRequiredResponseHook;
  enrichSettlementPayload?: SchemeEnrichSettlementPayloadHook;
  enrichSettlementResponse?: SchemeEnrichSettlementResponseHook;

  /**
   * Optional: return payment requirements to settle when a verified payment is
   * canceled (handler failure/throw or post-verify abort). Core calls
   * `settlePayment` with the returned requirements; return void to skip settle.
   *
   * @param context - Cancellation context for the verified payment
   * @returns Requirements to settle, or void to leave the payment unsettled
   */
  settleOnCancel?(
    context: VerifiedPaymentCanceledContext,
  ): PaymentRequirements | void | Promise<PaymentRequirements | void>;

  /**
   * Convert a user-friendly price to the scheme's specific amount and asset format
   * Always returns a Promise for consistency
   *
   * @param price - User-friendly price (e.g., "$0.10", "0.10", { amount: "100000", asset: "USDC" })
   * @param network - The network identifier for context
   * @returns Promise that resolves to the converted amount, asset identifier, and any extra metadata
   *
   * @example
   * // For EVM networks with USDC:
   * await parsePrice("$0.10", "eip155:8453") => { amount: "100000", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" }
   *
   * // For custom schemes:
   * await parsePrice("10 points", "custom:network") => { amount: "10", asset: "points" }
   */
  parsePrice(price: Price, network: Network): Promise<AssetAmount>;

  /**
   * Optional asset decimals for `$…` settlement overrides. Core throws when
   * this is missing or returns undefined
   *
   * @param asset - Asset address or symbol
   * @param network - Network identifier
   * @returns Decimal places, or undefined when unknown
   */
  getAssetDecimals?(asset: string, network: Network): number | undefined;

  /**
   * Build payment requirements for this scheme/network combination
   *
   * @param paymentRequirements - Base payment requirements with amount/asset already set
   * @param supportedKind - The supported kind from facilitator's /supported endpoint
   * @param supportedKind.x402Version - The x402 version
   * @param supportedKind.scheme - The payment scheme
   * @param supportedKind.network - The network identifier
   * @param supportedKind.extra - Optional extra metadata
   * @param facilitatorExtensions - Extensions supported by the facilitator
   * @returns Enhanced payment requirements ready to be sent to clients
   */
  enhancePaymentRequirements(
    paymentRequirements: PaymentRequirements,
    supportedKind: SupportedKind,
    facilitatorExtensions: string[],
  ): Promise<PaymentRequirements>;

  /**
   * Optional: validate that the facilitator's advertised capabilities for this
   * scheme/network are sufficient given the scheme's own configuration. Invoked
   * during initialize(), only when the facilitator supports the scheme.
   *
   * @param network - The network identifier being validated
   * @param supportedKind - The facilitator's advertised kind for this scheme/network
   * @param facilitatorExtensions - Extensions advertised by the facilitator
   * @returns A human-readable problem message when the configuration cannot be
   *   fulfilled, or void/undefined when valid.
   */
  validateFacilitatorSupport?(
    network: Network,
    supportedKind: SupportedKind,
    facilitatorExtensions: string[],
  ): string | void;
}
```

### 1.5 Extension types

Source: `$X402/typescript/packages/core/src/types/extensions.ts:30-111`

```ts
export interface FacilitatorExtension {
  key: string;
}

/**
 * Per-extension verify/settle hooks. Contexts are **read-only** for core protocol fields; use
 * **abort** / **recover** return values instead of mutating `paymentPayload`, `requirements`, etc.
 */
export interface ResourceServerExtensionHooks {
  onBeforeVerify?: (
    declaration: unknown,
    context: VerifyContext,
  ) => Promise<
    | void
    | { abort: true; reason: string; message?: string }
    | { skip: true; result: VerifyResponse }
  >;
  onAfterVerify?: (
    declaration: unknown,
    context: VerifyResultContext,
  ) => Promise<
    | void
    | { skipHandler: true; response?: SkipHandlerDirective }
    | { abort: true; reason: string; message?: string }
  >;
  onVerifyFailure?: (
    declaration: unknown,
    context: VerifyFailureContext,
  ) => Promise<void | { recovered: true; result: VerifyResponse }>;
  onBeforeSettle?: (
    declaration: unknown,
    context: SettleContext,
  ) => Promise<
    | void
    | { abort: true; reason: string; message?: string }
    | { skip: true; result: SettleResponse }
  >;
  onAfterSettle?: (declaration: unknown, context: SettleResultContext) => Promise<void>;
  onSettleFailure?: (
    declaration: unknown,
    context: SettleFailureContext,
  ) => Promise<void | { recovered: true; result: SettleResponse }>;
  onVerifiedPaymentCanceled?: (
    declaration: unknown,
    context: VerifiedPaymentCanceledContext,
  ) => Promise<void>;
}

export interface ResourceServerExtension {
  key: string;
  /**
   * Names of fields under the extension's `info` that are dynamic - regenerated
   * on every PaymentRequired response (e.g. nonces, timestamps) - rather than
   * static committed terms. Dynamic fields are excluded from client echo
   * validation. Defaults to none (all info fields treated as static / strict).
   */
  dynamicInfoFields?: string[];
  enrichDeclaration?: (declaration: unknown, transportContext: unknown) => unknown;
  /**
   * Return value merges into `extensions[key]`. In-place edits to `accepts` are allowlisted only
   * (see server `assertAcceptsAllowlistedAfterExtensionEnrich`): vacant `payTo` / `amount` / `asset`
   * may be filled; locked values and `scheme` / `network` / `maxTimeoutSeconds` / baseline `extra`
   * entries are immutable. `extra.paymentFlow` and `extra.assetTransferMethod` are
   * protocol-reserved and must not be added or changed during enrichment.
   */
  enrichPaymentRequiredResponse?: (
    declaration: unknown,
    context: PaymentRequiredContext,
  ) => Promise<unknown>;
  /**
   * Return value merges into `settleResult.extensions[key]`. Facilitator fields (`success`,
   * `transaction`, `network`, etc.) must not be changed; only `extensions` is merged from the hook.
   */
  enrichSettlementResponse?: (
    declaration: unknown,
    context: SettleResultContext,
  ) => Promise<unknown>;
  /** Installed on `registerExtension`; runs only when `declaredExtensions[key]` is defined. */
  hooks?: ResourceServerExtensionHooks;
  /** Transport-specific hooks scoped to declared extension keys. */
  transportHooks?: ResourceServerTransportExtensionHooks;
}
```

### 1.6 Headers and encodings

| Header | Direction | Value |
| --- | --- | --- |
| `PAYMENT-REQUIRED` | API to client, on every 402 except a settle failure | base64(JSON `PaymentRequired`) |
| `PAYMENT-SIGNATURE` | client to API | base64(JSON `PaymentPayload`); v1 used `X-PAYMENT` |
| `PAYMENT-RESPONSE` | API to client, on success and on a settle failure | base64(JSON `SettleResponse`), with `extensionResponses` stripped |
| `EXTENSION-RESPONSES` | facilitator to API only (optional sidechannel) | base64(JSON object keyed by extension) |

Sources: `$X402/specs/transports-v2/http.md:164-170`; `$X402/typescript/packages/core/src/http/x402HTTPClient.ts:93-108` (header choice by version); `httpFacilitatorClient.ts:262-274` (EXTENSION-RESPONSES).

Source: `$X402/typescript/packages/core/src/http/index.ts:11-81`

```ts
/**
 * Encodes a payment payload as a base64 header value.
 *
 * @param paymentPayload - The payment payload to encode
 * @returns Base64 encoded string representation of the payment payload
 */
export function encodePaymentSignatureHeader(paymentPayload: PaymentPayload): string {
  return safeBase64Encode(JSON.stringify(paymentPayload));
}

/**
 * Decodes a base64 payment signature header into a payment payload.
 *
 * @param paymentSignatureHeader - The base64 encoded payment signature header
 * @returns The decoded payment payload
 */
export function decodePaymentSignatureHeader(paymentSignatureHeader: string): PaymentPayload {
  if (!Base64EncodedRegex.test(paymentSignatureHeader)) {
    throw new Error("Invalid payment signature header");
  }
  return JSON.parse(safeBase64Decode(paymentSignatureHeader)) as PaymentPayload;
}

/**
 * Encodes a payment required object as a base64 header value.
 *
 * @param paymentRequired - The payment required object to encode
 * @returns Base64 encoded string representation of the payment required object
 */
export function encodePaymentRequiredHeader(paymentRequired: PaymentRequired): string {
  return safeBase64Encode(JSON.stringify(paymentRequired));
}

/**
 * Decodes a base64 payment required header into a payment required object.
 *
 * @param paymentRequiredHeader - The base64 encoded payment required header
 * @returns The decoded payment required object
 */
export function decodePaymentRequiredHeader(paymentRequiredHeader: string): PaymentRequired {
  if (!Base64EncodedRegex.test(paymentRequiredHeader)) {
    throw new Error("Invalid payment required header");
  }
  return JSON.parse(safeBase64Decode(paymentRequiredHeader)) as PaymentRequired;
}

/**
 * Encodes a payment response as a base64 header value.
 *
 * @param paymentResponse - The payment response to encode
 * @returns Base64 encoded string representation of the payment response
 */
export function encodePaymentResponseHeader(paymentResponse: SettleResponse): string {
  // Strip server-internal facilitator sidechannel; never forward to buyers.
  const buyerFacing = { ...paymentResponse };
  delete buyerFacing.extensionResponses;
  return safeBase64Encode(JSON.stringify(buyerFacing));
}

/**
 * Decodes a base64 payment response header into a settle response.
 *
 * @param paymentResponseHeader - The base64 encoded payment response header
 * @returns The decoded settle response
 */
export function decodePaymentResponseHeader(paymentResponseHeader: string): SettleResponse {
  if (!Base64EncodedRegex.test(paymentResponseHeader)) {
    throw new Error("Invalid payment response header");
  }
  return JSON.parse(safeBase64Decode(paymentResponseHeader)) as SettleResponse;
}
```

Source: `$X402/typescript/packages/core/src/utils/index.ts:185-219`

```ts
export const Base64EncodedRegex = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Encodes a string to base64 format
 *
 * @param data - The string to be encoded to base64
 * @returns The base64 encoded string
 */
export function safeBase64Encode(data: string): string {
  if (typeof globalThis !== "undefined" && typeof globalThis.btoa === "function") {
    const bytes = new TextEncoder().encode(data);
    const binaryString = Array.from(bytes, byte => String.fromCharCode(byte)).join("");
    return globalThis.btoa(binaryString);
  }
  return Buffer.from(data, "utf8").toString("base64");
}

/**
 * Decodes a base64 string back to its original format
 *
 * @param data - The base64 encoded string to be decoded
 * @returns The decoded string in UTF-8 format
 */
export function safeBase64Decode(data: string): string {
  if (typeof globalThis !== "undefined" && typeof globalThis.atob === "function") {
    const binaryString = globalThis.atob(data);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    const decoder = new TextDecoder("utf-8");
    return decoder.decode(bytes);
  }
  return Buffer.from(data, "base64").toString("utf-8");
}
```

- The encoding is standard base64 with padding, **not base64url**. A `PAYMENT-SIGNATURE` that fails `Base64EncodedRegex` or `JSON.parse` is logged and treated as **no payment**: the client gets a plain 402 with `error: "Payment required"`, not an error (`$X402/typescript/packages/core/src/http/x402HTTPResourceServer.ts:1274-1287`). Use the SDK helpers.
- The server reads the header case-insensitively through `req.header("payment-signature")` (`express/src/adapter.ts:21-24`).

## 2. Facilitator side

### 2.1 `x402Facilitator` (`import { x402Facilitator } from "@x402/core/facilitator"`)

Source: `$X402/typescript/packages/core/src/facilitator/x402Facilitator.ts:81-128`

```ts
  /**
   * Registers a scheme facilitator for the current x402 version.
   * Networks are stored and used for getSupported() - no need to specify them later.
   *
   * @param networks - Single network or array of networks this facilitator supports
   * @param facilitator - The scheme network facilitator to register
   * @returns The x402Facilitator instance for chaining
   */
  register(networks: Network | Network[], facilitator: SchemeNetworkFacilitator): x402Facilitator {
    const networksArray = Array.isArray(networks) ? networks : [networks];
    return this._registerScheme(x402Version, networksArray, facilitator);
  }

  /**
   * Registers a scheme facilitator for x402 version 1.
   * Networks are stored and used for getSupported() - no need to specify them later.
   *
   * @param networks - Single network or array of networks this facilitator supports
   * @param facilitator - The scheme network facilitator to register
   * @returns The x402Facilitator instance for chaining
   */
  registerV1(
    networks: Network | Network[],
    facilitator: SchemeNetworkFacilitator,
  ): x402Facilitator {
    const networksArray = Array.isArray(networks) ? networks : [networks];
    return this._registerScheme(1, networksArray, facilitator);
  }

  /**
   * Registers a protocol extension.
   *
   * @param extension - The extension object to register
   * @returns The x402Facilitator instance for chaining
   */
  registerExtension(extension: FacilitatorExtension): x402Facilitator {
    this.extensions.set(extension.key, extension);
    return this;
  }

  /**
   * Gets the list of registered extension keys.
   *
   * @returns Array of extension key strings
   */
  getExtensions(): string[] {
    return Array.from(this.extensions.keys());
  }
```

Source: `$X402/typescript/packages/core/src/facilitator/x402Facilitator.ts:212-274`

```ts
  /**
   * Gets supported payment kinds, extensions, and signers.
   * Uses networks registered during register() calls - no parameters needed.
   * Returns flat array format for backward compatibility with V1 clients.
   *
   * @returns Supported response with kinds as array (with version in each element), extensions, and signers
   */
  getSupported(): {
    kinds: Array<{
      x402Version: number;
      scheme: string;
      network: string;
      extra?: Record<string, unknown>;
    }>;
    extensions: string[];
    signers: Record<string, string[]>;
  } {
    const kinds: Array<{
      x402Version: number;
      scheme: string;
      network: string;
      extra?: Record<string, unknown>;
    }> = [];
    const signersByFamily: Record<string, Set<string>> = {};

    // Iterate over registered scheme data (array supports multiple facilitators per version)
    for (const [version, schemeDataArray] of this.registeredFacilitatorSchemes) {
      for (const schemeData of schemeDataArray) {
        const { facilitator, networks } = schemeData;
        const scheme = facilitator.scheme;

        // Iterate over stored concrete networks
        for (const network of networks) {
          const extra = facilitator.getExtra(network);
          kinds.push({
            x402Version: version,
            scheme,
            network,
            ...(extra && { extra }),
          });

          // Collect signers by CAIP family for this network
          const family = facilitator.caipFamily;
          if (!signersByFamily[family]) {
            signersByFamily[family] = new Set();
          }
          facilitator.getSigners(network).forEach(signer => signersByFamily[family].add(signer));
        }
      }
    }

    // Convert signer sets to arrays
    const signers: Record<string, string[]> = {};
    for (const [family, signerSet] of Object.entries(signersByFamily)) {
      signers[family] = Array.from(signerSet);
    }

    return {
      kinds,
      extensions: this.getExtensions(),
      signers,
    };
  }
```

Source: `$X402/typescript/packages/core/src/facilitator/x402Facilitator.ts:534-557`

```ts
  /**
   * Derives a wildcard pattern from an array of networks.
   * If all networks share the same namespace, returns wildcard pattern.
   * Otherwise returns the first network for exact matching.
   *
   * @param networks - Array of networks
   * @returns Derived pattern for matching
   */
  private derivePattern(networks: Network[]): Network {
    if (networks.length === 0) return "" as Network;
    if (networks.length === 1) return networks[0];

    // Extract namespaces (e.g., "eip155" from "eip155:84532")
    const namespaces = networks.map(n => n.split(":")[0]);
    const uniqueNamespaces = new Set(namespaces);

    // If all same namespace, use wildcard
    if (uniqueNamespaces.size === 1) {
      return `${namespaces[0]}:*` as Network;
    }

    // Mixed namespaces - use first network for exact matching
    return networks[0];
  }
```

Semantics, all read from `$X402/typescript/packages/core/src/facilitator/x402Facilitator.ts`:

- `register(networks, scheme)` stores *concrete* networks; those are what `getSupported()` lists (lines 89-92 and 514-532). With two or more networks in one namespace, the matching pattern becomes `ns:*` (`derivePattern`). A single network is its own pattern. **Register the literal `"zcash:testnet"`.** If you registered `"zcash:*"`, `/supported` would advertise a kind whose network is `"zcash:*"`, and the resource server's exact-match lookup would fail (section 4.1).
- Several schemes per network are allowed: there is one array of `{facilitator, networks, pattern}` per x402 version. Lookup takes the first entry whose `scheme === paymentRequirements.scheme` and whose network set contains `paymentRequirements.network`, or whose pattern matches it (lines 311-326). If the same scheme and network are registered twice, the first registration wins.
- Dispatch keys are `paymentPayload.x402Version` together with `paymentRequirements.scheme` and `.network`. The body's top-level `x402Version` and `paymentPayload.accepted` are not used for dispatch. An unknown version, scheme or network makes the call **throw** `Error("No facilitator registered for ...")` rather than return `isValid:false` (lines 304-332), so the HTTP handler chooses the status.
- `verify()` (lines 283-396) runs in this order:
  1. `onBeforeVerify` hooks. One that returns `{abort:true,reason}` makes verify return `{isValid:false, invalidReason: reason}`.
  2. `scheme.verify(payload, requirements, context)`.
  3. On `isValid:false`: the `onVerifyFailure` hooks run and may return `{recovered:true,result}`; otherwise the result is returned.
  4. On success: the `onAfterVerify` hooks run.
  5. On a thrown error: the `onVerifyFailure` hooks run, then the error is rethrown.
- `settle()` (lines 405-487) runs in this order:
  1. `onBeforeSettle` hooks. An abort **throws** `Error("Settlement aborted: <reason>")`.
  2. `scheme.settle()`.
  3. `onAfterSettle` hooks, which run for **any** returned result, including `success:false`.
  4. On a thrown error: the `onSettleFailure` hooks run and may recover; otherwise the error is rethrown.
- `getSupported()` produces one kind per registered network. A kind gets `extra` only if `getExtra(network)` returns something truthy. `signers` is grouped by the scheme's `caipFamily`, and `extensions` lists the registered extension keys. The method is synchronous.
- The facilitator context passed to `scheme.verify` and `scheme.settle` exposes only `getExtension(key)` (lines 495-504).

Facilitator hook types (verbatim):

Source: `$X402/typescript/packages/core/src/facilitator/x402Facilitator.ts:9-61`

```ts
/**
 * Facilitator Hook Context Interfaces
 */

export interface FacilitatorVerifyContext {
  paymentPayload: PaymentPayload;
  requirements: PaymentRequirements;
}

export interface FacilitatorVerifyResultContext extends FacilitatorVerifyContext {
  result: VerifyResponse;
}

export interface FacilitatorVerifyFailureContext extends FacilitatorVerifyContext {
  error: Error;
}

export interface FacilitatorSettleContext {
  paymentPayload: PaymentPayload;
  requirements: PaymentRequirements;
}

export interface FacilitatorSettleResultContext extends FacilitatorSettleContext {
  result: SettleResponse;
}

export interface FacilitatorSettleFailureContext extends FacilitatorSettleContext {
  error: Error;
}

/**
 * Facilitator Hook Type Definitions
 */

export type FacilitatorBeforeVerifyHook = (
  context: FacilitatorVerifyContext,
) => Promise<void | { abort: true; reason: string }>;

export type FacilitatorAfterVerifyHook = (context: FacilitatorVerifyResultContext) => Promise<void>;

export type FacilitatorOnVerifyFailureHook = (
  context: FacilitatorVerifyFailureContext,
) => Promise<void | { recovered: true; result: VerifyResponse }>;

export type FacilitatorBeforeSettleHook = (
  context: FacilitatorSettleContext,
) => Promise<void | { abort: true; reason: string }>;

export type FacilitatorAfterSettleHook = (context: FacilitatorSettleResultContext) => Promise<void>;

export type FacilitatorOnSettleFailureHook = (
  context: FacilitatorSettleFailureContext,
) => Promise<void | { recovered: true; result: SettleResponse }>;
```

### 2.2 `SchemeNetworkFacilitator` members and how core uses them

| Member | Used by | z402 value (Proposal) |
| --- | --- | --- |
| `readonly scheme: string` | dispatch (`x402Facilitator.ts:314`), `/supported` kind `scheme` | the agreed scheme id (placeholder `"zcash-session"`) |
| `readonly caipFamily: string` | key of `/supported.signers` only (`:254-258`) | `"zcash:*"` |
| `getExtra(network)` | `/supported.kinds[].extra` (`:245-251`), which the server receives as `supportedKind.extra` | `{ windowZat: 100000, creditRatio: 0.25, creditCapZat: 200000 }` |
| `getSigners(network)` | `/supported.signers[caipFamily]` | `[]`. The facilitator never signs or broadcasts. Nothing in core, http or extensions reads `signers` (grep over `$X402/typescript/packages/{core,http,extensions}`). |
| `verify(payload, requirements, context?)` | `POST /verify` | read-only: deposit lookup, voucher, trust ramp |
| `settle(payload, requirements, context?)` | `POST /settle` | re-check, then record the deposit and `cumulativeZat` |

Spec constraint: "`/verify` is **read-only**: it validates payment state but MUST NOT commit payment state" (`$X402/specs/x402-specification-v2.md:307`). For client-prepaid methods, settle "MAY bind a payment proof to the request (for example, consuming a challenge or marking a transaction as used) after read-only observation of ledger or backend state" (`:395`). That sentence describes z402's `/settle`. Caching a chain observation (a decrypted deposit) during verify does not commit payment state.

### 2.3 `/supported` produced by the skeleton (ran it)

Source: `$SPIKE/probe-roundtrip.log:42-59`

```json
{
  "kinds": [
    {
      "x402Version": 2,
      "scheme": "zcash-session",
      "network": "zcash:testnet",
      "extra": {
        "windowZat": 100000,
        "creditRatio": 0.25,
        "creditCapZat": 200000
      }
    }
  ],
  "extensions": [],
  "signers": {
    "zcash:*": []
  }
}
```


## 3. HTTP facilitator protocol (`HTTPFacilitatorClient`)

`import { HTTPFacilitatorClient } from "@x402/core/server"`; the same class is also exported from `@x402/core/http`. Source: `$X402/typescript/packages/core/src/http/httpFacilitatorClient.ts`.

### 3.1 What it sends

Source: `$X402/typescript/packages/core/src/http/httpFacilitatorClient.ts:14-61`

```ts
const DEFAULT_FACILITATOR_URL = "https://x402.org/facilitator";
/** Default per-request timeout for facilitator HTTP calls, in milliseconds */
const DEFAULT_TIMEOUT_MS = 90_000;
/**
 * Upper bound for timeoutMs (2^31 - 1). AbortSignal.timeout() requires an
 * integer, and larger values overflow Node's 32-bit timers, which would
 * silently fire after ~1ms while reporting the configured duration.
 */
const MAX_TIMEOUT_MS = 2_147_483_647;

export interface FacilitatorConfig {
  url?: string;
  /**
   * Timeout in milliseconds applied to each facilitator HTTP request —
   * `verify()`, `settle()`, and every `getSupported()` attempt — covering both
   * response headers and body consumption. Must be a positive integer no
   * greater than 2_147_483_647 (2^31 - 1, about 24.8 days).
   * Defaults to 90_000 (90 seconds).
   *
   * On expiry the operation rejects with {@link FacilitatorTimeoutError}. For
   * `settle()` a timeout is an indeterminate outcome: the facilitator may still
   * have completed the settlement.
   */
  timeoutMs?: number;
  /**
   * Returns authentication headers for the facilitator, keyed by request path.
   *
   * The returned object must be keyed by path (`verify`, `settle`, `supported`,
   * and optionally `bazaar`), each mapping to a headers object — NOT a flat
   * headers object. Paths may be omitted (no auth is sent for them), but
   * returning a flat object such as `{ Authorization: "Bearer ..." }` will
   * throw, since it would otherwise silently drop auth on every request.
   *
   * @example
   * ```ts
   * createAuthHeaders: async () => {
   *   const headers = { Authorization: `Bearer ${token}` };
   *   return { verify: headers, settle: headers, supported: headers };
   * }
   * ```
   */
  createAuthHeaders?: () => Promise<{
    verify?: Record<string, string>;
    settle?: Record<string, string>;
    supported?: Record<string, string>;
    bazaar?: Record<string, string>;
  }>;
}
```

Source: `$X402/typescript/packages/core/src/http/httpFacilitatorClient.ts:390-504`

```ts
  /**
   * Verify a payment with the facilitator
   *
   * @param paymentPayload - The payment to verify
   * @param paymentRequirements - The requirements to verify against
   * @returns Verification response
   */
  async verify(
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    let headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (this._createAuthHeaders) {
      const authHeaders = await this.createAuthHeaders("verify");
      headers = { ...headers, ...authHeaders.headers };
    }

    return this.withRequestTimeout("verify", async signal => {
      const response = await fetch(`${this.url}/verify`, {
        method: "POST",
        headers,
        redirect: "follow",
        body: JSON.stringify({
          x402Version: paymentPayload.x402Version,
          paymentPayload: this.toJsonSafe(paymentPayload),
          paymentRequirements: this.toJsonSafe(paymentRequirements),
        }),
        signal,
      });

      if (!response.ok) {
        const text = await response.text();
        let data: unknown;
        try {
          data = JSON.parse(text);
        } catch {
          throw new Error(
            `Facilitator verify failed (${response.status}): ${responseExcerpt(text)}`,
          );
        }

        if (typeof data === "object" && data !== null && "isValid" in data) {
          throw new VerifyError(response.status, data as VerifyResponse);
        }

        throw new Error(
          `Facilitator verify failed (${response.status}): ${responseExcerpt(JSON.stringify(data))}`,
        );
      }

      const verifyResult = await parseSuccessResponse(response, verifyResponseSchema, "verify");
      return attachExtensionResponsesFromHeader(verifyResult, response);
    });
  }

  /**
   * Settle a payment with the facilitator
   *
   * @param paymentPayload - The payment to settle
   * @param paymentRequirements - The requirements for settlement
   * @returns Settlement response
   */
  async settle(
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    let headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (this._createAuthHeaders) {
      const authHeaders = await this.createAuthHeaders("settle");
      headers = { ...headers, ...authHeaders.headers };
    }

    return this.withRequestTimeout("settle", async signal => {
      const response = await fetch(`${this.url}/settle`, {
        method: "POST",
        headers,
        redirect: "follow",
        body: JSON.stringify({
          x402Version: paymentPayload.x402Version,
          paymentPayload: this.toJsonSafe(paymentPayload),
          paymentRequirements: this.toJsonSafe(paymentRequirements),
        }),
        signal,
      });

      if (!response.ok) {
        const text = await response.text();
        let data: unknown;
        try {
          data = JSON.parse(text);
        } catch {
          throw new Error(
            `Facilitator settle failed (${response.status}): ${responseExcerpt(text)}`,
          );
        }

        if (typeof data === "object" && data !== null && "success" in data) {
          throw new SettleError(response.status, data as SettleResponse);
        }

        throw new Error(
          `Facilitator settle failed (${response.status}): ${responseExcerpt(JSON.stringify(data))}`,
        );
      }

      const settleResult = await parseSuccessResponse(response, settleResponseSchema, "settle");
      return attachExtensionResponsesFromHeader(settleResult, response);
    });
  }
```

Request details:

- The base `url` is stripped of trailing slashes and gets `/verify`, `/settle` or `/supported` appended. The default URL is `https://x402.org/facilitator`, so always pass `url`. A URL with a path prefix such as `http://127.0.0.1:4021/facilitator` works.
- `POST /verify` and `POST /settle` send `Content-Type: application/json`, any auth headers, and the body `{"x402Version": paymentPayload.x402Version, "paymentPayload": {...}, "paymentRequirements": {...}}`. BigInts are stringified by `toJsonSafe` (lines 654-658). `redirect: "follow"` is set.
- `GET /supported` sends the same headers (including a `Content-Type`) and no body.
- `paymentRequirements` is the **server-built** requirement that matched, not the client's `accepted`, which travels inside `paymentPayload.accepted` (`x402HTTPResourceServer.ts:621-667`).

Observed `/verify` and `/settle` bodies from the deposit call (the two bodies are identical):

Source: `$SPIKE/probe-roundtrip.log:105-198`

```json
[
  {
    "path": "POST /verify",
    "body": {
      "x402Version": 2,
      "paymentPayload": {
        "x402Version": 2,
        "payload": {
          "sessionKey": "cb7b30062909c6615522e5e0881a4fc632e98b267db7efd347790ea7f6860466",
          "cumulativeZat": "1000",
          "sig": "68aea9a0355503448d5f09129d8000becb77938818433b7855f57e2037478a60a92a58f0861c59f3cce2172e36f64ebfd8d399009f981c1788856ef66e2c1406",
          "depositTxid": "abababababababababababababababababababababababababababababababab"
        },
        "resource": {
          "url": "http://127.0.0.1:49238/chunk",
          "description": "One chunk of the stream",
          "mimeType": "application/json"
        },
        "accepted": {
          "scheme": "zcash-session",
          "network": "zcash:testnet",
          "amount": "1000",
          "asset": "ZEC",
          "payTo": "utest1merchantshieldedonlyunifiedaddressplaceholder",
          "maxTimeoutSeconds": 60,
          "extra": {
            "windowZat": 100000,
            "creditRatio": 0.25,
            "creditCapZat": 200000
          }
        }
      },
      "paymentRequirements": {
        "scheme": "zcash-session",
        "network": "zcash:testnet",
        "amount": "1000",
        "asset": "ZEC",
        "payTo": "utest1merchantshieldedonlyunifiedaddressplaceholder",
        "maxTimeoutSeconds": 60,
        "extra": {
          "windowZat": 100000,
          "creditRatio": 0.25,
          "creditCapZat": 200000
        }
      }
    }
  },
  {
    "path": "POST /settle",
    "body": {
      "x402Version": 2,
      "paymentPayload": {
        "x402Version": 2,
        "payload": {
          "sessionKey": "cb7b30062909c6615522e5e0881a4fc632e98b267db7efd347790ea7f6860466",
          "cumulativeZat": "1000",
          "sig": "68aea9a0355503448d5f09129d8000becb77938818433b7855f57e2037478a60a92a58f0861c59f3cce2172e36f64ebfd8d399009f981c1788856ef66e2c1406",
          "depositTxid": "abababababababababababababababababababababababababababababababab"
        },
        "resource": {
          "url": "http://127.0.0.1:49238/chunk",
          "description": "One chunk of the stream",
          "mimeType": "application/json"
        },
        "accepted": {
          "scheme": "zcash-session",
          "network": "zcash:testnet",
          "amount": "1000",
          "asset": "ZEC",
          "payTo": "utest1merchantshieldedonlyunifiedaddressplaceholder",
          "maxTimeoutSeconds": 60,
          "extra": {
            "windowZat": 100000,
            "creditRatio": 0.25,
            "creditCapZat": 200000
          }
        }
      },
      "paymentRequirements": {
        "scheme": "zcash-session",
        "network": "zcash:testnet",
        "amount": "1000",
        "asset": "ZEC",
        "payTo": "utest1merchantshieldedonlyunifiedaddressplaceholder",
        "maxTimeoutSeconds": 60,
        "extra": {
          "windowZat": 100000,
          "creditRatio": 0.25,
          "creditCapZat": 200000
        }
      }
    }
  }
]
```

`paymentPayload.extensions` is absent because the 402 declared none: `mergeExtensions(undefined, undefined)` returns undefined and JSON drops the key (`x402Client.ts:589-600`).

### 3.2 What it expects back, and how each reply reaches the buyer

Response schemas. `z.object` strips unknown keys, so anything the API should see must go in `extra`:

Source: `$X402/typescript/packages/core/src/http/httpFacilitatorClient.ts:141-212`

```ts
const verifyResponseSchema: z.ZodType<VerifyResponse, z.ZodTypeDef, unknown> = z.object({
  isValid: z.boolean(),
  invalidReason: z
    .string()
    .nullish()
    .transform(v => v ?? undefined),
  invalidMessage: z
    .string()
    .nullish()
    .transform(v => v ?? undefined),
  payer: z
    .string()
    .nullish()
    .transform(v => v ?? undefined),
  extensions: z
    .record(z.string(), z.unknown())
    .nullish()
    .transform(v => v ?? undefined),
  extra: z
    .record(z.string(), z.unknown())
    .nullish()
    .transform(v => v ?? undefined),
});

const settleResponseSchema: z.ZodType<SettleResponse, z.ZodTypeDef, unknown> = z.object({
  success: z.boolean(),
  errorReason: z
    .string()
    .nullish()
    .transform(v => v ?? undefined),
  errorMessage: z
    .string()
    .nullish()
    .transform(v => v ?? undefined),
  payer: z
    .string()
    .nullish()
    .transform(v => v ?? undefined),
  transaction: z.string(),
  network: z.custom<SettleResponse["network"]>(value => typeof value === "string"),
  amount: z
    .string()
    .nullish()
    .transform(v => v ?? undefined),
  extensions: z
    .record(z.string(), z.unknown())
    .nullish()
    .transform(v => v ?? undefined),
  extra: z
    .record(z.string(), z.unknown())
    .nullish()
    .transform(v => v ?? undefined),
});

const supportedKindSchema: z.ZodType<SupportedResponse["kinds"][number], z.ZodTypeDef, unknown> =
  z.object({
    x402Version: z.number(),
    scheme: z.string(),
    network: z.custom<SupportedResponse["kinds"][number]["network"]>(
      value => typeof value === "string",
    ),
    extra: z
      .record(z.string(), z.unknown())
      .nullish()
      .transform(v => v ?? undefined),
  });

const supportedResponseSchema: z.ZodType<SupportedResponse, z.ZodTypeDef, unknown> = z.object({
  kinds: z.array(supportedKindSchema),
  extensions: z.array(z.string()).default([]),
  signers: z.record(z.string(), z.array(z.string())).default({}),
});
```

| Facilitator reply | Client-side result (source) | What the buyer gets (ran it: `$SPIKE/probe-failures.log`, `$SPIKE/probe-roundtrip.log`) |
| --- | --- | --- |
| `/verify` 200 `{isValid:true,...}` | parsed | handler runs, then settle |
| `/verify` 200 `{isValid:false, invalidReason, invalidMessage}` | parsed and returned | **402**, `PAYMENT-REQUIRED.error = "z402_limit_exceeded"` (invalidReason only) |
| `/verify` non-2xx with JSON containing `isValid` | throws `VerifyError` (l. 434-436) | **402**, `error = "z402_limit_exceeded: over by 1"` (reason and message) |
| `/verify` non-2xx with other JSON | throws `Error("Facilitator verify failed (500): {...}")` | **402**, `error = "Facilitator verify failed (500): {\"error\":\"boom\"}"` |
| `/verify` 200 non-JSON or schema-invalid | `FacilitatorResponseError` | **502** `{"error":"Facilitator verify returned invalid ..."}` (source: l. 340-358 plus `express/src/index.ts:207-216`; not run) |
| `/settle` 200 `{success:true, transaction, network,...}` | parsed | **200**: handler body, `PAYMENT-RESPONSE`, `Cache-Control: private` |
| `/settle` 200 `{success:false, errorReason, errorMessage, transaction:"", network}` | `onSettleFailure` hooks, then returned | **402**, body `{}`, `PAYMENT-RESPONSE{success:false,errorReason,errorMessage,...}`, `Cache-Control: no-store`, **no `PAYMENT-REQUIRED`** |
| `/settle` non-2xx with JSON containing `success` | throws `SettleError` | 402 with `PAYMENT-RESPONSE` (same shape) (source: `x402HTTPResourceServer.ts:871-889`; not run) |
| `/settle` non-2xx with other JSON | throws `Error` | **402**, `PAYMENT-RESPONSE.errorReason = "Facilitator settle failed (500): {\"error\":\"boom\"}"`, `transaction:""` |
| `/settle` 200 without `transaction` (or `network`) | `FacilitatorResponseError` | **502** `{"error":"Facilitator settle returned invalid data: {\"success\":true,\"network\":\"zcash:testnet\"}"}` |
| any call slower than `timeoutMs` | `FacilitatorTimeoutError` | **502** `{"error":"Facilitator settle request timed out after 500ms"}` |
| facilitator unreachable at the first protected request | init fails with `TypeError: fetch failed`, which is not a FacilitatorResponseError | **500** `{"error":"Internal Server Error"}`; init is retried on the next protected request |

Timeouts, retries and auth:

- **Timeout.** `timeoutMs` defaults to 90 000 ms and applies per request (verify, settle, and each `/supported` attempt) via `AbortSignal.timeout` (lines 16 and 632-645; dist `server/index.js:600`). CHANGELOG 2.21.0 says the default is 30 s, but 2.28.0 code says 90 s. A settle timeout is indeterminate: the facilitator may have committed anyway (`facilitator.ts:126-136`).
- **Retries.** `getSupported` makes 3 attempts on HTTP 429 only, honouring `Retry-After` with a 30 s cap (lines 100-139 and 512-575). Verify is never retried. Settle is retried **exactly once**, by `x402ResourceServer.settleWithPendingRetry`, and only when the reply has `errorReason === "settlement_pending"` and a non-empty `transaction` (section 4.5).
- **Auth.** `createAuthHeaders` must return path-keyed objects such as `{ verify: {...}, settle: {...}, supported: {...} }`. A flat `{Authorization}` object throws (lines 583-620). The probes ran with `Authorization: Bearer probe-secret` on all three paths.

### 3.3 Official example facilitator: Express wiring (verbatim)

Source: `$X402/examples/typescript/facilitator/basic/index.ts:138-250`

```ts
// Initialize Express app
const app = express();
app.use(express.json());

/**
 * POST /verify
 * Verify a payment against requirements
 *
 * Note: Payment tracking and bazaar discovery are handled by lifecycle hooks
 */
app.post("/verify", async (req, res) => {
  const endpointT0 = performance.now();
  try {
    const { paymentPayload, paymentRequirements } = req.body as {
      paymentPayload: PaymentPayload;
      paymentRequirements: PaymentRequirements;
    };

    if (!paymentPayload || !paymentRequirements) {
      return res.status(400).json({
        error: "Missing paymentPayload or paymentRequirements",
      });
    }

    // Hooks will automatically:
    // - Track verified payment (onAfterVerify)
    // - Extract and catalog discovery info (onAfterVerify)
    const response: VerifyResponse = await facilitator.verify(
      paymentPayload,
      paymentRequirements,
    );

    res.json(response);
  } catch (error) {
    console.error("Verify error:", error);
    res.status(500).json({
      error: error instanceof Error ? error.message : "Unknown error",
    });
  } finally {
    console.log(
      `/verify completed in ${((performance.now() - endpointT0) / 1000).toFixed(3)}s`,
    );
  }
});

/**
 * POST /settle
 * Settle a payment on-chain
 *
 * Note: Verification validation and cleanup are handled by lifecycle hooks
 */
app.post("/settle", async (req, res) => {
  const endpointT0 = performance.now();
  try {
    const { paymentPayload, paymentRequirements } = req.body;

    if (!paymentPayload || !paymentRequirements) {
      return res.status(400).json({
        error: "Missing paymentPayload or paymentRequirements",
      });
    }

    // Hooks will automatically:
    // - Validate payment was verified (onBeforeSettle - will abort if not)
    // - Check verification timeout (onBeforeSettle)
    // - Clean up tracking (onAfterSettle / onSettleFailure)
    const response: SettleResponse = await facilitator.settle(
      paymentPayload as PaymentPayload,
      paymentRequirements as PaymentRequirements,
    );

    res.json(response);
  } catch (error) {
    console.error("Settle error:", error);

    // Check if this was an abort from hook
    if (
      error instanceof Error &&
      error.message.includes("Settlement aborted:")
    ) {
      // Return a proper SettleResponse instead of 500 error
      return res.json({
        success: false,
        errorReason: error.message.replace("Settlement aborted: ", ""),
        network: req.body?.paymentPayload?.network || "unknown",
      } as SettleResponse);
    }

    res.status(500).json({
      error: error instanceof Error ? error.message : "Unknown error",
    });
  } finally {
    console.log(
      `/settle completed in ${((performance.now() - endpointT0) / 1000).toFixed(3)}s`,
    );
  }
});

/**
 * GET /supported
 * Get supported payment kinds and extensions
 */
app.get("/supported", async (req, res) => {
  try {
    const response = facilitator.getSupported();
    res.json(response);
  } catch (error) {
    console.error("Supported error:", error);
    res.status(500).json({
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});
```

Two bugs in that example, which the skeleton's `app.ts` (section 9) fixes:

- The "Settlement aborted" branch returns a body without `transaction`, so the API answers 502 (see the table above).
- `req.body?.paymentPayload?.network` does not exist in v2; the network lives in `paymentPayload.accepted.network` or `paymentRequirements.network`.

`$X402/examples/typescript/facilitator/advanced/all_networks.ts:515-535` repeats both bugs. Apart from that, the pattern is fine: `express.json()`, `/supported` returns `facilitator.getSupported()`, `/verify` returns `res.json(await facilitator.verify(...))`, and thrown errors become 500 `{error}`.

## 4. Resource server (`x402ResourceServer`, `import { x402ResourceServer } from "@x402/core/server"` or `"@x402/express"`)

### 4.1 Constructor, register, initialize

Source: `$X402/typescript/packages/core/src/server/x402ResourceServer.ts:347-365`

```ts
  /**
   * Creates a new x402ResourceServer instance.
   *
   * @param facilitatorClients - Optional facilitator client(s) for payment processing
   */
  constructor(facilitatorClients?: FacilitatorClient | FacilitatorClient[]) {
    // Normalize facilitator clients to array
    if (!facilitatorClients) {
      // No clients provided, create a default HTTP client
      this.facilitatorClients = [new HTTPFacilitatorClient()];
    } else if (Array.isArray(facilitatorClients)) {
      // Array of clients provided
      this.facilitatorClients =
        facilitatorClients.length > 0 ? facilitatorClients : [new HTTPFacilitatorClient()];
    } else {
      // Single client provided
      this.facilitatorClients = [facilitatorClients];
    }
  }
```

Source: `$X402/typescript/packages/core/src/server/x402ResourceServer.ts:639-737`

```ts
  /**
   * Initialize by fetching supported kinds from all facilitators
   * Creates mappings for supported responses and facilitator clients
   * Earlier facilitators in the array get precedence
   */
  async initialize(): Promise<void> {
    // Clear existing mappings
    this.supportedResponsesMap.clear();
    this.facilitatorClientsMap.clear();
    let lastError: Error | undefined;

    // Fetch supported kinds from all facilitator clients
    // Process in order to give precedence to earlier facilitators
    for (const facilitatorClient of this.facilitatorClients) {
      try {
        const supported = await facilitatorClient.getSupported();

        // Process each supported kind (now flat array with version in each element)
        for (const kind of supported.kinds) {
          const x402Version = kind.x402Version;

          // Get or create version map for supported responses
          if (!this.supportedResponsesMap.has(x402Version)) {
            this.supportedResponsesMap.set(x402Version, new Map());
          }
          const responseVersionMap = this.supportedResponsesMap.get(x402Version)!;

          // Get or create version map for facilitator clients
          if (!this.facilitatorClientsMap.has(x402Version)) {
            this.facilitatorClientsMap.set(x402Version, new Map());
          }
          const clientVersionMap = this.facilitatorClientsMap.get(x402Version)!;

          // Get or create network map for responses
          if (!responseVersionMap.has(kind.network)) {
            responseVersionMap.set(kind.network, new Map());
          }
          const responseNetworkMap = responseVersionMap.get(kind.network)!;

          // Get or create network map for clients
          if (!clientVersionMap.has(kind.network)) {
            clientVersionMap.set(kind.network, new Map());
          }
          const clientNetworkMap = clientVersionMap.get(kind.network)!;

          // Only store if not already present (gives precedence to earlier facilitators)
          if (!responseNetworkMap.has(kind.scheme)) {
            responseNetworkMap.set(kind.scheme, supported);
            clientNetworkMap.set(kind.scheme, facilitatorClient);
          }
        }
      } catch (error) {
        lastError = error as Error;
        // Log error but continue with other facilitators
        console.warn(`Failed to fetch supported kinds from facilitator: ${error}`);
      }
    }

    if (this.supportedResponsesMap.size === 0) {
      throw lastError
        ? new Error(
            "Failed to initialize: no supported payment kinds loaded from any facilitator.",
            {
              cause: lastError,
            },
          )
        : new Error(
            "Failed to initialize: no supported payment kinds loaded from any facilitator.",
          );
    }

    this.validateFacilitatorCapabilities();
  }

  /**
   * Get supported kind for a specific version, network, and scheme
   *
   * @param x402Version - The x402 version
   * @param network - The network identifier
   * @param scheme - The payment scheme
   * @returns The supported kind or undefined if not found
   */
  getSupportedKind(
    x402Version: number,
    network: Network,
    scheme: string,
  ): SupportedKind | undefined {
    const versionMap = this.supportedResponsesMap.get(x402Version);
    if (!versionMap) return undefined;

    const supportedResponse = findByNetworkAndScheme(versionMap, scheme, network);
    if (!supportedResponse) return undefined;

    // Find the specific kind from the response (kinds are flat array with version in each element)
    return supportedResponse.kinds.find(
      kind =>
        kind.x402Version === x402Version && kind.network === network && kind.scheme === scheme,
    );
  }
```

- `register(network, schemeServer)` stores the scheme by network, then by `scheme`, and wires `schemeServer.schemeHooks` (lines 374-411). On the server side the network may be a pattern such as `"zcash:*"`; lookups use `findByNetworkAndScheme`, which matches patterns.
- **Does `initialize()` fetch `/supported` and fail if the facilitator is down?** Yes, it fetches. It throws only if *no* facilitator returned kinds; the cause is attached. It then runs `validateFacilitatorCapabilities()`, which calls each scheme's optional `validateFacilitatorSupport` and throws `FacilitatorCapabilityError` (lines 1607-1632).
- `getSupportedKind()` needs `kind.network === route network` **exactly**. A pattern only selects the cached response. So `/supported` must list `"zcash:testnet"` literally.
- The result is cached for the life of the process; nothing refreshes it. If the facilitator's terms change, restart the API.
- How `@x402/express` triggers `initialize()`, and what happens on failure, is covered in section 5.5.

### 4.2 Route config to PaymentRequirements

Source: `$X402/typescript/packages/core/src/server/x402ResourceServer.ts:755-832`

```ts
  /**
   * Build payment requirements for a protected resource
   *
   * @param resourceConfig - Configuration for the protected resource
   * @returns Array of payment requirements
   */
  async buildPaymentRequirements(resourceConfig: ResourceConfig): Promise<PaymentRequirements[]> {
    const requirements: PaymentRequirements[] = [];

    // Find the matching server implementation
    const scheme = resourceConfig.scheme;
    const SchemeNetworkServer = findByNetworkAndScheme(
      this.registeredServerSchemes,
      scheme,
      resourceConfig.network,
    );

    if (!SchemeNetworkServer) {
      throw new Error(
        `No server implementation registered for ${scheme} on ${resourceConfig.network}. ` +
          `Make sure to call register() with a scheme server for this network.`,
      );
    }

    // Find the matching supported kind from facilitator
    const supportedKind = this.getSupportedKind(
      x402Version,
      resourceConfig.network,
      SchemeNetworkServer.scheme,
    );

    if (!supportedKind) {
      throw new Error(
        `Facilitator does not support ${SchemeNetworkServer.scheme} on ${resourceConfig.network}. ` +
          `Make sure to call initialize() to fetch supported kinds from facilitators.`,
      );
    }

    // Get facilitator extensions for this combination
    const facilitatorExtensions = this.getFacilitatorExtensions(
      x402Version,
      resourceConfig.network,
      SchemeNetworkServer.scheme,
    );

    // Parse the price using the scheme's price parser
    const parsedPrice = await SchemeNetworkServer.parsePrice(
      resourceConfig.price,
      resourceConfig.network,
    );

    // Build base payment requirements from resource config
    const baseRequirements: PaymentRequirements = {
      scheme: SchemeNetworkServer.scheme,
      network: resourceConfig.network,
      amount: parsedPrice.amount,
      asset: parsedPrice.asset,
      payTo: resourceConfig.payTo,
      maxTimeoutSeconds: resourceConfig.maxTimeoutSeconds || 300, // Default 5 minutes
      extra: {
        ...parsedPrice.extra,
        ...resourceConfig.extra, // Merge user-provided extra
      },
    };

    // Delegate to the implementation for scheme-specific enhancements
    const requirement = await SchemeNetworkServer.enhancePaymentRequirements(
      baseRequirements,
      supportedKind,
      facilitatorExtensions,
    );

    const resolved = resolvePaymentFlow(SchemeNetworkServer, requirement);
    requirement.extra = applyPaymentFlowWireExtra(requirement.extra ?? {}, resolved);

    requirements.push(requirement);
    return requirements;
  }
```

Source: `$X402/typescript/packages/core/src/server/paymentFlow.ts:11-34`

```ts
/**
 * Closed set of payment-flow phase tables.
 *
 * Multi-settle flows (`escrow`) invoke settle lifecycle hooks once per settle.
 * Authors of side-effecting `beforeSettle` / `afterSettle` hooks should branch on
 * {@link SettleContext.phase} when used with those flows.
 */
export const PAYMENT_FLOWS: Record<PaymentFlowName, PaymentFlowPhases> = {
  authorization: {
    verifyBeforeHandler: true,
    settleBeforeHandler: false,
    settleAfterHandler: true,
  },
  upfront: {
    verifyBeforeHandler: false,
    settleBeforeHandler: true,
    settleAfterHandler: false,
  },
  escrow: {
    verifyBeforeHandler: false,
    settleBeforeHandler: true,
    settleAfterHandler: true,
  },
};
```

Source: `$X402/typescript/packages/core/src/server/paymentFlow.ts:82-109`

```ts
/**
 * Apply resolved payment-flow rules to 402 `extra`:
 * - Strip the SDK ATM sentinel `"default"` (never on the wire).
 * - When resolved flow is not `authorization`, set `extra.paymentFlow` so clients
 *   can distinguish trust models without scheme-specific knowledge.
 *
 * @param extra - Current requirements extra
 * @param resolved - Result of {@link resolvePaymentFlow}
 * @param resolved.assetTransferMethod - Resolved asset transfer method
 * @param resolved.paymentFlow - Resolved payment flow name
 * @returns New extra object with wire rules applied
 */
export function applyPaymentFlowWireExtra(
  extra: Record<string, unknown>,
  resolved: { assetTransferMethod: string; paymentFlow: PaymentFlowName },
): Record<string, unknown> {
  const next = { ...extra };
  if (
    resolved.assetTransferMethod === SDK_DEFAULT_ASSET_TRANSFER_METHOD ||
    next.assetTransferMethod === SDK_DEFAULT_ASSET_TRANSFER_METHOD
  ) {
    delete next.assetTransferMethod;
  }
  if (resolved.paymentFlow !== "authorization") {
    next.paymentFlow = resolved.paymentFlow;
  }
  return next;
}
```

- `extra` is built in this order: `parsedPrice.extra`, overwritten by the route's `extra`, then `enhancePaymentRequirements(base, supportedKind, facilitatorExtensions)`, which may do anything (the skeleton overlays the facilitator's terms), then `applyPaymentFlowWireExtra`. The last step strips the SDK sentinel `assetTransferMethod: "default"` and adds `extra.paymentFlow` only when the flow is not `authorization`.
- **`supportedKind.extra` is not merged automatically.** Only your `enhancePaymentRequirements` can copy it (`$X402/typescript/packages/mechanisms/concordium/src/exact/server/scheme.ts:117-134` does this for `feePayer`).
- `maxTimeoutSeconds` defaults to `|| 300`, so 0 also becomes 300. Core never enforces it; it is only a positive-number check in the zod schemas (`schemas/index.ts:161`).
- Requirements are rebuilt on **every** request (`x402HTTPResourceServer.ts:580-583`), so `parsePrice` and `enhancePaymentRequirements` must be cheap and deterministic.

### 4.3 `parsePrice` for a native non-USD asset in base units

- There is no Zcash default asset. A Money price such as `"$0.001"` reaches your `parsePrice` and must be rejected or handled; USD pricing is out of MVP scope (spec). Pass through an `AssetAmount`: `price: { amount: "1000", asset: "ZEC" }` becomes `{ amount: "1000", asset: "ZEC", extra: {} }`. This is the pattern Concordium uses for native CCD (`$X402/typescript/packages/mechanisms/concordium/src/exact/server/scheme.ts:13-21` and `78-99`).
- Optionally accept `"0.00001 ZEC"`. `parseMoney` returns `{amount:"0.00001", symbol:"ZEC"}` (`utils/index.ts:62-82`), and `convertToTokenAmount("0.00001", 8)` returns `"1000"` (`:93-105`).
- `getAssetDecimals` is used only for `$` settlement overrides and for paywall display (`x402ResourceServer.ts:444-453` and `1210-1229`). Return 8 for `ZEC`.
- The DEFAULT_ASSETS convention says every default asset is assumed USD-pegged (`$X402/DEFAULT_ASSETS.md:44-55`).

### 4.4 Matching the client's `accepted` (v2)

Source: `$X402/typescript/packages/core/src/server/x402ResourceServer.ts:1509-1540`

```ts
  /**
   * Finds the server-advertised requirement that matches a client payment payload.
   *
   * @param availableRequirements - Payment requirements advertised for the resource.
   * @param paymentPayload - Signed payment payload from the client.
   * @returns The matching requirement, or undefined when none match.
   */
  findMatchingRequirements(
    availableRequirements: PaymentRequirements[],
    paymentPayload: PaymentPayload,
  ): PaymentRequirements | undefined {
    switch (paymentPayload.x402Version) {
      case 2:
        if (!paymentPayload.accepted) {
          return undefined;
        }

        // For v2, all server-declared requirements must match.
        // The client may include additive scheme-specific metadata under `accepted.extra`.
        // Scheme-declared dynamicExtraFields are omitted from the extra comparison
        return availableRequirements.find(paymentRequirements => {
          const scheme = findByNetworkAndScheme(
            this.registeredServerSchemes,
            paymentRequirements.scheme,
            paymentRequirements.network,
          );
          return paymentRequirementsMatchAccepted(
            paymentRequirements,
            paymentPayload.accepted,
            scheme?.dynamicExtraFields,
          );
        });
```

Source: `$X402/typescript/packages/core/src/server/x402ResourceServer.ts:2088-2120`

```ts
/**
 * Returns whether a client-selected requirement satisfies a server-advertised requirement.
 *
 * Core payment terms and all server-declared `extra` fields must match exactly,
 * but clients may include additive scheme-specific metadata under `accepted.extra`.
 * Fields listed in `dynamicExtraFields` are excluded from the extra comparison.
 *
 * @param required - Server-advertised payment requirement.
 * @param accepted - Client-selected payment requirement from the payment payload.
 * @param dynamicExtraFields - Scheme-declared `extra` keys regenerated per PaymentRequired.
 * @returns True when `accepted` preserves every server-declared requirement.
 */
function paymentRequirementsMatchAccepted(
  required: PaymentRequirements,
  accepted: PaymentRequirements,
  dynamicExtraFields?: string[],
): boolean {
  const { extra: requiredExtra, ...requiredCore } = required;
  const { extra: acceptedExtra, ...acceptedCore } = accepted;

  if (!deepEqual(requiredCore, acceptedCore)) {
    return false;
  }

  if (requiredExtra === undefined) {
    return true;
  }

  return objectContainsSubset(
    omitFields(requiredExtra, dynamicExtraFields),
    omitFields(acceptedExtra, dynamicExtraFields),
  );
}
```

Ran it (`$SPIKE/probe-roundtrip.log:333-340`):

- A client that changed `accepted.extra.windowZat` got **402 `error: "No matching payment requirements"`**, and the facilitator was never called.
- A client that *added* `accepted.extra.clientNote` was accepted (200).
- `dynamicExtraFields` is the escape hatch for per-response values. SVM uses it for `recentBlockhash` (`$X402/typescript/packages/mechanisms/svm/src/exact/server/scheme.ts:33`). z402 does not need it if the terms are static.

### 4.5 `verifyPayment` and `settlePayment`

- Flow phases come from `PAYMENT_FLOWS[resolvePaymentFlow(scheme, requirements).paymentFlow]`. With `authorization`, the order is: verify through the facilitator, then the handler, then settle. `upfront` skips the facilitator `/verify` entirely: `verifyPayment` returns `{isValid:true}` locally, as `x402ResourceServer.ts:1049-1054` shows.
- `verifyPayment` (lines 1002-1121) runs in this order:
  1. Manual, scheme, then extension `beforeVerify` hooks. `{abort}` returns `isValid:false`; `{skip,result}` short-circuits.
  2. The facilitator `verify`.
  3. `runAfterVerifyHooks` with **the facilitator's result even when `isValid:false`** (line 1092). A hook can turn a success into a failure with `{abort}`, or ask for `skipHandler`.
  4. If the facilitator call threw, the `onVerifyFailure` hooks run (they may recover), then the error is rethrown.
- `settlePayment` (lines 1197-1438) runs in this order:
  1. `beforeSettle` hooks. `{abort}` throws `SettleError(400)`; `{skip,result}` returns a locally built result.
  2. The scheme's `enrichSettlementPayload`, which may only add payload keys.
  3. `settleWithPendingRetry`.
  4. If the reply has `success:false`, the `onSettleFailure` hooks run (they may recover), then the result is returned.
  5. On success, the `afterSettle` hooks run, then `enrichSettlementResponse`, which may only add to `extra`.
  6. If anything threw, the `onSettleFailure` hooks run, then the error is rethrown.

Source: `$X402/typescript/packages/core/src/server/x402ResourceServer.ts:1559-1598`

```ts
  /**
   * Calls `facilitatorClient.settle` once, then retries exactly once with the
   * identical payload/requirements when the outcome is a non-terminal
   * `settlement_pending` failure carrying a broadcast transaction hash. Sits
   * above all scheme/network dispatch — the mechanism that actually handles
   * the retry (via its own `PendingSettlementStore` check) reconciles against
   * the already-broadcast transaction instead of verifying and broadcasting
   * a second one. No mutation, backoff, or sleep: the mechanism layer owns
   * any bounded waiting. Any other outcome (success, or a different failure
   * reason) short-circuits after the first call. Capped at exactly one retry
   * regardless of the second outcome, so this can never loop. Mirrors Go's
   * `settleWithPendingRetry` (`go/server.go`).
   *
   * @param facilitatorClient - The facilitator client to call
   * @param settlePayload - The (possibly enriched) settle-local payload
   * @param effectiveRequirements - The effective payment requirements
   * @returns The settle result, either from the first attempt or the single retry
   */
  private async settleWithPendingRetry(
    facilitatorClient: FacilitatorClient,
    settlePayload: PaymentPayload,
    effectiveRequirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    let result: SettleResponse | undefined;
    let retryable: boolean;
    try {
      result = await facilitatorClient.settle(settlePayload, effectiveRequirements);
      retryable = isRetryableSettlementPendingResult(result);
    } catch (error) {
      if (!isRetryableSettlementPendingError(error)) {
        throw error;
      }
      retryable = true;
    }

    if (!retryable) {
      return result!;
    }
    return facilitatorClient.settle(settlePayload, effectiveRequirements);
  }
```

Source: `$X402/typescript/packages/core/src/server/x402ResourceServer.ts:2039-2052`

```ts
/**
 * Reports whether a returned (non-thrown) settle outcome is a retryable
 * `settlement_pending`: `success: false`, `errorReason === "settlement_pending"`,
 * and a non-empty `transaction` hash. Mirrors Go's `isRetryableSettlementPending`
 * (`go/server.go`) for the HTTP/remote `FacilitatorClient` path.
 *
 * @param result - The settle response to inspect
 * @returns Whether the result is a retryable settlement_pending outcome
 */
function isRetryableSettlementPendingResult(result: SettleResponse): boolean {
  return (
    !result.success && result.errorReason === SETTLEMENT_PENDING_REASON && !!result.transaction
  );
}
```

### 4.6 Resource-server hook contexts and types (verbatim)

Source: `$X402/typescript/packages/core/src/server/x402ResourceServer.ts:61-227`

```ts
export type SettlePhase = "before-handler" | "after-handler" | "cancel";

/**
 * Configuration for a protected resource
 * Only contains payment-specific configuration, not resource metadata
 */
export interface ResourceConfig {
  scheme: string;
  /**
   * Payment recipient. Use a **vacant** value (`""` or whitespace-only) when an extension must
   * fill `payTo` during `enrichPaymentRequiredResponse`; non-vacant values are **immutable** there
   * so extensions cannot redirect funds to an arbitrary address.
   */
  payTo: string;
  price: Price;
  network: Network;
  maxTimeoutSeconds?: number;
  extra?: Record<string, unknown>; // Scheme-specific additional data
}

/**
 * Context for `enrichPaymentRequiredResponse`. Extensions may merge extension payload via the
 * return value. In-place edits to `paymentRequiredResponse.accepts` are **allowlisted** only
 * (see {@link assertAcceptsAllowlistedAfterExtensionEnrich}): `scheme`, `network`, and
 * `maxTimeoutSeconds` are immutable; `payTo`, `amount`, and `asset` may change only when the
 * baseline value was vacant; `extra` may add keys but must not change or remove baseline keys.
 * `extra.paymentFlow` and `extra.assetTransferMethod` are protocol-reserved and immutable
 * during enrichment (enrichment must not add or rewrite them).
 */
export interface PaymentRequiredContext {
  requirements: PaymentRequirements[];
  resourceInfo: ResourceInfo;
  error?: string;
  paymentRequiredResponse: PaymentRequired;
  transportContext?: unknown;
}

/**
 * Verify / settle lifecycle hook context: treat as **read-only** for core protocol fields.
 * Control flow uses **abort** / **recover** return values only, not in-place mutation.
 */
export interface VerifyContext {
  paymentPayload: DeepReadonly<PaymentPayload>;
  requirements: DeepReadonly<PaymentRequirements>;
  declaredExtensions: DeepReadonly<Record<string, unknown>>;
  transportContext?: unknown;
}

export interface VerifyResultContext extends VerifyContext {
  result: DeepReadonly<VerifyResponse>;
}

/**
 * Optional acknowledgement body returned to the caller when an `AfterVerifyHook`
 * requests that the resource handler be skipped for a self-contained operation
 * (e.g. cooperative refund). Travels in-process only — never on the facilitator wire.
 */
export interface SkipHandlerDirective {
  contentType?: string;
  body?: unknown;
}

export type ResourceVerifyRespone = VerifyResponse & {
  skipHandler?: SkipHandlerDirective;
};

export interface VerifyFailureContext extends VerifyContext {
  error: Error;
}

export interface SettleContext {
  paymentPayload: DeepReadonly<PaymentPayload>;
  requirements: DeepReadonly<PaymentRequirements>;
  declaredExtensions: DeepReadonly<Record<string, unknown>>;
  phase: SettlePhase;
  transportContext?: unknown;
}

export interface SettleResultContext extends SettleContext {
  result: DeepReadonly<SettleResponse>;
}

export interface SettleFailureContext extends SettleContext {
  error: Error;
}

/**
 * Generic (scheme/network-agnostic) settle error reason meaning a
 * transaction broadcast successfully but its receipt/confirmation wait
 * failed — non-terminal, and always carries the broadcast transaction hash
 * so a caller can reconcile onchain. Duplicated here (rather than imported
 * from a mechanism package) so core does not depend on the mechanisms
 * packages, mirroring Go's `x402.ErrSettlementPending`
 * (`go/errors.go`) and its mechanism-level counterparts
 * (`evm.ErrSettlementPending`, `svm.ErrSettlementPending`). Used by
 * {@link x402ResourceServer.settlePayment}'s single automatic settle retry.
 */
const SETTLEMENT_PENDING_REASON = "settlement_pending";

export type VerifiedPaymentCancellationReason =
  | "handler_threw"
  | "handler_failed"
  | "after_verify_aborted";

export interface VerifiedPaymentCanceledContext extends SettleContext {
  reason: VerifiedPaymentCancellationReason;
  error?: unknown;
  responseStatus?: number;
  readonly settledPhases: readonly SettlePhase[];
}

export interface VerifiedPaymentCancelOptions {
  reason: VerifiedPaymentCancellationReason;
  error?: unknown;
  responseStatus?: number;
}

export interface CompletedSettlement {
  phase: SettlePhase;
  flow: PaymentFlowName;
  result: SettleResponse;
  requirements: PaymentRequirements;
}

/**
 * Failure-path cancel hook for a payment that already passed pre-handler gates.
 * Created by {@link x402ResourceServer.createPaymentCancellationDispatcher}.
 * Success-path settle results are not stored here — callers pass
 * `beforeHandlerSettlement` into settlement separately when echoing PAYMENT-RESPONSE.
 */
export interface PaymentCancellationDispatcher {
  cancel(options: VerifiedPaymentCancelOptions): Promise<SettleResponse | void>;
}

export type BeforeVerifyHook = (
  context: VerifyContext,
) => Promise<
  void | { abort: true; reason: string; message?: string } | { skip: true; result: VerifyResponse }
>;

export type AfterVerifyHook = (
  context: VerifyResultContext,
) => Promise<
  | void
  | { skipHandler: true; response?: SkipHandlerDirective }
  | { abort: true; reason: string; message?: string }
>;

export type OnVerifyFailureHook = (
  context: VerifyFailureContext,
) => Promise<void | { recovered: true; result: VerifyResponse }>;

export type BeforeSettleHook = (
  context: SettleContext,
) => Promise<
  void | { abort: true; reason: string; message?: string } | { skip: true; result: SettleResponse }
>;

export type AfterSettleHook = (context: SettleResultContext) => Promise<void>;

export type OnSettleFailureHook = (
  context: SettleFailureContext,
) => Promise<void | { recovered: true; result: SettleResponse }>;

export type OnVerifiedPaymentCanceledHook = (
  context: VerifiedPaymentCanceledContext,
) => Promise<void>;
```

Hook order for each phase: manual hooks registered with `server.onBeforeVerify(...)` and friends first, then the matched scheme's `schemeHooks`, then extension hooks for the extension keys in use (lines 1870-1912). A hook that throws is logged with `console.warn` and skipped.

### 4.7 `SchemeNetworkServer` members (all of them; full interface in 1.4)

| Member | Required | Used where | z402 skeleton |
| --- | --- | --- | --- |
| `scheme` | yes | registry key, `requirements.scheme` | `Z402_SCHEME` |
| `defaultAssetTransferMethod` | yes (since 2.22.0, CHANGELOG l. 52) | `resolvePaymentFlow` when `extra.assetTransferMethod` is absent | `"default"` (SDK sentinel, never on the wire) |
| `paymentFlows` | yes | flow resolution; constructor-time route validation (`x402HTTPResourceServer.ts:443-449`) | `{ default: { supported: ["authorization"], default: "authorization" } }` |
| `parsePrice(price, network)` | yes | `buildPaymentRequirements` | AssetAmount pass-through, plus `"<n> ZEC"` |
| `enhancePaymentRequirements(req, supportedKind, extKeys)` | yes | after `parsePrice`, on every request | copy `windowZat`, `creditRatio`, `creditCapZat` from `supportedKind.extra` |
| `getAssetDecimals?` | no | `$` overrides, paywall | `ZEC` → 8 |
| `validateFacilitatorSupport?` | no | `initialize()`; a problem string means `exit(1)` | require the three terms |
| `schemeHooks?` | no | verify and settle lifecycle | `onAfterVerify` stashes `result.extra.session` on refusals |
| `enrichPaymentRequiredResponse?` | no | every 402 built for this scheme; receives `paymentPayload` on verify failures | corrective `accepts[i].extra.session` |
| `dynamicExtraFields?` | no | `extra` comparison during matching | not needed |
| `enrichSettlementPayload?` / `enrichSettlementResponse?` | no | before and after facilitator settle | not needed |
| `settleOnCancel?` | no | only if a settle already ran **before** the handler (upfront or escrow) | not needed |

## 5. `@x402/express`

### 5.1 Exports and signatures (published `.d.mts`, verbatim)

Source: `$NPM/x402-express-2.28.0/package/dist/esm/index.d.mts:84-176`

```ts
declare function setSettlementOverrides(res: Response, overrides: SettlementOverrides): void;
/**
 * Configuration for registering a payment scheme with a specific network
 */
interface SchemeRegistration {
    /**
     * The network identifier (e.g., 'eip155:84532', 'solana:mainnet')
     */
    network: Network;
    /**
     * The scheme server implementation for this network
     */
    server: SchemeNetworkServer;
}
/**
 * Express payment middleware for x402 protocol (direct HTTP server instance).
 *
 * Use this when you need to configure HTTP-level hooks.
 *
 * @param httpServer - Pre-configured x402HTTPResourceServer instance
 * @param paywallConfig - Optional configuration for the built-in paywall UI
 * @param paywall - Optional custom paywall provider (overrides default)
 * @param syncFacilitatorOnStart - Whether to sync with the facilitator on startup (defaults to true)
 * @returns Express middleware handler
 *
 * @example
 * ```typescript
 * import { paymentMiddlewareFromHTTPServer, x402ResourceServer, x402HTTPResourceServer } from "@x402/express";
 *
 * const resourceServer = new x402ResourceServer(facilitatorClient)
 *   .register(NETWORK, new ExactEvmScheme())
 *
 * const httpServer = new x402HTTPResourceServer(resourceServer, routes)
 *   .onProtectedRequest(requestHook);
 *
 * app.use(paymentMiddlewareFromHTTPServer(httpServer));
 * ```
 */
declare function paymentMiddlewareFromHTTPServer(httpServer: x402HTTPResourceServer, paywallConfig?: PaywallConfig, paywall?: PaywallProvider, syncFacilitatorOnStart?: boolean): (req: Request, res: Response, next: NextFunction) => Promise<void>;
/**
 * Express payment middleware for x402 protocol (direct server instance).
 *
 * Use this when you want to pass a pre-configured x402ResourceServer instance.
 * This provides more flexibility for testing, custom configuration, and reusing
 * server instances across multiple middlewares.
 *
 * @param routes - Route configurations for protected endpoints
 * @param server - Pre-configured x402ResourceServer instance
 * @param paywallConfig - Optional configuration for the built-in paywall UI
 * @param paywall - Optional custom paywall provider (overrides default)
 * @param syncFacilitatorOnStart - Whether to sync with the facilitator on startup (defaults to true)
 * @returns Express middleware handler
 *
 * @example
 * ```typescript
 * import { paymentMiddleware } from "@x402/express";
 *
 * const server = new x402ResourceServer(myFacilitatorClient)
 *   .register(NETWORK, new ExactEvmScheme());
 *
 * app.use(paymentMiddleware(routes, server, paywallConfig));
 * ```
 */
declare function paymentMiddleware(routes: RoutesConfig, server: x402ResourceServer, paywallConfig?: PaywallConfig, paywall?: PaywallProvider, syncFacilitatorOnStart?: boolean): (req: Request, res: Response, next: NextFunction) => Promise<void>;
/**
 * Express payment middleware for x402 protocol (configuration-based).
 *
 * Use this when you want to quickly set up middleware with simple configuration.
 * This function creates and configures the x402ResourceServer internally.
 *
 * @param routes - Route configurations for protected endpoints
 * @param facilitatorClients - Optional facilitator client(s) for payment processing
 * @param schemes - Optional array of scheme registrations for server-side payment processing
 * @param paywallConfig - Optional configuration for the built-in paywall UI
 * @param paywall - Optional custom paywall provider (overrides default)
 * @param syncFacilitatorOnStart - Whether to sync with the facilitator on startup (defaults to true)
 * @returns Express middleware handler
 *
 * @example
 * ```typescript
 * import { paymentMiddlewareFromConfig } from "@x402/express";
 *
 * app.use(paymentMiddlewareFromConfig(
 *   routes,
 *   myFacilitatorClient,
 *   [{ network: "eip155:8453", server: evmSchemeServer }],
 *   paywallConfig
 * ));
 * ```
 */
declare function paymentMiddlewareFromConfig(routes: RoutesConfig, facilitatorClients?: FacilitatorClient | FacilitatorClient[], schemes?: SchemeRegistration[], paywallConfig?: PaywallConfig, paywall?: PaywallProvider, syncFacilitatorOnStart?: boolean): (req: Request, res: Response, next: NextFunction) => Promise<void>;

export { ExpressAdapter, type SchemeRegistration, paymentMiddleware, paymentMiddlewareFromConfig, paymentMiddlewareFromHTTPServer, setSettlementOverrides };
```

Re-exported from `@x402/express`: `x402ResourceServer`, `x402HTTPResourceServer`, `RouteConfigurationError`, `SETTLEMENT_OVERRIDES_HEADER`, and the types `PaymentRequired`, `PaymentRequirements`, `PaymentPayload`, `Network`, `SchemeNetworkServer`, `PaywallConfig`, `PaywallProvider`, `SettlementOverrides`, `RouteValidationError` (`$X402/typescript/packages/http/express/src/index.ts:545-561`).

### 5.2 Route config format (verbatim)

Source: `$X402/typescript/packages/core/src/http/x402HTTPResourceServer.ts:149-213`

```ts
/**
 * A single payment option for a route
 * Represents one way a client can pay for access to the resource
 */
export interface PaymentOption {
  scheme: string;
  payTo: string | DynamicPayTo;
  price: Price | DynamicPrice;
  network: Network;
  maxTimeoutSeconds?: number;
  extra?: Record<string, unknown>;
}

/**
 * Route configuration for HTTP endpoints
 *
 * The 'accepts' field defines payment options for the route.
 * Can be a single PaymentOption or an array of PaymentOptions for multiple payment methods.
 */
export interface RouteConfig {
  // Payment option(s): single or array
  accepts: PaymentOption | PaymentOption[];

  // HTTP-specific metadata
  resource?: string;
  description?: string;
  mimeType?: string;
  serviceName?: string;
  tags?: string[];
  iconUrl?: string;
  customPaywallHtml?: string;

  /**
   * Optional callback to generate a custom response for unpaid API requests.
   * This allows servers to return preview data, error messages, or other content
   * when a request lacks payment.
   *
   * For browser requests (Accept: text/html), the paywall HTML takes precedence.
   * This callback is only used for API clients.
   *
   * If not provided, defaults to { contentType: 'application/json', body: {} }.
   *
   * @param context - The HTTP request context
   * @returns An object containing both contentType and body for the 402 response
   */
  unpaidResponseBody?: UnpaidResponseBody;

  /**
   * Optional callback to generate a custom response for settlement failures.
   * If not provided, defaults to { contentType: 'application/json', body: {} }.
   *
   * @param context - The HTTP request context
   * @param settleResult - The settlement failure result
   * @returns An object containing both contentType and body for the 402 response
   */
  settlementFailedResponseBody?: SettlementFailedResponseBody;

  // Extensions
  extensions?: Record<string, unknown>;
}

/**
 * Routes configuration - maps path patterns to route configs
 */
export type RoutesConfig = Record<string, RouteConfig> | RouteConfig;
```

- Route keys look like `"GET /chunk"`, `"/api/*"`, `"/x/:id"` or `"/x/[id]"`. A key without a verb matches every method (`x402HTTPResourceServer.ts:1373-1402`).
- `description` and `mimeType` default to `""`. `resource.url` defaults to `` `${req.protocol}://${req.headers.host}${req.originalUrl}` ``, query string included (`express/src/adapter.ts:49-51`).
- **TypeScript gotcha (ran it).** An object literal assigned to an unannotated variable widens `network` to `string`, which produces `TS2322: Type 'string' is not assignable to type '${string}:${string}'`. Write the options inline in `paymentMiddleware({...})`, or annotate them with `RoutesConfig` (`@x402/core/server`) or `PaymentOption` (`@x402/core/http`).

### 5.3 Control flow of `paymentMiddlewareFromHTTPServer` (`$X402/typescript/packages/http/express/src/index.ts:106-454`)

1. At construction, call `httpServer.initialize()` eagerly and attach `attachBackgroundInitHandler` (lines 117-125). Fatal errors call `process.exit(1)`; retryable ones are swallowed.
2. Per request: if `requiresPayment()` is false, call `next()` with no facilitator contact. Otherwise make sure init has succeeded (retrying it), then call `processHTTPRequest()` (lines 167-216):
   - It rebuilds the requirements and the 402.
   - With no or an undecodable `PAYMENT-SIGNATURE`, it returns 402 with `PAYMENT-REQUIRED`.
   - If no requirement matches, it returns 402 "No matching payment requirements". An extension echo mismatch also returns 402.
   - It calls `verifyPayment`. `isValid:false` returns 402 whose `error` is `invalidReason`.
   - With `settleBeforeHandler` (upfront or escrow) it settles here.
3. On `payment-verified`, it monkey-patches `res.writeHead`, `write`, `end` and `flushHeaders` to **buffer** everything, then calls `next()` and awaits the handler's `res.end()` (lines 238-337). The whole response body is held until settle finishes, so streaming responses do not stream.
4. If the handler threw: `cancellationDispatcher.cancel({reason:"handler_threw"})`, then `next(error)`.
5. If the handler status is 400 or more: no settle. Cancel, then replay the buffered response as-is, without `PAYMENT-RESPONSE` (lines 339-371). The voucher is not recorded, so the client must not advance its local total (section 8.6).
6. Otherwise call `processSettlement()`. On success, set `PAYMENT-RESPONSE` and `Cache-Control: private` (merged), then replay the buffered response. On failure, discard the buffer and send `response.status` (402) with `PAYMENT-RESPONSE` and `{}`. A `FacilitatorResponseError` becomes 502 `{error}`; any other throw becomes 402 `{}` (lines 373-450).

Source: `$X402/typescript/packages/http/express/src/index.ts:373-453`

```ts
        try {
          // Build response body buffer from buffered write/end calls
          const responseBody = Buffer.concat(
            bufferedCalls.flatMap(([m, args]) =>
              (m === "write" || m === "end") && args[0] ? [Buffer.from(args[0])] : [],
            ),
          );

          const responseHeaders: Record<string, string> = {};
          for (const [key, value] of Object.entries(res.getHeaders())) {
            if (value != null) {
              responseHeaders[key] = String(value);
            }
          }

          const settleResult = await httpServer.processSettlement(
            paymentPayload,
            paymentRequirements,
            declaredExtensions,
            { request: context, responseBody, responseHeaders },
            undefined,
            beforeHandlerSettlement,
          );

          // If settlement fails, return an error and do not send the buffered response
          if (!settleResult.success) {
            bufferedCalls = [];
            const { response } = settleResult;
            Object.entries(response.headers).forEach(([key, value]) => {
              res.setHeader(key, value);
            });
            if (response.isHtml) {
              res.status(response.status).send(response.body);
            } else {
              res.status(response.status).json(response.body ?? {});
            }
            return;
          }

          // Settlement succeeded - add headers to response
          Object.entries(settleResult.headers).forEach(([key, value]) => {
            res.setHeader(key, value);
          });
          res.setHeader(
            "Cache-Control",
            withPrivateCacheControl(
              res.getHeader("Cache-Control") != null
                ? String(res.getHeader("Cache-Control"))
                : null,
            ),
          );
        } catch (error) {
          if (error instanceof FacilitatorResponseError) {
            bufferedCalls = [];
            sendFacilitatorError(res, error);
            return;
          }
          console.error(error);
          // If settlement fails, don't send the buffered response
          bufferedCalls = [];
          res.status(402).json({});
          return;
        } finally {
          restoreResponseMethods();

          res.removeHeader(SETTLEMENT_OVERRIDES_HEADER);

          // Replay all buffered calls in order
          for (const [method, args] of bufferedCalls) {
            if (method === "writeHead")
              originalWriteHead(...(args as Parameters<typeof originalWriteHead>));
            else if (method === "write")
              originalWrite(...(args as Parameters<typeof originalWrite>));
            else if (method === "end") originalEnd(...(args as Parameters<typeof originalEnd>));
            else if (method === "flushHeaders") originalFlushHeaders();
          }
          bufferedCalls = [];
        }
        return;
    }
  };
```

Source: `$X402/typescript/packages/core/src/http/x402HTTPResourceServer.ts:1035-1073`

```ts
  /**
   * Build HTTPResponseInstructions for settlement failure.
   * Uses settlementFailedResponseBody hook if configured, otherwise defaults to empty body.
   *
   * @param failure - Settlement failure result with headers
   * @param transportContext - Optional HTTP transport context for the request
   * @returns HTTP response instructions for the 402 settlement failure response
   */
  private async buildSettlementFailureResponse(
    failure: Omit<ProcessSettleFailureResponse, "response">,
    transportContext?: HTTPTransportContext,
  ): Promise<HTTPResponseInstructions> {
    const settlementHeaders = failure.headers;
    const routeConfig = transportContext
      ? this.getRouteConfig(
          transportContext.request.path,
          transportContext.request.method,
          transportContext.request.decodedPath,
        )
      : undefined;

    const customBody = routeConfig?.config.settlementFailedResponseBody
      ? await routeConfig.config.settlementFailedResponseBody(transportContext!.request, failure)
      : undefined;

    const contentType = customBody ? customBody.contentType : "application/json";
    const body = customBody ? customBody.body : {};

    return {
      status: 402,
      headers: {
        "Content-Type": contentType,
        ...settlementHeaders,
        "Cache-Control": PAYMENT_REQUIRED_CACHE_CONTROL,
      },
      body,
      isHtml: contentType.includes("text/html"),
    };
  }
```

### 5.4 What the client sees (ran it, `$SPIKE/probe-roundtrip.log`)

Unpaid request (`GET /chunk?n=1`): status, headers and body:

Source: `$SPIKE/probe-roundtrip.log:3-13`

```json
{
  "status": 402,
  "headers": {
    "cache-control": "no-store",
    "content-length": "2",
    "content-type": "application/json; charset=utf-8",
    "payment-required": "eyJ4NDAyVmVyc2lvbiI6MiwiZXJyb3IiOiJQYXltZW50IHJlcXVpcmVkIiwicmVzb3VyY2UiOnsidXJsIjoiaHR0cDovLzEyNy4wLjAuMTo0OTIzOC9jaHVuaz9uPTEiLCJkZXNjcmlwdGlvbiI6Ik9uZSBjaHVuayBvZiB0aGUgc3RyZWFtIiwibWltZVR5cGUiOiJhcHBsaWNhdGlvbi9qc29uIn0sImFjY2VwdHMiOlt7InNjaGVtZSI6InpjYXNoLXNlc3Npb24iLCJuZXR3b3JrIjoiemNhc2g6dGVzdG5ldCIsImFtb3VudCI6IjEwMDAiLCJhc3NldCI6IlpFQyIsInBheVRvIjoidXRlc3QxbWVyY2hhbnRzaGllbGRlZG9ubHl1bmlmaWVkYWRkcmVzc3BsYWNlaG9sZGVyIiwibWF4VGltZW91dFNlY29uZHMiOjYwLCJleHRyYSI6eyJ3aW5kb3daYXQiOjEwMDAwMCwiY3JlZGl0UmF0aW8iOjAuMjUsImNyZWRpdENhcFphdCI6MjAwMDAwfX1dfQ==",
    "x-powered-by": "Express"
  },
  "body": "{}"
}
```

Decoded `PAYMENT-REQUIRED`:

Source: `$SPIKE/probe-roundtrip.log:16-39`

```json
{
  "x402Version": 2,
  "error": "Payment required",
  "resource": {
    "url": "http://127.0.0.1:49238/chunk?n=1",
    "description": "One chunk of the stream",
    "mimeType": "application/json"
  },
  "accepts": [
    {
      "scheme": "zcash-session",
      "network": "zcash:testnet",
      "amount": "1000",
      "asset": "ZEC",
      "payTo": "utest1merchantshieldedonlyunifiedaddressplaceholder",
      "maxTimeoutSeconds": 60,
      "extra": {
        "windowZat": 100000,
        "creditRatio": 0.25,
        "creditCapZat": 200000
      }
    }
  ]
}
```

Paid call that carried the deposit: 200, headers, body, decoded `PAYMENT-RESPONSE`:

Source: `$SPIKE/probe-roundtrip.log:70-102`

```text
{
  "status": 200,
  "headers": {
    "cache-control": "private",
    "content-length": "28",
    "content-type": "application/json; charset=utf-8",
    "payment-response": "eyJzdWNjZXNzIjp0cnVlLCJwYXllciI6ImNiN2IzMDA2MjkwOWM2NjE1NTIyZTVlMDg4MWE0ZmM2MzJlOThiMjY3ZGI3ZWZkMzQ3NzkwZWE3ZjY4NjA0NjYiLCJ0cmFuc2FjdGlvbiI6ImFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWIiLCJuZXR3b3JrIjoiemNhc2g6dGVzdG5ldCIsImFtb3VudCI6IjEwMDAiLCJleHRyYSI6eyJzZXNzaW9uIjp7InNlc3Npb25LZXkiOiJjYjdiMzAwNjI5MDljNjYxNTUyMmU1ZTA4ODFhNGZjNjMyZTk4YjI2N2RiN2VmZDM0Nzc5MGVhN2Y2ODYwNDY2IiwiY3VtdWxhdGl2ZVphdCI6IjEwMDAiLCJsaW1pdFphdCI6IjEwMDAwMCIsImNvbmZpcm1lZFphdCI6IjAiLCJwZW5kaW5nWmF0IjoiMTAwMDAwIiwiY3JlZGl0WmF0IjoiMCJ9fX0=",
    "x-powered-by": "Express"
  },
  "body": {
    "chunk": 1,
    "data": "chunk-1"
  }
}

=== call 1 decoded PAYMENT-RESPONSE
{
  "success": true,
  "payer": "cb7b30062909c6615522e5e0881a4fc632e98b267db7efd347790ea7f6860466",
  "transaction": "abababababababababababababababababababababababababababababababab",
  "network": "zcash:testnet",
  "amount": "1000",
  "extra": {
    "session": {
      "sessionKey": "cb7b30062909c6615522e5e0881a4fc632e98b267db7efd347790ea7f6860466",
      "cumulativeZat": "1000",
      "limitZat": "100000",
      "confirmedZat": "0",
      "pendingZat": "100000",
      "creditZat": "0"
    }
  }
}
```

The stock wrapper made two HTTP requests per paid call: unpaid, which got 402, then paid, which got 200 (`probe-roundtrip.log:200-213`). The first request of every call is always unpaid (`$X402/typescript/packages/http/fetch/src/index.ts:46-54`).

Verify refused with `z402_limit_exceeded`: 402 with `PAYMENT-REQUIRED`, and what the client scheme's `onPaymentResponse` hook received. `accepts[0].extra.session` is the corrective state added by the skeleton's `enrichPaymentRequiredResponse`:

Source: `$SPIKE/probe-roundtrip.log:221-271`

```text
=== limit exceeded: status + headers
{
  "status": 402,
  "headers": {
    "cache-control": "no-store",
    "content-length": "2",
    "content-type": "application/json; charset=utf-8",
    "payment-required": "eyJ4NDAyVmVyc2lvbiI6MiwiZXJyb3IiOiJ6NDAyX2xpbWl0X2V4Y2VlZGVkIiwicmVzb3VyY2UiOnsidXJsIjoiaHR0cDovLzEyNy4wLjAuMTo0OTIzOC9jaHVuayIsImRlc2NyaXB0aW9uIjoiT25lIGNodW5rIG9mIHRoZSBzdHJlYW0iLCJtaW1lVHlwZSI6ImFwcGxpY2F0aW9uL2pzb24ifSwiYWNjZXB0cyI6W3sic2NoZW1lIjoiemNhc2gtc2Vzc2lvbiIsIm5ldHdvcmsiOiJ6Y2FzaDp0ZXN0bmV0IiwiYW1vdW50IjoiMTAwMCIsImFzc2V0IjoiWkVDIiwicGF5VG8iOiJ1dGVzdDFtZXJjaGFudHNoaWVsZGVkb25seXVuaWZpZWRhZGRyZXNzcGxhY2Vob2xkZXIiLCJtYXhUaW1lb3V0U2Vjb25kcyI6NjAsImV4dHJhIjp7IndpbmRvd1phdCI6MTAwMDAwLCJjcmVkaXRSYXRpbyI6MC4yNSwiY3JlZGl0Q2FwWmF0IjoyMDAwMDAsInNlc3Npb24iOnsic2Vzc2lvbktleSI6ImNiN2IzMDA2MjkwOWM2NjE1NTIyZTVlMDg4MWE0ZmM2MzJlOThiMjY3ZGI3ZWZkMzQ3NzkwZWE3ZjY4NjA0NjYiLCJjdW11bGF0aXZlWmF0IjoiNzUwMDAiLCJsaW1pdFphdCI6IjEwMDAwMCIsImNvbmZpcm1lZFphdCI6IjAiLCJwZW5kaW5nWmF0IjoiMTAwMDAwIiwiY3JlZGl0WmF0IjoiMCJ9fX1dfQ==",
    "x-powered-by": "Express"
  },
  "body": "{}"
}

=== limit exceeded: decoded PAYMENT-REQUIRED.error
z402_limit_exceeded

=== limit exceeded: what onPaymentResponse saw
{
  "paymentRequired": {
    "x402Version": 2,
    "error": "z402_limit_exceeded",
    "resource": {
      "url": "http://127.0.0.1:49238/chunk",
      "description": "One chunk of the stream",
      "mimeType": "application/json"
    },
    "accepts": [
      {
        "scheme": "zcash-session",
        "network": "zcash:testnet",
        "amount": "1000",
        "asset": "ZEC",
        "payTo": "utest1merchantshieldedonlyunifiedaddressplaceholder",
        "maxTimeoutSeconds": 60,
        "extra": {
          "windowZat": 100000,
          "creditRatio": 0.25,
          "creditCapZat": 200000,
          "session": {
            "sessionKey": "cb7b30062909c6615522e5e0881a4fc632e98b267db7efd347790ea7f6860466",
            "cumulativeZat": "75000",
            "limitZat": "100000",
            "confirmedZat": "0",
            "pendingZat": "100000",
            "creditZat": "0"
          }
        }
      }
    ]
  }
}
```

Settle refused (two concurrent requests with one voucher and a 300 ms handler, so both passed `/verify`):

Source: `$SPIKE/probe-roundtrip.log:291-331`

```text
=== concurrent duplicate voucher (slow handler): statuses
[
  200,
  402
]

=== settle-failure response: headers + body
{
  "status": 402,
  "headers": {
    "cache-control": "no-store",
    "content-length": "2",
    "content-type": "application/json; charset=utf-8",
    "payment-response": "eyJzdWNjZXNzIjpmYWxzZSwiZXJyb3JSZWFzb24iOiJ6NDAyX2N1bXVsYXRpdmVfdG9vX2xvdyIsImVycm9yTWVzc2FnZSI6ImN1bXVsYXRpdmVaYXQgbXVzdCBiZSA+PSA3ODAwMCIsInBheWVyIjoiY2I3YjMwMDYyOTA5YzY2MTU1MjJlNWUwODgxYTRmYzYzMmU5OGIyNjdkYjdlZmQzNDc3OTBlYTdmNjg2MDQ2NiIsInRyYW5zYWN0aW9uIjoiIiwibmV0d29yayI6InpjYXNoOnRlc3RuZXQiLCJleHRyYSI6eyJzZXNzaW9uIjp7InNlc3Npb25LZXkiOiJjYjdiMzAwNjI5MDljNjYxNTUyMmU1ZTA4ODFhNGZjNjMyZTk4YjI2N2RiN2VmZDM0Nzc5MGVhN2Y2ODYwNDY2IiwiY3VtdWxhdGl2ZVphdCI6Ijc3MDAwIiwibGltaXRaYXQiOiIxMjUwMDAiLCJjb25maXJtZWRaYXQiOiIxMDAwMDAiLCJwZW5kaW5nWmF0IjoiMCIsImNyZWRpdFphdCI6IjI1MDAwIn19fQ==",
    "x-powered-by": "Express"
  },
  "body": "{}"
}

=== settle-failure decoded header
{
  "paymentResponse": {
    "success": false,
    "errorReason": "z402_cumulative_too_low",
    "errorMessage": "cumulativeZat must be >= 78000",
    "payer": "cb7b30062909c6615522e5e0881a4fc632e98b267db7efd347790ea7f6860466",
    "transaction": "",
    "network": "zcash:testnet",
    "extra": {
      "session": {
        "sessionKey": "cb7b30062909c6615522e5e0881a4fc632e98b267db7efd347790ea7f6860466",
        "cumulativeZat": "77000",
        "limitZat": "125000",
        "confirmedZat": "100000",
        "pendingZat": "0",
        "creditZat": "25000"
      }
    }
  },
  "paymentRequiredError": null
}
```

### 5.5 Startup behaviour (ran it, `$SPIKE/probe-startup-*.log`)

| `/supported` state when `paymentMiddleware(...)` is constructed | Result |
| --- | --- |
| facilitator unreachable | `console.warn` "Failed to fetch supported kinds..."; the process stays up; each protected request retries init and gets 500 until it succeeds (`down`: exit 0 after 3 s) |
| reachable but no kind for `(2, scheme, "zcash:testnet")` | `RouteConfigurationError: ... Facilitator does not support scheme "zcash-session" on network "zcash:testnet"`, then **exit 1** (`wrong-scheme`) |
| kind present but no terms in `extra` (our `validateFacilitatorSupport`) | `FacilitatorCapabilityError: ... lacks extra.windowZat, extra.creditRatio, extra.creditCapZat`, then **exit 1** (`no-terms`) |

Source: `$X402/typescript/packages/core/src/http/backgroundInit.ts:14-33` (fatal means `FacilitatorCapabilityError` or `RouteConfigurationError`). Start the facilitator first. Alternatively, build `new x402HTTPResourceServer(server, routes)`, `await httpServer.initialize()` before `app.listen`, and then use `paymentMiddlewareFromHTTPServer(httpServer)`; it calls `initialize()` again, which is harmless.

### 5.6 One process instead of two

- Option A: mount the facilitator routes under `/facilitator` in the API's Express app and point `HTTPFacilitatorClient` at `http://127.0.0.1:<port>/facilitator`. The eager init fails once, before `listen`, and the first protected request retries it.
- Option B: pass an in-process `FacilitatorClient`, as in `$X402/examples/typescript/servers/self-facilitation/index.ts:64-68`. **The example as written does not type-check against 2.28.0** (ran it, `$SPIKE/checks/selfFacilitationNoCast.ts`): `x402Facilitator.getSupported()` types `kinds[].network` as `string`, and `SupportedKind.network` is `` `${string}:${string}` `` (TS2345). Fix: `getSupported: async () => facilitator.getSupported() as SupportedResponse` (`$SPIKE/src/server/selfFacilitation.ts`).
- The spec asks for `/verify`, `/settle` and `/supported` endpoints, so the two-process HTTP layout in section 9 matches it most directly.


## 6. Sessions, `upto`, deferred and batch schemes, idempotency, reusing a payment

- **Core has no session concept.** The v2 spec lists "Session handling mechanisms" as out of scope (`$X402/specs/x402-specification-v2.md:14-20`). Every request is a fresh 402 round trip, and any session state lives inside a scheme.
- **`upto`** (`$X402/specs/schemes/upto/scheme_upto.md`): a single-use authorization of up to `amount`. The settle-time `amount` may be lower, passed through `SettlementOverrides` or the `Settlement-Overrides` response header that `setSettlementOverrides(res, {amount})` sets in Express. It explicitly excludes "Multi-settlement / streaming". z402 does not need it.
- **`batch-settlement`** (`$X402/specs/schemes/batch-settlement/scheme_batch_settlement.md`) is the closest official analog. A commitment (voucher) is accepted per request and value moves later; "The settlement result MUST include a non-empty commitment identifier on success". Its EVM implementation offers four patterns z402 can borrow:
  1. Facilitator `getExtra()` advertises scheme parameters (`receiverAuthorizer`), and the server's `enhancePaymentRequirements` copies them into `extra` (`$X402/typescript/packages/mechanisms/evm/src/batch-settlement/facilitator/scheme.ts:99-104`, `.../server/scheme.ts:296-330`).
  2. `validateFacilitatorSupport` fails startup when those parameters are missing (`.../server/scheme.ts:341-360`).
  3. A **corrective 402**. On a cumulative mismatch, `enrichPaymentRequiredResponse` adds `channelState` to `accepts[].extra` (`.../server/verify.ts:193-251`). The client's `onPaymentResponse` hook resyncs from `ctx.paymentRequired` and returns `{recovered:true}` (`.../client/hooks.ts:22-71`). The settle response's `extra.channelState` updates the client after each success.
  4. Per-request state is kept in a `WeakMap` keyed by the `PaymentPayload` object (`.../server/scheme.ts:70-73`).
  - The EVM binding also settles vouchers **in the resource server**, through `beforeSettle` returning `{skip:true,result}` (`.../server/settle.ts:45-160`). That pattern does not fit z402, where the facilitator owns session state.
  - z402 is a "capital-backed" variant of this idea with a zero-conf credit ramp. Calling the z402 scheme `batch-settlement` would also claim its Commit, Accumulate, Redeem lifecycle (`scheme_batch_settlement.md`, "Settlement lifecycle"). z402 has no redeem phase, so a new scheme id is cleaner. The scheme-id choice is open.
- **No "deferred" scheme** ships in 2.28.0. The mechanisms present are exact, upto, batch-settlement and auth-capture (`$X402/specs/schemes/`, `$X402/typescript/packages/mechanisms/*/src`).
- **`payment-identifier`** (`$X402/specs/extensions/payment_identifier.md`) is an idempotency key, `extensions["payment-identifier"].info.id`, 16 to 128 characters. A repeated id with the same payload gets the cached response; a different payload gets 409. It is optional, and z402 does not need it: a cumulative voucher is naturally idempotent, since a replay has delta 0, which is less than `amount`, and is refused (ran it: "replayed voucher", `probe-roundtrip.log:285-290`).
- **`sign-in-with-x`** (`$X402/specs/extensions/sign-in-with-x.md`) is CAIP-122 wallet sign-in, so a returning payer can skip payment. It runs between client and server only and is EVM/SVM-oriented. It is not needed.
- **`PendingSettlementStore`** (`@x402/core/facilitator`, `$X402/typescript/packages/core/src/facilitator/pendingSettlementStore.ts`) supports broadcast-then-confirm settles that return `settlement_pending`. Not needed: z402's settle broadcasts nothing.
- **Reusing one payment across requests:** core has no mechanism for it. The session key and the cumulative voucher are what make reuse safe in z402.

## 7. What blocks or complicates a non-EVM, non-SVM scheme on `zcash:testnet`

1. **Client spend controls (blocker for "one register line").** `x402Client` starts with `spendControls = {}` (`$X402/typescript/packages/core/src/client/x402Client.ts:330`). It drops every requirement whose asset the registered scheme's `findDefaultAsset` does not recognise and that has no `allowedAssets` entry (`:884-898`). Ran it: without `findDefaultAsset` the client throws *"All payment requirements were rejected by spendControls: only default assets or entries in spendControls.allowedAssets are allowed. ..."*. With `findDefaultAsset` returning `{asset:"ZEC",decimals:8,symbol:"ZEC"}`, it passes, and the scheme receives `context.maxAmountPerPayment = "100000000"` ("$1" treated as 1 ZEC). That works, but it bends the USD-peg rule in `DEFAULT_ASSETS.md:44-55`. The honest alternative costs the agent one extra call: `new x402Client().setSpendControls({ allowedAssets: [{ network: "zcash:testnet", asset: "ZEC", maxAmountPerPayment: "1000" }] })`. The core tests do `.setSpendControls(false)` for their non-USD "cash" scheme (`$X402/typescript/packages/core/test/mocks/cash/index.ts:19-23`).
2. **No USD pricing.** `"$..."` prices need a default-asset table (`DEFAULT_ASSETS.md`), and Zcash has none. Price as an `AssetAmount` in zatoshi.
3. **The amount must be an integer string.** Spend controls compare `BigInt(amount)` only when `amount` matches `/^\d+$/`; otherwise the amount is treated as a decimal USD value (`x402Client.ts:201-203` and `917-934`). The zod schema also requires a non-empty string (`schemas/index.ts:155-163`).
4. **Network type.** `${string}:${string}` and zod `min(3)` with a colon (`types/index.ts:62`, `schemas/index.ts:43-48`). `zcash:testnet` passes. Watch for literal widening in TypeScript (section 5.2).
5. **CAIP id.** `ChainAgnostic/namespaces` (commit `463bae5625aaa8c184ccc74f1db457da8a43e72b`, 2026-09-03) has **no `zcash` namespace**. `bip122` covers Bitcoin-derived chains by the 32-hex prefix of the genesis hash (`bip122/caip2.md`). For Zcash testnet that prefix is `05a60a92d99d85997cce3b87616c089f`: block 1's `prevHash`, read from testnet.zec.rocks:443 via `GetBlock{height:1}`, is `05a60a92d99d85997cce3b87616c089f6124d7342af37106edc76126334a2c38` in display order. The SDK does not care which id is chosen; both agents must use the same exact string. The official repo itself uses non-numeric references such as `stellar:testnet` (`$X402/examples/typescript/facilitator/advanced/all_networks.ts:163`).
6. **`caipFamily` and signers.** These are only used to group `/supported.signers`. Use `"zcash:*"` and return `[]` from `getSigners`.
7. **`settlement_pending` is reserved.** It triggers the single automatic re-settle and requires a non-empty `transaction` (`x402-specification-v2.md:608`, `x402ResourceServer.ts:2048-2070`). Do **not** use it for "deposit unconfirmed". Unconfirmed deposits are normal in z402.
8. **`transaction` semantics.** "Blockchain transaction hash (empty string if no transaction was broadcast...)" (`x402-specification-v2.md:249`). For voucher-only calls `""` is correct; for the deposit call, the deposit txid is reasonable (Proposal). Nothing in core or express inspects the value on success.
9. **`payTo` and `asset` are free-form strings.** Core only requires them to be non-empty (`schemas/index.ts:155-163`), so a long unified address is fine. It travels base64-encoded in the `PAYMENT-REQUIRED` and `PAYMENT-SIGNATURE` headers, where Node's HTTP header size limit is the only bound (inferred). Matching is exact string equality, so build `payTo` in one place.
10. **Paywall.** Browsers (`Accept: text/html` and a `Mozilla` user agent) get HTML: `@x402/paywall`, which is EVM/SVM-oriented and not installed, or else the static fallback (`x402HTTPResourceServer.ts:1295-1299` and `1455-1490`). Irrelevant to the agent.
11. **The stock fetch wrapper.** It always sends an unpaid request first, so every call costs two HTTP round trips to the API. It allows exactly one paid retry, plus one more only if a hook returns `{recovered:true}` (`$X402/typescript/packages/http/fetch/src/index.ts:46-155`). A 402 *without* `PAYMENT-REQUIRED` on the *first* response throws "Failed to parse payment requirements". That cannot happen to z402, because settle-failure 402s only follow paid requests.
12. **Typing of `@x402/fetch`.** Its `.d.mts` uses the DOM type `RequestInfo`. Under `skipLibCheck:false` without `"lib": ["DOM"]`, tsc reports `TS2552 Cannot find name 'RequestInfo'` (ran it, `$SPIKE/checks/tsconfig.nodom.json`). The client agent should add `"DOM"` to `lib` or set `skipLibCheck: true`.

## 8. Proposed wire contract for z402 (**Proposal**: both agents must agree on it)

### 8.1 402 `accepts[0]`, exactly as the skeleton emits it (ran it)

```json
{
  "scheme": "zcash-session",
  "network": "zcash:testnet",
  "amount": "1000",
  "asset": "ZEC",
  "payTo": "<merchant shielded-only UA>",
  "maxTimeoutSeconds": 60,
  "extra": { "windowZat": 100000, "creditRatio": 0.25, "creditCapZat": 200000 }
}
```

- The scheme id `"zcash-session"` is a placeholder; pick one string and use it on all four sides: route config, server scheme, facilitator scheme, client scheme.
- The terms come from the facilitator's `getExtra()`. The client should treat `extra` as read-only and echo `accepted` unchanged, which the stock `x402Client` does (`accepted: requirements`, `x402Client.ts:594-600`).
- `accepts[0].extra.session` appears **only** on corrective 402s (8.4).

### 8.2 `PaymentPayload.payload`

```json
{
  "sessionKey": "<64 lowercase hex: raw ed25519 public key>",
  "cumulativeZat": "<decimal integer string>",
  "sig": "<128 lowercase hex: raw ed25519 signature>",
  "depositTxid": "<64 lowercase hex, display byte order; only on the call that pays a new window>"
}
```

The client scheme's `createPaymentPayload` must return `{ x402Version, payload }` with **`x402Version` equal to the argument it received (2)**. If it returns 1, the client treats the result as a full v1 payload and `accepted` goes missing (`x402Client.ts:583-601`).

### 8.3 Voucher signature bytes

Proposal; the spec's minimum is "payTo + cumulativeZat". The message is the UTF-8 encoding of:

```
z402-voucher:v1|<network>|<payTo>|<sessionKey>|<cumulativeZat>
```

It is signed with raw ed25519 (RFC 8032), which is what `node:crypto` `sign(null, msg, key)` and `verify(null, msg, jwkKey, sig)` do. Any RFC 8032 library (`@noble/ed25519`, tweetnacl) produces the same 64 bytes. The skeleton uses `voucherMessage()` and `verifyEd25519()` (section 9, `src/shared/z402.ts`).

### 8.4 Facilitator replies

- **VerifyResponse when valid:** `{ "isValid": true, "payer": "<sessionKey>", "extra": { "session": <SessionSnapshot> } }`.
- **VerifyResponse when refused:** `{ "isValid": false, "invalidReason": "<code>", "invalidMessage": "<text>", "payer"?: ..., "extra"?: { "session": <SessionSnapshot> } }`, always with HTTP 200.
- **SettleResponse on success:** `{ "success": true, "payer": "<sessionKey>", "transaction": "<depositTxid or \"\">", "network": "zcash:testnet", "amount": "<cumulative delta>", "extra": { "session": <SessionSnapshot after commit> } }`.
- **SettleResponse on failure:** `{ "success": false, "errorReason": "<code>", "errorMessage": "<text>", "transaction": "", "network": "zcash:testnet", "extra"?: { "session": ... } }`, with HTTP 200.
- **`SessionSnapshot`:** `{ sessionKey, cumulativeZat, limitZat, confirmedZat, pendingZat, creditZat }`, all decimal strings. `limitZat` = `confirmedZat + pendingZat + creditZat`, the spec's `D_conf + D_pend + min(C_max, r·D_conf)`. `pendingZat` is the newest unconfirmed deposit only.
- **Corrective 402 (verify refusals):** the server scheme's `onAfterVerify` stashes `result.extra.session` keyed by the payload object, and `enrichPaymentRequiredResponse` copies it into `accepts[0].extra.session`.
- Ran it: a client that lost its counter got 402 `z402_cumulative_too_low` with the corrective state. Its `onPaymentResponse` hook returned `{recovered:true}`, the stock wrapper retried, and the call got 200 within the same `paidFetch()`. The exchanges were unpaid 402, paid 402, paid 200 (`$SPIKE/probe-recovery.log`).

### 8.5 Error codes and where the client sees them

| Code (Proposal) | Raised in | Client sees |
| --- | --- | --- |
| `invalid_payload`, `invalid_scheme`, `invalid_network`, `invalid_payment_requirements` (spec §9 names) | verify / settle | verify: `paymentRequired.error`; settle: `settleResponse.errorReason` |
| `z402_invalid_signature` | verify | `paymentRequired.error` |
| `z402_deposit_not_found` (after the 15 s mempool retry), `z402_deposit_memo_mismatch`, `z402_deposit_amount_too_low`, `z402_deposit_wrong_recipient`, `z402_deposit_has_transparent`, `z402_deposit_already_used`, `z402_deposit_index_reused` | verify | `paymentRequired.error` |
| `z402_cumulative_too_low` (delta < amount; also replays), `z402_limit_exceeded` (c_new > limit) | verify; settle on races | verify: `paymentRequired.error` plus `accepts[0].extra.session`; settle: `PAYMENT-RESPONSE` `errorReason`/`errorMessage` plus `extra.session` |
| `No matching payment requirements` (SDK) | API | `paymentRequired.error`; `accepted` was altered |

`invalidMessage` never reaches the client on a 200 verify refusal (`x402HTTPResourceServer.ts:669-681` passes only `invalidReason`). `errorMessage` does reach the client on settle refusals.

### 8.6 Client-scheme obligations (for the client agent; they affect the contract)

- Implement `findDefaultAsset`, or have the agent set `spendControls` (7.1).
- Advance the local "settled cumulative" **only** from a successful `PAYMENT-RESPONSE`, using `settleResponse.extra.session.cumulativeZat`. A handler error of 400 or more, a verify refusal or a settle refusal means the voucher was not recorded; the next voucher is `settled + amount` again. Ran it: replaying an already-settled cumulative gets `z402_cumulative_too_low`.
- Compute headroom from `extra` terms and the last `session` snapshot. Deposit when `limitZat - cumulativeZat < windowZat/2` and no deposit is pending.
- Send calls sequentially. Concurrent calls with the same next voucher produce one 200 and one 402, either at verify or at settle (ran it).

### 8.7 Facilitator obligations

- Bind to 127.0.0.1. Optionally require `Authorization: Bearer <secret>`; the API supplies it through `createAuthHeaders`.
- Return 200 for every well-formed outcome. Use 400 only for malformed bodies; the skeleton validates them with `PaymentPayloadV2Schema` and `PaymentRequirementsV2Schema` from `@x402/core/schemas`. Return 500 only on bugs. Always include `transaction` and `network` in settle replies.
- `verify` is read-only toward session state. It may wait up to 15 s for a mempool txid and cache the decrypted deposit by txid, so that `settle` does not wait again.
- `settle` re-runs every check against current state and commits **synchronously after the last `await`**, so concurrent settles cannot both pass. Ran it: 20 concurrent settles of one voucher produced exactly 1 success; the other 19 got `z402_cumulative_too_low` (`$SPIKE/probe-concurrency.log`).
- Keep the `HTTPFacilitatorClient.timeoutMs` that the API uses (skeleton: 30 000 ms) above 15 s plus lightwalletd latency.

## 9. Skeleton (compiles: tsc 7.0.2 and 5.9.3, `strict`, `noUnusedLocals`, `skipLibCheck:false`)

Type-check output: `$SPIKE/typecheck-ts7.log` and `$SPIKE/typecheck-ts5.log` both contain `exit=0`. The chain adapter (`DepositVerifier`) is a stub interface. Its real implementation, lightwalletd `GetTransaction` or the mempool plus IVK trial decryption of a possibly v6/NU7 transaction, belongs to other tracks.

Source: `$SPIKE/package.json`

```json
{
  "name": "z402-x402-sdk-server-spike",
  "private": true,
  "type": "module",
  "scripts": {
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "typecheck:ts5": "node node_modules/typescript5/bin/tsc --noEmit -p tsconfig.json",
    "probe:roundtrip": "tsx src/probe/roundtrip.ts"
  },
  "dependencies": {
    "@x402/core": "2.28.0",
    "@x402/express": "2.28.0",
    "@x402/fetch": "2.28.0",
    "express": "5.3.0"
  },
  "devDependencies": {
    "@types/express": "5.0.6",
    "@types/node": "26.6.5",
    "tsx": "4.23.15",
    "typescript": "7.0.2",
    "typescript5": "npm:typescript@^5.9.3"
  }
}
```

Source: `$SPIKE/tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022", "DOM"],
    "types": ["node"],
    "strict": true,
    "noUnusedLocals": true,
    "esModuleInterop": true,
    "skipLibCheck": false,
    "forceConsistentCasingInFileNames": true,
    "noEmit": true
  },
  "include": ["src/**/*.ts"]
}
```

Source: `$SPIKE/src/shared/z402.ts`

```ts
import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import type { Network } from "@x402/core/types";

// Placeholder scheme id; the build plan picks the final name. Every party must use the same string.
export const Z402_SCHEME = "zcash-session";
export const ZCASH_TESTNET = "zcash:testnet" satisfies Network;
export const ZEC_ASSET = "ZEC";
export const ZEC_DECIMALS = 8;

/** Trust-ramp terms advertised in accepts[].extra (spec values). */
export interface Z402Terms {
  windowZat: number;
  creditRatio: number;
  creditCapZat: number;
}

export const DEMO_TERMS: Z402Terms = {
  windowZat: 100_000,
  creditRatio: 0.25,
  creditCapZat: 200_000,
};

/** PaymentPayload.payload for this scheme. */
export interface Z402Payload {
  sessionKey: string;
  cumulativeZat: string;
  sig: string;
  depositTxid?: string;
}

const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;
const UINT = /^(0|[1-9][0-9]*)$/;

export function parseZ402Payload(raw: Record<string, unknown>): Z402Payload | string {
  const { sessionKey, cumulativeZat, sig, depositTxid } = raw;
  if (typeof sessionKey !== "string" || !HEX64.test(sessionKey)) return "sessionKey must be 64 lowercase hex chars";
  if (typeof cumulativeZat !== "string" || !UINT.test(cumulativeZat)) return "cumulativeZat must be a decimal integer string";
  if (typeof sig !== "string" || !HEX128.test(sig)) return "sig must be 128 lowercase hex chars";
  if (depositTxid !== undefined && (typeof depositTxid !== "string" || !HEX64.test(depositTxid))) {
    return "depositTxid must be 64 lowercase hex chars";
  }
  return { sessionKey, cumulativeZat, sig, ...(depositTxid !== undefined && { depositTxid }) };
}

/** Bytes the session key signs. Proposal: domain-separated, binds network, payTo and sessionKey. */
export function voucherMessage(network: string, payTo: string, sessionKey: string, cumulativeZat: string): Buffer {
  return Buffer.from(`z402-voucher:v1|${network}|${payTo}|${sessionKey}|${cumulativeZat}`, "utf8");
}

export function verifyEd25519(publicKeyHex: string, message: Buffer, signatureHex: string): boolean {
  const key = createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(publicKeyHex, "hex").toString("base64url") },
    format: "jwk",
  });
  return cryptoVerify(null, message, key, Buffer.from(signatureHex, "hex"));
}

/** limit = D_conf + D_pend + min(C_max, floor(r * D_conf)); D_pend = newest unconfirmed deposit only. */
export function sessionLimitZat(terms: Z402Terms, confirmedZat: bigint, newestPendingZat: bigint): bigint {
  const ratioPpm = BigInt(Math.round(terms.creditRatio * 1_000_000));
  const credit = (confirmedZat * ratioPpm) / 1_000_000n;
  const cap = BigInt(terms.creditCapZat);
  return confirmedZat + newestPendingZat + (credit < cap ? credit : cap);
}
```

Source: `$SPIKE/src/facilitator/zcashFacilitatorScheme.ts`

```ts
import type {
  FacilitatorContext,
  PaymentPayload,
  PaymentRequirements,
  SchemeNetworkFacilitator,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import {
  DEMO_TERMS,
  Z402_SCHEME,
  ZEC_ASSET,
  parseZ402Payload,
  sessionLimitZat,
  verifyEd25519,
  voucherMessage,
  type Z402Payload,
  type Z402Terms,
} from "../shared/z402.js";

/** Result of looking up a deposit txid and trial-decrypting it with the merchant IVK. */
export type DepositCheck =
  | { ok: true; amountZat: bigint; memo: string; confirmations: number }
  | {
      ok: false;
      reason: "not_found" | "wrong_recipient" | "memo_mismatch" | "amount_too_low" | "has_transparent";
      detail?: string;
    };

/** Chain adapter (lightwalletd + IVK trial decryption) supplied by the facilitator build. */
export interface DepositVerifier {
  checkDeposit(txid: string, payTo: string): Promise<DepositCheck>;
  getConfirmations(txid: string): Promise<number>;
}

interface DepositRecord {
  txid: string;
  index: number;
  amountZat: bigint;
  confirmed: boolean;
  recordedAt: number;
}

interface Session {
  sessionKey: string;
  lastCumulativeZat: bigint;
  deposits: DepositRecord[];
}

export interface SessionSnapshot {
  sessionKey: string;
  cumulativeZat: string;
  limitZat: string;
  confirmedZat: string;
  pendingZat: string;
  creditZat: string;
}

interface Refusal {
  ok: false;
  reason: string;
  message: string;
  payer?: string;
  snapshot?: SessionSnapshot;
}

interface Prepared {
  ok: true;
  payload: Z402Payload;
  deposit?: { txid: string; index: number; check: DepositCheck & { ok: true } };
}

interface Accepted {
  ok: true;
  payload: Z402Payload;
  newDeposit?: DepositRecord;
  snapshot: SessionSnapshot;
  deltaZat: bigint;
}

const DEPOSIT_RETRY_MS = 15_000;
const DEPOSIT_POLL_MS = 1_500;

export class ZcashSessionFacilitatorScheme implements SchemeNetworkFacilitator {
  readonly scheme = Z402_SCHEME;
  readonly caipFamily = "zcash:*";

  private readonly sessions = new Map<string, Session>();
  private readonly depositOwner = new Map<string, string>();
  private readonly depositCache = new Map<string, DepositCheck & { ok: true }>();

  constructor(
    private readonly verifier: DepositVerifier,
    private readonly terms: Z402Terms = DEMO_TERMS,
  ) {}

  getExtra(_network: string): Record<string, unknown> | undefined {
    return { ...this.terms };
  }

  getSigners(_network: string): string[] {
    return [];
  }

  async verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    _context?: FacilitatorContext,
  ): Promise<VerifyResponse> {
    const prepared = await this.prepare(payload, requirements, true);
    const result = prepared.ok ? this.check(prepared, requirements) : prepared;
    if (!result.ok) {
      return {
        isValid: false,
        invalidReason: result.reason,
        invalidMessage: result.message,
        payer: result.payer,
        ...(result.snapshot && { extra: { session: result.snapshot } }),
      };
    }
    return { isValid: true, payer: result.payload.sessionKey, extra: { session: result.snapshot } };
  }

  async settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    _context?: FacilitatorContext,
  ): Promise<SettleResponse> {
    const prepared = await this.prepare(payload, requirements, false);
    // No await between check() and the commit below: concurrent settles cannot both pass.
    const result = prepared.ok ? this.check(prepared, requirements) : prepared;
    if (!result.ok) {
      return {
        success: false,
        errorReason: result.reason,
        errorMessage: result.message,
        payer: result.payer,
        transaction: "",
        network: requirements.network,
        ...(result.snapshot && { extra: { session: result.snapshot } }),
      };
    }
    const session = this.getOrCreateSession(result.payload.sessionKey);
    if (result.newDeposit) {
      session.deposits.push(result.newDeposit);
      this.depositOwner.set(result.newDeposit.txid, session.sessionKey);
    }
    session.lastCumulativeZat = BigInt(result.payload.cumulativeZat);
    return {
      success: true,
      payer: session.sessionKey,
      transaction: result.payload.depositTxid ?? "",
      network: requirements.network,
      amount: result.deltaZat.toString(),
      extra: { session: this.snapshot(session) },
    };
  }

  /** Confirmation poller body; run every 30 s. */
  async pollConfirmations(): Promise<void> {
    for (const session of this.sessions.values()) {
      for (const deposit of session.deposits) {
        if (deposit.confirmed) continue;
        if ((await this.verifier.getConfirmations(deposit.txid)) >= 1) deposit.confirmed = true;
      }
    }
  }

  /** Stateless checks plus the (possibly slow) chain lookup. */
  private async prepare(
    paymentPayload: PaymentPayload,
    requirements: PaymentRequirements,
    allowChainWait: boolean,
  ): Promise<Prepared | Refusal> {
    if (requirements.scheme !== Z402_SCHEME || paymentPayload.accepted?.scheme !== Z402_SCHEME) {
      return { ok: false, reason: "invalid_scheme", message: "scheme mismatch" };
    }
    if (paymentPayload.accepted.network !== requirements.network) {
      return { ok: false, reason: "invalid_network", message: "network mismatch" };
    }
    if (requirements.asset !== ZEC_ASSET || paymentPayload.accepted.payTo !== requirements.payTo) {
      return { ok: false, reason: "invalid_payment_requirements", message: "asset or payTo mismatch" };
    }
    const parsed = parseZ402Payload(paymentPayload.payload);
    if (typeof parsed === "string") {
      return { ok: false, reason: "invalid_payload", message: parsed };
    }
    const payer = parsed.sessionKey;
    const message = voucherMessage(requirements.network, requirements.payTo, parsed.sessionKey, parsed.cumulativeZat);
    if (!verifyEd25519(parsed.sessionKey, message, parsed.sig)) {
      return { ok: false, reason: "z402_invalid_signature", message: "voucher signature does not verify", payer };
    }
    if (!parsed.depositTxid) return { ok: true, payload: parsed };

    const check = await this.lookupDeposit(parsed.depositTxid, requirements.payTo, allowChainWait);
    if (!check.ok) {
      return { ok: false, reason: `z402_deposit_${check.reason}`, message: check.detail ?? check.reason, payer };
    }
    const memo = /^([0-9a-f]{64}):(0|[1-9][0-9]*)$/.exec(check.memo.trim());
    if (!memo || memo[1] !== parsed.sessionKey) {
      return { ok: false, reason: "z402_deposit_memo_mismatch", message: "memo is not <sessionKey>:<depositIndex>", payer };
    }
    if (check.amountZat < BigInt(this.terms.windowZat)) {
      return { ok: false, reason: "z402_deposit_amount_too_low", message: "deposit below windowZat", payer };
    }
    return { ok: true, payload: parsed, deposit: { txid: parsed.depositTxid, index: Number(memo[2]), check } };
  }

  /** Synchronous checks against current session state (trust ramp). */
  private check(prepared: Prepared, requirements: PaymentRequirements): Accepted | Refusal {
    const { payload } = prepared;
    const payer = payload.sessionKey;
    const session = this.sessions.get(payer) ?? this.emptySession(payer);
    let newDeposit: DepositRecord | undefined;
    const dep = prepared.deposit;
    if (dep && !session.deposits.some(d => d.txid === dep.txid)) {
      const owner = this.depositOwner.get(dep.txid);
      if (owner && owner !== payer) {
        return { ok: false, reason: "z402_deposit_already_used", message: "deposit credited to another session", payer };
      }
      if (session.deposits.some(d => d.index === dep.index)) {
        return { ok: false, reason: "z402_deposit_index_reused", message: `depositIndex ${dep.index} already used`, payer };
      }
      newDeposit = {
        txid: dep.txid,
        index: dep.index,
        amountZat: dep.check.amountZat,
        confirmed: dep.check.confirmations >= 1,
        recordedAt: Date.now(),
      };
    }
    const projected: Session = newDeposit ? { ...session, deposits: [...session.deposits, newDeposit] } : session;
    const snapshot = this.snapshot(projected);
    const cumulative = BigInt(payload.cumulativeZat);
    const delta = cumulative - session.lastCumulativeZat;
    if (delta < BigInt(requirements.amount)) {
      return {
        ok: false,
        reason: "z402_cumulative_too_low",
        message: `cumulativeZat must be >= ${session.lastCumulativeZat + BigInt(requirements.amount)}`,
        payer,
        snapshot,
      };
    }
    if (cumulative > BigInt(snapshot.limitZat)) {
      return { ok: false, reason: "z402_limit_exceeded", message: `cumulativeZat exceeds limit ${snapshot.limitZat}`, payer, snapshot };
    }
    return { ok: true, payload, newDeposit, snapshot, deltaZat: delta };
  }

  private async lookupDeposit(txid: string, payTo: string, allowChainWait: boolean): Promise<DepositCheck> {
    const cached = this.depositCache.get(txid);
    if (cached) return cached;
    const deadline = Date.now() + (allowChainWait ? DEPOSIT_RETRY_MS : 0);
    for (;;) {
      const check = await this.verifier.checkDeposit(txid, payTo);
      if (check.ok) {
        this.depositCache.set(txid, check);
        return check;
      }
      if (check.reason !== "not_found" || Date.now() + DEPOSIT_POLL_MS > deadline) return check;
      await new Promise(resolve => setTimeout(resolve, DEPOSIT_POLL_MS));
    }
  }

  private snapshot(session: Session): SessionSnapshot {
    const confirmed = session.deposits.filter(d => d.confirmed).reduce((sum, d) => sum + d.amountZat, 0n);
    const pendingDeposits = session.deposits.filter(d => !d.confirmed);
    const newestPending = pendingDeposits.length > 0 ? pendingDeposits[pendingDeposits.length - 1].amountZat : 0n;
    const limit = sessionLimitZat(this.terms, confirmed, newestPending);
    return {
      sessionKey: session.sessionKey,
      cumulativeZat: session.lastCumulativeZat.toString(),
      limitZat: limit.toString(),
      confirmedZat: confirmed.toString(),
      pendingZat: newestPending.toString(),
      creditZat: (limit - confirmed - newestPending).toString(),
    };
  }

  private emptySession(sessionKey: string): Session {
    return { sessionKey, lastCumulativeZat: 0n, deposits: [] };
  }

  private getOrCreateSession(sessionKey: string): Session {
    let session = this.sessions.get(sessionKey);
    if (!session) {
      session = this.emptySession(sessionKey);
      this.sessions.set(sessionKey, session);
    }
    return session;
  }
}
```

Source: `$SPIKE/src/facilitator/app.ts`

```ts
import express, { type Express, type Request, type Response } from "express";
import { x402Facilitator } from "@x402/core/facilitator";
import type { PaymentPayload, PaymentRequirements, SettleResponse, VerifyResponse } from "@x402/core/types";
import { PaymentPayloadV2Schema, PaymentRequirementsV2Schema } from "@x402/core/schemas";
import { ZCASH_TESTNET } from "../shared/z402.js";
import { ZcashSessionFacilitatorScheme, type DepositVerifier } from "./zcashFacilitatorScheme.js";

export interface FacilitatorAppOptions {
  /** Shared secret expected in `Authorization: Bearer <token>`; omit to disable auth. */
  authToken?: string;
  pollIntervalMs?: number;
  onRequest?: (path: string, body: unknown) => void;
}

export function createFacilitatorApp(verifier: DepositVerifier, options: FacilitatorAppOptions = {}) {
  const scheme = new ZcashSessionFacilitatorScheme(verifier);
  const facilitator = new x402Facilitator().register(ZCASH_TESTNET, scheme);

  const app: Express = express();
  app.use(express.json({ limit: "64kb" }));

  app.use((req, res, next) => {
    options.onRequest?.(`${req.method} ${req.path}`, req.body);
    if (options.authToken && req.header("authorization") !== `Bearer ${options.authToken}`) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  });

  app.get("/supported", (_req: Request, res: Response) => {
    res.json(facilitator.getSupported());
  });

  app.post("/verify", async (req: Request, res: Response) => {
    const parsed = parseBody(req.body);
    if (typeof parsed === "string") {
      res.status(400).json({ isValid: false, invalidReason: "invalid_payload", invalidMessage: parsed } satisfies VerifyResponse);
      return;
    }
    try {
      const result: VerifyResponse = await facilitator.verify(parsed.paymentPayload, parsed.paymentRequirements);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "verify failed" });
    }
  });

  app.post("/settle", async (req: Request, res: Response) => {
    const parsed = parseBody(req.body);
    if (typeof parsed === "string") {
      res.status(400).json({
        success: false,
        errorReason: "invalid_payload",
        errorMessage: parsed,
        transaction: "",
        network: ZCASH_TESTNET,
      } satisfies SettleResponse);
      return;
    }
    try {
      const result: SettleResponse = await facilitator.settle(parsed.paymentPayload, parsed.paymentRequirements);
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "settle failed";
      res.json({
        success: false,
        errorReason: message.startsWith("Settlement aborted:") ? message.slice(20) : "unexpected_settle_error",
        errorMessage: message,
        transaction: "",
        network: parsed.paymentRequirements.network,
      } satisfies SettleResponse);
    }
  });

  const poller = setInterval(() => {
    scheme.pollConfirmations().catch(error => console.error("[z402] poller", error));
  }, options.pollIntervalMs ?? 30_000);
  poller.unref();

  return { app, facilitator, scheme, stop: () => clearInterval(poller) };
}

function parseBody(body: unknown): { paymentPayload: PaymentPayload; paymentRequirements: PaymentRequirements } | string {
  if (typeof body !== "object" || body === null) return "body must be a JSON object";
  const { paymentPayload, paymentRequirements } = body as Record<string, unknown>;
  const payload = PaymentPayloadV2Schema.safeParse(paymentPayload);
  if (!payload.success) return `paymentPayload: ${payload.error.issues[0]?.message ?? "invalid"}`;
  const requirements = PaymentRequirementsV2Schema.safeParse(paymentRequirements);
  if (!requirements.success) return `paymentRequirements: ${requirements.error.issues[0]?.message ?? "invalid"}`;
  return {
    paymentPayload: paymentPayload as PaymentPayload,
    paymentRequirements: paymentRequirements as PaymentRequirements,
  };
}
```

Source: `$SPIKE/src/server/zcashServerScheme.ts`

```ts
import type {
  AssetAmount,
  Network,
  PaymentFlowConfig,
  PaymentRequirements,
  Price,
  SchemeNetworkServer,
  SchemePaymentRequiredContext,
  SchemeServerHooks,
  SupportedKind,
} from "@x402/core/types";
import { convertToTokenAmount, parseMoney } from "@x402/core/utils";
import { Z402_SCHEME, ZEC_ASSET, ZEC_DECIMALS } from "../shared/z402.js";

const TERM_KEYS = ["windowZat", "creditRatio", "creditCapZat"] as const;

export class ZcashSessionServerScheme implements SchemeNetworkServer {
  readonly scheme = Z402_SCHEME;
  readonly defaultAssetTransferMethod = "default";
  readonly paymentFlows = {
    default: { supported: ["authorization"], default: "authorization" },
  } as const satisfies Record<string, PaymentFlowConfig>;

  // Session snapshot from a failed /verify, keyed by the request's PaymentPayload object.
  private readonly refusedSessions = new WeakMap<object, unknown>();

  readonly schemeHooks: SchemeServerHooks = {
    onAfterVerify: async ctx => {
      const session = ctx.result.extra?.session;
      if (!ctx.result.isValid && session !== undefined) this.refusedSessions.set(ctx.paymentPayload, session);
    },
  };

  /** Corrective 402: copies the facilitator's session snapshot into accepts[].extra.session. */
  enrichPaymentRequiredResponse = async (ctx: SchemePaymentRequiredContext): Promise<void> => {
    const payload = ctx.paymentPayload;
    if (!payload) return;
    const session = this.refusedSessions.get(payload);
    if (session === undefined) return;
    this.refusedSessions.delete(payload);
    const accept = ctx.requirements.find(r => r.scheme === this.scheme && r.network === payload.accepted.network);
    if (accept) accept.extra = { ...accept.extra, session };
  };

  async parsePrice(price: Price, network: Network): Promise<AssetAmount> {
    if (typeof price === "object" && price !== null && "amount" in price) {
      if (price.asset.toUpperCase() !== ZEC_ASSET || !/^[1-9][0-9]*$/.test(price.amount)) {
        throw new Error(`${Z402_SCHEME} on ${network} takes { amount: "<zatoshi>", asset: "ZEC" }`);
      }
      return { amount: price.amount, asset: ZEC_ASSET, extra: price.extra ?? {} };
    }
    const { amount, symbol } = parseMoney(price);
    if (symbol !== ZEC_ASSET) {
      throw new Error(`${Z402_SCHEME} has no USD pricing; use "0.00001 ZEC" or { amount, asset: "ZEC" }`);
    }
    return { amount: convertToTokenAmount(amount, ZEC_DECIMALS), asset: ZEC_ASSET, extra: {} };
  }

  getAssetDecimals(asset: string, _network: Network): number | undefined {
    return asset.toUpperCase() === ZEC_ASSET ? ZEC_DECIMALS : undefined;
  }

  async enhancePaymentRequirements(
    paymentRequirements: PaymentRequirements,
    supportedKind: SupportedKind,
    _facilitatorExtensions: string[],
  ): Promise<PaymentRequirements> {
    const terms: Record<string, unknown> = {};
    for (const key of TERM_KEYS) terms[key] = supportedKind.extra?.[key];
    return { ...paymentRequirements, extra: { ...paymentRequirements.extra, ...terms } };
  }

  validateFacilitatorSupport(network: Network, supportedKind: SupportedKind, _extensions: string[]): string | void {
    const missing = TERM_KEYS.filter(key => typeof supportedKind.extra?.[key] !== "number");
    if (missing.length > 0) return `facilitator /supported kind for ${network} lacks extra.${missing.join(", extra.")}`;
  }
}
```

Source: `$SPIKE/src/server/app.ts`

```ts
import express, { type Express } from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { HTTPFacilitatorClient } from "@x402/core/server";
import type { RoutesConfig } from "@x402/core/server";
import { Z402_SCHEME, ZCASH_TESTNET } from "../shared/z402.js";
import { ZcashSessionServerScheme } from "./zcashServerScheme.js";

export interface ResourceServerOptions {
  facilitatorUrl: string;
  payTo: string;
  authToken?: string;
}

export function createResourceServerApp(options: ResourceServerOptions): Express {
  const facilitatorClient = new HTTPFacilitatorClient({
    url: options.facilitatorUrl,
    timeoutMs: 30_000,
    ...(options.authToken && {
      createAuthHeaders: async () => {
        const headers = { Authorization: `Bearer ${options.authToken}` };
        return { verify: headers, settle: headers, supported: headers };
      },
    }),
  });

  const resourceServer = new x402ResourceServer(facilitatorClient).register(
    ZCASH_TESTNET,
    new ZcashSessionServerScheme(),
  );

  const routes: RoutesConfig = {
    "GET /chunk": {
      accepts: {
        scheme: Z402_SCHEME,
        network: ZCASH_TESTNET,
        price: { amount: "1000", asset: "ZEC" },
        payTo: options.payTo,
        maxTimeoutSeconds: 60,
      },
      description: "One chunk of the stream",
      mimeType: "application/json",
    },
  };

  let served = 0;
  const app = express();
  app.use(paymentMiddleware(routes, resourceServer));
  app.get("/chunk", (_req, res) => {
    served += 1;
    res.json({ chunk: served, data: `chunk-${served}` });
  });
  return app;
}
```

Source: `$SPIKE/src/server/selfFacilitation.ts`

```ts
import { x402Facilitator } from "@x402/core/facilitator";
import { x402ResourceServer } from "@x402/core/server";
import type { FacilitatorClient } from "@x402/core/server";
import type { SupportedResponse } from "@x402/core/types";

// In-process FacilitatorClient, mirroring examples/typescript/servers/self-facilitation.
export function inProcessFacilitatorClient(facilitator: x402Facilitator): FacilitatorClient {
  return {
    verify: (payload, requirements) => facilitator.verify(payload, requirements),
    settle: (payload, requirements) => facilitator.settle(payload, requirements),
    // getSupported() types kinds[].network as plain string, so it needs a cast to SupportedResponse.
    getSupported: async () => facilitator.getSupported() as SupportedResponse,
  };
}

export function exampleSelfFacilitatedServer(facilitator: x402Facilitator): x402ResourceServer {
  return new x402ResourceServer(inProcessFacilitatorClient(facilitator));
}
```

Facilitator process entry point. This file is not part of the spike; it is a sketch for the facilitator build:

```ts
import { createFacilitatorApp } from "./facilitator/app.js";
const { app } = createFacilitatorApp(realLightwalletdVerifier, { authToken: process.env.FACILITATOR_TOKEN });
app.listen(4022, "127.0.0.1");
```

The probes are in `$SPIKE/src/probe/*.ts`. `roundtrip.ts` includes a minimal client scheme (`ProbeClientScheme`, with `findDefaultAsset` and an `onPaymentResponse` hook) that the client agent can compare against.

## 10. Open questions and risks

- **Scheme id and network id** still need a decision: placeholder `zcash-session` and `zcash:testnet`, versus `bip122:05a60a92d99d85997cce3b87616c089f`.
- **Spend controls:** choose between `findDefaultAsset` in the client scheme, which bends the USD-peg rule but keeps the agent code to one line, and an explicit `setSpendControls` call in the agent code.
- **Voucher message format** (8.3) must be fixed byte for byte by both agents.
- **The `transaction` value.** This track proposes the deposit txid on the deposit call and `""` on voucher-only calls; the spec's `transaction` field says "empty string if no transaction was broadcast" (`x402-specification-v2.md:249`). The parallel `docs/research/x402-e2e-spike.md` instead proposes a non-empty voucher id, in the style of batch-settlement's "non-empty commitment identifier". The SDK accepts either. Pick one.
- **Memo `depositIndex` rule:** the skeleton accepts any unused non-negative integer per session; the alternative is strictly sequential indexes.
- **`creditRatio` as a float:** it is compared with `deepEqual` through JSON, so `0.25` round-trips exactly. Floats in terms are fine if the client echoes `accepted` untouched.
- **Restarts:** the API caches `/supported` for its lifetime, so restart it after changing the facilitator's terms. Facilitator sessions are in memory only (per spec).
- **The flow choice is `authorization`**, which matches the spec's read-only `/verify` followed by `/settle`. The alternative `upfront` would skip `/verify` (one facilitator round trip fewer) but would record vouchers before the handler runs, with no refund path.

## Verification corrections

Fact-check of this track, 2026-10-27. Sources: an independent clone of `x402-foundation/x402` at tag `npm-@x402/core@v2.28.0`, commit `6b6ee91fee027b540faabcb25774e73851006c3b`, and the published `@x402/core@2.28.0` and `@x402/express@2.28.0` tarballs (core shasum `22ed0e4e49fdd3dda30b0d6a93289b647f46b533`; the installed packages are byte-identical to the tarballs). Probes and logs are in `$VERIFY` = `/private/tmp/claude-501/-Users-oynozan-Desktop-Dev-Web3-z402/afbb7c76-d88e-47a4-8a53-fd001155f8ac/scratchpad/spikes/verify-x402-sdk-server` (`probe-*.mjs`, `probe-*.log`), run on node v26.11.0 with zod 3.25.76 and express 5.3.0.

The other load-bearing claims held on re-check:
- Matched source and the published dist, and confirmed by a run: the `SchemeNetworkServer` and `SchemeNetworkFacilitator` members; `x402Facilitator` dispatch and its throws; zod stripping of facilitator replies; the retry counts.
- Confirmed by a run: the `x402Version == 1` client branch, the base64 header rules, and the `upfront` skip of `/verify`.
- Matched verbatim: the four spec sentences.

Only the two items below need correcting.

### C1. `initialize()` (sections 4.1 and 10)

**Three throw paths, not one.** `x402ResourceServer.initialize()` throws in two cases:
- (a) No kinds were loaded from any facilitator. It throws `Error("Failed to initialize: no supported payment kinds loaded from any facilitator.")`, with `cause` set to the last fetch error if there was one (`x402ResourceServer.ts:697-709`).
- (b) A registered scheme's optional `validateFacilitatorSupport()` returns a problem string. It throws `FacilitatorCapabilityError` (`:710`, `:1607-1630`).

`x402HTTPResourceServer.initialize()` adds a third: `RouteConfigurationError`, when a route's scheme is not registered or has no exact `(2, scheme, network)` kind (`x402HTTPResourceServer.ts:486-495`, `:1118-1230`).

Ran it (`probe-facilitator-init.log`):
- `kinds: []` gives (a).
- `validateFacilitatorSupport: () => "terms missing"` gives `FacilitatorCapabilityError`.
- A facilitator that lists only `zcash:*`, or only another scheme, passes `x402ResourceServer.initialize()`. `x402HTTPResourceServer.initialize()` then throws `RouteConfigurationError` ("Facilitator does not support scheme ... on network \"zcash:testnet\"").

**Not a cache.** Every call to `initialize()` clears both maps (`x402ResourceServer.ts:646-647`) and fetches `/supported` again. Ran it: two calls made two `GET /supported`. The process-lifetime caching is `@x402/express`'s `isInitialized` flag (`http/express/src/index.ts:119-145`).

**Do not refresh by calling it again.** A second `resourceServer.initialize()` while serving is unsafe. A request that arrives while it awaits `/supported` finds no kinds. `buildPaymentRequirements` then throws "Facilitator does not support zcash-session on zcash:testnet", and the client gets **500** `{"error":"Internal Server Error"}`. Ran it (`probe-gaps.log`). To change terms, restart the API.

### C2. The section 9 paid route can be fetched for free with `HEAD`

`createResourceServerApp` keys the route `"GET /chunk"`. In 2.28.0, `getRouteConfig` matches a route only when `route.verb === "*"` or `route.verb === <request method>` (`x402HTTPResourceServer.ts:1241-1262`, test at `:1250`). So `HEAD /chunk` matches no route and the middleware calls `next()`. Express then runs the `app.get("/chunk")` handler for the HEAD request.

Ran it with the skeleton's exact shape: `@x402/express@2.28.0`, `express@5.3.0`, and a handler that increments `served`.
- An unpaid `GET` got 402.
- An unpaid `HEAD` got **200** with `Content-Length: 11`. The handler ran (`served` went 0 to 1), and `/verify` and `/settle` were each called 0 times (`probe-gaps.log`).

Upstream `main` (`1148309d5bdf4db476c488048d34dc6706a1c6da`) adds a HEAD-to-GET fallback in `getRouteConfig`, but it is not released; npm `latest` is still 2.28.0.

Fix for 2.28.0, either (both ran, `probe-head-fix.log`):
- Key the route without a verb: `"/chunk"` parses to verb `*` (`x402HTTPResourceServer.ts:1373-1374`), so HEAD also needs payment. Unpaid HEAD and unpaid GET each got 402, and the handler ran 0 times. This also gates `OPTIONS`, which does not affect a Node agent.
- Or add `app.head("/chunk", (_req, res) => res.sendStatus(405))` before `app.get`. Unpaid HEAD got 405, unpaid GET got 402, and the handler ran 0 times.
