# @z402/api

The merchant's paid HTTP API. It has one route, `GET /chunk`, which costs `Z402_PRICE_ZAT` zatoshi (500 by default) and is paid with the `prepaid-voucher` scheme through the stock x402 Express middleware. For each request the middleware has the facilitator verify the voucher in the `PAYMENT-SIGNATURE` header before the handler runs, and settle it after. An unpaid `HEAD /chunk` is refused the same way.

A paid call answers `{ "chunk": n, "cumulativeZat": "<voucher total>", "data": "chunk-n" }`, where n is the voucher's cumulative amount divided by the price. The handler keeps no state of its own. The wire format is in `docs/spec/protocol.md`, and the design in `docs/superpowers/specs/2026-10-27-z402-facilitator-design.md` (section 4.6).

Only GET is served. The route has no verb in its key, so a request of any method that carries no valid voucher gets the 402 first. A request that carries a valid voucher but uses another method (HEAD, OPTIONS, POST and so on) gets 405 with `Allow: GET`. The middleware never settles a status of 400 or more, so that request is not charged, and the same voucher still buys a GET.

The terms (window, credit ratio, credit cap, zero-conf expiry margin) are not set here. The API reads them from the facilitator's `/supported` at start and copies them into every 402.

## Run it

Start the facilitator first (`packages/facilitator/README.md`), because the API loads `/supported` from it before it listens. The API exits 1 if the facilitator is down, refuses the token, offers no `prepaid-voucher` on this network, or advertises another payTo.

The facilitator README creates the bearer token in `.data/manual-token`, and runs the block clock in terminal 1 and the facilitator in terminal 2. The API is the third process that runs until stopped, so give it terminal 3, opened in the repository root. That terminal does not have the token, so it reads it from the file:

```bash
export Z402_FACILITATOR_TOKEN="$(cat .data/manual-token)"
Z402_NETWORK=regtest \
Z402_FACILITATOR_URL=http://127.0.0.1:4022 \
Z402_PAY_TO="$(jq -r .orchardOnlyAddress .secrets/merchant-regtest.view.json)" \
pnpm --filter @z402/api start
```

The ready line goes to stdout and the logs to stderr:

```
api listening on http://127.0.0.1:4021 network=zcash:regtest
```

`Z402_PAY_TO` is the merchant's public address, so the shell above reads it from `.secrets/merchant-regtest.view.json` and the API process never opens that file. The facilitator README makes that file with `node scripts/merchant-keygen.mjs --view-only --from .secrets/merchant-regtest.json`. It holds only `network`, `uivk` and `orchardOnlyAddress`, and it is the keys file to give the facilitator. The alternative is `Z402_MERCHANT_KEYS_FILE=.secrets/merchant-regtest.view.json`. The API then reads and parses the whole file, viewing key included, and uses only its `orchardOnlyAddress`. That file holds no seed, so the API prints no warning. Given the full `.secrets/merchant-regtest.json` instead, which holds the spending seed, the API prints `api: warning: Z402_MERCHANT_KEYS_FILE: <file> holds the spending seed; the API needs only Z402_PAY_TO` and goes on, and on mainnet it refuses the file with the same text. Use `Z402_PAY_TO` wherever the API should not be able to read the viewing key, which is every deployment but a local regtest one, and keep the keys file out of that process's reach (another OS user or another host).

Stop the API with SIGINT or SIGTERM, which closes the server and exits 0 (or exits 1 after 5 s if that hangs).

To run beside the demo (`scripts/demo.sh up` uses 4022 and 4021), start a second facilitator with its own port and its own ledger, as `packages/facilitator/README.md` shows. It cannot use the demo's ledger, because the demo facilitator holds that ledger's lock. Then give this API `Z402_FACILITATOR_URL=http://127.0.0.1:4098 Z402_API_PORT=4097`. This is for scratch runs on regtest only: two facilitators for the same merchant with separate ledgers can each credit the same deposit once, so the deposit is served twice. Never do this on mainnet.

## Environment

An empty variable counts as unset. A path that is not absolute is relative to the repository root, whatever directory `pnpm` runs the package from. A problem makes the process exit 1 with an `api: ...` line on stderr that names the variable or option at fault. A warning is an `api: warning: ...` line on stderr, and the start goes on. When the facilitator cannot be reached or refuses the token, the x402 SDK first prints its own `Failed to fetch supported kinds from facilitator: ...` warning line.

