# Deploy on one VPS, on testnet, behind Caddy

`scripts/vps.sh up` runs z402 on a single server with HTTPS: the website at `https://z402.net`, the facilitator at
`https://facilitator.z402.net`, the demo API at `https://api.z402.net`, and, if you turn them on, the four starter
services at their own names. It is the Zcash **testnet** and nothing else: no coin of value is involved. There is no
chain on the server. The facilitator reads deposits through the public lightwalletd `testnet.zec.rocks`, with the
operator's **view-only** keys, so the seed that controls the account never leaves your laptop.

```
                           ┌─ z402.net, www ──────────────> web
internet ── 80/443 ── caddy ─┼─ facilitator.z402.net ───────> facilitator ── https ──> testnet.zec.rocks
 (Let's Encrypt)           ├─ api.z402.net ───────────────> api ── https://facilitator.z402.net (kept inside)
                           └─ llm. markdown. embeddings.   llm, markdown, embeddings, dropbox   (profile "services")
                              dropbox.z402.net
```

Caddy is the only container with a published port. The facilitator, the API and the services listen on the compose
network and nowhere else. The private regtest stack of [`deploy.md`](deploy.md) is a different project (`compose.yaml`,
its own volumes and image names) and shares nothing with this one.

## What you need

- **A VPS** with 2 vCPU, 4 GB of memory and 20 GB of disk (the first build leaves a few GB of build cache), running
  **Ubuntu 24.04**, and a user with `sudo`.
- **Docker Engine 25 or later with the Compose plugin** (v2.24 or later), installed as below.
- **A domain** whose DNS you control: `z402.net` here. Any other works with `Z402_DOMAIN`.
- **A laptop** with Node 22 or later and Rust, to make the operator's keys.

The memory limits of the containers add up to 1.4 GB without the starter services and 3.2 GB with them, so both fit in
4 GB with room for Docker and the system. The build is the heavy part: it compiles the Rust decryptor and the Next.js
site. `vps.sh up` builds one image after another so that they do not compete for memory, and if the kernel still kills a
build ("Killed" in the output), add swap for it:

```bash
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
```

## 1. DNS

Point these at the server's IPv4 address, and wait until they resolve before the first `up`: Caddy asks Let's Encrypt for
a certificate for each name as soon as it starts, and the demo API cannot start without the certificate for
`facilitator.`.

| Type | Name | Needed for |
|---|---|---|
| A | `@` (z402.net) | the website |
| A | `www` | redirects to z402.net |
| A | `facilitator` | the facilitator, for providers that register and the API |
| A | `api` | the demo API |
| A | `llm`, `markdown`, `embeddings`, `dropbox` | only with the starter services on. One wildcard `*` record does for all four |

Add AAAA records only if the server has working IPv6: a broken AAAA record makes Let's Encrypt's check fail or slow.

## 2. The server

Open the three ports. Docker publishes Caddy's ports itself (80, 443 and 443/udp for HTTP/3), past `ufw`'s rules; these
rules are for everything else on the server, and say what you intend:

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443        # tcp and udp
sudo ufw enable
```

If your provider has a firewall in front of the server, allow 22, 80 and 443 there too.

Install Docker Engine from Docker's own repository ([the official page](https://docs.docker.com/engine/install/ubuntu/)
has the current steps):

```bash
sudo apt-get update && sudo apt-get install -y ca-certificates curl git openssl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker "$USER"      # log out and in again for it to apply
```

## 3. The commands, in order

On the server:

```bash
git clone <the repository's URL> z402 && cd z402
scripts/vps.sh init
```

`init` writes `.env.vps` (mode 0600, never committed) from `.env.vps.example`, with a random facilitator token and a
random registration token from `openssl rand -hex 32`. It prints neither. It never overwrites an existing `.env.vps`.
`scripts/vps.sh init example.org` sets another domain; so does `Z402_DOMAIN` in the file.

```bash
scripts/vps.sh keys
```

With no argument, `keys` prints what to do on your **laptop**. In short, in a checkout of the repository there:

```bash
cargo build --release --locked --manifest-path crates/zdecrypt/Cargo.toml
node scripts/merchant-keygen.mjs --network testnet                             # .secrets/merchant-testnet.json
node scripts/merchant-keygen.mjs --view-only --from .secrets/merchant-testnet.json   # .secrets/merchant-testnet.view.json
```

The first file holds the seed. It is the only backup of the account: keep it on the laptop and back it up there. The
second holds three fields and no seed: the network, the viewing key (it sees deposits and cannot spend) and the address
that deposits go to. Send that one alone, straight into the import:

```bash
ssh you@server 'cd z402 && scripts/vps.sh keys -' < .secrets/merchant-testnet.view.json
```

(or copy the file over, run `scripts/vps.sh keys merchant-testnet.view.json`, and delete the copy). The import accepts
exactly those three fields for testnet and refuses a file that holds anything else, the seed above all. It writes
`Z402_PAY_TO` and `Z402_UIVK` into `.env.vps`, prints the address so you can compare it with the one `merchant-keygen`
printed, and never prints the viewing key. Importing keys of another account later needs `--force`, because a ledger
belongs to one address.

```bash
scripts/vps.sh up
```

`up` checks the settings, builds the images one at a time, runs `docker compose -f compose.vps.yaml --env-file .env.vps
up -d --build`, and waits (up to 10 minutes, `Z402_WAIT_SECONDS`) until every service reports healthy. If one does not,
it prints the state and the end of the log of those that do not, and exits 1. The first run downloads the base images,
the npm packages and the Rust crates and takes several minutes; later runs reuse what they have. A build that fails on
the network is run again by running `up` again.

## 4. Check it

```bash
scripts/vps.sh status
curl -s https://facilitator.z402.net/supported | jq .kinds       # prepaid-voucher on zcash:testnet
curl -s -o /dev/null -w '%{http_code}\n' https://api.z402.net/chunk    # 402: payment required
curl -s https://z402.net/discovery/resources | jq '.items[].resource'  # the catalog, read from the facilitator
```

Open `https://z402.net` and its `/services` page. The facilitator's log shows its start-up checks passing against
`testnet.zec.rocks` and then one line that names the network and your address, and the number of providers:

