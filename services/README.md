# Starter services

Four paid HTTP services that agents find through discovery and pay with `prepaid-voucher` (one shielded deposit, then
a signed voucher per call). They are reference services operated by the project, not independent providers.

| Service | Port | One paid call buys | Directory |
| --- | --- | --- | --- |
| LLM inference | 4031 | one output chunk (about 32 tokens) | [`llm`](llm/README.md) |
| URL to markdown | 4032 | one page | [`markdown`](markdown/README.md) |
| Text embeddings | 4033 | about 1,000 tokens | [`embeddings`](embeddings/README.md) |
| Encrypted drop box | 4034 | 10 blocks of storage | [`dropbox`](dropbox/README.md) |

Every call costs `Z402_PRICE_ZAT` (500 zat), which must equal the facilitator's: the facilitator accepts one price
today. A refused call is never charged, because each service refuses everything it can before the agent sends a
voucher.

## Settings and keys

Each service reads its own `services/<name>/.env`: copy its `.env.example` and uncomment only what you change (its
provider's API key, limits, `PUBLIC_URL`). A variable already set in the environment wins over the file. Under Docker,
compose reads the same file after its defaults in `docker/env/<name>.env`, so `LLM_BASE_URL`, `LLM_MODEL` and
`LLM_API_KEY` in `services/llm/.env` switch the LLM service from the bundled model to a hosted, OpenAI-compatible
provider, and the same goes for `EMBEDDINGS_*`. See [docs/deploy.md](../docs/deploy.md).

## Discovery

Every paid route declares itself with the x402 Bazaar extension (`declareDiscoveryExtension`), so its 402 carries a
description, input and output schemas, and a `z402` extension with the billing unit. `apps/discovery` probes the
services and serves the list at `GET /discovery/resources`, which the website proxies. An agent reads it with the
stock Bazaar client and picks on its own machine: there is no search endpoint, so nobody learns what it looks for.

```bash
pnpm --filter @z402/agent discover --discovery http://localhost:3000 --intent "turn a web page into markdown"
```

## Adding a service

Build it on [`@z402/service-kit`](../packages/service-kit/src/service.ts): describe the paid routes as data
(`createPaidService`), put every check that can fail in the route's `prepare` handlers so it runs before payment,
apply side effects only in `onDelivered(res, { ok })`, and add its origin to `DISCOVERY_SERVICES`. The kit's
`@z402/service-kit/testing` stack makes real paid calls in tests. The rules are in
[the design spec](../docs/superpowers/specs/2026-10-27-z402-services-design.md), sections 3 and 4.

## Running a service anonymously

Listing needs no account, and a shielded-only `payTo` links nothing to the operator on-chain. What can still identify
the operator is the infrastructure around the service:

- a shielded-only unified address as `payTo`
- a new domain, unrelated to existing sites
- a separate host, paid privately
- no IPs, analytics IDs, emails or certificates shared with other sites
- a separate git identity for the service's repository
- an onion address only as a second endpoint, since stock x402 clients cannot reach `.onion` without a proxy
