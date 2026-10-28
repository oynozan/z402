# @z402/api

The merchant's paid HTTP API. It has one route, `GET /chunk`, which costs `Z402_PRICE_ZAT` zatoshi (500 by default) and is paid with the `prepaid-voucher` scheme through the stock x402 Express middleware. For each request the middleware has the facilitator verify the voucher in the `PAYMENT-SIGNATURE` header before the handler runs, and settle it after. An unpaid `HEAD /chunk` is refused the same way.

A paid call answers `{ "chunk": n, "cumulativeZat": "<voucher total>", "data": "chunk-n" }`, where n is the voucher's cumulative amount divided by the price. The handler keeps no state of its own. The wire format is in `docs/spec/protocol.md`, and the design in `docs/superpowers/specs/2026-10-27-z402-facilitator-design.md` and `docs/superpowers/specs/2026-10-28-z402-multi-provider-design.md` (section 4.6 of both).

The API is a provider of the facilitator: its API key picks the provider, and its `Z402_PAY_TO` and `Z402_PRICE_ZAT` are its own. The facilitator takes any price from 1 zat to its window for a route, so this API sets its price without telling the facilitator. The operator's API and a second provider's API can run side by side (see [Run as provider 2](#run-as-provider-2)).

Only GET is served. The route has no verb in its key, so a request of any method that carries no valid voucher gets the 402 first. A request that carries a valid voucher but uses another method (HEAD, OPTIONS, POST and so on) gets 405 with `Allow: GET`. The middleware never settles a status of 400 or more, so that request is not charged, and the same voucher still buys a GET.

The terms (window, credit ratio, credit cap, zero-conf expiry margin) are not set here. The API reads them from the facilitator's `/supported` at start and copies them into every 402.

## Run it

Start the facilitator first (`packages/facilitator/README.md`), because the API asks it who its key is, and then loads `/supported`, before it listens. The API exits 1 if the facilitator is down, does not take the token as a provider's API key, has that key for another payTo or network, or offers no `prepaid-voucher` on this network. It does not wait for a facilitator that is down.

The facilitator README creates the bearer token in `.data/manual-token`, which is the operator's API key, and runs the block clock in terminal 1 and the facilitator in terminal 2. The API is the third process that runs until stopped, so give it terminal 3, opened in the repository root. That terminal does not have the token, so it reads it from the file:

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

To run beside the demo (`scripts/demo.sh up` uses 4022 and 4021), start a second facilitator with its own port, its own ledger and its own providers directory, as `packages/facilitator/README.md` shows. It cannot use the demo's ledger or registry, because the demo facilitator holds their locks. Then give this API `Z402_FACILITATOR_URL=http://127.0.0.1:4098 Z402_API_PORT=4097`. This is for scratch runs on regtest only: two facilitators for the same merchant with separate ledgers can each credit the same deposit once, so the deposit is served twice. Never do this on mainnet.

## Run as provider 2

A second API can run beside the first on the same facilitator, as a provider of its own with its own address, API key and price. That is the live check of the multi-provider facilitator: the operator's API at 500 zat on port 4021, and provider 2 at 800 zat on port 4023.

Provider 2 needs an account of its own, so its keys go to files of its own. Run these from the repository root, with the facilitator up. `--out` takes an absolute path inside `.secrets/`, and the second command writes the view-only file that holds no seed:

```bash
node scripts/merchant-keygen.mjs --network regtest --out "$PWD/.secrets/provider2.json"
node scripts/merchant-keygen.mjs --view-only --from .secrets/provider2.json --out "$PWD/.secrets/provider2.view.json"
```

Then register the view-only keys with the running facilitator, which proves that the viewing key owns the address and issues the API key. The script saves the key in `--out` and prints only the provider id, the payTo and the path (`packages/facilitator/README.md`, Registering a provider):

```bash
node scripts/register-provider.mjs \
  --keys .secrets/provider2.view.json \
  --facilitator http://127.0.0.1:4022 \
  --out .secrets/provider2.apikey
```

Start the second API with that key, the same view-only file for its address, its own price and its own port, in a terminal of its own:

```bash
Z402_NETWORK=regtest \
Z402_FACILITATOR_URL=http://127.0.0.1:4022 \
Z402_FACILITATOR_TOKEN="$(cat .secrets/provider2.apikey)" \
Z402_MERCHANT_KEYS_FILE=.secrets/provider2.view.json \
Z402_PRICE_ZAT=800 \
Z402_API_PORT=4023 \
pnpm --filter @z402/api start
```

Its 402 now asks 800 zat and names provider 2's address, and the facilitator credits deposits and vouchers to provider 2 alone. It sets no `Z402_API_PUBLIC_URL`, so it declares nothing and the catalog lists it from the payments it settles (see [The Bazaar extension](#the-bazaar-extension)). If the key and the address do not belong together the API exits 1 naming `payTo` or `facilitatorToken`. Registering the same address again issues a new key and ends the old one, which is how a lost key is recovered. The facilitator holds provider 2's viewing key from the registration on, and it can see that account's incoming payments and cannot spend them.

## Environment

An empty variable counts as unset. A path that is not absolute is relative to the repository root, whatever directory `pnpm` runs the package from. A problem makes the process exit 1 with an `api: ...` line on stderr that names the variable or option at fault. A warning is an `api: warning: ...` line on stderr, and the start goes on. When the facilitator accepts the key and then fails to answer `/supported`, the x402 SDK first prints its own `Failed to fetch supported kinds from facilitator: ...` warning line.

| Variable | Default | Meaning |
| --- | --- | --- |
| `Z402_NETWORK` | `regtest` | `regtest`, `testnet` or `mainnet`. The facilitator must offer `prepaid-voucher` on it. |
| `Z402_FACILITATOR_URL` | none | Required. The `http://` or `https://` URL of the facilitator, without a username or password in it (the token has its own variable). There is no default on purpose, because an empty URL makes the x402 SDK send payments to x402.org. The token and every voucher travel on this link, so on testnet and mainnet `http://` is allowed only to a loopback host (`localhost`, `127.0.0.0/8` or `[::1]`). Regtest allows it to any host, such as another container of a compose network. |
| `Z402_FACILITATOR_TOKEN` | none | The API key of the provider this API is: the facilitator's `Z402_FACILITATOR_TOKEN` for the operator, or the key that `scripts/register-provider.mjs` issued for this payTo. Nothing is sent when it is unset, and a facilitator that wants one then answers 401. It must be one token of letters, digits and `-._~+/` that may end in any number of `=`, the same rule as the facilitator's, so the API refuses a token that no header could carry (an `=` anywhere but at the end, for one). |
| `Z402_PAY_TO` | `orchardOnlyAddress` of the keys file | The merchant's shielded-only unified address, which every 402 names as the place to send deposits (`uregtest1...`, `utest1...` or `u1...`, and the ZIP 316 revision 2 `zu...` forms). It must be the payTo that the facilitator has for the API key: its `Z402_PAY_TO` for the operator's token, and the registered payTo for a provider's key. Prefer it to the keys file. |
| `Z402_MERCHANT_KEYS_FILE` | none | The JSON that `zdecrypt keygen` prints, which `scripts/merchant-keygen.mjs` writes. Used only when `Z402_PAY_TO` is unset. The whole file is read and parsed, seed and viewing key included, and only its `orchardOnlyAddress` is used. A file with a top-level `seedHex` key is refused on mainnet with `Z402_MERCHANT_KEYS_FILE: <file> holds the spending seed; the API needs only Z402_PAY_TO`, and one with no `seedHex` but a top-level `ufvk` key with `Z402_MERCHANT_KEYS_FILE: <file> holds the full viewing key; the API needs only Z402_PAY_TO`. Elsewhere either text is a warning. The rule goes by those two exact key names only, so a secret stored under another name, in other letter case or nested deeper is not detected. The facilitator's keys file, `.secrets/merchant-<network>.view.json` from `node scripts/merchant-keygen.mjs --view-only --from <keys file>`, holds neither and gives no warning. |
| `Z402_PRICE_ZAT` | `500` | The price of one call in zatoshi, from 1 to the facilitator's window (`Z402_WINDOW_ZAT`, 100000 by default). The price is this API's own: the facilitator reads it from the requirements of each call and takes any amount in that range, so it does not have to match anything there. Nothing checks the window at start, and a price above it makes the facilitator refuse every paid call with `invalid_payment_requirements`. |
| `Z402_API_HOST` | `127.0.0.1` | The address to listen on. |
| `Z402_API_PORT` | `4021` | 0 to 65535, where 0 picks a free port. |
| `Z402_API_PUBLIC_URL` | none | Where this API is reached, such as `https://api.example.com`. It lists the demo route `GET /chunk` in the facilitator's Bazaar: the 402 then names `<this URL>/chunk` as its `resource`, and the API declares that route to the facilitator as soon as it listens and every 30 s after (see [The Bazaar extension](#the-bazaar-extension)). An absolute `http://` or `https://` URL with no username or password, no query and no fragment. A trailing `/` is dropped and a path is kept, for an API that a proxy serves under one. The facilitator never fetches it. Set it on an API whose provider also declares other routes (the operator's, beside the starter services), because a provider that has declared anything is listed by its declarations alone. Leave it unset for a bare API, which is listed from its first paid call. |

## Check the 402

```bash
curl -s -D - -o /dev/null http://127.0.0.1:4021/chunk
```

The answer is `HTTP/1.1 402 Payment Required` with an empty JSON body (`{}`). Everything is in the `PAYMENT-REQUIRED` header, which is base64 of a JSON object with `x402Version`, `error`, `resource`, `accepts` and `extensions`. Decode the one offer:

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

`payTo` is the merchant's address, and `termsVersion` is an opaque id that the facilitator derives from the terms alone, so every provider of a facilitator reads the same one. The `resource.url` of the 402 is the URL the request came to, or `<Z402_API_PUBLIC_URL>/chunk` when that is set. A client whose authenticated voucher is refused gets a corrective 402, whose `accepts[0].extra.session` carries its session's limits. A request without a `PAYMENT-SIGNATURE` header gets the plain 402. Next to `accepts` the 402 has `extensions.bazaar` (the next section).

To pay it, run the agent (`scripts/demo.sh honest`, see `docs/demo.md`).

## The Bazaar extension

`GET /chunk` declares itself to the x402 Bazaar, the facilitator's public catalog of paid resources. Its 402 carries `extensions.bazaar`, which is fixed JSON written out in `src/app.ts` and needs no package of its own:

- `info` says that the route is an `http` `GET`, and shows what a paid call answers: `{ "chunk": 1, "cumulativeZat": "<the price>", "data": "chunk-1" }`, where `cumulativeZat` is `Z402_PRICE_ZAT`.
- `schema` is the JSON Schema (draft 2020-12) of that `info`, in the shape that `declareDiscoveryExtension` of `@x402/extensions` builds for a GET with no input.

```bash
curl -s -D - -o /dev/null http://127.0.0.1:4021/chunk | tr -d '\r' \
  | awk -F': ' 'tolower($1) == "payment-required" { print $2 }' | base64 -d | jq '.extensions.bazaar.info'
```

A stock x402 client puts the `extensions` of the 402 it paid into its payment, and the facilitator lists a resource from the payments it settles, as long as the provider that was paid has never declared anything. So a bare API, one that sets no `Z402_API_PUBLIC_URL` and whose provider declares nothing (provider 2 above is one), is listed from its first paid call: `GET /discovery/resources` of the facilitator then lists `<this API>/chunk` with the provider's address, the price it was paid at and `paidCallsToday`, and nothing declares the route by hand. A payment without the extension lists nothing.

An API that runs as a provider that declares, such as the operator's next to the starter services, is not listed by its payments. They create no item for a provider that has declared (they only count on the items it declared), and the provider's first declaration removes the items they had made, except those it declares itself. That API is listed only through its own declaration, which `Z402_API_PUBLIC_URL` turns on (next section).

### Declaring the route

The operator's API is the same provider as the starter services, which declare their routes, so its paid calls never list `/chunk` (above), and the demo's paid route would be missing from the catalog. `Z402_API_PUBLIC_URL` opts the API in to declaring `/chunk` as they declare theirs.

Once the API listens, it sends `POST /discovery/resources` to the facilitator, with its token as the bearer when it has one, at once and then every 30 s after each declaration ended. The one item is read from the 402 of an unpaid in-process request to `/chunk`, so the catalog offers what the route asks for: the 402's `accepts` as they are, its `extensions` (the bazaar extension above), `mimeType`, and `resource` set to `<Z402_API_PUBLIC_URL>/chunk`. That is also the `resource` that a stock client echoes in its payments, so a settled payment counts on the declared item (`paidCallsToday`) and creates no other. The facilitator sets `lastSeen` on the item at each declaration, which is how a reader of the catalog tells that the route is up. Stopping the API stops the beat.

```bash
curl -s http://127.0.0.1:4022/discovery/resources | jq '.items[] | {resource, lastSeen, paidCallsToday}'
```

A failed declaration never stops the API, and the next beat tries again. A line goes to stderr only when the outcome changes, so a facilitator that stays down is reported once and not every 30 s. No line shows the token, and the facilitator's own words are cut to one line.

| Line (after `api: discovery: `) | Cause |
| --- | --- |
| `1 paid route listed by the facilitator at <origin>, declared again every 30 s` | the facilitator took the declaration. Printed at the first one and again after any failure |
| `the facilitator at <origin> refused the declaration (400, item 0: ...); trying again every 30 s` | the catalog refused the item, in the words that follow. A `Z402_PRICE_ZAT` above the facilitator's window is one cause, since nothing else checks it at start |
| `Z402_FACILITATOR_TOKEN: the facilitator at <origin> refused the declaration (401); ...` | the key was rotated out or is no longer taken. A 403 reads the same |
| `the facilitator at <origin> has no Bazaar to declare to (404), so the route is not listed; ...` | a facilitator without the discovery routes |
| `the facilitator at <origin> answered the declaration with 503; ...` | any other status, a redirect included |
| `cannot reach the facilitator at <origin> (ECONNREFUSED); ...` | the facilitator is down or restarting. `no answer within 10 s` is one that takes the connection and never answers |

## Startup failures

Each one names the option to fix, and none quotes a token. The first three rows are checks that run before the facilitator is contacted, so a password in the URL is refused before any message could print it. Then the API asks the facilitator `GET /providers/me` with its token (`checkProvider` of `@z402/server`), which must answer with this API's payTo and network. That check comes before `/supported` is read, it fails the start on any problem, and it does not wait for a facilitator that is down. Its outcomes are the rows from `cannot reach` to `serves` below:

| Message | Cause |
| --- | --- |
| `api: facilitatorUrl: must not carry credentials (use facilitatorToken)` | the URL has a username or a password |
| `api: facilitatorToken: must be one token of letters, digits and -._~+/` | the token has a space, a control character or another character |
| `api: facilitatorUrl: plaintext http:// is allowed only to a loopback host on zcash:testnet; use https://` | an `http://` URL to a host that is not loopback, on testnet or mainnet |
| `api: Z402_MERCHANT_KEYS_FILE: <file> holds the spending seed; the API needs only Z402_PAY_TO` | a mainnet keys file with a `seedHex` key (set `Z402_PAY_TO` instead); `holds the full viewing key` for one with only a `ufvk` key |
| `api: Z402_FACILITATOR_URL is required (...)` | no facilitator URL |
| `api: Z402_API_PUBLIC_URL: expected an http:// or https:// URL` | the value is not an absolute `http(s)` URL, or has whitespace or a backslash in it. `must not carry credentials`, `must not have a query or a fragment` and `with /chunk it makes a resource URL over 2048 characters` are its other refusals, and none quotes the value. All of them come before the facilitator is contacted |
| `api: facilitatorUrl: cannot reach the facilitator at <origin> (ECONNREFUSED)` | the facilitator is not running at that URL. `did not answer /providers/me within 5000 ms` is one that takes the connection and never answers, and `answered /providers/me with 503` one that is starting or failing (any 5xx, and 408 and 429) |
| `api: facilitatorUrl: the facilitator at <origin> has no /providers/me (404), so it is not a facilitator of the multi-provider rail` | an older facilitator, or a URL that is not one. `answered /providers/me with a body that is not {providerId, network, payTo}` is a 200 from something else |
| `api: facilitatorToken: the facilitator at <origin> refused the API key (401)` | the key is wrong, rotated out, or not one of this facilitator's. A 403 reads the same |
| `api: facilitatorToken: the facilitator at <origin> wants an API key (401) and none is set` | `Z402_FACILITATOR_TOKEN` is unset |
| `api: payTo: the facilitator at <origin> has this API key for another payTo than <address>` | the key and `Z402_PAY_TO` belong to different providers |
| `api: payTo: the facilitator at <origin> serves zcash:testnet, not zcash:regtest` | `Z402_NETWORK` differs from the facilitator's |
| `api: facilitatorUrl: the facilitator at <url> advertises terms this API cannot use (...)` | the terms in its `/supported` are not a set of terms |
| `api: network: the facilitator at <url> offers prepaid-voucher on zcash:regtest, not on zcash:testnet` | its `/supported` offers the scheme on another network only |
| `api: port: cannot listen on 127.0.0.1:4021 (EADDRINUSE)` | the port is taken |
| `api: port: cannot listen on 127.0.0.1:80 (EACCES)` | the port is forbidden to this user (a port below 1024 without root, for one) |

## Tests

```bash
pnpm --filter @z402/api test
pnpm --filter @z402/api typecheck
```

Most tests start the real facilitator and the real API inside the test process, against a fake chain. The declaration tests list through the real facilitator's catalog, and also use a stub facilitator that counts what it is sent and answers each declaration as told. `main.test.ts` runs `src/main.ts` as a child process, the way `pnpm --filter @z402/api start` does, against a facilitator in the test process. The live checks against the Z3 stack are recorded in `docs/research/live-run.md`.
