# z402 services, discovery, website and deployment — design

2026-10-27 · owner: services session (z402-f9) · source: the user's "Service Discovery and Starter Services" doc

This is the build contract for everything the services session adds. It sits next to the wire contract
(`docs/spec/protocol.md` v1.1), which it does not change.

## 0. Decisions agreed with the other sessions

- **Facilitator untouched.** `packages/facilitator/**` and `apps/api/**` belong to the facilitator session and are not
  edited. Discovery does not run inside the facilitator process (it holds the viewing key and the ledger).
- **Discovery is its own service** (`apps/discovery`). It serves the Bazaar endpoint `GET /discovery/resources`. The
  website proxies `/discovery/*` to it, so the public site origin is a Bazaar "facilitator URL" for discovery only:
  `withBazaar(new HTTPFacilitatorClient({ url: siteOrigin })).extensions.bazaar.listResources({ type: "http" })`.
- **One price.** The facilitator accepts exactly one amount (`Z402_PRICE_ZAT`, default 500). Every service charges
  exactly that per call; what one call buys is the service's *billing unit*. A service with another price fails every
  paid call with `invalid_payment_requirements`. Per-route prices are a later protocol v1.2 change (facilitator owner).
- **One merchant.** All starter services share the merchant `payTo` (the facilitator's `orchardOnlyAddress`), so one
  deposit window funds every service (the client keeps one session per `payTo`).
- **@x402 pinned at exactly 2.28.0** (`@x402/core`, `@x402/express`, `@x402/fetch`, `@x402/extensions`). No other
  version may enter the lockfile.
- **No central intent matching.** There is no `/discovery/search`: a server that matches intents learns what every agent
  wants. Agents pull the whole list and pick locally.

## 1. Layout

| Path | Package | What |
|---|---|---|
| `packages/service-kit` | `@z402/service-kit` | Shared paid-service wiring: env, x402 + prepaid-voucher + Bazaar, `/health`, call counter, delivery hook, process runner, in-process test stack |
| `services/llm` | `@z402/service-llm` | LLM inference, billed per output chunk |
| `services/markdown` | `@z402/service-markdown` | URL to clean markdown, billed per page |
| `services/embeddings` | `@z402/service-embeddings` | Text embeddings, billed per 1,000 tokens |
| `services/dropbox` | `@z402/service-dropbox` | Encrypted drop box, billed per blocks held |
| `apps/discovery` | `@z402/discovery` | Bazaar catalog: probes the services, serves `/discovery/resources` and `/discovery/status` |
| `apps/web` | `@z402/web` | Next.js site: landing `/`, services `/services`, proxy `/discovery/*` |
| `apps/agent/src/discover.ts` | (agent, reviewed by the client session) | `discover` subcommand using the stock Bazaar client |
| `compose.yaml`, `docker/`, `.env.example` | — | One `docker compose up` for the whole project |

Each service directory has its own `README.md`, `.env.example` (its own provider keys and limits) and tests.

## 2. Ports

| Service | Port | Published by compose |
|---|---|---|
| web | 3000 | yes |
| api (`/chunk`, existing) | 4021 | yes |
| facilitator | 4022 | **no** |
| discovery | 4030 | no (reached through the website) |
| llm | 4031 | yes |
| markdown | 4032 | yes |
| embeddings | 4033 | yes |
| dropbox | 4034 | yes |
| Zebra, Zallet, Zaino, llama.cpp model servers | — | **no** |

Published ports bind to `${Z402_PUBLISH_HOST:-0.0.0.0}`.

## 3. Service kit (`@z402/service-kit`)

### 3.1 Environment (every service)

An empty variable counts as unset. Every error names the variable.

| Variable | Default | Meaning |
|---|---|---|
| `Z402_NETWORK` | `regtest` | `regtest`, `testnet` or `mainnet` |
| `Z402_FACILITATOR_URL` | — (required) | The facilitator's `http(s)://` URL |
| `Z402_FACILITATOR_TOKEN` / `Z402_FACILITATOR_TOKEN_FILE` | — | Bearer token for the facilitator (the file form is trimmed) |
| `Z402_PAY_TO` / `Z402_PAY_TO_FILE` | — (required) | Merchant shielded-only UA; must be the facilitator's |
| `Z402_PRICE_ZAT` | `500` | Must equal the facilitator's price |
| `PUBLIC_URL` | `http://localhost:<PORT>` | Public origin of the service, used as the 402 `resource` URL and in discovery |
| `HOST` | `127.0.0.1` | Listen address (`0.0.0.0` in compose) |
| `PORT` | per service | Listen port |

### 3.2 Paid routes

A service is defined as data:

```ts
interface PaidRoute {
  method: "GET" | "POST" | "PUT" | "DELETE";   // the method agents use; also the discovery probe method
  path: string;            // x402 route key WITHOUT a verb ("/v1/generate", "/v1/drops/:id/hold"), so HEAD cannot bypass payment
  probePath?: string;      // concrete path for dynamic routes, used by discovery probes ("/v1/drops/example/hold")
  description: string;     // one sentence for agents
  unit: string;            // what one call buys: "output chunk", "page", "1k tokens", "10 blocks"
  note?: string;           // one short guardrail/privacy note (shown behind a "?" on the site)
  mimeType?: string;       // default "application/json"
  discovery: DeclareDiscoveryExtensionInput;  // @x402/extensions/bazaar declareDiscoveryExtension config
}
interface ServiceDefinition { serviceName: string /* ≤32 printable ASCII */; tags?: string[]; routes: PaidRoute[] }
```

The kit turns each route into an x402 `RouteConfig`: `accepts` = `{ scheme: "prepaid-voucher", network, price: { amount:
priceZat, asset: "ZEC" }, payTo, maxTimeoutSeconds: 60 }`; `resource` = `PUBLIC_URL + path`; `description`,
`mimeType`, `serviceName`, `tags`; `extensions` = `declareDiscoveryExtension(route.discovery)` plus
`{ z402: { unit, note? } }`. Wiring follows `apps/api/src/app.ts`: `HTTPFacilitatorClient` (60 s timeout, bearer on
verify/settle/supported), one `PrepaidVoucherServerScheme({ payTo, network })`, `await http.initialize()` (startup
errors name the option), then `paymentMiddlewareFromHTTPServer(http, undefined, undefined, false)`.

### 3.3 Free routes the kit adds

- `GET /health` → `200` when ready, `503` otherwise:
  `{ ok, service, ready, network, priceZat, callsToday, routes: [{ method, path, probePath, unit }] }`.
  `callsToday` counts paid calls delivered with a 2xx since 00:00 UTC (aggregate only, never per session).
- Everything else is the service's own.
- **Discovery probes** send `X-Z402-Probe: 1` without a payment. They skip the route's `prepare` (a placeholder id or
  an empty body would be refused there) and get the route's 402. A request that carries `PAYMENT-SIGNATURE` or
  `X-PAYMENT` never skips `prepare`.

