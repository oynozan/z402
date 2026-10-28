# z402 multi-provider facilitator (design)

Date: 2026-10-28 · Owner: facilitator agent (`z402-b1`) · Status: **draft, awaiting review** · Deadline: 2026-10-28 23:59 UTC

z402 becomes what x402 facilitators are: one hosted payment rail that many independent resource servers connect to. Each provider, us included, sets its own `payTo` and its own price per route, connects with its own API key, and never runs a facilitator. The facilitator also hosts the x402 Bazaar, the public catalog of every provider's paid resources.

This replaces the single-merchant model of [2026-10-27-z402-facilitator-design.md](2026-10-27-z402-facilitator-design.md), where one `payTo`, one price and one viewing key served the whole rail. Rulings R33 (discovery outside the facilitator) and R34 (one price) of that plan are reversed. Everything else in that design still holds: deposits, the trust ramp, the ledger and its lock, startup checks, and the voucher.

The client wire contract does not change. Payload, voucher, memo, snapshot and reason codes stay byte-for-byte as they are, and the client agent has confirmed the client is compatible as built. Section 5 is the protocol v2.0 draft for the client agent to co-sign.

## 1. Goal and success criteria

The user's requirement: "I should be able to monetize my any service and set custom price … independent service providers will set their prices, we are also technically independent service providers. So both of them. Also, they won't deploy their own facilitator, they will connect our facilitator because we are handling the payment rails." Follow the standard x402 integration; do not invent a z402-specific one.

Done means all of these hold on the live Z3 regtest stack:
1. Two providers with different `payTo` addresses and different per-route prices are both served by our one facilitator.
   - Provider 1 is us: the operator, with `apps/api` `GET /chunk` at 500 zat on `127.0.0.1:4021`, and the starter services.
   - Provider 2 registers itself through `POST /providers`. It is a second `apps/api` instance, `GET /chunk` at 800 zat on `127.0.0.1:4023`, with its own view-only keys and its own API key.
2. One agent process pays both in one run (`apps/agent --url …4021/chunk --url …4023/chunk`). Each provider's deposits and vouchers are credited only to that provider.
3. Both providers' resources are listed by the facilitator's public `GET /discovery/resources`, by both standard sources:
   - the starter services by declaration, with liveness (`lastSeen`);
   - provider 2's `GET /chunk` from its paid calls, through the static bazaar extension that `apps/api` gains.

   Each item shows today's paid calls (`paidCallsToday`).
4. Every test suite is green: root vitest, cargo, typecheck and shellcheck.

Out of scope (section 9): per-provider trust terms, provider accounts and dashboards, revocation beyond key rotation, and sender-disclosed decryption.

## 2. What the x402 standard does, and what we do

