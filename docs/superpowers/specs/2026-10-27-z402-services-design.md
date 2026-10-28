# z402 services, discovery, website and deployment — design

Revised 2026-10-28 for the multi-provider facilitator ([design](2026-10-28-z402-multi-provider-design.md)).

2026-10-27 · owner: services session (z402-f9) · source: the user's "Service Discovery and Starter Services" doc

This is the build contract for everything the services session adds. It sits next to the wire contract
(`docs/spec/protocol.md`) and the multi-provider design, which it does not change.

## 0. Decisions agreed with the other sessions

- **Facilitator untouched.** `packages/facilitator/**` and `apps/api/**` belong to the facilitator session and are not
  edited. The facilitator is one rail for many providers, each with its own `payTo`, API key and prices, and it hosts
  the Bazaar.
- **The Bazaar is the facilitator's.** It takes each provider's declarations on `POST /discovery/resources` and serves
  `GET /discovery/resources` and `GET /discovery/search` to everyone (multi-provider design §4.4). `apps/discovery` is
  retired and port 4030 is gone. The website proxies those two reads, so the public site origin is still a Bazaar
  "facilitator URL" for discovery only:
  `withBazaar(new HTTPFacilitatorClient({ url: siteOrigin })).extensions.bazaar.listResources({ type: "http" })`.
- **A price per route.** A service sets its own price, and a route may set its own (`PaidRoute.priceZat`). Any
  canonical amount from 1 to the facilitator's `windowZat` (100,000) is valid, and the kit refuses to start outside
  that range. What one call buys is the service's *billing unit*. Compose runs each service at its own price.
- **Two providers.** The operator's services (LLM, embeddings, drop box) and `apps/api` share the operator's `payTo`
  and facilitator token, so one deposit window funds them (the client keeps one session per `payTo`). URL to markdown
  is provider 2 in compose, with its own `payTo` and API key, so a client pays it with a deposit of its own.
- **@x402 pinned at exactly 2.28.0** (`@x402/core`, `@x402/express`, `@x402/fetch`, `@x402/extensions`). No other
  version may enter the lockfile.
- **No central intent matching.** A server that matches intents learns what every agent wants. The facilitator serves
  `/discovery/search` because the standard Bazaar client has it, but the agent and the website never call it: they pull
  the whole list and pick on their own side. The facilitator logs request paths only, never query strings.

## 1. Layout

| Path | Package | What |
|---|---|---|
| `packages/service-kit` | `@z402/service-kit` | Shared paid-service wiring: env, x402 + prepaid-voucher + Bazaar, a price per route, `checkProvider` at start-up, the Bazaar declaration heartbeat, `/health`, call counter, delivery hook, process runner, in-process test stack |
| `services/llm` | `@z402/service-llm` | LLM inference, billed per output chunk |
| `services/markdown` | `@z402/service-markdown` | URL to clean markdown, billed per page; provider 2 in compose |
| `services/embeddings` | `@z402/service-embeddings` | Text embeddings, billed per call (about 1,000 tokens) |
| `services/dropbox` | `@z402/service-dropbox` | Encrypted drop box, billed per blocks held |
| `apps/web` | `@z402/web` | Next.js site: landing `/`, services `/services`, proxy of the facilitator's two public Bazaar reads under `/discovery/` |
| `apps/agent/src/discover.ts` | (agent, reviewed by the client session) | `discover` subcommand using the stock Bazaar client |
| `compose.yaml`, `docker/`, `.env.example` | — | One `docker compose up` for the whole project |

Each service directory has its own `README.md`, `.env.example` (its own provider keys and limits) and tests.

## 2. Ports

