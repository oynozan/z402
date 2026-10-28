# z402 Multi-Provider Facilitator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the single-merchant facilitator into a hosted multi-provider x402 rail: per-provider runtimes picked by API key, self-registration, per-route prices, and a facilitator-hosted Bazaar. The client wire stays unchanged.

**Architecture:** Each provider gets a `ProviderRuntime`: its own chain view (its UIVK), ledger + lock + header, state, resolver, watcher, scheme and `x402Facilitator`. A bearer API key picks the runtime. A registry file holds the registered providers. A catalog serves the Bazaar from provider declarations and settled payments. The operator (today's config, token and ledger) is just the first runtime.

**Tech Stack:** TypeScript strict (NodeNext, `.js` imports), Express 5, `@x402/core` 2.28.0, vitest, `@z402/protocol`, `@z402/testkit` (FakeChain).

**Spec:** `docs/superpowers/specs/2026-10-28-z402-multi-provider-design.md` (approved 2026-10-28). The spec is binding, and its exact values (routes, codes, limits, shapes) apply verbatim.

## Global Constraints

- Work only in the git worktree and branch named in your dispatch. Never touch `/Users/oynozan/Desktop/Dev/Web3/z402` (the shared tree, other sessions' files). Never `git checkout`, rebase, amend, reset or stash.
- Commits are path-limited (`git add <paths>`, `git commit -- <paths>`), never `-A`, `.` or `-a`. They carry no `Co-Authored-By` or AI trailer. `crates/zdecrypt/target` is a symlink to the shared build; never commit it.
- Never read or print `.secrets/` or `.data/`. Never log or print a UIVK, API key, token, seed or `PAYMENT-SIGNATURE`.
- Keep all existing behaviour of the operator path. Today's `startFacilitator` callers (`apps/api`, `apps/e2e/src/harness.ts`, `packages/service-kit/src/testing.ts`) must compile and pass unchanged.
- Match the surrounding code: comment density, naming, error text style (`field: reason`), and the always-200 rule for `/verify` and `/settle`.
- Verify before you report: `npx vitest run packages/facilitator packages/server apps/api` and `npx tsc -p packages/facilitator --noEmit` (and `-p packages/server`, `-p apps/api` when touched). Report the real output.

## Review Focus

1. **Cross-tenant leakage.** A key for provider A sending requirements with B's `payTo` must get `invalid_payment_requirements`, and must never touch B's state.
2. **Rotation.** A rotated key must fail on the very next request (`/providers/me`, `/verify`, `/settle`, `POST /discovery/resources`), and the new key must work at once.
3. **Crash safety of registration.** A runtime opens before the registry is written. A failed write leaves no half-registered provider. A malformed or tampered registry refuses startup.
4. **Catalog poisoning.** For a provider that has declared, payments never create items. Every declared `accepts` must name that provider's `payTo` and the rail's terms.
5. **Privacy.** No query string, key or UIVK ever reaches a log line, an error message or a response.

---

### Task 1: `GET /providers/me` and `checkProvider` (landing step 1, first)

**Files:**
- Create: `packages/facilitator/src/providers/id.ts`; `packages/server/src/provider.ts`; `packages/server/test/provider.test.ts`
- Modify: `packages/facilitator/src/app.ts` (route plus the `me` option); `packages/facilitator/src/index.ts`; `packages/server/src/index.ts`; `apps/api/src/app.ts` (startup check); tests in `packages/facilitator/test/app.test.ts` and `apps/api/test/integration.test.ts`

**Interfaces (produces):**
- `providerId(network: string, payTo: string): string`: the first 16 lowercase hex of sha256(`"z402-provider-v1\n" + network + "\n" + payTo`).
- `GET /providers/me` sits behind the existing bearer middleware, so it is authenticated whenever `authToken` is set. It answers `200 {"providerId","network","payTo"}` for the operator. `createFacilitatorApp` gains `me?: { network: string; payTo: string }`, and `startFacilitator` passes the operator's.
- `@z402/server`:
  - `type ProviderCheckField = "facilitatorToken" | "payTo" | "facilitatorUrl"`
  - `class ProviderCheckError extends Error { readonly field: ProviderCheckField; readonly retryable: boolean }`
  - `checkProvider(o: { facilitatorUrl: string; token?: string; payTo: string; network: string; fetch?: typeof fetch; timeoutMs?: number }): Promise<void>`. It sends `GET <url without trailing slashes>/providers/me` with `Authorization: Bearer <token>` when a token is given, and `timeoutMs` defaults to 5000.

**Outcome table (spec §4.6, verbatim):** connection error, timeout or 5xx → `facilitatorUrl`, retryable; 404, or a 200 whose body lacks string `providerId`/`network`/`payTo` → `facilitatorUrl`, not retryable; 401 or 403 → `facilitatorToken`, not retryable; 200 with another `payTo` or `network` → `payTo`, not retryable. Every message starts with `<field>: ` and never contains the token.

- [ ] Write the tests:
  - facilitator `/providers/me`: with a token, without a token, and 401 on a wrong token;
  - every row of the outcome table, with a stub `fetch` and a real stub HTTP server for the timeout case;
  - `apps/api` refusing to start on each non-retryable case, with the message's field prefix.
- [ ] Implement them. In `apps/api`, call `checkProvider` after the option checks and before `initialize()`. On a retryable error, keep the API's existing wait-for-facilitator behaviour, as its `initialize()` retry does today; on a non-retryable error, refuse to start with the error's message. Keep the existing `/supported` payTo check; Task 4 removes it.
- [ ] Run the verify commands and commit: `feat: GET /providers/me and checkProvider (typed ProviderCheckError) for the multi-provider rail`.

### Task 2a: API keys and the provider registry (new files only; parallel with Task 1 and Task 3a)

**Files:** Create `packages/facilitator/src/providers/apiKey.ts`, `packages/facilitator/src/providers/registry.ts`, `packages/facilitator/test/apiKey.test.ts`, `packages/facilitator/test/registry.test.ts`. No other file.

**Interfaces (produces):**
- `API_KEY_RE = /^z402_[A-Za-z0-9_-]{43}$/`
- `newApiKey(): string`: `"z402_" + randomBytes(32).toString("base64url")`
- `keyDigest(key: string): string`: the sha256 hex of the UTF-8 key
- `interface ProviderEntry { id: string; payTo: string; uivk: string; keyHash: string; createdAt: string; keyIssuedAt: string }`
- `class RegistryError extends Error`: messages start with `providersDir: `
- `openRegistry(o: { dir: string; network: ZcashNetwork; onLost?: (err: unknown) => void }): Promise<ProviderRegistry>`
- `class ProviderRegistry`:
  - `readonly dir`, `readonly network`
  - `entries(): readonly ProviderEntry[]`, `get(payTo): ProviderEntry | undefined`
  - `ledgerPath(id): string` (`<dir>/ledgers/<id>.jsonl`), `catalogPath(): string` (`<dir>/discovery.json`)
  - `put(entry: ProviderEntry): void` (synchronous)
  - `close(): void`

**Rules:**
- `openRegistry` creates `dir` and `dir/ledgers` with mode 0700. It takes the heartbeat lock on `<dir>/registry.json` with `lockLedger` from `src/core/ledgerLock.ts`; read that file first, and create an empty registry file first if the lock needs one to exist. It then loads `registry.json`. A missing file is an empty registry.
- The file is strictly `{"version":1,"network":<network>,"providers":[…]}`. Each entry has:
  - `id`: 16 lowercase hex;
  - `payTo`: valid for the network (`isValidPayTo`);
  - `uivk`: a non-empty string of at most 1024 characters with no whitespace;
  - `keyHash`: 64 lowercase hex;
  - `createdAt` and `keyIssuedAt`: ISO 8601 strings that round-trip through `new Date(x).toISOString()`;
  - no duplicate `payTo` or `id` across entries.

  Anything else → `RegistryError("providersDir: <path> is not a valid provider registry (<reason>)")`. The reason must never contain a uivk or keyHash value. Another network → `RegistryError("providersDir: <path> is the registry of <other network>")`.
- `put` replaces the entry with the same `payTo`, or appends one. It writes atomically:
  - `assertHeld()` on the lock;
  - a temp file in `dir`, opened with `wx` and mode 0600;
  - the JSON plus `\n`, then `fsyncSync`, `closeSync`, `renameSync` onto `registry.json`, and an fsync of the directory.

  Only then does the in-memory list change. If any step throws, it removes the temp file, the list is unchanged, and the error is rethrown.
- `close()` releases the lock, and the second call does nothing.

- [ ] Write the tests:
  - key format and uniqueness; digest vectors;
  - an empty dir; a round trip of `put` across `openRegistry` again;
  - mode 0600 on `registry.json`; every malformed case, plus a duplicate payTo; network mismatch;
  - a second `openRegistry` on a held dir refusing;
  - `put` failing (a read-only dir) leaving file and memory unchanged;
  - no uivk in any error message.
- [ ] Implement, verify and commit: `feat(facilitator): API keys and the atomic, locked provider registry`.

### Task 3a: the Bazaar catalog (new files only; parallel with Task 1 and Task 2a)

**Files:** Create `packages/facilitator/src/discovery/catalog.ts`, `packages/facilitator/src/discovery/validate.ts`, `packages/facilitator/test/catalog.test.ts`. No other file.

**Interfaces (produces):**
- `interface CatalogProvider { id: string; network: string; payTo: string; terms: Terms; termsVersion: string }`
- `class CatalogError extends Error { readonly index?: number }` (an invalid declaration, answered with 400)
- `class CatalogQueryError extends Error` (a bad list or search query, 400)
- `parseListQuery(q: Record<string, unknown>): ListQuery` and `parseSearchQuery(q): SearchQuery` (Express `req.query` values may be strings or arrays; an array is a 400)
- `class Catalog`:
  - `static load(o: { file?: string; now?: () => Date; log?: (msg: string, err?: unknown) => void; maxPerProvider?: number /*128*/; maxTotal?: number /*4096*/; writeDelayMs?: number /*2000*/ }): Catalog`
  - `declare(p: CatalogProvider, body: unknown): ServedResource[]`: throws `CatalogError`
  - `recordPaid(p: CatalogProvider, paymentPayload: unknown, paymentRequirements: unknown): void`: never throws
  - `list(q: ListQuery): { x402Version: 2; items: ServedResource[]; pagination: { limit: number; offset: number; total: number } }`
  - `search(q: SearchQuery): { x402Version: 2; resources: ServedResource[]; partialResults: false; pagination: { limit: number; cursor: string | null } }`
  - `flush(): Promise<void>`, `close(): Promise<void>`
- `ServedResource` = `{ resource, type: "http", x402Version: 2, accepts, lastUpdated, description?, mimeType?, serviceName?, tags?, iconUrl?, extensions?, lastSeen?, paidCallsToday }`

**Rules:** spec §4.4 verbatim.
- **Keys and canonical form.** The key is (`p.id`, canonical resource, method).
  - The canonical resource is the URL origin plus a valid `extensions.bazaar.routeTemplate`, else the URL path. Query and hash are dropped.
  - A route template is valid when it matches `^\/[a-zA-Z0-9_/:.\-~%]+$` after percent-decoding to a fixed point in at most 5 passes, and contains no `..` and no `://`. `/` alone is invalid.
  - The method is `extensions.bazaar.info.input.method` when it is one of GET, POST, PUT, PATCH, DELETE or HEAD, else GET.
- **Declaration bodies.** `{items: [...]}` with 1–32 items. One invalid item refuses the whole call with its `index`.
- **Item validation:**
  - `resource`: an absolute http(s) URL of at most 2048 characters with no userinfo; `type` `"http"`; `x402Version` 2.
  - `accepts`: 1–4 entries, each `scheme` `prepaid-voucher`, `network` = `p.network`, `asset` `ZEC`, `payTo` = `p.payTo`.
  - `amount`: canonical zat (`ZAT_RE`/`parseZat`) with 1 ≤ amount ≤ `p.terms.windowZat`.
  - `extra`: `parseTerms(extra)` equal to `p.terms`, and `extra.termsVersion === p.termsVersion`.
  - `description` at most 512 characters, `mimeType` at most 128.
  - `serviceName`: 1–32 characters of printable ASCII (0x20–0x7e).
  - `tags`: at most 5, each 1–32 printable ASCII, deduplicated case-insensitively.
  - `iconUrl`: http(s), at most 2048, no userinfo, the host not an IP literal, not `localhost`, and not a decimal or hex number.
  - `extensions`: a plain object of at most 8192 bytes as JSON.
- **Caps.** At most 128 items per provider and 4096 in all; a new item past a cap refuses a declaration (`CatalogError`), or is skipped and logged once for a payment.
- **Declaration effects.** A declaration upserts and sets `lastSeen` to now, and marks the provider as declaring (persisted).
- **`recordPaid`:**
  - Only for `paymentPayload.x402Version === 2` with a string `resource.url`.
  - A matching item gets `lastPaid` = now and today's count + 1.
  - With no match, the provider has never declared, and `extensions.bazaar` is a plain object: an item is created from `paymentRequirements` (validated as an `accepts` entry for `p`), the sanitized `resource` fields (invalid ones are dropped, not refused), and `extensions: { bazaar }`.
  - A declared item is never changed by payment data except `lastPaid` and the count.
- **Served times.**
  - `lastUpdated` = `lastPaid`, else `firstListed` (ISO).
  - `paidCallsToday` = the count when its stored UTC day (`YYYY-MM-DD`) is today, else 0.
- **List and search:**
  - Filters: `type`, `payTo`, `scheme`, `network` (any accepts entry), and `extensions` (the item carries that key).
  - Order: resource, then method, then provider id.
  - `limit`: default 20, a non-negative decimal integer, clamped to 1–100. `offset`: default 0, a non-negative decimal integer.
  - `query`: 1–256 characters, a case-insensitive substring of resource, description, serviceName or any tag.
  - `cursor`: a decimal offset string; the next cursor is null at the end; a bad cursor is a `CatalogQueryError`.
- **Persistence.**
  - With `file`, any change schedules a write within `writeDelayMs`: a temp file, then rename, mode 0600.
  - `load` reads the file. An unreadable or invalid file is renamed to `<file>.bad-<epoch ms>`, logged, and the catalog starts empty.
  - Items whose newest of `lastSeen`, `lastPaid` and `firstListed` is older than 7 days are dropped at load.
  - Without `file`, the catalog is memory-only.

- [ ] Write the tests: every validation rule (accepted and refused), upsert and `lastSeen`, the canonical key with and without a route template, payment matching, payment creation only for non-declaring providers, never for declaring ones, caps, the day rollover (injected `now`), both filter sets, order, pagination edges, search cursor, persistence round trip, a corrupt file set aside, and the 7-day drop.
- [ ] Implement, verify and commit: `feat(facilitator): Bazaar catalog (declarations, payment sourcing, list/search, persistence)`.

### Task 2b: per-provider runtimes, auth, `POST /providers`, wiring (after Tasks 1 and 2a are merged)

**Files:** Create `packages/facilitator/src/runtime.ts`, `packages/facilitator/src/providers/register.ts`, and tests. Modify `packages/facilitator/src/app.ts`, `config.ts`, `main.ts`, `index.ts`, `chain/zdecrypt.ts`, `chain/lightwalletdChainView.ts`, and the existing tests that pin auth on `/supported`.

**Interfaces (produces):**
- `openRuntime(o): Promise<ProviderRuntime>`, extracted from today's `openLedger`, `replayed` and `serve` (no `listen`).
- `ProviderRuntime { id; network; payTo; facilitator: x402Facilitator; pollNow(); start(); stop(); release(); extra(): Record<string, unknown> }`.
- `FacilitatorOptions.providers?: { dir: string; chainFor(p: { payTo: string; uivk: string }): ChainView; owns(p: { payTo: string; uivk: string }): Promise<boolean>; max?: number /*32*/; registrationToken?: string }`.
- Config:
  - `Z402_PROVIDERS_DIR`, default `.data/providers.<network>`, relative to the repo root like `Z402_LEDGER`;
  - `Z402_MAX_PROVIDERS`, default 32, a whole number 0–1000;
  - `Z402_REGISTRATION_TOKEN`, optional, a b64token;
  - export `isValidUivk(uivk, network)` from the existing per-network pattern.

**Rules:** spec §3, §4.1, §4.2 (who) and §4.5, verbatim.
- **Authentication.**
  - `Authorization: Bearer <k>` → sha256 → a runtime. The operator's key is `authToken`.
  - With no header and no `authToken`, the request is the operator's; otherwise it gets `401` with `WWW-Authenticate: Bearer`.
  - Authenticated: `/verify`, `/settle`, `GET /providers/me`. Public: `GET /supported`, which the operator runtime answers. `POST /providers` is public, gated by `registrationToken` when it is set.
  - An unknown route is `404` without needing auth.
- **`POST /providers`.** It follows §4.1 exactly: statuses and codes 201, 200 rotate, 400 `invalid_request`, 401, 403 `not_owner`, 403 `provider_limit`, 403 `registration_disabled`, and 409 `operator`.
  - Registrations run one at a time.
  - A new provider: open the runtime, ledger at `registry.ledgerPath(id)`; first poll; `start`; `registry.put`; then swap in the key. If the runtime fails, nothing is written. If `put` fails, stop and release the runtime and answer 500 `internal_error`.
  - A rotation: `put` the new hash, then swap; the old key fails from then on.
- **Startup.**
  - The operator runtime opens as today, with `ledgerPath`.
  - Then `openRegistry`, then `owns` for every entry; a false answer refuses startup naming the id.
  - Then all registered runtimes open in parallel, then `pollNow` runs on all in parallel, then `listen`, then `start` on all.
  - Any failure releases everything.
- **`close()`** stops every watcher, closes the server, then releases every runtime lock and the registry lock once in-flight requests end.
- **Shared resources.**
  - zdecrypt runs are limited to 8 at once, process-wide (a queue in `chain/zdecrypt.ts`).
  - `LightwalletdChainView` accepts an optional shared `tip()`, and `main.ts` passes one with a 1 s cache to every view.
- **`main.ts`.**
  - `owns` wraps the existing `zdecryptOwns` as `ownedByKey && !hasTransparent`.
  - It prints the existing ready line unchanged, then `facilitator providers=<n>`.
- **Price.** Until Task 4, registered runtimes use `o.priceZat`.

- [ ] Write the tests, over FakeChain with a stub `owns`:
  - two providers on one facilitator, with interleaved sessions and an isolated state each;
  - A's key with B's `payTo` → `invalid_payment_requirements`;
  - registration, and rotation (the old key 401 on `/providers/me` at once);
  - the cap, the gate, `operator` 409, `not_owner`;
  - a restart replaying both ledgers;
  - a registry entry whose `owns` is now false refusing startup;
  - a malformed registry refusing startup;
  - `/supported` without a token;
  - no key or uivk in any log line.

  Every existing test must still pass, or be updated only where it pinned "every route behind auth".
- [ ] Implement, verify and commit: `feat(facilitator): per-provider runtimes behind API keys, POST /providers, registry wiring`.

### Task 3b: discovery routes and the settle hook (after Tasks 2b and 3a)

**Files:** Modify `packages/facilitator/src/app.ts`, `index.ts`, and tests.

**Rules (spec §4.3–§4.4):**
- Routes:
  - `POST /discovery/resources` (authenticated): `catalog.declare(provider of the key, body)`, answering `200 {"x402Version":2,"items":[…]}`. A `CatalogError` gets `400 {"error":"invalid_request","index","message"}`.
  - `GET /discovery/resources` and `GET /discovery/search` (public): `parseListQuery`/`parseSearchQuery`, then `list`/`search`. A `CatalogQueryError` gets `400 {"error":"invalid_request","message"}`.
- After every `/settle` that answers `success: true`, call `catalog.recordPaid(provider, body.paymentPayload, body.paymentRequirements)` inside a try/catch that only logs.
- Every runtime's `x402Facilitator` registers the extension `{ key: "bazaar" }`, so `/supported` lists `"extensions":["bazaar"]`.
- `CatalogProvider` for a runtime: its id, network and payTo, `terms`, and `termsVersion` from `runtime.extra().termsVersion`.
- The catalog file is `registry.catalogPath()` with a providers dir, and memory-only otherwise. `close()` awaits `catalog.close()`.

- [ ] Write the tests:
  - HTTP declare, list and search;
  - 401 on an unauthenticated declare; public GETs;
  - a settle bumping `paidCallsToday`;
  - a payment-sourced item for a non-declaring provider;
  - none for a declaring one;
  - the access log never containing `?`;
  - `extensions` listing `"bazaar"`.
- [ ] Implement, verify and commit: `feat(facilitator): facilitator-hosted Bazaar routes and settle-sourced catalog updates`.

### Task 4: v2.0 wire rules (landing steps 3 and 4: only after the services agent's kit switch and smoke change)

**Files:** Modify:
- `packages/facilitator/src/scheme.ts`, `termsVersion.ts`, `app.ts`, `runtime.ts`, `config.ts`, `main.ts`, and tests;
- `packages/server/src/scheme.ts` and tests;
- `apps/api/src/app.ts` and tests.

**Rules (spec §4.2, §4.3, §4.6):**
- **Amount.** `#matches` accepts `amount` as a canonical zat with 1 ≤ amount ≤ `terms.windowZat`. `Voucher` carries `priceZat` = that amount, and `#decide` passes it to `checkVoucher` and to the mismatch message. `priceZat` leaves `SchemeConfig`.
- **Options and config.** `FacilitatorOptions.priceZat` becomes optional and is ignored, with no validation. The config stops reading `Z402_PRICE_ZAT`; when it is set, there is one warning: `Z402_PRICE_ZAT is ignored: each provider prices its own routes`.
- **`termsVersion(terms: Terms): string`.** The first 16 hex of sha256(`JSON.stringify(["z402-terms-v2", encodeTerms(terms)])`). `getExtra` returns `{...encodeTerms(terms), termsVersion}` with no `payTo`.
- **Server and API.** `validateFacilitatorSupport` no longer reads or compares `extra.payTo`. In `apps/api`, the `startupError` payTo branch goes, since `checkProvider` covers it.
- **Tests.**
  - Update every pinned test the maps list. That includes the facilitator `app.test.ts:223`, `:248`, `:1148`, `scheme.test.ts:246`, `:1475`, `:1627` and `:1644`. It includes server `scheme.test.ts:243`, `:256` and `:451`, and `apps/api` `integration.test.ts:44`, `:196`, `:382`, `:561` and `:282`, plus `main.test.ts:126`. Use real values computed by the new function: no hand-typed hash that has not been checked.
  - Add: two prices in one session (500 then 800) are both accepted; 0, `windowZat + 1` and `"0500"` are refused; vouchers short of each call's own price are refused with `z402_cumulative_mismatch`.

- [ ] Implement, verify and commit: `feat: protocol v2.0 wire rules (per-route amount, termsVersion over terms only, /supported without payTo)`.

### Task 5: provider tooling, `apps/api` Bazaar extension, docs

**Files:** Create `scripts/register-provider.mjs`. Modify:
- `apps/api/src/app.ts` and its tests;
- `docs/spec/protocol.md` (v2.0, from spec §5);
- `packages/facilitator/README.md`, `apps/api/README.md`;
- `docs/superpowers/specs/2026-10-27-z402-facilitator-design.md`: one pointer line at the top.

**Rules:**
- **`apps/api`.** `GET /chunk` carries a static `extensions.bazaar`:
  - `info`: `{"input":{"type":"http","method":"GET"},"output":{"type":"json","example":{"chunk":1,"cumulativeZat":"500","data":"…"}}}`
  - `schema`: a JSON Schema (draft 2020-12) of that `info`, as `declareDiscoveryExtension` would build it.

  It is hand-written JSON, with no new dependency. Test that it appears in the 402's decoded `PAYMENT-REQUIRED`.
- **`scripts/register-provider.mjs`.**
  - Usage: `--keys <view-only keys file> --facilitator <url> --out <key file> [--registration-token-file <f>]`.
  - It reads `payTo` (`orchardOnlyAddress`) and `uivk` from the keys file, posts `{payTo, uivk, network}` to `/providers`, and writes `apiKey` to `--out` under umask 077 with `wx` (refusing an existing file unless `--force`).
  - It prints only the providerId, the payTo and the out path, and never the key or the uivk. Exit codes: 0 on success, 1 on HTTP errors (it prints `error`/`message`), 2 on usage.
- **Docs.** `protocol.md` gets the §5 table applied, version line v2.0, ACKed by both agents. READMEs: the new env vars, routes, the operator provider, how to run provider 2:

  ```
  node scripts/register-provider.mjs …
  Z402_PAY_TO=… Z402_FACILITATOR_TOKEN="$(cat …)" Z402_PRICE_ZAT=800 Z402_API_PORT=4023 pnpm --filter @z402/api start
  ```

- [ ] Implement, verify (`node --check scripts/register-provider.mjs` plus a test that runs it against a stub server), and commit: `feat: register-provider script, apps/api Bazaar extension, protocol v2.0 and READMEs`.

### Task 6: the live two-provider run (controller)

Use the Z3 regtest stack and `scripts/demo.sh up` for the facilitator (4022) and provider 1's API (4021). Then:
1. Provider 2's view-only keys: `node scripts/merchant-keygen.mjs` into a scratch path, then `--view-only`.
2. `scripts/register-provider.mjs` → its key file.
3. Provider 2's API on 4023 at 800 zat.
4. `apps/agent --url http://127.0.0.1:4021/chunk --url http://127.0.0.1:4023/chunk`.

Check:
- each provider's ledger;
- `GET /discovery/resources`;
- record the run in `docs/research/live-run.md`.