| Standard x402 practice | z402 |
|---|---|
| The resource server puts `payTo` and `amount` in each route's `PaymentRequirements`, and the facilitator verifies the payment against the requirements it is sent | Same. Any canonical amount from 1 zat to `windowZat` is accepted, per route. `payTo` must be the provider bound to the API key (§4.2) |
| A hosted facilitator (CDP) authenticates resource servers with an API key; the key does not decide where funds land, `payTo` does | `Authorization: Bearer <apiKey>` on `/verify`, `/settle` and the Bazaar's write route. Our existing bearer token becomes the operator provider's API key (§4.1) |
| `GET /supported` lists `{kinds, extensions, signers}`; `extra` holds facilitator-wide values (e.g. Solana's fee payer) | Our `extra` holds the rail-wide trust terms and `termsVersion`, and no longer `payTo`. `extensions` lists `"bazaar"` |
| The Bazaar: facilitators catalog resources from the `bazaar` extension that clients echo in payments, and serve `GET /discovery/resources` and `GET /discovery/search` | Same, with the exact 2.28.0 shapes (§4.4). Providers may also declare their resources directly, which gives liveness and lists a route before its first sale |
| A shielded payment needs a view of the recipient's incoming notes | Each provider registers its view-only key (UIVK) once, as with a payment processor. The facilitator proves the key owns `payTo` before accepting it |

## 3. Architecture

```
 agent ──402/pay──▶ provider's resource server ──Bearer apiKey──▶ facilitator
                    (stock @x402 + @z402/server)                  │
                                                                  ├─ auth: sha256(apiKey) → ProviderRuntime
                                                                  ├─ ProviderRuntime (one per provider)
                                                                  │    chain view decrypting with its UIVK,
                                                                  │    ledger + lock + header (its payTo),
                                                                  │    FacilitatorState, resolver, watcher,
                                                                  │    scheme, its own x402Facilitator
                                                                  ├─ ProviderRegistry (registry.json, 0600)
                                                                  └─ Catalog (Bazaar, discovery.json)
 browser / agent ──GET /discovery/resources (public)──────────────┘
```

**Per provider.** A `ProviderRuntime` is today's `serve()` without `listen`: a `LightwalletdChainView` that decrypts with that provider's UIVK and filters on its `payTo`, plus its own ledger file, ledger lock, `FacilitatorState`, `DepositResolver`, `ChainWatcher`, `PrepaidVoucherFacilitatorScheme` and `x402Facilitator`.
- Sessions are therefore keyed by (network, `payTo`, `sessionKey`): the network is one per process, and `payTo` is one per runtime.
- Credit units are keyed by (network, `payTo`, txid).
- Nothing is shared between two providers' state.

**Why one `x402Facilitator` per provider.** `x402Facilitator` picks the first registered scheme that matches (version, scheme, network), and its `verify`/`settle` never see the caller. With one facilitator per runtime, the API key picks the runtime. The scheme's existing check that `requirements.payTo` equals its own `payTo` (scheme.ts `#matches`) then binds each key to its tenant, with no routing state.

**Shared.**
- the lightwalletd client, with one tip source cached for 1 s;
- the zdecrypt binary, under one process-wide limit of 8 concurrent runs;
- the startup self-test and network check (run once);
- the Express server, the key map, the registry and the catalog.

**The operator provider.** Our own `payTo`/UIVK from today's configuration (`Z402_MERCHANT_KEYS_FILE` or `Z402_PAY_TO` + `Z402_UIVK`) is a provider like any other:
- it is configured at startup, not registered;
- its API key is `Z402_FACILITATOR_TOKEN`;
- its ledger stays at `Z402_LEDGER`, so the live ledger carries on unchanged.

Today's deployments and every existing caller of `startFacilitator` therefore keep working.

**On disk** (`Z402_PROVIDERS_DIR`, default `.data/providers.<network>`, mode 0700):

| Path | Content |
|---|---|
| `registry.json` (0600) + `registry.json.lock` | `{"version":1,"network":…,"providers":[{"id","payTo","uivk","keyHash","createdAt","keyIssuedAt"}]}`. Written atomically: temp file, fsync, rename, fsync of the directory. One writer, through the same heartbeat lock as ledgers |
| `ledgers/<id>.jsonl` + `.lock` | One ledger per registered provider, in today's format, whose header names that provider's `payTo` |
| `discovery.json` | The Bazaar catalog (§4.4). Not critical: a corrupt file is set aside and the catalog starts empty |

`id` (the provider id) is the first 16 hex of sha256(`"z402-provider-v1\n" + network + "\n" + payTo`). It is fixed by `payTo`, so a key rotation keeps the provider's ledger and catalog entries.

## 4. Behaviour

### 4.1 Providers and API keys

**`POST /providers`.** Public unless `Z402_REGISTRATION_TOKEN` is set; then `Authorization: Bearer <registration token>` is required.
- Body: `{"payTo": "<UA>", "uivk": "<UIVK>", "network"?: "<network>"}`.
- `payTo` must pass `isValidPayTo(payTo, network)`. `uivk` must match the network's UIVK pattern (config.ts). `network`, if given, must be the facilitator's network.
- The UIVK must own `payTo`: zdecrypt `owns --address <payTo> --network <n>` with the key in `ZDECRYPT_KEY` must answer `ownedByKey: true` and `hasTransparent: false`.
- Registrations run one at a time. For a new `payTo`, the provider's runtime is opened first: its ledger lock, header and replay, its first poll, and its watcher. Only then is the registry written, so a crash never leaves an entry with no runtime. Then the key is issued.
- Answer: `201 {"providerId","network","payTo","apiKey"}`. The key is shown once, and only its sha256 is stored.

**Re-registering a registered `payTo`** proves ownership the same way and rotates the key: `200` with the same shape. The new hash is written before the in-memory swap, and the old key stops working at once. This is also how a lost key is recovered.

**Refusals**, all with body `{"error": "<code>", "message": "<text>"}`:

| Status | Code | When |
|---|---|---|
| 400 | `invalid_request` | A field is missing or invalid. `message` names the field |
| 401 | `unauthorized` | A registration token is configured and was not presented |
| 403 | `not_owner` | The UIVK does not own `payTo`, or `payTo` has a transparent receiver |
| 403 | `provider_limit` | `Z402_MAX_PROVIDERS` (default 32, operator not counted) is reached. `0` disables registration |
| 403 | `registration_disabled` | No providers directory (embedded or test facilitators) |
| 409 | `operator` | `payTo` is the operator's |

**API key format.** `z402_` followed by 43 base64url characters (32 random bytes), which is a valid RFC 6750 b64token. It is never logged: access-log lines name the `providerId`.

**`GET /providers/me`.** Authenticated with the API key. Answers `200 {"providerId","network","payTo"}`, or `401 {"error":"unauthorized"}`. A resource server calls it at startup to prove that its key and its configured `payTo` match (§4.6). That check used to be done by comparing `payTo` in `/supported`.

**Unauthenticated requests** to the authenticated routes are refused with `401` + `WWW-Authenticate: Bearer`. The one exception is a facilitator started without `authToken`, as in embedded tests: there a request with no `Authorization` header is the operator's, as today. Registered providers always need their key.

### 4.2 `/verify` and `/settle`

Both are unchanged except:
- **Who.** The bearer picks the runtime, and `paymentRequirements.payTo` must be that runtime's `payTo`, else `invalid_payment_requirements` (HTTP 200, as every verify and settle answer).
- **Price.** `paymentRequirements.amount` must be a canonical zat with `1 ≤ amount ≤ windowZat`, else `invalid_payment_requirements`. It is the price of this call and is set by the provider per route. The voucher rule becomes `c_new − c_last ≥ requirements.amount ∧ c_new ≤ limit`, for verify and for settle alike. `priceZat` leaves the scheme.
- **Terms.** `extra` must still carry exactly the rail's terms. `termsVersion` is still not checked on verify or settle.
- **Catalog.** After a successful settle, the app reports it to the catalog (§4.4). A catalog error is logged and never changes the settle answer.

Everything else stays: always HTTP 200, the schema-complete answers, the closed reason list, refresh-before-refuse, the synchronous check-and-commit in `/settle`, and the ledger events (`deposit`, `voucher`, `status`). A ledger event still records no price or route.

### 4.3 `GET /supported`

Public. Answer:

```json
{ "kinds": [{ "x402Version": 2, "scheme": "prepaid-voucher", "network": "zcash:regtest",
              "extra": { "windowZat": "100000", "creditRatioBps": 2500, "creditCapZat": "200000",
                         "zeroConfMinExpiryBlocks": 20, "termsVersion": "<16 hex>" } }],
  "extensions": ["bazaar"], "signers": { "zcash:*": [] } }
```

`termsVersion` is the first 16 hex of sha256(JSON `["z402-terms-v2", encodeTerms(terms)]`). It names the rail's terms only and no longer moves with `payTo` or price. `signers` stays as today (`{"zcash:*": []}`: no on-chain signer). Every runtime advertises the same `extra`, and the operator runtime's `x402Facilitator` answers. The bazaar extension (`{key:"bazaar"}`) is registered on every runtime's `x402Facilitator`.

### 4.4 Discovery (the Bazaar)

The catalog is keyed by (`providerId`, canonical resource, HTTP method). The canonical resource is the URL's origin plus the bazaar `routeTemplate` when it is valid (the `@x402/extensions` rule `^\/[a-zA-Z0-9_/:.\-~%]+$`, no `..`, no `://`), else the URL's path. Query and fragment are dropped, as `extractDiscoveryInfo` does. Two providers listing the same URL get two items, each showing its own `payTo`.

**Sources.**
1. **Declarations.** `POST /discovery/resources`, authenticated with the API key. Body: `{"items":[DeclaredResource, …]}` (1–32 items), where a `DeclaredResource` is the standard `DiscoveryResource` without `lastUpdated`.
   - Every item is validated, and one bad item refuses the whole call with `400 {"error":"invalid_request","index":i,"message":…}`. The facilitator never fetches a provider URL.
   - A valid item is upserted, and its `lastSeen` is set to now. The answer is `200 {"x402Version":2,"items":[…as served…]}`.
   - The kit re-declares every 30 s. That heartbeat is the liveness signal, and declaring one service never removes another service's items.
2. **Settled payments.** On every successful settle, the item of that provider whose canonical resource and method match the payment gets `lastUpdated` = now and `paidCallsToday` + 1.
   - The resource comes from `paymentPayload.resource.url` and `extensions.bazaar.routeTemplate`. The method comes from `extensions.bazaar.info.input.method`.
   - A provider that has never declared anything is listed from its payments, as standard Bazaar facilitators do. A matching item is created from `paymentRequirements` (the server's, not the client's `accepted`), the sanitized `resource` metadata, and the `bazaar` extension.
   - **Once a provider has declared anything, its settled payments only update matching declared items, and never create one.** In a payment, `resource.url` and `extensions.bazaar` are echoed by the client. Without this rule, any payer could add a listing with any URL and description under a declaring provider's `payTo`, for the price of one call.
   - Client-echoed data never overwrites a declared item.

**Item validation** (declarations; payment-sourced items get the same sanitizers):
- `resource`: an absolute `http`/`https` URL, at most 2048 characters, with no userinfo. `type` must be `"http"`, and `x402Version` must be 2.
- `accepts`: 1–4 entries. Each one must be `prepaid-voucher` on the facilitator's network, `asset` `ZEC`, `payTo` equal to the provider's, an `amount` as in §4.2, and an `extra` whose terms and `termsVersion` equal the rail's. The catalog then never advertises a payment the facilitator would refuse.
- Optional metadata:
  - `description` at most 512 characters, `mimeType` at most 128;
  - `serviceName` 1–32 printable ASCII;
  - `tags` at most 5, each 1–32 printable ASCII, deduplicated without case;
  - `iconUrl`: the `@x402/extensions` `isValidIconUrl` rule (http(s), at most 2048, no userinfo, IP literal or loopback host).
- `extensions`: a plain JSON object of at most 8 KB serialized. It is kept as declared (the kit sends `bazaar` and `z402`). `extensions.bazaar.info.input.method`, when present, must be one of GET, POST, PUT, PATCH, DELETE or HEAD; it is the item's method, GET when absent.
- At most 128 items per provider and 4096 in all. Past either cap, a new item is refused (a declaration gets 400) or not created (a payment), and either way it is logged once.

**`GET /discovery/resources`** (public). Exactly what `withBazaar(client).extensions.bazaar.listResources()` calls.
- Query: `type`, `payTo`, `scheme`, `network`, `extensions` (a single key name; the item must carry it), `limit` (default 20, clamped to 1–100), `offset` (default 0). Both must be non-negative decimal integers, else `400`; `limit` is then clamped.
- Answer: `{"x402Version":2,"items":[DiscoveryResource…],"pagination":{"limit","offset","total"}}`.
- Order: by resource, then method, then provider id, so offset pages are stable.

**`GET /discovery/search`** (public). What `search()` calls.
- `query` is required, 1–256 characters, and matched as a case-insensitive substring of `resource`, `description`, `serviceName` or any tag. The same filters and `limit` apply. `cursor` is an opaque string (a decimal offset).
- Answer: `{"x402Version":2,"resources":[…],"partialResults":false,"pagination":{"limit","cursor": <next or null>}}`.

**Served item:**

```
{ resource, type: "http", x402Version: 2, accepts, lastUpdated, description?, mimeType?, serviceName?, tags?,
  iconUrl?, extensions?, lastSeen?, paidCallsToday }
```

- `lastUpdated` (ISO 8601, required by the standard) is the time of the latest paid call, or of the first listing if there is none.
- `lastSeen` is the latest declaration, absent for payment-only items.
- `paidCallsToday` counts the successful settles since 00:00 UTC. It is an aggregate only; no session, key or amount per call is ever exposed.

The site derives up, stale and down from the age of `lastSeen`; the recommendation is under 90 s, under 10 min, and older.

**Persistence.** The catalog lives in memory and is written to `discovery.json` at most every 2 s (temp file and rename). It is loaded at startup. Items neither declared nor paid for 7 days are dropped at load. Without a providers directory the catalog is memory-only.

### 4.5 Startup, shutdown, failure

**Startup** extends today's order:
1. Config, the self-test and the network checks, once.
2. The operator's `owns`, then the registry's lock and load. A malformed registry, or one for another network, refuses startup.
3. `owns` again for every registered provider, so a tampered registry refuses startup and names the `providerId`.
4. Every runtime's ledger is opened in parallel (a stale lock can take 15 s each), then every runtime's first poll runs in parallel.
5. `listen`, then the watchers start.

Any failure releases everything and refuses startup, as today.
- The ready line stays exactly as it is, naming the operator's `payTo`, because `scripts/demo.sh` waits on it. A second line gives the count of registered providers.
- `Z402_PRICE_ZAT` is no longer read by the facilitator; if set, one warning says each provider prices its own routes.

**Shutdown.** `close()` stops every watcher, closes the server, and releases every lock once in-flight requests have finished. A settle in flight is still recorded, as today.

**Failure.** `onFatal` stays process-wide: a failed ledger write or a lost lock in any runtime exits the process, and the restart replays every ledger. This is deliberate: those failures are disk or deployment faults that hit every tenant. Per-tenant quarantine is a known limit (§9).

### 4.6 Server scheme and API (`@z402/server`, `apps/api`)

- `validateFacilitatorSupport` no longer requires or compares `extra.payTo`. It still checks the terms and the `termsVersion` format. `enhancePaymentRequirements` already copies only the terms and `termsVersion`, so per-route prices already work through it.
- New `checkProvider({facilitatorUrl, token, payTo, network, fetch?, timeoutMs?}): Promise<void>` in `@z402/server`, with `timeoutMs` defaulting to 5000. It calls `GET /providers/me`. On failure it throws `ProviderCheckError`, with `field: "facilitatorToken" | "payTo" | "facilitatorUrl"` and `retryable: boolean`, so callers branch without parsing the message. `apps/api` calls it at startup, before `initialize()`, and fails on any error. The kit retries while `retryable` (§6).

  | Outcome | `field` | `retryable` |
  |---|---|---|
  | connection error, timeout, or 5xx | `facilitatorUrl` | true |
  | 404 (a facilitator without the route) or an unreadable 200 | `facilitatorUrl` | false |
  | 401 or 403 | `facilitatorToken` | false |
  | 200, but another `payTo` or network | `payTo` | false |

  The message never echoes the token.
- `/providers/me` answers 401 for an unknown key, and for a rotated-out key from the moment it is rotated. The kit's registration job relies on that, and registers only on a 401.
- `apps/api` keeps its one route (`GET /chunk`) and its one price.

## 5. Protocol v2.0 (ACKed by the client agent with no changes, 2026-10-28)

v2.0 changes nothing the client sends or signs. It is a major version because `/supported` drops `extra.payTo` and the facilitator accepts any per-route amount, which breaks our own API's startup check.

| § | Change |
|---|---|
| header | v2.0: multi-provider rail, per-route prices, facilitator-hosted Bazaar |
| 2 `amount` | "Price of this call, zat, canonical, `1 ≤ amount ≤ extra.windowZat`, set per route by the provider. The facilitator accepts any such amount." The demo note goes |
| 2 `payTo` | Adds: "must be the `payTo` registered to the API key the resource server presents (§16)" |
| 2 `termsVersion` | Becomes the first 16 hex of sha256(JSON `["z402-terms-v2", encodeTerms(terms)]`), the rail's terms only. The client still ignores it |
| 2 bullets | `/supported` `extra` carries the terms and `termsVersion`, never `payTo` |
| 5.2 | The credit unit is consumed once **per provider**, under `<network>:<payTo>:<txid>`, with one ledger file per provider. A transaction funds at most one session per `payTo`, and credits each `payTo` with its own outputs only |
| 6 | `amount` in the accept rule is this call's `requirements.amount` |
| 10 | "Check `payTo`, `amount` and the terms against its own config" becomes "`payTo` must be the authenticated provider's; `amount` canonical in [1, `windowZat`]; terms equal to the rail's; else `invalid_payment_requirements`" |
| 12 | 500 zat becomes the demo API's `GET /chunk` price, not a protocol value. Each service sets its own (the starter services charge 200, 100, 1,000 and 500) |
| 14 | `apps/discovery` is retired; the Bazaar is the facilitator's |
| 15 | `FacilitatorOptions.priceZat` becomes optional and is ignored. New `providers?: { dir; chainFor(p): ChainView; owns(p): Promise<boolean>; max?; registrationToken? }`. The token rule also covers API keys and the registration token. The API's startup check is `checkProvider` |
| 16 (new) | Providers: `POST /providers`, `GET /providers/me`, API keys, rotation, the operator provider (§4.1 of this design) |
| 17 (new) | Discovery: the routes, item shape, sources and validation (§4.4 of this design) |

Kept byte-for-byte: §3 payload, §4 voucher (its message already binds `payTo`, so a voucher never verifies at another provider), the §5.1 memo, the §7 answers and snapshot, and the §8 reason codes. §4's "Keys are ephemeral" stays.

## 6. Work split

| Who | Work |
|---|---|
| Facilitator agent (`z402-b1`) | `packages/facilitator`: amount rule, `termsVersion` v2, `/supported`, registry, runtimes, auth, `/providers`, catalog and discovery routes, the zdecrypt limit and shared tip. `packages/server`: `validateFacilitatorSupport`, `checkProvider`. `apps/api`: its startup check, and a static bazaar extension on `GET /chunk`, hand-written JSON (`info.input` `{type:"http", method:"GET"}`, an output example, the matching schema), so no new dependency. `scripts/register-provider.mjs`: a view-only keys file → `POST /providers` → API key file written under umask 077, never printed. The protocol v2.0 edit after co-signing, the READMEs, and the live run record |
| Services agent (`z402-f9`) | `service-kit`: `priceZat?` per route; `checkProvider` at startup; a declaration heartbeat (`POST /discovery/resources` every 30 s, built from the same `accepts` and `extensions` as its 402). Starter services get prices that fit their cost. compose: provider 2, with its own view-only keys, a one-shot registration job writing its API key to a volume, and its own `Z402_PAY_TO`/token. `apps/web`: proxy `/discovery/*` to the facilitator and derive status from `lastSeen`. Retire `apps/discovery`. Update the smoke test that relied on a 600 vs 500 price refusal |
| Client agent (`z402-08`) | Co-signed v2.0 (ACK, no changes). The agent's `--discovery` default becomes the facilitator (`http://127.0.0.1:4022`), committed once the routes are on `dev`. `--url` becomes repeatable: targets are called round-robin, with a summary per target; `--api` stays as shorthand, and `--cheat` stays single-target |

**Provider 2 in compose** is the services agent's call; it proposes `services/markdown` (plain paid GET, no model) as an independent provider with its own keys. The host live check (§8) uses the second `apps/api` instance, which needs no outside network.

**Landing order on `dev`**, so the root suite is never red:
1. Additive:
   - `GET /providers/me` and `checkProvider`;
   - the registry, auth, `/providers` and the Bazaar routes, all behind an unchanged operator path.
2. The kit switches to `checkProvider` and moves its `payTo` case off `validateFacilitatorSupport`. The smoke test's 600-vs-500 refusal moves to a case refused under both price rules.
3. The amount rule lands, pinged to the services agent first.
4. `payTo` leaves `/supported` and `validateFacilitatorSupport`, and `termsVersion` v2 lands.
5. The agent's `--discovery` default switches to the facilitator.

Until each step lands, the others build against this section's shapes.

## 7. Security

- **Tenant isolation.** The bearer picks the runtime. That runtime's scheme refuses any other `payTo`, and it signs and checks vouchers over its own `payTo`. Deposits decrypt only with that provider's UIVK, and credits live in that provider's ledger. No request can reach another provider's state.
- **Secrets.**
  - API keys are 256-bit random, shown once, and stored as sha256; lookup is by hash.
  - UIVKs sit in the 0600 registry and reach zdecrypt only through `ZDECRYPT_KEY`.
  - Neither keys nor UIVKs are ever logged or returned. The registration answer never echoes the UIVK.
- **Squatting.** A `payTo` can be registered only with a key that owns it. Re-registration with such a key rotates the key, so whoever holds a provider's UIVK controls its API key. Providers must keep their UIVK private, which they must do anyway, since it reveals their incoming payments.
- **Catalog poisoning.**
  - Only an authenticated provider writes its own items. Every `accepts` entry must name that provider's `payTo` and the rail's terms.
  - Sizes and counts are capped, and the facilitator never fetches a provider URL (no SSRF).
  - Client-echoed metadata never overwrites a declared item, and never creates an item for a provider that declares.
  - The 402 a resource returns stays authoritative: clients pay what it says, not what the catalog says.
- **What agents search for stays private.** The access log records the path only, never a query string. That covers `/discovery/search` and `/discovery/resources` in particular, as today's log does (app.ts `accessLog` uses `req.path`).
- **Exposure.** Compose keeps the facilitator port unpublished; the website proxies only the public Bazaar reads. Before outside providers connect over the internet, put the facilitator behind TLS and set `Z402_REGISTRATION_TOKEN`. With open registration, anyone can take the provider slots (a runtime each) and list resources on our site.
- **Resource limits.**
  - Up to 32 providers by default, plus the optional registration token.
  - The 64 KB body limit stays.
  - zdecrypt runs at most 8 at a time across tenants.
  - Each tenant keeps its own resolver bound (4 slots, 16 queued).

## 8. Testing and the live check

- **Facilitator unit tests:**
  - the registry (atomic write, mode, lock, rotation, malformed file, network mismatch);
  - keys (format, hash lookup, unknown key);
  - the amount rule (1, `windowZat`, 0, `windowZat + 1`, non-canonical) and the voucher increment under two prices in one session;
  - `payTo` binding;
  - `/supported` and `termsVersion` v2 (pinned);
  - catalog validation for every rule above, upsert and heartbeat, payment matching and creation, caps, the `paidCallsToday` day rollover, list and search filters, and pagination;
  - persistence and the 7-day drop.
- **Facilitator integration:**
  - two providers on one facilitator over FakeChain, with interleaved sessions;
  - one txid presented at both, crediting each with its own outputs;
  - a registration while traffic flows;
  - a restart that replays both ledgers;
  - the operator path with today's ledger and token unchanged;
  - `withBazaar(HTTPFacilitatorClient)` against our routes.
- **Server and API:** `checkProvider` (match, 401, other `payTo`, unreachable), and `validateFacilitatorSupport` without `payTo`.
- **Live (Z3 regtest, compose):**
  - provider 2 registers through `scripts/register-provider.mjs` and starts as a second `apps/api` instance at 800 zat on 4023;
  - one agent pays `4021/chunk` (500) and `4023/chunk` (800) in one run;
  - each provider's ledger holds only its own deposits and vouchers;
  - `GET /discovery/resources` lists the declared starter services (fresh `lastSeen`) and provider 2's `/chunk` (payment-sourced), each with a non-zero `paidCallsToday` once paid.

  The result is recorded in `docs/research/live-run.md`.

## 9. Known limits

- **Terms.** The trust terms (`windowZat`, ratio, cap) are rail-wide. Per-provider terms, and so prices above `windowZat`, are future work.
- **Viewing keys.** The facilitator holds every provider's view-only key, so it sees their incoming payments. Sender-disclosed decryption (in the style of ZIP 311) would remove that, and is future work.
- **Failure scope.** A ledger write failure or a lost lock in one runtime restarts the whole process (§4.5).
- **Duplicate listings.** Two providers can list the same URL. The catalog shows each with its own `payTo`, and the resource's 402 is authoritative.
- **Rate limiting.** The public routes have none.
- **Growth.** Ledgers and state grow without bound, per provider, as before.
- **Polling.** Each runtime polls the shared, cached tip every 5 s.