| Service | Port | Published by compose |
|---|---|---|
| web | 3000 | yes |
| api (`/chunk`, existing) | 4021 | yes |
| facilitator (hosts the Bazaar) | 4022 | **no** (the website proxies its public Bazaar reads) |
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
| `Z402_FACILITATOR_TOKEN` / `Z402_FACILITATOR_TOKEN_FILE` | — | The provider's API key as a bearer token: the operator's token, or the key `POST /providers` issued (the file form is trimmed) |
| `Z402_PAY_TO` / `Z402_PAY_TO_FILE` | — (required) | The provider's shielded-only UA; must be the one its API key is registered to, which `checkProvider` verifies at start-up (§3.2) |
| `Z402_PRICE_ZAT` | the service's own price (§4) | Replaces the service's price for every route that sets none; a whole number of zat from 1 to the facilitator's `windowZat` |
| `PUBLIC_URL` | `http://localhost:<PORT>` | Public origin of the service, used as the 402 `resource` URL and in its Bazaar declarations |
| `HOST` | `127.0.0.1` | Listen address (`0.0.0.0` in compose) |
| `PORT` | per service | Listen port |

### 3.2 Paid routes

A service is defined as data:

```ts
interface PaidRoute {
  method: "GET" | "POST" | "PUT" | "DELETE";   // the method agents use; also the method of its catalog item
  path: string;            // x402 route key WITHOUT a verb ("/v1/generate", "/v1/drops/:id/hold"), so HEAD cannot bypass payment
  probePath?: string;      // concrete path for dynamic routes, whose 402 gives the catalog item ("/v1/drops/example/hold")
  description: string;     // one sentence for agents
  unit: string;            // what one call buys: "output chunk", "page", "1k tokens", "10 blocks"
  note?: string;           // one short guardrail/privacy note (shown behind a "?" on the site)
  mimeType?: string;       // default "application/json"
  priceZat?: bigint;       // price of one call in zat; default: the service's price
  discovery: DeclareDiscoveryExtensionInput;  // @x402/extensions/bazaar declareDiscoveryExtension config
}
interface ServiceDefinition { serviceName: string /* ≤32 printable ASCII */; tags?: string[]; routes: PaidRoute[] }
```

`loadServiceEnv(env, { port, priceZat })` takes the service's default price, and `Z402_PRICE_ZAT` in the service's
environment or its `services/<name>/.env` replaces it. A route's own `priceZat` replaces both for that route.

The kit turns each route into an x402 `RouteConfig`: `accepts` = `{ scheme: "prepaid-voucher", network, price: { amount:
<route price>, asset: "ZEC" }, payTo, maxTimeoutSeconds: 60 }`; `resource` = `PUBLIC_URL + path`; `description`,
`mimeType`, `serviceName`, `tags`; `extensions` = `declareDiscoveryExtension(route.discovery)` plus
`{ z402: { unit, note? } }`. Wiring follows `apps/api/src/app.ts`: `HTTPFacilitatorClient` (60 s timeout for verify and
settle, 5 s for the start-up reads; bearer on all three), one `PrepaidVoucherServerScheme({ payTo, network })`, then
`paymentMiddlewareFromHTTPServer(http, undefined, undefined, false)`.

Start-up runs in this order, before anything listens, and every failure names the variable at fault:

1. `checkProvider` from `@z402/server` calls `GET /providers/me`, which proves that the API key and `Z402_PAY_TO`
   belong together. It keeps waiting while the error is retryable (the facilitator is starting or down, §3.6) and
   otherwise fails at once, naming `Z402_FACILITATOR_URL`, `Z402_FACILITATOR_TOKEN` or `Z402_PAY_TO`.
2. It reads `/supported`: the rail's terms and their `termsVersion`.
3. It checks that every route's price is from 1 to the terms' `windowZat`, or fails naming `Z402_PRICE_ZAT`.
4. It builds each route's catalog item once, from that route's own unpaid 402 (§5).

Then the Bazaar heartbeat starts (§5).

### 3.3 Free routes the kit adds

- `GET /health` → `200` when ready, `503` otherwise:
  `{ ok, service, ready, network, priceZat, callsToday, routes: [{ method, path, probePath, unit, priceZat }] }`.
  `priceZat` at the top is the service's price, and each route's entry has its own. `callsToday` counts paid calls
  delivered with a 2xx since 00:00 UTC (aggregate only, never per session).