```bash
scripts/vps.sh logs --no-follow facilitator | grep -E 'listening|providers='
# facilitator listening on http://0.0.0.0:4022 network=zcash:testnet payTo=utest1...
# facilitator providers=0
```

Paying the API takes an agent with a funded testnet wallet. The demo agent (`apps/agent`) takes `--network
zcash:testnet`, `--url https://api.z402.net/chunk`, `--zallet-url` and `--lightwalletd https://testnet.zec.rocks:443`.
**As of 2026-10-27 the testnet faucets were down**, so funding a testnet agent may need another source: a testnet
wallet that already holds funds, or a faucet that is back.

## 5. The starter services (optional)

`llm`, `markdown`, `embeddings` and `dropbox` are a compose profile that is off. `llm` and `embeddings` call a hosted
OpenAI-compatible provider, and no model runs on a 4 GB server, so they need one and its key. In `.env.vps`:

```
COMPOSE_PROFILES=services
Z402_LLM_BASE_URL=https://openrouter.ai/api/v1
Z402_LLM_API_KEY=...
Z402_LLM_MODEL=qwen/qwen-2.5-7b-instruct
Z402_EMBEDDINGS_BASE_URL=https://api.openai.com/v1
Z402_EMBEDDINGS_API_KEY=...
Z402_EMBEDDINGS_MODEL=text-embedding-3-small
```

Add the four DNS records (or the wildcard), then run `scripts/vps.sh up`. Each service gets `PUBLIC_URL`
`https://<name>.z402.net`, which is the resource URL in its 402s and in the catalog. All four are the operator's own
provider, paid to the same address with the operator's token (in `compose.yaml` `markdown` is a second provider; here it
is not). The drop box reads the chain tip from the same lightwalletd.

Turning `COMPOSE_PROFILES` off again and running `up` stops and removes the four containers and takes their four names
out of Caddy's configuration, so Caddy asks for no certificates for them and routes nothing to them. Their volume (the
drops) stays. With the profile off, Caddy has only the four sites of section 1.

## 6. Register an outside provider

The facilitator serves any number of providers (32 by default, `Z402_MAX_PROVIDERS`). A provider has its own address and
viewing key and registers once with the registration token, which `init` put in `.env.vps`:

```bash
# on the server; the token is read from the file and never shown
TOKEN=$(sed -n 's/^Z402_REGISTRATION_TOKEN=//p' .env.vps)
curl -sS -X POST https://facilitator.z402.net/providers \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  --data @provider.register.json
```

`provider.register.json` is `{ "payTo": "utest1...", "uivk": "uivktest1...", "network": "zcash:testnet" }`, built from
the provider's own view-only file (`merchant-keygen --view-only`, as in section 3):

```bash
jq '{payTo: .orchardOnlyAddress, uivk, network: ("zcash:" + .network)}' provider.view.json > provider.register.json
```