### 3.4 Refuse before payment, deliver after

The stock client sends a request unpaid first, gets the 402, then retries with a voucher. If the paid retry fails with
a non-402 status, the client cannot tell whether it was charged: it counts the call as **ambiguous** and advances its
cumulative total, so the next successful voucher pays for the failed call too (protocol.md §9.4, lenient increment).
Hence:

- **Every check that can run before payment must** (`PaidRoute.prepare`, mounted before the payment middleware): body
  parsing and validation, unknown ids, finished streams, size and format checks, rate limits, capacity. The kit itself
  refuses a wrong method (`405`) and a service that is not ready (`503`, readiness cached 5 s) before payment. These
  refusals reach the client on its unpaid first attempt, before any voucher exists.
- A handler status ≥ 400 after payment still cancels settlement, but the client counts it; keep those for genuine
  runtime failures only.
- Side effects that must only happen for a call that was **paid and delivered** use `onDelivered(res, { ok, failed })`:
  `ok` runs when the response finished with a 2xx, `failed` otherwise (refused settle, handler error, aborted
  connection).

### 3.5 Test stack

`@z402/service-kit/testing` starts a FakeChain, the real facilitator (in-memory ledger), the service app and a stock
`wrapFetchWithPayment` client paying through `PrepaidVoucherScheme` + `MockWallet`, so every service test makes real
paid calls in-process.