- Everything else is the service's own.
- A request with `X-Z402-Probe: 1` and no payment skips the route's `prepare` (a placeholder id or an empty body would
  be refused there) and gets the route's 402. A request that carries `PAYMENT-SIGNATURE` or `X-PAYMENT` never skips
  `prepare`.

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
paid calls in-process. With `catalog: true` it also puts a stub Bazaar in front of the facilitator, which the service
declares its routes to and which records each declaration; `declarationRefusal` checks one against the catalog's rules
(multi-provider design §4.4).

### 3.6 Hardening rules in the kit (2026-10-28)

- Paid paths are matched in one canonical spelling. A spelling the x402 middleware would fold into a paid route but
  Express would not route (`//v1/generate`, `/v1/%67enerate`, a trailing slash) is refused `404 not_found` before
  payment.
- A copy of a voucher that is already being verified or handled is refused `409 payment_in_flight`, so one payment
  runs the paid handler once.
- The HTTP server takes at most 15 s for the request headers and 30 s for the whole request, so a slow upload cannot
  hold a buffered body for minutes.
- At start a service waits for a facilitator that is starting or down (`Z402_FACILITATOR_WAIT_MS`, default 120000,
  retry every 2 s); any other failure of the start-up order (§3.2), such as a refused API key, another `payTo` or a
  facilitator that answers wrongly, is a configuration error and fails at once.
- `loadDotEnv` reads the service's own `services/<name>/.env`; a variable already in the environment (compose, the
  shell) wins.
- Text that is not valid Unicode (a lone surrogate) is refused before payment wherever it would reach a provider.

## 4. Starter services

Each service sets its own price (in its heading below), and `Z402_PRICE_ZAT` replaces it (§3.1). A failed call
(4xx/5xx) is never charged.

### 4.1 LLM inference (`services/llm`, 4031) — 200 zat per output chunk

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

### 4.2 URL to markdown (`services/markdown`, 4032) — 1,000 zat per page

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
- In compose it runs as provider 2, paid at its own `payTo` with its own API key (§7).

### 4.3 Text embeddings (`services/embeddings`, 4033) — 100 zat per call (about 1,000 tokens)

- `POST /v1/embeddings` `{ "input": string | string[] }` (≤ 64 non-empty strings) →
  `{ object: "list", model, dimensions, data: [{ object: "embedding", index, embedding }], usage: { prompt_tokens, total_tokens } }`.
- Cap: about 1,000 tokens per call, enforced before payment by length: total input ≤ `EMBEDDINGS_MAX_CHARS` (4000),
  and each string ≤ `EMBEDDINGS_MAX_INPUT_CHARS` (unlimited by default; compose sets 2000 for its local model, whose
  window is 2048 tokens per string). The provider's `usage.prompt_tokens` is reported back; a call is never failed
  after payment for being long.
- Env: `EMBEDDINGS_BASE_URL` (`http://127.0.0.1:11434/v1`), `EMBEDDINGS_API_KEY`, `EMBEDDINGS_MODEL`
  (`nomic-embed-text`). Ready when the provider lists the model.

### 4.4 Encrypted drop box (`services/dropbox`, 4034) — 500 zat per upload or hold (10 blocks)

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
- Unpaid upload attempts are rate-limited per client (`DROPBOX_RATE_PER_MIN`, 30, `429 rate_limited`), compressed
  request bodies are refused (`415 unsupported_encoding`), and a malformed id is `400 bad_request`. Downloads carry
  `X-Content-Type-Options: nosniff` and `Content-Disposition: attachment`. After a chain reset with the directory kept,
  every expiry is pulled back to at most the current tip + `DROPBOX_MAX_HOLD_BLOCKS`.
- Note: only client-side-encrypted blobs; size and time are capped.

## 5. Discovery (the facilitator's Bazaar)

The facilitator hosts the Bazaar (multi-provider design §4.4), and the services list themselves in it.

- **Declaring** (`packages/service-kit/src/declare.ts`). A ready service posts its routes to
  `POST {facilitator}/discovery/resources` with the service's API key: as soon as it is ready, then every 30 s, and
  only while it is ready. `declareIntervalMs` sets the interval, and `0` turns it off. Each item is `resource` =
  `PUBLIC_URL` + the route's path template, `accepts` = that route's 402 `accepts`, `serviceName`, `tags`,
  `description`, `mimeType`, and `extensions`: `bazaar` (with `method`, and `routeTemplate` on a route with
  parameters) and `z402` `{ unit, note? }`. One bad item refuses a whole call, so the kit checks the catalog's item
  limits at start. A failed declaration never stops the service: it logs one line per change of state, never the
  token, and tries again at the next beat.
