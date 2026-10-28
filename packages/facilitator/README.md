# @z402/facilitator

The x402 facilitator for the `prepaid-voucher` scheme on Zcash, shared by many providers. A provider is a resource server with its own `payTo`, its own viewing key and its own price for each route, and it connects with an API key. The facilitator answers `GET /supported`, `POST /verify` and `POST /settle` for all of them, finds each deposit through a lightwalletd-compatible endpoint, reads it with the viewing key of the provider it pays (`crates/zdecrypt`), keeps one ledger of sessions and deposits per provider, and hosts the x402 Bazaar, the public catalog of every provider's paid resources. We run one provider ourselves, the operator (see [Providers](#providers)). The design is in `docs/superpowers/specs/2026-10-28-z402-multi-provider-design.md`, which builds on `docs/superpowers/specs/2026-10-27-z402-facilitator-design.md`, and the wire format is in `docs/spec/protocol.md`.

Every `Z402_*` variable of the facilitator is listed in [Environment](#environment) below, and the API's are in `apps/api/README.md`.

## Run it against the Z3 regtest stack

Run these from the repository root. Docker, Node 24.2 or later (the Z3 helpers need it), pnpm, `jq`, `curl`, `perl`, `openssl` and a Rust toolchain are needed.

Set up once, in any terminal:

```bash
pnpm install
pnpm --filter @z402/facilitator build:native          # builds crates/zdecrypt
node scripts/merchant-keygen.mjs --network regtest    # .secrets/merchant-regtest.json, prints the payTo
node scripts/merchant-keygen.mjs --view-only --from .secrets/merchant-regtest.json   # .secrets/merchant-regtest.view.json
bash infra/z3/up.sh                                   # Zebra, Zallet and Zaino
mkdir -p .data && (umask 077; rm -f .data/manual-token; openssl rand -hex 16 > .data/manual-token)
```

Each `merchant-keygen.mjs` line refuses to replace a file that exists, so on a machine that has it the line exits 1 and changes nothing. The first line writes the account with its seed. The second writes the facilitator's keys file, which holds only `network`, `uivk` and `orchardOnlyAddress`, so the facilitator never sees the seed (see [Merchant keys](#merchant-keys)). `up.sh` publishes every port on `127.0.0.1`, with one gap: Zebra listens on every interface for about a minute on the first run and again after `down.sh --wipe`, while the wallet initialises, and if that initialisation fails part-way it stays on every interface until `bash infra/z3/down.sh` runs (`infra/z3/README.md`, section Endpoints). Add `bash infra/z3/fund-agent.sh` if an agent will pay deposits. `infra/z3/README.md` has the stack's commands and ports.

The last line writes the bearer token to `.data/manual-token`, which only you can read (`.data/` is gitignored). The file is created under `umask 077`, so it has mode 0600 from the moment it exists and the token is never in a file that others can read, not even for an instant. Do not write the file first and `chmod` it afterwards. The `rm -f` comes first because `umask` applies only to a file that is created, and `>` onto an existing file keeps that file's mode and its readers. The facilitator and the API both read the token from that file, so run the line once. A second run writes a new token that the running processes do not have.

The block clock, the facilitator and the API each run until you stop them, so each gets its own terminal, opened in the repository root.

Terminal 1, the block clock (nothing confirms or expires unless blocks are mined):

```bash
node infra/z3/clock.mjs run --every 25
```

Terminal 2, the facilitator:

```bash
export Z402_FACILITATOR_TOKEN="$(cat .data/manual-token)"
Z402_NETWORK=regtest \
Z402_MERCHANT_KEYS_FILE=.secrets/merchant-regtest.view.json \
pnpm --filter @z402/facilitator start
```

Wait for the ready line on stdout, which names the full network id and the operator's payTo, and is followed by a line that counts the registered providers (the operator is not one of them):

```
facilitator listening on http://127.0.0.1:4022 network=zcash:regtest payTo=uregtest1...
facilitator providers=0
```

Everything else the process prints goes to stderr: one line per request (`GET /supported 200`, or `POST /verify 200 <providerId>` for a request that carried a provider's key) and the diagnostics. Neither stream carries a key, the token or a viewing key, and a request line never has a query string. The keys file of this example holds no seed, so the facilitator prints no warning about it. It does print `facilitator: warning: POST /providers is open to anyone: set Z402_REGISTRATION_TOKEN to require a token`, since this run sets no registration token, which is fine on a regtest that only this machine reaches. Pointed at the full `.secrets/merchant-regtest.json` instead, it first prints a `facilitator: warning: Z402_MERCHANT_KEYS_FILE: ...` line on stderr that says the file holds the spending seed. On regtest that is tolerated, and mainnet refuses such a file. `scripts/demo.sh up` passes the full file for now, so the log of its facilitator has that warning.

Terminal 3, the API (`apps/api/README.md`), which reads the same token from the same file.

Check the facilitator from a fourth terminal, opened in the repository root, since terminals 1 to 3 are busy and `cat .data/manual-token` needs the root. `GET /supported` is public and answers the rail's terms, with no payTo:

```bash
curl -s http://127.0.0.1:4022/supported | jq
```

`GET /providers/me` needs the token, which is the operator's API key, and answers the operator's providerId, network and payTo. The token goes in on stdin, so it never shows in `ps`, and `-q` keeps a `~/.curlrc` from printing the header. Without the token the answer is 401:

```bash
curl -q -s -K - http://127.0.0.1:4022/providers/me <<<"header = \"authorization: Bearer $(cat .data/manual-token)\"" | jq
```

Stop each process with SIGINT or SIGTERM (Ctrl-C). The facilitator closes the server and exits 0, or exits 1 after 5 s if that hangs. `scripts/demo.sh up` starts the stack, the facilitator and the API for the demo on ports 4022 and 4021, and keeps their logs and the token in `.data/demo/`.

To run a second facilitator next to the demo, give it its own port, its own ledger and its own providers directory. It cannot share the demo's ledger or registry anyway: the demo facilitator holds their locks, and a second one on the same file stops with `ledgerPath: ... is in use by pid ...` or `providersDir: ... is in use by pid ...` (see [The ledger and its lock](#the-ledger-and-its-lock)). This is for scratch runs on regtest only. Two facilitators for the same merchant with separate ledgers know nothing of each other's credits, so each can credit the same deposit once, and the deposit is served twice. Never do this on mainnet. In a terminal of its own:

```bash
export Z402_FACILITATOR_TOKEN="$(cat .data/manual-token)"
Z402_NETWORK=regtest \
Z402_MERCHANT_KEYS_FILE=.secrets/merchant-regtest.view.json \
Z402_FACILITATOR_PORT=4098 \
Z402_LEDGER=.data/scratch-ledger.jsonl \
Z402_PROVIDERS_DIR=.data/scratch-providers \
pnpm --filter @z402/facilitator start
```

## Environment

An empty variable counts as unset. A path that is not absolute is relative to the repository root, whatever directory `pnpm` runs the package from. A problem is printed as one `facilitator: ...` line on stderr, and the process exits 1. A setting that works but puts something at risk is printed as a `facilitator: warning: ...` line on stderr before the start-up checks, and the start goes on. Those are the five warnings of the configuration: a keys file that holds the seed or the full viewing key (off mainnet), a mainnet `Z402_LWD_URL` host that is not loopback, a `Z402_FACILITATOR_HOST` that is not loopback, a `Z402_PRICE_ZAT` that is set, and a `POST /providers` that anyone may call, or that mainnet has switched off (see `Z402_REGISTRATION_TOKEN` below). Two warnings print later, during the checks and with no `facilitator:` prefix: `warning: Z402_EXPECTED_BRANCH_ID is not set, so the consensus branch of lightwalletd is not checked` (mainnet, check 4), and `ledger <ledger>: dropped a truncated last line (line <n>)` (check 5). The line names the variable at fault, the start-up check that failed, or, for the ledger, the port and the host, the option (`ledgerPath:`, `port:` and `host:`) rather than the variable. No message quotes the keys file, the viewing key or the token.

| Variable | Default | Meaning |
| --- | --- | --- |
| `Z402_NETWORK` | `regtest` | `regtest`, `testnet` or `mainnet`. Picks the defaults of `Z402_LWD_URL` and `Z402_EXPECTED_BRANCH_ID`, and the address and key prefixes that are accepted. |
| `Z402_MERCHANT_KEYS_FILE` | none | The JSON that `zdecrypt keygen` prints, which `scripts/merchant-keygen.mjs` writes. The whole file is read and parsed, but only `orchardOnlyAddress` and `uivk` are used, and only for the two variables below that are not set. A file with a top-level `seedHex` key, as that one has, is refused on mainnet with `Z402_MERCHANT_KEYS_FILE: <file> holds the spending seed; give the facilitator only uivk and orchardOnlyAddress, or set Z402_UIVK and Z402_PAY_TO`. A file with no `seedHex` but a top-level `ufvk` key gets the same text with `holds the full viewing key` in place of `holds the spending seed`. Elsewhere either text is a warning. The rule goes by those two exact key names only, so a secret stored under another name, in other letter case or nested deeper is not detected; the files `scripts/merchant-keygen.mjs` writes use exactly those names. Set those two variables instead, or give the facilitator a file that holds only `uivk` and `orchardOnlyAddress`, and keep the seed out of that process's reach (another OS user or another host). `node scripts/merchant-keygen.mjs --view-only --from <keys file>` writes exactly such a file, `.secrets/merchant-<network>.view.json`, and it is the keys file to give the facilitator (see [Merchant keys](#merchant-keys)). |
| `Z402_PAY_TO` | `orchardOnlyAddress` of the keys file | The operator's shielded-only unified address, where the operator's deposits go (`uregtest1...`, `utest1...` or `u1...`, and the ZIP 316 revision 2 `zu...` forms). Required unless the keys file has it. The operator's API needs the same address, and every other provider has an address of its own. At most 1024 characters, else `Z402_PAY_TO: must be at most 1024 characters` (a real address has under 200, and ZIP 316 lets an address carry any number of receivers of unknown type, which the address pattern of `@z402/protocol` does not bound). |
| `Z402_UIVK` | `uivk` of the keys file | The operator's unified incoming viewing key (`uivkregtest1...`, `uivktest1...` or `uivk1...`, and the revision 2 `uvi...` forms). Required unless the keys file has it. It can see deposits and cannot spend. |
| `Z402_FACILITATOR_TOKEN` | none | Required. The operator's API key: the bearer token its resource servers present, as `Authorization: Bearer <token>` (the scheme in any case, one or more spaces after it). It must be one token of letters, digits and `-._~+/`, which may end in any number of `=` (an RFC 6750 b64token), so `openssl rand -hex 16` and `openssl rand -base64 24` both pass. An `=` anywhere but at the end is refused. Anything else is refused at start with `Z402_FACILITATOR_TOKEN: must be one token of letters, digits and -._~+/ (no spaces or control characters)`, since no Authorization header could carry it. The operator's API needs the same token. A registered provider presents the key it was issued instead. |
| `Z402_LWD_URL` | regtest `http://127.0.0.1:28137`, testnet `https://testnet.zec.rocks:443`, mainnet none | A lightwalletd-compatible gRPC endpoint. `http://` is plaintext and `https://` is TLS. On testnet and mainnet `http://` is allowed only to a loopback host (`localhost`, `127.0.0.0/8` or `[::1]`), and any other host is refused with `Z402_LWD_URL: plaintext http:// is allowed only to a loopback host on <network>; use https://`. Regtest allows it to any host, such as another container of a compose network. The loopback test reads the host as `new URL()` parses it, so `127.1` and `[0:0:0:0:0:0:0:1]` count as loopback, while `localhost.` and `[::ffff:127.0.0.1]` do not. A username or password in the URL is ignored: it is neither sent nor printed. Required on mainnet, where no public default is trusted. On mainnet a host that is not loopback gives the warning `Z402_LWD_URL points at <host>: the facilitator trusts it for whether a deposit exists and how deep it is mined; for real money use a node you operate`. |
| `Z402_EXPECTED_BRANCH_ID` | regtest `37a5165b`, testnet `77190ad9`, mainnet none | Eight hex digits. Start-up compares them with the endpoint's `consensusBranchId`. Left unset on mainnet, that check is skipped with a warning, and the network check still runs. |
| `Z402_ZDECRYPT_BIN` | `crates/zdecrypt/target/release/zdecrypt` | The decryptor. `pnpm --filter @z402/facilitator build:native` builds the default. |
| `Z402_LEDGER` | `.data/facilitator-ledger.<network>.jsonl` | The operator's append-only JSON Lines ledger, replayed at start. One facilitator at a time writes it, through `<ledger>.lock` (see [The ledger and its lock](#the-ledger-and-its-lock)). |
| `Z402_PROVIDERS_DIR` | `.data/providers.<network>` | Where the registered providers live: their registry, their ledgers and the Bazaar's catalog (see [The providers directory](#the-providers-directory)). It is made with mode 0700 if it does not exist. A container needs it on a volume that the process can write. |
| `Z402_MAX_PROVIDERS` | `32` | How many providers can register, the operator not counted. A whole number from 0 to 1000, else `Z402_MAX_PROVIDERS: expected a whole number from 0 to 1000`. With 0 no new provider can register (`provider_limit`), and a registered one can still rotate its key. Registration with 0 is not open, so the warnings about it below do not apply. |
| `Z402_REGISTRATION_TOKEN` | none | The bearer token that `POST /providers` needs, at least 32 characters, for example `openssl rand -hex 32`. A shorter one is refused at start with `Z402_REGISTRATION_TOKEN: must be at least 32 characters, for example the output of openssl rand -hex 32`, and the same token rule as `Z402_FACILITATOR_TOKEN` applies first (`Z402_REGISTRATION_TOKEN: must be one token of letters, digits and -._~+/ (no spaces or control characters)`). An empty variable counts as unset, and then registration is open to anyone who can reach the port, unless this is mainnet (next row). Open registration prints `facilitator: warning: POST /providers is open to anyone: set Z402_REGISTRATION_TOKEN to require a token` at every start, since anyone can then take the provider slots and list resources on the site. The operator's token and a provider's key are not registration tokens. |
| `Z402_REGISTRATION_OPEN` | unset | `1` or unset (an empty variable counts as unset), else `Z402_REGISTRATION_OPEN: expected 1, or leave it unset`. Only mainnet looks at it. On regtest and testnet registration with no token is open (with the warning above). On mainnet it is off unless this is `1`: with no token and no `Z402_REGISTRATION_OPEN=1` the facilitator still starts, serves the operator and the providers already registered, answers `POST /providers` with `403 registration_disabled`, and prints `facilitator: warning: POST /providers answers 403 registration_disabled on mainnet: set Z402_REGISTRATION_TOKEN to require a token, or Z402_REGISTRATION_OPEN=1 to let anyone register`. With `1` and no token mainnet is open like the other networks, with the warning about open registration. A token always gates registration, so `1` beside a token changes nothing. |
| `Z402_FACILITATOR_HOST` | `127.0.0.1` | The address to listen on. Keep it on loopback, since the only protection is the keys and tokens. Any other address gives the warning `Z402_FACILITATOR_HOST: <host> is not a loopback host, so the facilitator and its bearer token are reachable over plain http`. The value is matched as written: only `localhost` (in any letter case), `::1` or `[::1]`, and `127.` followed by three dot-separated groups of one to three digits count as loopback. Other spellings of a loopback address, such as `127.1`, `localhost.`, `0:0:0:0:0:0:0:1` or `::ffff:127.0.0.1`, also get the warning. |
| `Z402_FACILITATOR_PORT` | `4022` | 0 to 65535, where 0 picks a free port. |
| `Z402_PRICE_ZAT` | none | Ignored since protocol v2.0, because each provider prices its own routes. Set to anything, it only prints the warning `facilitator: warning: Z402_PRICE_ZAT is ignored: each provider prices its own routes` once, and its value is never read or checked. An empty variable counts as unset. |
| `Z402_WINDOW_ZAT` | `100000` | The size of one deposit, which is also the cap on unconfirmed exposure and the highest price a provider can set for one call. |
| `Z402_CREDIT_RATIO_BPS` | `2500` | Credit on confirmed deposits, in basis points, 0 to 10000. |
| `Z402_CREDIT_CAP_ZAT` | `200000` | The most credit a session can hold. |
| `Z402_ZERO_CONF_MIN_EXPIRY_BLOCKS` | `20` | An unconfirmed deposit earns zero-conf credit only with at least this many blocks left before it expires. |

The last four are the `extra` terms that `/supported` advertises and each resource server copies into its 402s (`docs/spec/protocol.md` section 2). They belong to the rail and not to a provider: every provider is held to the same four. `/supported` also advertises a `termsVersion`, the first 16 hex of sha256 over the tag `z402-terms-v2` and the four terms as they travel on the wire, so it moves with the terms and with nothing else. It does not move with a `payTo` or a price, and `/supported` carries no `payTo`.

`Z402_LIVE` is not a setting of the process. It switches on the live tests below.

## Start-up checks

The process exits 1 at the first failure. The message names the check, and the variable or option to look at where one is behind it:

1. The configuration parses, and the address and key match the network.
2. `zdecrypt` decrypts a bundled real transaction (the Kage vector `030c3cbf...8351`) to the output it is known to hold.
3. `zdecrypt owns` says the viewing key owns the payTo address (`ownedByKey: true`) and that the address has no transparent receiver (`hasTransparent: false`).
4. One `GetLightdInfo` answers two checks. Its `saplingActivationHeight` must be the network's: 419200 on mainnet, 280000 on testnet, and neither of those on regtest (Z3's Zaino reports 1). Otherwise the start stops with `startup check failed (network): lightwalletd reports Sapling activation at <height>, which is not <network>'s; Z402_LWD_URL serves another network`. Then its `consensusBranchId` must equal `Z402_EXPECTED_BRANCH_ID`, which checks the upgrade. `chainName` is never compared, because Zaino reports `test` on regtest.
5. The operator's ledger is locked, proven writable, and replayed in chunks, so a long ledger is never held in memory whole (next section). A truncated last line is dropped with a warning. A new ledger starts with a header line that names its network and payTo. A ledger whose header names another network or payTo stops the start, untouched, with `ledgerPath: <ledger> is the ledger of <network> <payTo>, not of this facilitator`. A ledger with no header, written before the header existed, opens on regtest and testnet, and on mainnet it stops the start with `ledgerPath: <ledger> has no ledger header; a mainnet facilitator opens only a ledger it created`.

The registered providers come next (see [Providers](#providers)):

6. The providers directory is made, and its registry is locked and loaded. A registry that is not exactly what a registration writes (an entry whose `payTo` is over 1024 characters is not), or that belongs to another network, stops the start with `providersDir: ...`, and so does an entry that shares a key with another or has the operator's `payTo`.
7. `zdecrypt owns` runs again for every stored viewing key, so a registry that was tampered with, or a key that no longer owns its `payTo`, stops the start with `providersDir: provider <providerId>: the stored viewing key no longer owns its payTo`.
8. Every provider's ledger is locked and replayed, in parallel (a stale lock can take 15 s each). A ledger of another `payTo` stops the start with `ledgerPath: ...`, as for the operator's.

After the checks it polls the chain once for the operator and for every provider, then listens, and the watchers start. A failed first poll does not stop the start. Each watcher then checks the tip every 5 s, and the providers share one cached tip. Any failure releases every lock it took and stops the start.

A failed ledger write exits 1, so that a restart replays the file. Until then the ledger refuses every later write, and it cuts the bytes of the failed batch off the file. This holds for every provider's ledger and for the registry: a failed write or a lost lock in any of them exits the process, which replays every ledger on restart. The ledgers belong to one chain: after `bash infra/z3/down.sh --wipe` the chain starts again from height 0, so delete the ledgers too (`scripts/demo.sh down --wipe-ledger` does, the registered providers' included).

## Providers

The facilitator serves many providers. A provider is a resource server with its own `payTo`, its own viewing key and its own price for each route. It presents an API key as `Authorization: Bearer <key>` on `/verify` and `/settle`, and the key picks the provider whose runtime answers. The key does not decide where money lands. The `payTo` in the requirements of each request does, and it must be the provider's own, else the answer is `invalid_payment_requirements`, so a key can never touch another provider's state. A runtime holds everything one `payTo` needs and shares nothing with another provider: a chain view that decrypts with that provider's viewing key, its ledger and lock, its sessions, its resolver and its watcher. Sessions are keyed by network, `payTo` and session key, and a deposit is credited once per provider, so one transaction that pays two providers credits each with its own outputs only.

### The operator provider

The `Z402_PAY_TO` and `Z402_UIVK` of the environment, or of the keys file, are a provider like any other, the operator, which is us. It is configured at start and not registered, so `POST /providers` answers 409 `operator` for its `payTo`. Its API key is `Z402_FACILITATOR_TOKEN`, and its ledger stays at `Z402_LEDGER`, so a facilitator that serves only the operator is the one that ran before providers existed. Our own resource servers, `apps/api` and the starter services, present the operator's token unless they are given a key of their own.

### Routes and who may call them

| Route | Key | Answer |
| --- | --- | --- |
| `GET /supported` | none. A key that is presented and names no provider is refused with 401 | The rail's terms and no `payTo`: `{ "kinds": [{ "x402Version": 2, "scheme": "prepaid-voucher", "network": "zcash:regtest", "extra": { "windowZat", "creditRatioBps", "creditCapZat", "zeroConfMinExpiryBlocks", "termsVersion" } }], "extensions": ["bazaar"], "signers": { "zcash:*": [] } }`. The operator's runtime answers, and every runtime advertises the same `extra`. |
| `POST /providers` | none, or `Authorization: Bearer <Z402_REGISTRATION_TOKEN>` when that is set. On mainnet with no token and no `Z402_REGISTRATION_OPEN=1` the route answers 403 `registration_disabled` to everyone | Registers a provider, or rotates its key (next section) |
| `GET /providers/me` | a provider's API key | `{ "providerId", "network", "payTo" }`. A resource server calls it at start to prove that its key and its configured `payTo` belong together (`checkProvider` of `@z402/server`) |
| `POST /verify`, `POST /settle` | a provider's API key | The answers of `docs/spec/protocol.md` section 7, with HTTP 200 whatever happens to the payment |
| `POST /discovery/resources` | a provider's API key | The provider declares its resources to the Bazaar: `200 { "x402Version": 2, "items": [...] }`, or 400 `invalid_request` with the `index` of the item at fault |
| `GET /discovery/resources`, `GET /discovery/search` | none. A key that names no provider is refused with 401 | The Bazaar, public (below) |
| anything else | none | `404 { "error": "not_found" }` |

A route that needs a key refuses a request with none, or with a key that names no provider, with `401 { "error": "unauthorized" }` and `WWW-Authenticate: Bearer`. A rotated-out key is such a key from the request after the rotation.

What `/verify` and `/settle` ask of the requirements of a call (protocol v2.0):

- `payTo` must be the `payTo` of the provider that owns the key.
- `amount` must be a canonical zat from 1 to `windowZat`, without a sign, an exponent or a leading zero. It is the price of this call, which the provider sets for each route, and any such amount is taken. A session may pay 500 and then 800. A voucher is accepted when it is at least the amount of its own call above the last one (`c_new - c_last >= amount`) and within the session's limit, and a voucher short of its call's price is refused with `z402_cumulative_mismatch` and `cumulativeZat must be at least <c_last + amount>`.
- `extra` must carry exactly the rail's terms. `termsVersion` is not checked.

A requirements object that fails any of these, or names another asset than the rail's `ZEC`, is answered with `invalid_payment_requirements`. One that names a scheme or network this facilitator does not serve is answered with `unsupported_scheme`.

### Registering a provider

A provider registers once with the keys of its account. The facilitator holds the viewing key from then on, so it sees the provider's incoming payments, as a payment processor would. Give it the view-only keys file (`node scripts/merchant-keygen.mjs --view-only`, see [Merchant keys](#merchant-keys)), which holds the viewing key and the address and no seed:

```bash
node scripts/register-provider.mjs \
  --keys .secrets/provider2.view.json \
  --facilitator http://127.0.0.1:4022 \
  --out .secrets/provider2.apikey
```

The script posts `{ payTo, uivk, network }` to `POST /providers` and saves the API key it gets in `--out`. It prints only the provider id, the payTo and the path of the key file, and never the key or the viewing key. `node scripts/register-provider.mjs --help` has the usage:

- `--keys`, `--facilitator` and `--out` are required. `--out` must be outside the repository or inside its `.secrets/` directory.
- `--registration-token-file <file>` names a file with the facilitator's registration token, for a facilitator that sets `Z402_REGISTRATION_TOKEN`.
- The facilitator shows a key once, so the key file is opened with mode 0600 before the request is sent, and a key is never issued with nowhere to go. An existing key file is replaced only with `--force`.
- Off regtest, `http://` is allowed to a loopback host only, since the viewing key travels on this link.
- Exit codes: 0 registered, 1 refused or failed, 2 usage.

The provider then starts its resource server with the key as the bearer token. The API does it with `Z402_FACILITATOR_TOKEN` (`apps/api/README.md`, Run as provider 2).

What the facilitator does for `POST /providers`, whose body is `{ "payTo": "<UA>", "uivk": "<UIVK>", "network"?: "<network>" }`:

- It checks the shapes (`payTo` for the network and of at most 1024 characters, `uivk` for the network's key pattern, `network` if given is the facilitator's), all before `zdecrypt` is called, then proves that the viewing key owns the address: `zdecrypt owns` must say `ownedByKey: true` and `hasTransparent: false`. A key that is well formed and does not own the address is `not_owner`.
- Registrations run one at a time. For a new `payTo` the provider's runtime opens first: its ledger and lock, header and replay, first poll and watcher. Only then is the registry written, so a crash never leaves an entry with no runtime, and a failed write leaves no half-registered provider.
- The answer is `201 { "providerId", "network", "payTo", "apiKey" }` with `Cache-Control: no-store`. The key is shown once, and only its sha256 is stored. A key is `z402_` and 43 base64url characters (256 random bits), which is a valid bearer token.
- Registering a `payTo` that is registered again, with a viewing key that owns it, rotates the key. The answer is `200` with the same shape, the new hash is written to the registry before the old key is dropped from memory, and the old key stops working at the next request. This is also how a lost key is recovered. It follows that whoever holds a provider's viewing key controls its API key, so keep the viewing key private. A rotation keeps the provider's id, ledger and Bazaar items.
- `providerId` is the first 16 hex of sha256 over `z402-provider-v1`, a newline, the network, a newline and the `payTo`. It names the provider in the access log, which never has a key.

Refusals all have the body `{ "error": "<code>", "message": "<text>" }`:

| Status | Code | When |
| --- | --- | --- |
| 400 | `invalid_request` | A field is missing or invalid, and the message names it: a `payTo` of more than 1024 characters is one. A body that is not JSON or is over 64 KB is one too |
| 401 | `unauthorized` | A registration token is set and was not presented |
| 403 | `not_owner` | The viewing key does not own the `payTo`, or the `payTo` has a transparent receiver |
| 403 | `provider_limit` | `Z402_MAX_PROVIDERS` is reached, and a new `payTo` is not taken |
| 403 | `registration_disabled` | The facilitator has no providers directory, as in tests that embed it, or it runs on mainnet with no registration token and no `Z402_REGISTRATION_OPEN=1` (`registration is closed on this facilitator`). Nothing else is checked, and the body is not read |
| 409 | `operator` | The `payTo` is the operator's |

A failure of the facilitator's own is `500 { "error": "internal_error" }` and nothing else, with the cause in the log.

With `Z402_REGISTRATION_TOKEN` unset, anyone who can reach the port may register, take the provider slots (a runtime each) and list resources on the site, and every start says so with a warning. That is the default on regtest and testnet. On mainnet registration is off until the operator sets the token or `Z402_REGISTRATION_OPEN=1`. Before outside providers connect over the internet, put the facilitator behind TLS and set the token.

### Removing a provider

Nothing removes a provider while the facilitator runs: there is no deregistration, and an idle provider keeps its slot (`Z402_MAX_PROVIDERS` counts it). To free the slot or to drop an abusive provider, edit the files by hand:

1. Stop the facilitator, so that the registry is unlocked.
2. Remove the entry from `registry.json` in the providers directory. Keep `ledgers/<providerId>.jsonl`, so that the deposits it consumed stay consumed if the same `payTo` ever registers again.
3. Optionally delete `discovery.json`, which the heartbeats rebuild. The items of the removed provider otherwise stay in the catalog until a start finds them untouched for 7 days. Deleting the file also restarts every `paidCallsToday`, and a provider that declared can be listed from its payments again until its next declaration.
4. Start the facilitator again.

The removed provider's key stops working at that start, since the facilitator knows only the keys of the entries in `registry.json`. The `id` of an entry is its `providerId`, and its `payTo` tells whose it is. To remove one entry and keep the file private:

```bash
cd .data/providers.mainnet   # Z402_PROVIDERS_DIR
(umask 077; jq --arg id <providerId> '.providers |= map(select(.id != $id))' registry.json > registry.json.new) \
  && mv registry.json.new registry.json
```

### The providers directory

`Z402_PROVIDERS_DIR` (default `.data/providers.<network>`) is made with mode 0700 and holds:

| Path | Content |
| --- | --- |
| `registry.json`, mode 0600, and `registry.json.lock` | `{ "version": 1, "network": ..., "providers": [{ "id", "payTo", "uivk", "keyHash", "createdAt", "keyIssuedAt" }] }`. It is written by a temp file that is synced and renamed over it, and the directory is synced after, so a crash leaves the old file or the new one whole. Only one start writes it, through the lock. The viewing keys are in it and the API keys are not, only their sha256 |
| `ledgers/<providerId>.jsonl` and its `.lock` | One ledger for each registered provider, in the format of the operator's, whose header line names that provider's `payTo` |
| `discovery.json`, mode 0600 | The Bazaar's catalog. It is not critical: a file that cannot be read is set aside as `discovery.json.bad-<time>` and the catalog starts empty. Items that were neither declared nor paid for in 7 days are dropped at load. The items take at most 16 MiB, counted as the JSON of each stored item: a declaration that would pass that is refused whole with `400 invalid_request` and `the catalog is full`, a payment that would pass it lists nothing (the log says so once), and a file that holds more drops its oldest items at load, by the newest of their `lastSeen`, `lastPaid` and `firstListed`, and logs that once |

The operator's ledger is not in it. It stays at `Z402_LEDGER`. Keep the directory private, since the registry holds every provider's viewing key.

### The Bazaar

The facilitator hosts the x402 Bazaar, the public catalog of every provider's paid resources, with the standard `GET /discovery/resources` and `GET /discovery/search` that `withBazaar(client).extensions.bazaar` calls from `@x402/extensions`. A resource gets into it in two ways:

- **A declaration.** The provider posts its resources to `POST /discovery/resources` with its key, and repeats it as a heartbeat (the service kit does every 30 s). The facilitator never fetches a provider URL. A declaration lists a route before its first sale, and its time (`lastSeen`) tells that the service is up.
- **A settled payment.** After each successful settle the item of that provider that matches the payment gets `paidCallsToday` plus one. A provider that has never declared anything is listed from its payments, through the `bazaar` extension that its 402 declares and the client echoes (`apps/api` declares one, see its README). The client chooses what it echoes, and the stock server does not check it, so an item made from a payment holds only what the facilitator can trust or bound: the canonical resource (origin and path, or the route template, never the query), the requirements of the server (never the `accepted` of the client), the sanitized `bazaar` extension (`extensions` is `{ bazaar }` alone, within 8 KB) and the `mimeType` when it is a string of at most 128 characters. It never takes a `description`, `serviceName`, `tags` or `iconUrl` from a payment. A provider has at most 8 such items: a payment for a 9th resource lists nothing, and the log says so once for the provider. A payment for a listed resource still counts. A declaration is how a provider lists more, with text of its own. Once a provider has declared anything, its payments only update the items it declared, and never create one.

Every item names the `payTo` of its provider and the requirements the facilitator would take: the same terms and `termsVersion` as `/supported`, and an `amount` from 1 to `windowZat`. The 402 of the resource stays authoritative, and a client pays what it says and not what the catalog says. Items show `paidCallsToday`, a count of today's settled payments, and no session, key or amount of any call. The multi-provider design (section 4.4) has the rules, the item shape and the limits.

## The ledger and its lock

One facilitator at a time writes a ledger. Before it reads the file, a facilitator takes the lock `<ledger>.lock`, for example `.data/facilitator-ledger.regtest.jsonl.lock`. The ledger of each registered provider and the registry are locked the same way, under their own names, and the rules below hold for all of them:

- The lock is a small file, created exclusively with mode 0600 beside the ledger's real path, with links and letter case resolved, so every spelling of one ledger shares one lock. It holds the pid, the host name, a random token and the start time of its owner, and the owner touches it every 5 s while it runs.
- One facilitator per ledger path. A symbolic link to the ledger, and on a case-insensitive filesystem (the macOS default) another letter case of the path, name the same real path, so they share the lock and the second start is refused (`ledgerPath: <path> is already open in this process` inside one process, and the message below across processes). A hard link is the one other name that does not resolve: it is another path to the same file, so a facilitator started on it takes a lock of its own beside the link, finds the ledger unlocked and starts, and two facilitators then append to one file. Never open a ledger by a hard link, and never give two running facilitators two names of one ledger.
- A second facilitator on the same ledger does not start, and it leaves the ledger as it was. It stops with `ledgerPath: <ledger> is in use by pid <pid> on <host> since <time>; stop that facilitator, or delete <ledger>.lock if none is running`. It stops at once when the lock names a live pid of this host, and a pid of another user counts as alive. Any other fresh lock (a pid that no longer exists, this very pid as a container's pid 1 would be, another host, or a lock it cannot read) may belong to a facilitator this process cannot see, in another container that shares the volume for example. So the start watches it for up to 15 s, and a touch in that time stops the start. Inside one process the message is `ledgerPath: <ledger> is already open in this process`.
- A lock that nobody touched for 15 s was left by a crash, whatever pid or host it names, and the next start takes it over with no help. A crashed facilitator can therefore be replaced within 15 s, and a start can wait that long. Neither rule depends on the host name staying the same, which macOS may change when the network does. A facilitator that is paused for longer than 15 s (SIGSTOP, a suspended VM) looks crashed, and another start may take its lock over.
- The holder reads its lock back at every heartbeat and before every ledger write, a check that costs about 13 µs per write here. Once the lock names another start, or is gone, the facilitator writes nothing more, reports `ledgerPath: <ledger> is no longer locked by this facilitator (...), so it writes nothing more`, and exits 1. A paused facilitator that resumes after a takeover therefore stops at its first check. One batch can still pass: the check and the append run back to back, about 20 µs apart (median, measured; up to tens of milliseconds under heavy CPU load), so a facilitator stopped exactly between them (SIGSTOP, a VM pause, a write hung on a stalled network filesystem) appends the batch it was writing to a ledger the new holder has already replayed. Closing that window needs `flock` or a lease, which is a mainnet item.
- The takeover runs under `<ledger>.lock.takeover`, created exclusively, and it checks again under that file that the lock is still the one it judged stale, so of two starts that race for one stale lock only one wins.
- A lock that cannot be read as one (empty or garbled, as a crash between its creation and its first write leaves it) is stale like any other once 15 s pass with no touch. If it changes while a start watches it, the start stops with `ledgerPath: <ledger>.lock exists and cannot be read; delete it if no facilitator is running`. Anything but a regular file at the lock path, such as a FIFO or a symbolic link, stops the start with `ledgerPath: <ledger>.lock is not a regular file; delete it if no facilitator is running`.
- Closing the facilitator removes the lock, but only while the lock still carries its owner's token. A start that fails after the lock was taken, on a busy port for example, gives it back.
- To clear a lock by hand, first make sure that no facilitator runs on that ledger anywhere, on this host or in any container that mounts it. Then delete `<ledger>.lock`, and `<ledger>.lock.takeover` if it is there. After a crash that is never needed, only to start sooner than 15 s.

The lock is created before anything else, so the first failure of a ledger that cannot be written is often the lock's own. A directory you cannot write to (mode 0555, say) or a read-only mount stops the start with `ledgerPath: cannot create <ledger>.lock (EACCES)`, or `(EROFS)` on a read-only mount, and the write check below is never reached. A ledger directory that does not exist and cannot be created gives `ledgerPath: cannot create the directory of <ledger> (<code>)` instead.

The lock is followed by a write check. The facilitator opens the ledger for appending, which creates it empty with mode 0600 when it does not exist yet, and it stops before its first chain poll if that fails: `ledgerPath: <ledger> is not writable (EACCES)` for a ledger file that you cannot write (mode 0444, say), with `EISDIR` when the path is a directory and `EROFS` in the same place, and `ledgerPath: cannot open <ledger> (<code>)` for any other error. The lock is given back whenever the start fails here. A facilitator that prints its ready line can therefore record a settle.

## Options of `startFacilitator`

The process builds its options from the variables above. The tests and `apps/e2e` call `startFacilitator` directly, and it checks its options before it opens anything. A bad one is refused with a message that starts with the option's name and never quotes its value:

| Option | Allowed | Default |
| --- | --- | --- |
| `port` | a whole number from 0 to 65535 | 0, a free port |
| `pollIntervalMs` | a whole number from 1 to 2,147,483,647, the longest delay a timer honours | 5000 |
| `depositWaitMs` | a whole number from 0 to 30,000, since the API's 60 s for a verify is sized for this wait, the read that ends it and the 5 s refresh | 30,000 |
| `host` | not blank | `127.0.0.1` |
| `ledgerPath` | not blank, or left out for an in-memory ledger that takes no lock and writes no file | none |
| `authToken` | one token of letters, digits and `-._~+/` that may end in any number of `=`, or left out to check no token | none |
| `priceZat` | ignored since protocol v2.0, because each provider prices its own routes, and not checked either | none |
| `providers` | `{ dir, chainFor, owns, max?, registrationToken?, registrationEnabled? }`: `dir` not blank, `chainFor` and `owns` functions, `max` a whole number from 0 to 1000, `registrationToken` one token as `authToken`, `registrationEnabled` true or false (false answers `POST /providers` with 403 `registration_disabled` and the registered providers keep serving). A bad field is refused as `providers.<field>: ...` | none, and `POST /providers` answers 403 `registration_disabled` |

A host that the machine does not have fails when it listens, as `host: cannot listen on <host>:<port> (<code>)`. A port that is busy fails as `port: cannot listen on <host>:<port> (EADDRINUSE)`, and a port that you may not bind (a port below 1024 without root, for one) fails as `port: cannot listen on <host>:<port> (EACCES)`.

## Merchant keys

```bash
node scripts/merchant-keygen.mjs --network regtest     # or testnet, or mainnet
```

It runs `zdecrypt keygen` and writes `.secrets/merchant-<network>.json` with mode 0600, inside a 0700 directory. The file holds `seedHex`, `ufvk`, `uivk`, `address`, `orchardOnlyAddress` and a few more fields. The seed is the only backup of the account, and `.secrets/` is gitignored.

- The script prints the `orchardOnlyAddress` on stdout and a backup reminder on stderr. Nothing else leaves the file.
- It refuses to replace an existing file. `--force` replaces it and keeps the old one as `<file>.replaced-<UTC time>` (for example `merchant-regtest.json.replaced-20261027T205936Z`, mode 0600), so a replaced seed is never destroyed. The script prints that path, never the contents.
- Run one merchant-keygen at a time: two runs on the same key file can lose a key whose address was already printed.
- The keys path is never absent. The old file first gets a second name, or a copy where the filesystem has no hard links (FAT and exFAT), and the directory entry of that name is synced. Then the new file takes the place of the old one by an atomic rename. A failure before the rename leaves the old file where it was, byte for byte. Key files must be 0600, so `--force` sets the old file to that mode on the way, and where a hard link made the second name the mode stays set even if the write then fails.
- A rename that reports an error may have happened all the same, so after the old file got its second name the script never deletes that name. It exits 1, names the kept file and the key path, and says "check which key <path> holds before you use it". Read `orchardOnlyAddress` in both files to tell them apart.
- A new key file is published with an exclusive create, with or without `--force`: the finished temp file is hard-linked to the key path, and the link fails if anything is there. Two runs that race for one new path cannot overwrite each other. The loser of the race refuses, or with `--force` it keeps the winner's file as `<file>.replaced-<UTC time>` and writes its own key, so both keys are on disk. A filesystem without hard links (FAT, exFAT) has no exclusive create, so a new key file there is refused with `cannot create <file> here, the filesystem has no hard links for the exclusive create; create the file on another filesystem and copy it here`. `--force` still replaces a file that exists there, keeping the old one as a copy.
- A symbolic link as the key file is refused with or without `--force`: exit 2 with "the key file is a symbolic link; replace it by hand".
- The temp file's mode is read back before any key is written. A filesystem that does not keep mode 0600 (FAT and exFAT show the mode of their mount) makes `mainnet` stop with exit 2 and no key, and gives `regtest` and `testnet` one warning, "this filesystem does not keep file modes; the key file is readable by other users".
- After the write the script syncs the directory entries to disk, the new directories included. If that fails, it still prints the address and the kept file, then one warning ("the new key is in place but its directory entry may not survive a power loss; run sync"), and it exits 1.
- On `mainnet` the seed controls real money and the script says so. A server needs only `Z402_UIVK` and `Z402_PAY_TO`, so keep the seed off it.
- `--out <absolute path>` writes somewhere else, but only outside the repository or inside its `.secrets/` directory (symlinks are resolved first). Any other path in the work tree exits 2, since a key file there can be committed by accident. The binary and the default output are found from the script's own location, so the working directory does not matter.

### The facilitator's keys file

```bash
node scripts/merchant-keygen.mjs --view-only --from .secrets/merchant-regtest.json
```

The facilitator needs the viewing key and the address and has no use for the seed, so give it a keys file without one. `--view-only` makes no key. It reads a keys file that the command above wrote and writes `.secrets/merchant-<network>.view.json` (the network is the file's own) with mode 0600, holding exactly these three fields and nothing else:

```json
{ "network": "regtest", "uivk": "uivkregtest1...", "orchardOnlyAddress": "uregtest1..." }
```

This is the recommended `Z402_MERCHANT_KEYS_FILE` of the facilitator. It has no `seedHex` and no `ufvk`, so the facilitator prints no warning about it, and mainnet accepts it. The API accepts it too (`Z402_MERCHANT_KEYS_FILE`, `apps/api/README.md`) and uses only its address. A provider that registers with the facilitator gives `scripts/register-provider.mjs` the same kind of file (see [Providers](#providers)).

- It prints the address on stdout and `Saved <path> (mode 600)` on stderr, and nothing of the key.
- It follows the rules of the command above: an exclusive create, no replacing of a file that exists without `--force`, which keeps the old file as `<file>.replaced-<UTC time>`, no symbolic link, `--out` only outside the repository or inside `.secrets/`, and the same check that the filesystem keeps file modes. `--from` is a path from the working directory. `--network` is optional, and if it is given it must be the file's network (exit 2 otherwise).
- It refuses a file whose `uivk` or `orchardOnlyAddress` does not fit the network, and no message quotes the file.

Check that the key owns the address. The key goes through the environment, never an argument:

```bash
ZDECRYPT_KEY=$(jq -r .uivk .secrets/merchant-regtest.json) crates/zdecrypt/target/release/zdecrypt owns \
  --network regtest --address $(jq -r .orchardOnlyAddress .secrets/merchant-regtest.json)
# {"hasTransparent":false,"orchardOwned":true,"ownedByKey":true,"saplingOwned":null}
```

## Look at a deposit

```bash
scripts/show-deposit.sh <txid> [--network regtest] [--keys <file>]
```

It fetches the raw transaction from Zebra (`getrawtransaction <txid> 1` at `Z3_ZEBRA_RPC`, default `http://127.0.0.1:29232`, Basic auth `Z3_RPC_USER:Z3_RPC_PASSWORD`, default `zebra:zebra`), then decrypts it with the viewing key from the keys file (default `.secrets/merchant-<network>.json`). A mined transaction is judged at its height and a mempool one at the tip plus one. The key reaches `zdecrypt` through `ZDECRYPT_KEY` only and is never printed. The JSON report is on stdout and the commentary is on stderr, so `scripts/show-deposit.sh <txid> 2>/dev/null | jq` works. The report goes through `jq -a`, which escapes every non-ASCII and control character, so a memo chosen by the sender cannot reach the terminal as one, and the text that Zebra sends in an error is cut to printable characters, with control, format and line separator characters removed whatever `PERL_UNICODE` or `PERL5OPT` say. A `zdecrypt` that prints something other than a JSON report ends the run with `ERROR: zdecrypt did not print a JSON report`, and one whose report names no txid with `ERROR: zdecrypt printed a report with no txid`. After the report, a line says whether only the net value balance (the fee) is public, as for a fully shielded deposit, or the transaction also has a transparent part. The script needs `curl`, `jq`, `base64`, `perl` and `env`. `scripts/demo.sh show` runs it.

## Testnet

The same process runs against the public testnet. Only `testnet.zec.rocks:443` answers there. It is a shared lightwalletd behind several backends, which see a new transaction up to about 16 s apart, and its tip can lag by 0 to 9 s (section 7 of the design, `docs/research/zcash-testnet.md`).

```bash
node scripts/merchant-keygen.mjs --network testnet
node scripts/merchant-keygen.mjs --view-only --from .secrets/merchant-testnet.json
Z402_NETWORK=testnet \
Z402_MERCHANT_KEYS_FILE=.secrets/merchant-testnet.view.json \
pnpm --filter @z402/facilitator start
```

The defaults become `https://testnet.zec.rocks:443` and branch id `77190ad9` (NU7). The paying wallet needs testnet funds, which come from a faucet. Blocks arrive about every 25 s and are not mined by you. Keep the ledger of each network apart: the default path already includes the network name.

## Tests

```bash
pnpm --filter @z402/facilitator test
pnpm --filter @z402/facilitator typecheck
```

The live tests are off unless `Z402_LIVE` is set. They only read, and they need the Z3 stack to be up:

```bash
Z402_LIVE=1 pnpm --filter @z402/lightwalletd exec vitest run
Z402_LIVE=1 pnpm --filter @z402/facilitator exec vitest run test/chain/live.test.ts
```

The first checks Zaino's branch id, tip and not-found answer (`Z402_LWD_URL` overrides the endpoint). The second reads the first real regtest deposit, `98e84dab...0eaf`, so it passes only on the chain that holds that transaction and fails after `down.sh --wipe`. The measurements from both are in `docs/research/live-run.md`.