## 4. Starter services

All charge `Z402_PRICE_ZAT` per call. A failed call (4xx/5xx) is never charged.

### 4.1 LLM inference (`services/llm`, 4031) — per output chunk

- `POST /v1/generate`, JSON. Start: `{ "prompt": string, "system"?: string, "maxTokens"?: number }`. Continue:
  `{ "stream": string }`. Answer: `{ "stream", "index", "text", "done", "finishReason"? }`. Each paid call returns
  exactly one chunk (about `LLM_CHUNK_TOKENS`, default 32, tokens). The agent stops paying whenever it wants.
- A background producer streams from an OpenAI-compatible `chat/completions` endpoint (`stream: true`). A chunk is
  published once it is full **and** the next token has arrived, or when the stream ends, so `done` is exact.
- The cursor advances only in `onDelivered.ok`; concurrent calls on one stream get `409`; an unknown stream `404`; a
  finished stream `410`; provider failure `502`; first chunk not ready within `LLM_CHUNK_TIMEOUT_MS` `504`.
- Env: `LLM_BASE_URL` (`http://127.0.0.1:11434/v1`, a local Ollama; compose points it at its llama.cpp server), `LLM_API_KEY`, `LLM_MODEL` (`qwen2.5:0.5b`), `LLM_CHUNK_TOKENS`
  (32), `LLM_MAX_TOKENS` (1024), `LLM_MAX_PROMPT_CHARS` (8000), `LLM_MAX_STREAMS` (64), `LLM_STREAM_IDLE_MS` (600000),
  `LLM_CHUNK_TIMEOUT_MS` (60000). Ready when the provider lists the model.
- Note: the operator sees prompts; default model is open-weights.

### 4.2 URL to markdown (`services/markdown`, 4032) — per page

- `GET /v1/markdown?url=<http(s) URL>` → `{ url, finalUrl, title, byline, markdown, length }`.
- SSRF guard: http/https only, no credentials in the URL, allowed ports (`MARKDOWN_ALLOWED_PORTS`, 80,443,8080,8443);
  every resolved address must be public unicast (no private, loopback, link-local, unique-local, CGNAT, multicast,
  reserved, unspecified, broadcast, documentation, benchmarking, IPv4-mapped/NAT64/6to4/Teredo of a non-public v4); the
  connection is pinned to the validated address (custom `lookup`), so DNS rebinding cannot swap it; redirects are
  followed manually (max 5) and each hop is re-validated.
- Limits: `MARKDOWN_MAX_BYTES` (5 MiB, counted after decompression), `MARKDOWN_TIMEOUT_MS` (15000), content types
  text/html, application/xhtml+xml, text/plain; per-IP rate limit `MARKDOWN_RATE_PER_MIN` (30) applied before payment;
  `MARKDOWN_MAX_CONCURRENT` (4).
- Readability (`@mozilla/readability` on `jsdom`, no scripts, no subresources) then `turndown`; links made absolute.
- **Fetch before payment.** The page is fetched and converted in `prepare` (rate-limited, SSRF-guarded) and cached for
  `MARKDOWN_CACHE_MS` (60000) by URL; a page that cannot be fetched or converted is refused on the unpaid attempt and is
  never charged. The paid retry is served from the cache.
- Note: the site sees the server's IP, not the agent's.

### 4.3 Text embeddings (`services/embeddings`, 4033) — per 1,000 tokens

- `POST /v1/embeddings` `{ "input": string | string[] }` (≤ 64 non-empty strings) →
  `{ object: "list", model, dimensions, data: [{ object: "embedding", index, embedding }], usage: { prompt_tokens, total_tokens } }`.
- Cap: about 1,000 tokens per call, enforced before payment by length: total input ≤ `EMBEDDINGS_MAX_CHARS` (4000).
  The provider's `usage.prompt_tokens` is reported back; a call is never failed after payment for being long.
