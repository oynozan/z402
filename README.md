# z402

**Private pay-per-call for AI agents, on shielded Zcash.**

z402 is an [x402](https://www.x402.org) v2 payment rail on shielded Zcash. An agent pays an API per call: one shielded deposit per provider, then an Ed25519-signed cumulative voucher on each call, so nothing goes on chain per call. A hosted facilitator serves many providers. Each sets its own price in zatoshi, is paid to its own shielded address, and is listed in the facilitator's x402 Bazaar catalog. A stock x402 client registers one more scheme.

**Website and docs:** [z402.net](https://z402.net) · [z402.net/docs](https://z402.net/docs)

## How it works

1. The agent makes one shielded deposit to the provider's address. A ZIP 302 memo ties the deposit to its session.
2. Every call carries a signed voucher that raises the session's running total. The facilitator checks it, and the API answers.
3. The first call is served before the deposit confirms. After a confirmation, a capped credit line opens, so an agent that stops paying is refused at a known limit.
4. The provider registers once with a view-only key (UIVK). With it, the facilitator can read the provider's incoming payments, but never spend them.

The chain sees only ciphertext and the fee: deposits have no transparent inputs or outputs. The wire contract is [docs/spec/protocol.md](docs/spec/protocol.md).

## Run it locally

The local stack needs Docker Engine 25+ with Compose v2.24+, 4 GB of memory and about 8 GB of disk.

```bash
docker compose up -d
docker compose ps
```

This starts a private Zcash regtest chain (Zebra, Zaino, Zallet), a block clock, the facilitator, a demo paid API, the starter services and the website. The walkthrough is the [quickstart](https://z402.net/docs/quickstart). The terminal demo, with one agent paying two providers, is in [docs/demo.md](docs/demo.md).

## Packages

| Package | What it is |
|---|---|
| [`@z402-net/client`](packages/client) | The paying side: an x402 client scheme that makes shielded deposits and signs vouchers for an agent |
| [`@z402-net/lightwalletd`](packages/lightwalletd) | A gRPC client for lightwalletd-compatible nodes, used as the client's deposit-status source |
| [`@z402-net/server`](packages/server) | The provider side, for x402 resource servers: the prepaid-voucher scheme and the start-up check |
| [`@z402-net/service-kit`](packages/service-kit) | Build a paid HTTP service: Express middleware, start-up checks and the Bazaar listing |
| [`@z402-net/protocol`](packages/protocol) | The wire format: payment terms, voucher signatures, deposit memos and the credit rules |

For an agent:

```bash
npm install @z402-net/client @z402-net/lightwalletd @x402/core@2.28.0
```

## Repository

- **`packages/`:** the SDK above, plus the facilitator (`packages/facilitator`) and the test kit.
- **`apps/`:** the website and docs (`apps/web`), the demo API, the demo agent, and the end-to-end and smoke tests.
- **`services/`:** the starter paid services: LLM, embeddings, URL to markdown, and an encrypted drop box.
- **`crates/zdecrypt`:** decrypts deposits with a viewing key (Rust).
- **`docs/`:** the protocol, the runbooks and the design records.

## Status

z402 runs end to end on a local Zcash regtest network, and it is configurable for testnet. Mainnet is not ready for real money. See [Run the facilitator](https://z402.net/docs/guides/run-a-facilitator) for what is still open.

## License

[MIT](LICENSE). Third-party files keep their own licences.