- **Reading.** `GET /discovery/resources` and `GET /discovery/search` are public. Items carry `lastSeen` (the latest
  declaration) and `paidCallsToday` (settled calls since 00:00 UTC). Once a provider has declared, a payment never
  creates an item; a provider that has not is listed from its payments alone, and such an item has no `lastSeen`.
- **Readers.** The agent's `discover` and the website read the whole list from `GET /discovery/resources` and filter
  on their own side. Neither calls `/discovery/search`, so what an agent looks for never reaches a server, and the
  facilitator logs request paths only, never query strings.
- The heartbeat is the liveness signal: the site reads a service's status from the age of its items' `lastSeen` (§6).

## 6. Website (`apps/web`)

Next.js 16.4.3 (App Router, standalone output), React 19.3.1, Tailwind 4.3.3. `DISCOVERY_URL` is the facilitator
(`http://127.0.0.1:4022`; compose `http://facilitator:4022`), and server components read every page of its
`GET /discovery/resources` with `limit=100`. `/` landing (install command on top), `/services` the read-only list
(service, endpoint, price, unit, status, TODAY; guardrail notes behind `?` tooltips), `GET /discovery/[...path]`
proxies only `/discovery/resources` and `/discovery/search` to the facilitator, forwarding only the parameters those
two reads document. Minimal: no explanations beyond tooltips, no decorative icons.

- Rows are grouped by origin and `payTo`, never by a self-declared name alone, since any provider can declare any name.
- Each route shows its own price; a row shows the range when its routes differ.
- Status comes from the age of `lastSeen`: up under 90 s, stale under 10 min, down after that, and a dash without one.
- TODAY is the sum of `paidCallsToday` over a row's routes.

## 7. Deployment (`compose.yaml`)

`docker compose up` brings up, in order: Zebra (regtest) → chain init (2 blocks) → Zallet init (own marker) → Zallet
and Zaino → agent funding → block clock; keygen (the operator's merchant keys, provider 2's own keys, the public pay-to
and the facilitator token) → facilitator → api, llm, embeddings, dropbox, web, and `markdown-register` → markdown; two
small llama.cpp servers (chat and embeddings, models fetched on first start) back llm and embeddings unless a service's
own `.env` points at a hosted provider. The website and `discover` read the facilitator's Bazaar over the compose
network. On demand: `docker compose run --rm agent` (the demo loop on `/chunk`), `docker compose run --rm discover` (the
catalog, no wallet) and `docker compose run --rm smoke` (one real paid call on every starter service, `apps/smoke`).
Details in `docs/deploy.md`.

- **Prices.** Each service charges its own price, and `Z402_PRICE_ZAT` in its `services/<name>/.env` sets another.
  `Z402_PRICE_ZAT` in the root `.env` prices only the demo API's `GET /chunk`; the facilitator no longer reads it.
- **Provider 2: URL to markdown.** An independent provider, as one on another machine would be. The other services and
  `apps/api` keep the operator's `payTo` and token.
  - `keygen` creates its own key set in a `markdown-keys` volume, mounted only into `keygen` and `markdown-register`.
  - The one-shot `markdown-register` job keeps a stored API key while `GET /providers/me` accepts it. Otherwise it
    calls `POST /providers` `{ payTo, uivk }` and writes the key (mode 0600) to a `markdown-runtime` volume, which
    `markdown` mounts read-only. `--rotate` issues a new key and ends the old one at once.
- **Exposure.** The facilitator's port stays unpublished. Before outside providers connect, put it behind TLS and set
  `Z402_REGISTRATION_TOKEN`: with open registration, anyone who reaches it can take its provider slots and list
  resources on the website.
- **Smoke.** One deposit per merchant (the operator's, and provider 2's for markdown), and each call is paid at the
  price its service asks. Its refused-voucher case breaks the voucher's signature, which the facilitator refuses at any
  price.