The answer is `201 { "providerId", "network", "payTo", "apiKey" }`. The API key is shown **once**; the provider's
resource server presents it as `Z402_FACILITATOR_TOKEN` with `Z402_FACILITATOR_URL=https://facilitator.z402.net`.
Registering the same address again issues a new key and ends the old one. The refusals are `401` (no registration
token, or the wrong one), `403 not_owner` (the viewing key does not own the address), `403 provider_limit` and
`409 operator` (the address is the operator's). A provider can also run `node scripts/register-provider.mjs --keys
provider.view.json --facilitator https://facilitator.z402.net --registration-token-file token.txt --out provider.apikey`
from a checkout, which keeps its key and the viewing key out of the shell history. Give the registration token only to
people you want to take provider slots, and over a private channel.

To remove a provider, stop the stack, take its entry out of the registry, and start it again. Keep its ledger
(`ledgers/<providerId>.jsonl`), so that the deposits it consumed stay consumed. In this deployment the registry is
`/data/providers.testnet/registry.json` on the facilitator's volume:

```bash
scripts/vps.sh down
docker compose -f compose.vps.yaml --env-file .env.vps run --rm -T --no-deps --entrypoint node facilitator -e '
  const fs = require("fs");
  const file = "/data/providers.testnet/registry.json";
  const registry = JSON.parse(fs.readFileSync(file, "utf8"));
  registry.providers = registry.providers.filter((p) => p.id !== process.argv[1]);
  fs.writeFileSync(file + ".new", JSON.stringify(registry, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(file + ".new", file);
' <providerId>
scripts/vps.sh up
```

The removed key stops working at that start. "Removing a provider" in `packages/facilitator/README.md` has the details.

## 7. Operate it

| Command | What it does |
|---|---|
| `scripts/vps.sh status` | `docker compose ps` and one line of health per service. Exits 1 unless every service is healthy |
| `scripts/vps.sh logs [--no-follow] [service...]` | the last 200 lines, then follows. A service is `caddy`, `facilitator`, `web`, `api`, and with the profile `llm`, `markdown`, `embeddings`, `dropbox` |
| `scripts/vps.sh down` | removes the containers and keeps every volume |
| `scripts/vps.sh update` | `git pull --ff-only`, then `up` from the new copy of the script, which rebuilds the images and recreates the containers whose image or settings changed |
| `scripts/vps.sh backup` | a `tar.gz` of the facilitator's volume in `.data/backups/` (mode 0600) |
| `scripts/vps.sh restore <file>` | empties that volume and puts a backup in it. Asks for `yes` |

**Reboots.** Every service has `restart: unless-stopped`, so the stack comes back with Docker. Nothing waits for
anything at that moment, and the API and the services wait for the facilitator themselves.

**Logs.** Each container keeps three files of 10 MB in Docker's json-file log, so logs cannot fill the disk. Caddy keeps
no access log on purpose: a voucher travels in a request header, and the id of a drop in its path is all it takes to
fetch the drop.

**Backups.** The facilitator's volume (`facilitator-data`) holds the operator's ledger, which records the deposits it has
credited, and the registered providers: the registry with every provider's viewing key, their ledgers and the service
catalog. Without the ledger the facilitator forgets which deposits it already credited, so back it up, and copy the
archive off the server:

```bash
scripts/vps.sh backup
scp you@server:z402/.data/backups/z402-vps-*.tar.gz ./backups/
```

The archive holds every provider's viewing key, so keep it private. The backup reads the volume while the facilitator
runs; its ledger only grows by appended lines, and a torn last line is dropped when the facilitator replays it. A
restore puts back the state of the backup, so it forgets what happened after it: use it to recover from loss, not to
roll back. Caddy's certificates (`caddy-data`) are left out; Caddy asks again if they are gone, but Let's Encrypt allows
only a few new certificates for the same names each week, so do not delete that volume casually.

**Updates.** `scripts/vps.sh backup && scripts/vps.sh update`. A change to the compose file, the Caddyfile or the
settings recreates only the services it touches. A new `.env.vps` value takes effect with `scripts/vps.sh up`.

**Deleting everything.** `down` keeps the volumes on purpose. `docker compose --profile '*' -f compose.vps.yaml
--env-file .env.vps down -v` also deletes them: the ledger, the registered providers, the drops and the certificates.
(`--profile '*'` is what includes the starter services' volume when the profile is off.)

## Exposure and security

- **One port opens, and it is Caddy's.** The facilitator's port is never published: it is reached through Caddy and over
  the compose network, as is every other container. Do not add `ports:` to a service. Docker's published ports bypass
  `ufw`, so a port that is published is open whatever `ufw status` says.
- **Registration is closed without the token.** `POST /providers` is open to anyone who can reach the facilitator unless
  `Z402_REGISTRATION_TOKEN` is set, and anyone could then take its provider slots and list resources on the website.
  `init` sets a 64-character token, `up` refuses an empty or short one before it starts anything, and the facilitator
  itself refuses to start with one under 32 characters. Without the variable registration is open, and every start warns.
- **The facilitator is public on purpose.** Providers call `/verify`, `/settle` and `/discovery/resources` there with
  their API keys, and `/supported` and the catalog are public. Every route that matters needs a key, and Caddy caps a
  request body at 2 MiB (the facilitator's own cap is 64 KB). Caddy has no rate limit; if you expect abuse, put a CDN or
  a firewall rule in front.
- **The tokens are secrets.** `Z402_FACILITATOR_TOKEN` is the operator's API key: with it anyone can verify and settle as
  the operator. It is in the environment of the facilitator, the API and the services, so `docker inspect` shows it to
  whoever is in the `docker` group, which is root on the server. Keep `.env.vps` at mode 0600 and out of git.
- **The server holds no way to spend.** The viewing key sees deposits and cannot spend them, and the seed stays on your
  laptop. A server that is broken into leaks the privacy of the incoming payments, not the funds. The facilitator
  refuses a keys file that holds a seed on mainnet, and `vps.sh keys` refuses one everywhere.
- **The demo API reaches the facilitator through Caddy.** `apps/api` allows a plain `http://` facilitator only on regtest
  or on a loopback host, so on testnet it uses `https://facilitator.<domain>`, which a network alias on the Caddy
  container resolves inside the compose network. The traffic does not leave the server, but the API starts only once
  Caddy has the certificate for that name. The starter services accept `http://facilitator:4022` and use it.
- **The services' client addresses.** `markdown` rate-limits per client and is told to trust Caddy's `X-Forwarded-For`
  (`MARKDOWN_TRUST_PROXY=uniquelocal`). `dropbox` has no such setting yet, so its per-client upload limit
  (`DROPBOX_RATE_PER_MIN`, 30 a minute) counts every client as Caddy and is shared by all of them.
- **`llm` and `embeddings` send their input to the hosted provider.** The operator and the provider both see every
  prompt and every text, so say so wherever you list the services.
- **Testnet only.** The file runs `Z402_NETWORK=testnet`. A facilitator that trusts a public lightwalletd for whether a
  deposit exists and how deep it is mined is fine for testnet coins and not for real money, where you would run your
  own node (`packages/facilitator/README.md`, `Z402_LWD_URL`).

## Trying it on one machine

The same stack runs on a laptop for a trial, with Caddy's own CA signing every site (browsers and curl do not trust
it, so use `curl -k`). In `.env.vps`:

```
Z402_DOMAIN=localhost
Z402_TLS=internal
Z402_PUBLISH_HOST=127.0.0.1
Z402_HTTP_PORT=18080
Z402_HTTPS_PORT=18443
```

Then `scripts/vps.sh up`, and `curl -k https://facilitator.localhost:18443/supported`. `Z402_TLS=internal` makes
`vps.sh` add `compose.vps.local.yaml`, through which Caddy hands its CA's certificate (not its key) to the API, which
needs to trust it. `COMPOSE_PROJECT_NAME=z402vps scripts/vps.sh up` keeps the trial under a project of its own, and
`docker compose -p z402vps --profile '*' -f compose.vps.yaml -f compose.vps.local.yaml --env-file .env.vps down -v`
removes everything it made.

## When something does not start

| What you see | Why, and what to do |
|---|---|
| `api` stays `starting`, and its log says `api: waiting for https://facilitator.<domain>` | It waits for that name to answer, which needs Caddy's certificate. `scripts/vps.sh logs caddy` shows the ACME errors. Usually a DNS record that does not resolve yet, or port 80 or 443 blocked |
| Caddy logs `rateLimited` | Let's Encrypt allows only a few certificates for the same names each week. Wait, and keep the `caddy-data` volume |
| `facilitator` exits at once | `scripts/vps.sh logs --no-follow facilitator` names the variable. Typical: `Z402_REGISTRATION_TOKEN` under 32 characters, or `Z402_PAY_TO` and `Z402_UIVK` that do not match each other |
| `facilitator` waits for `testnet.zec.rocks` | It is a shared public server and may be down. The facilitator waits up to 10 minutes and tries again on its own |
| `... is the ledger of ... not of this facilitator` | `.env.vps` holds another account than the ledger was made for. Restore the keys, or start a ledger of your own by deleting the `facilitator-data` volume (it forgets the credited deposits) |
| a build is "Killed" | Out of memory: add the swap file of the first section and run `up` again |
