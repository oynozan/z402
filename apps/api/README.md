# @z402/api

The merchant's paid HTTP API. It has one route, `GET /chunk`, which costs `Z402_PRICE_ZAT` zatoshi (500 by default) and is paid with the `prepaid-voucher` scheme through the stock x402 Express middleware. For each request the middleware has the facilitator verify the voucher in the `PAYMENT-SIGNATURE` header before the handler runs, and settle it after. An unpaid `HEAD /chunk` is refused the same way.

A paid call answers `{ "chunk": n, "cumulativeZat": "<voucher total>", "data": "chunk-n" }`, where n is the voucher's cumulative amount divided by the price. The handler keeps no state of its own. The wire format is in `docs/spec/protocol.md`, and the design in `docs/superpowers/specs/2026-10-27-z402-facilitator-design.md` (section 4.6).

The terms (window, credit ratio, credit cap, zero-conf expiry margin) are not set here. The API reads them from the facilitator's `/supported` at start and copies them into every 402.

## Run it

Start the facilitator first (`packages/facilitator/README.md`). The API loads `/supported` from it before it listens, and it exits 1 if the facilitator is down, refuses the token, offers no `prepaid-voucher` on this network, or advertises another payTo. In the shell where `Z402_FACILITATOR_TOKEN` was exported for the facilitator:

```bash
Z402_NETWORK=regtest \
Z402_FACILITATOR_URL=http://127.0.0.1:4022 \
Z402_MERCHANT_KEYS_FILE=.secrets/merchant-regtest.json \
pnpm --filter @z402/api start
```

The ready line goes to stdout and the logs to stderr:

```
api listening on http://127.0.0.1:4021 network=zcash:regtest
```

`Z402_MERCHANT_KEYS_FILE` is opened only for its `orchardOnlyAddress`, so the viewing key and the seed in it are never read by this process. Set `Z402_PAY_TO` instead to skip the file. Stop the API with SIGINT or SIGTERM, which closes the server and exits 0 (or exits 1 after 5 s if that hangs).

To run beside the demo (`scripts/demo.sh up` uses 4022 and 4021), give both processes other ports: `Z402_FACILITATOR_PORT=4098` for the facilitator, and `Z402_FACILITATOR_URL=http://127.0.0.1:4098 Z402_API_PORT=4097` here.

## Environment

An empty variable counts as unset. A path that is not absolute is relative to the repository root, whatever directory `pnpm` runs the package from. A problem is printed as one `api: ...` line on stderr that names the variable or option at fault, and the process exits 1.

| Variable | Default | Meaning |
| --- | --- | --- |
| `Z402_NETWORK` | `regtest` | `regtest`, `testnet` or `mainnet`. The facilitator must offer `prepaid-voucher` on it. |
| `Z402_FACILITATOR_URL` | none | Required. The `http://` or `https://` URL of the facilitator. There is no default on purpose, because an empty URL makes the x402 SDK send payments to x402.org. |
| `Z402_FACILITATOR_TOKEN` | none | The facilitator's bearer token. Nothing is sent when it is unset, and a facilitator that wants one then answers 401. |
| `Z402_PAY_TO` | `orchardOnlyAddress` of the keys file | The merchant's shielded-only unified address, which every 402 names as the place to send deposits (`uregtest1...`, `utest1...` or `u1...`, and the ZIP 316 revision 2 `zu...` forms). It must be the facilitator's `Z402_PAY_TO`. |
| `Z402_MERCHANT_KEYS_FILE` | none | The JSON that `zdecrypt keygen` prints, which `scripts/merchant-keygen.mjs` writes. Read only for `orchardOnlyAddress`, and only when `Z402_PAY_TO` is unset. |
| `Z402_PRICE_ZAT` | `500` | The price of one call in zatoshi, at least 1. It must match the facilitator's `Z402_PRICE_ZAT`. |
| `Z402_API_HOST` | `127.0.0.1` | The address to listen on. |
| `Z402_API_PORT` | `4021` | 0 to 65535, where 0 picks a free port. |

## Check the 402

```bash
curl -s -D - -o /dev/null http://127.0.0.1:4021/chunk
```

The answer is `HTTP/1.1 402 Payment Required` with an empty JSON body (`{}`). Everything is in the `PAYMENT-REQUIRED` header, which is base64 of a JSON object with `x402Version`, `error`, `resource` and `accepts`. Decode the one offer:

```bash
curl -s -D - -o /dev/null http://127.0.0.1:4021/chunk | tr -d '\r' \
  | awk -F': ' 'tolower($1) == "payment-required" { print $2 }' | base64 -d | jq '.accepts[0]'
```

On regtest with the default terms that is:

```json
{
  "scheme": "prepaid-voucher",
  "network": "zcash:regtest",
  "amount": "500",
  "asset": "ZEC",
  "payTo": "uregtest1...",
  "maxTimeoutSeconds": 60,
  "extra": {
    "windowZat": "100000",
    "creditRatioBps": 2500,
    "creditCapZat": "200000",
    "zeroConfMinExpiryBlocks": 20,
    "termsVersion": "..."
  }
}
```

`payTo` is the merchant's address, and `termsVersion` is an opaque id that the facilitator derives from the payTo, the price and the terms. A client that has paid before gets a corrective 402, whose `accepts[0].extra.session` carries its session's limits.

To pay it, run the agent (`scripts/demo.sh honest`, see `docs/demo.md`).

## Startup failures

Each one names the option to fix. The ones seen against a live facilitator:

| Message | Cause |
| --- | --- |
| `api: Z402_FACILITATOR_URL is required (...)` | no facilitator URL |
| `api: facilitatorUrl: cannot read /supported from the facilitator at <url> (fetch failed: connect ECONNREFUSED ...)` | the facilitator is not running at that URL |
| `api: facilitatorToken: the facilitator at <url> refused the request (... (401) ...)` | the token is missing or wrong |
| `api: payTo: the facilitator at <url> does not advertise <address> as its payTo` | the API and the facilitator have different merchants |
| `api: network: the facilitator at <url> offers prepaid-voucher on zcash:regtest, not on zcash:testnet` | `Z402_NETWORK` differs from the facilitator's |
| `api: port: cannot listen on 127.0.0.1:4021 (EADDRINUSE)` | the port is taken |

## Tests

```bash
pnpm --filter @z402/api test
pnpm --filter @z402/api typecheck
```

The tests start the real facilitator and the real API in one process, against a fake chain. The live checks against the Z3 stack are recorded in `docs/research/live-run.md`.