- Env: `EMBEDDINGS_BASE_URL` (`http://127.0.0.1:11434/v1`), `EMBEDDINGS_API_KEY`, `EMBEDDINGS_MODEL`
  (`nomic-embed-text`). Ready when the provider lists the model.

### 4.4 Encrypted drop box (`services/dropbox`, 4034) — per 10 blocks held

- `POST /v1/drops` (paid), body = an **age**-encrypted file (binary `age-encryption.org/v1` header or ASCII armor),
  `application/octet-stream`, ≤ `DROPBOX_MAX_BYTES` (1 MiB). Anything that is not age-shaped or whose payload is not
  high-entropy is refused `415` (free). Answer: `{ id, deleteToken, size, tip, expiresAtHeight }`; the drop is held
  for `DROPBOX_BLOCKS_PER_CALL` (10) blocks past the current tip.
- `POST /v1/drops/:id/hold` (paid) adds `DROPBOX_BLOCKS_PER_CALL` blocks, capped at tip + `DROPBOX_MAX_HOLD_BLOCKS`
  (1000): `409` when already at the cap, `404` when unknown or expired.
- `GET /v1/drops/:id` (free) returns the bytes; `DELETE /v1/drops/:id` (free) with `Authorization: Bearer <deleteToken>`.
- The upload is kept, and a hold applied, only in `onDelivered.ok`. Tip from lightwalletd (`DROPBOX_LWD_URL`), swept
  every 10 s; a drop is gone once `tip ≥ expiresAtHeight`. Disk store `DROPBOX_DIR`, total cap
  `DROPBOX_MAX_TOTAL_BYTES` (256 MiB, `507` when full).
- Note: only client-side-encrypted blobs; size and time are capped.

## 5. Discovery (`apps/discovery`, 4030)

- Config: `DISCOVERY_SERVICES` = comma-separated service origins (internal, e.g. `http://llm:4031`); optional
  `DISCOVERY_TARGETS` = extra `METHOD url` entries for routes not built on the kit; `DISCOVERY_REFRESH_MS` (30000);
  `DISCOVERY_TIMEOUT_MS` (5000); `HOST`, `PORT`.
- Refresh: for each origin `GET /health` (up/ready/callsToday/routes), then for each route an unpaid request with the
  route's method to `origin + (probePath ?? path)` (`Accept: application/json`, `X-Z402-Probe: 1`, no body), expecting
  `402` + `PAYMENT-REQUIRED`. The decoded v2 `PaymentRequired` becomes one item:
  `{ resource: resource.url, type: "http", x402Version, accepts, lastUpdated, description, mimeType, serviceName, tags,
  iconUrl, extensions }`. Items keep their last good data while a service is down.
- `GET /discovery/resources?type&payTo&scheme&network&extensions&limit&offset` → `{ x402Version: 2, items, pagination:
  { limit, offset, total } }` (limit default 100, max 1000). `GET /discovery/status` → per service
  `{ serviceName, url, up, ready, latencyMs, checkedAt, callsToday, unit, priceZat }`. `GET /health`. CORS `*` on GET.
- One failed probe never crashes the process (every await is caught).

## 6. Website (`apps/web`)

Next.js 16.4.3 (App Router, standalone output), React 19.3.1, Tailwind 4.3.3. Server components read
`DISCOVERY_URL` (`http://127.0.0.1:4030`; compose `http://discovery:4030`). `/` landing (install command on top),
`/services` the read-only list (name, description, price, unit, live up/down, calls today; guardrail notes behind `?`
tooltips), `GET /discovery/[...path]` proxies to the discovery service. Minimal: no explanations beyond tooltips, no
decorative icons.

## 7. Deployment (`compose.yaml`)

`docker compose up` brings up, in order: Zebra (regtest) → chain init (2 blocks) → Zallet init (own marker) → Zallet
and Zaino → agent funding → block clock; keygen (merchant keys + public pay-to + facilitator token) → facilitator →
api, services, discovery, web; two small llama.cpp servers (chat and embeddings, models fetched on first start) back
llm and embeddings unless a service's own `.env` points at a hosted provider. Details in `docs/deploy.md`.
