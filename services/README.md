# Starter services

Four paid HTTP services that agents find through discovery and pay with `prepaid-voucher` (one shielded deposit, then
a signed voucher per call). The project runs them as reference services. Three are the operator's, on its `payTo` and
facilitator token like `apps/api`; URL to markdown is provider 2, an independent provider with its own `payTo` and its
own facilitator API key ([`markdown`](markdown/README.md#as-provider-2)).

| Service | Port | Price | One paid call buys | Directory |
| --- | --- | --- | --- | --- |
| LLM inference | 4031 | 200 zat | one output chunk (about 32 tokens) | [`llm`](llm/README.md) |
| URL to markdown | 4032 | 1,000 zat | one page | [`markdown`](markdown/README.md) |
| Text embeddings | 4033 | 100 zat | about 1,000 tokens | [`embeddings`](embeddings/README.md) |
| Encrypted drop box | 4034 | 500 zat | 10 blocks of storage, for an upload or a hold | [`dropbox`](dropbox/README.md) |

Each service prices its own routes. `Z402_PRICE_ZAT`, in the environment or the service's `.env`, replaces the price
above, and a route may also carry a price of its own (`PaidRoute.priceZat`). A price is a whole number of zat from 1 to
the facilitator's `windowZat` (100,000 on the demo terms), and a service with a price outside that refuses to start,
naming `Z402_PRICE_ZAT`. Until the facilitator takes a price per route it accepts 500 zat only, so compose sets
`Z402_PRICE_ZAT=500` on every service for now. A refused call is never charged, because each service refuses
everything it can before the agent sends a voucher.

## Settings and keys

Each service reads its own `services/<name>/.env`: copy its `.env.example` and uncomment only what you change (its
provider's API key, limits, `PUBLIC_URL`). A variable already set in the environment wins over the file. Under Docker,
compose reads the same file after its defaults in `docker/env/<name>.env`, so `LLM_BASE_URL`, `LLM_MODEL` and
`LLM_API_KEY` in `services/llm/.env` switch the LLM service from the bundled model to a hosted, OpenAI-compatible
provider, and the same goes for `EMBEDDINGS_*`. See [docs/deploy.md](../docs/deploy.md).

## Discovery

Every paid route declares itself with the x402 Bazaar extension (`declareDiscoveryExtension`), so its 402 carries a
description, input and output schemas, and a `z402` extension with the billing unit.

The services list themselves in the facilitator's Bazaar; nothing probes them. While a service is ready it posts its
routes to the facilitator's `POST /discovery/resources` with its facilitator token, at start and then every 30 s, and
that heartbeat is how the catalog tells it is up. Each item is the route's own 402 offer: `PUBLIC_URL` and the route's
path as `resource`, the same `accepts`, the description, service name and tags, and the bazaar and `z402` extensions
with the method (and, for a route with parameters, its route template). A facilitator without a Bazaar yet answers
404; the service logs each change of outcome once, keeps serving and tries again at the next beat.

The facilitator serves the list at `GET /discovery/resources`, which the website proxies. The agent's `discover`
command reads the whole list with the stock Bazaar client and picks on its own machine, so nobody learns what it looks
for.

```bash
pnpm --filter @z402/agent discover --discovery http://localhost:3000 --intent "turn a web page into markdown"
```

## Adding a service

Build it on [`@z402/service-kit`](../packages/service-kit/src/service.ts): give `loadServiceEnv` the service's price,
describe the paid routes as data (`createPaidService`), put every check that can fail in the route's `prepare`
handlers so it runs before payment, apply side effects only in `onDelivered(res, { ok })`, and close the kit's service
when the process stops. The kit lists the routes in the facilitator's catalog by itself. Its `@z402/service-kit/testing`
stack makes real paid calls in tests, and with `catalog: true` it also checks the declarations against the catalog's
rules. The rules are in [the design spec](../docs/superpowers/specs/2026-10-27-z402-services-design.md), sections 3 and
4, and [the multi-provider design](../docs/superpowers/specs/2026-10-28-z402-multi-provider-design.md), section 4.4.

## Running a service anonymously

Listing needs no account, and a shielded-only `payTo` links nothing to the operator on-chain. What can still identify
the operator is the infrastructure around the service:

- a shielded-only unified address as `payTo`
- a new domain, unrelated to existing sites
- a separate host, paid privately
- no IPs, analytics IDs, emails or certificates shared with other sites
- a separate git identity for the service's repository
- an onion address only as a second endpoint, since stock x402 clients cannot reach `.onion` without a proxy