| Variable | Default | Meaning |
| --- | --- | --- |
| `Z402_NETWORK` | `regtest` | `regtest`, `testnet` or `mainnet`. The facilitator must offer `prepaid-voucher` on it. |
| `Z402_FACILITATOR_URL` | none | Required. The `http://` or `https://` URL of the facilitator, without a username or password in it (the token has its own variable). There is no default on purpose, because an empty URL makes the x402 SDK send payments to x402.org. The token and every voucher travel on this link, so on testnet and mainnet `http://` is allowed only to a loopback host (`localhost`, `127.0.0.0/8` or `[::1]`). Regtest allows it to any host, such as another container of a compose network. |
| `Z402_FACILITATOR_TOKEN` | none | The facilitator's bearer token. Nothing is sent when it is unset, and a facilitator that wants one then answers 401. It must be one token of letters, digits and `-._~+/` that may end in any number of `=`, the same rule as the facilitator's, so the API refuses a token that no header could carry (an `=` anywhere but at the end, for one). |
| `Z402_PAY_TO` | `orchardOnlyAddress` of the keys file | The merchant's shielded-only unified address, which every 402 names as the place to send deposits (`uregtest1...`, `utest1...` or `u1...`, and the ZIP 316 revision 2 `zu...` forms). It must be the facilitator's `Z402_PAY_TO`. Prefer it to the keys file. |
| `Z402_MERCHANT_KEYS_FILE` | none | The JSON that `zdecrypt keygen` prints, which `scripts/merchant-keygen.mjs` writes. Used only when `Z402_PAY_TO` is unset. The whole file is read and parsed, seed and viewing key included, and only its `orchardOnlyAddress` is used. A file that holds `seedHex` (the spending seed) or `ufvk` (the full viewing key) is refused on mainnet and gives a warning elsewhere. The facilitator's keys file, `.secrets/merchant-<network>.view.json` from `node scripts/merchant-keygen.mjs --view-only --from <keys file>`, holds neither and gives no warning. |
| `Z402_PRICE_ZAT` | `500` | The price of one call in zatoshi, at least 1. It must equal the facilitator's `Z402_PRICE_ZAT`, which nothing checks at start: with different prices the API starts, and then every paid call is refused with `invalid_payment_requirements`. |
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

`payTo` is the merchant's address, and `termsVersion` is an opaque id that the facilitator derives from the payTo, the price and the terms. A client whose authenticated voucher is refused gets a corrective 402, whose `accepts[0].extra.session` carries its session's limits. A request without a `PAYMENT-SIGNATURE` header gets the plain 402.

To pay it, run the agent (`scripts/demo.sh honest`, see `docs/demo.md`).

## Startup failures

Each one names the option to fix, and none quotes a token. The first three rows are checks that run before the facilitator is contacted, so a password in the URL is refused before any message could print it:

| Message | Cause |
| --- | --- |
| `api: facilitatorUrl: must not carry credentials (use facilitatorToken)` | the URL has a username or a password |
| `api: facilitatorToken: must be one token of letters, digits and -._~+/` | the token has a space, a control character or another character |
| `api: facilitatorUrl: plaintext http:// is allowed only to a loopback host on zcash:testnet; use https://` | an `http://` URL to a host that is not loopback, on testnet or mainnet |
| `api: Z402_MERCHANT_KEYS_FILE: <file> holds the spending seed; the API needs only Z402_PAY_TO` | a mainnet keys file that holds the seed (set `Z402_PAY_TO` instead) |
| `api: Z402_FACILITATOR_URL is required (...)` | no facilitator URL |
| `api: facilitatorUrl: cannot read /supported from the facilitator at <url> (fetch failed: connect ECONNREFUSED ...)` | the facilitator is not running at that URL |
| `api: facilitatorToken: the facilitator at <url> refused the request (... (401) ...)` | the token is missing or wrong |
| `api: payTo: the facilitator at <url> does not advertise <address> as its payTo` | the API and the facilitator have different merchants |
| `api: network: the facilitator at <url> offers prepaid-voucher on zcash:regtest, not on zcash:testnet` | `Z402_NETWORK` differs from the facilitator's |
| `api: port: cannot listen on 127.0.0.1:4021 (EADDRINUSE)` | the port is taken |
| `api: port: cannot listen on 127.0.0.1:80 (EACCES)` | the port is forbidden to this user (a port below 1024 without root, for one) |

## Tests

```bash
pnpm --filter @z402/api test
pnpm --filter @z402/api typecheck
```

Most tests start the real facilitator and the real API inside the test process, against a fake chain. `main.test.ts` runs `src/main.ts` as a child process, the way `pnpm --filter @z402/api start` does, against a facilitator in the test process. The live checks against the Z3 stack are recorded in `docs/research/live-run.md`.
