# Deploy with Docker Compose

`docker compose up -d` in the repository root runs the whole project on one machine: a private Zcash regtest chain
with a funded agent wallet and a block clock, the merchant keys, the facilitator, the paid API (`GET /chunk`), the
four starter services, a local llama.cpp model runtime for `llm` and `embeddings`, discovery and the website. No
`.env` and no other step is needed.

Needs Docker Engine 25 or later with Compose v2.24 or later, at least 4 GB of memory, about 8 GB of free disk, and
internet access on the first start. Linux amd64 is the target. macOS arm64 works too, with Zaino (amd64 only)
emulated; a Linux arm64 host needs amd64 emulation installed first
(`docker run --privileged --rm tonistiigi/binfmt --install amd64`).

The first start downloads images from Docker Hub and ghcr.io, npm packages and Rust crates for the build, the
website's fonts from Google Fonts (`fonts.googleapis.com`, `fonts.gstatic.com`) during its build, and the two models
from Hugging Face. A build step that fails on the network stops `up -d` before any container starts: run it again,
and the steps that finished are reused. The website build tries three times, 30 s apart. A model that cannot be
downloaded only keeps `llm` or `embeddings` unready, which refuses calls before payment.

## First start

```bash
docker compose up -d
docker compose ps
```

`up -d` builds five images (`z402-node`, `z402-web`, `z402-zallet`, `z402-zebra`, `z402-zaino`), pulls the rest, then
starts everything in dependency order. It returns once every service has started, the website once discovery answers
and the clock once the agent is funded:

1. `zebra` → `chain-init` mines blocks 1 and 2, where NU5 to NU6.3 activate
2. `zallet-init` creates the wallet, account 0 and the miner address, once → `zallet`, and `zaino` beside it
3. `wallet-fund` mines 110 blocks and shields 62.5 ZEC to the agent, when it holds less than 1 ZEC → `clock`
4. `keygen` creates the merchant keys and the facilitator token, once → `facilitator` (after Zaino answers) → `api`,
   `llm`, `markdown`, `embeddings`, `dropbox` → `discovery` → `web`
5. `llm-model` and `embed-model` download their models (about 580 MB) on the first start; `llm` and `embeddings` show
   `health: starting` until the model is loaded. Nothing else waits for them.

Measured on a 4-CPU arm64 VM with a fast link: building the images from nothing took about 1.5 minutes (the Node image
69 s, 31 s of it compiling zdecrypt; the web image 19 s). With the images built, `up -d` on empty volumes returned
after 45 s, and every service was healthy a second later, the model downloads included. Funding the agent is most of
that (36 s). A fresh server first downloads about 1 GB of images (Zebra, Zallet, Zaino, llama.cpp, the Rust and Node
build bases), plus the crates and npm packages of the build.

`chain-init`, `zallet-init`, `wallet-fund` and `keygen` are one-shot jobs: `docker compose ps -a` shows them as
`Exited (0)`. Every `up` runs them again, and they do nothing once their work is done.

Watch it: `docker compose logs -f wallet-fund facilitator`, or `docker compose logs -f` for everything.

## Check it works

```bash
docker compose ps                                                   # services healthy, jobs Exited (0)
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:4021/chunk   # 402
curl -s http://localhost:4031/health                                # {"ok":true,...,"ready":true,...}
docker compose run --rm agent --calls 10                            # paid calls, each printed as "#001 200 ..."
docker compose run --rm smoke                                       # paid calls on every starter service
```

Then open http://localhost:3000.

`smoke` proves that paid calls work end to end. It waits until `llm`, `markdown`, `embeddings` and `dropbox` are
healthy (on the first start, until the models are loaded), makes one deposit from the agent's wallet, and runs a short
script on each service over the compose network: an `llm` stream of up to three chunks, one page, one embedding, and a
drop uploaded, held, fetched and deleted. Every answer is checked. It prints one line per step, then `smoke ok` and
exits 0, or `smoke FAILED` and exits 1. `markdown` fetches https://example.com unless `--page` names another page:

```bash
docker compose run --rm smoke --page https://www.rfc-editor.org/rfc/rfc9110.html
```

## Ports

| Service | Port | Published on the host |
|---|---|---|
| web | 3000 | `Z402_WEB_PORT` (3000) |
| api | 4021 | `Z402_API_PORT` (4021) |
| llm | 4031 | `Z402_LLM_PORT` (4031) |
| markdown | 4032 | `Z402_MARKDOWN_PORT` (4032) |
| embeddings | 4033 | `Z402_EMBEDDINGS_PORT` (4033) |
| dropbox | 4034 | `Z402_DROPBOX_PORT` (4034) |
| facilitator | 4022 | no |
| discovery | 4030 | no, the website serves it at `/discovery/*` |
| zebra, zallet, zaino, llm-model, embed-model | 18232, 28232, 8137, 8080 | no |

Published ports bind to `Z402_PUBLISH_HOST`, `0.0.0.0` by default so a server serves them. On a laptop, or behind a
reverse proxy, set it to `127.0.0.1`. Behind a proxy, also set `MARKDOWN_TRUST_PROXY=uniquelocal` in
`services/markdown/.env`, or its per-client rate limit counts every client as the proxy. Docker's published ports
bypass `ufw`.

## Settings and API keys

- Compose settings (bind address, host ports, block time, price, models): copy `.env.example` to `.env`.
- A service's own settings and keys: `services/<name>/.env`, from `services/<name>/.env.example`. Compose reads
  `docker/env/<name>.env` first (the Docker defaults: the local model URLs, and limits that fit the local models), then
  this file, which wins. An empty value counts as unset, so `NAME=` brings back the service's own default. Leave out
  any `127.0.0.1` URL copied from the example: inside a container that is the container itself.
- On a server, set `PUBLIC_URL` in each `services/<name>/.env` to the origin agents reach it at (for example
  `https://llm.example.com`, or `http://203.0.113.7:4031`): it is the resource URL in every 402 and in discovery.
  Change it with the host port too.
- `HOST`, `PORT`, the network, the price, the facilitator URL and token, and the payTo are fixed by `compose.yaml` and
  cannot be changed from these files.

`docker compose up -d` recreates a service whose settings changed. After pulling new code:
`docker compose up -d --build`.

### A hosted model provider

`llm` and `embeddings` take any OpenAI-compatible API. In `services/llm/.env`:

```
LLM_BASE_URL=https://openrouter.ai/api/v1
LLM_API_KEY=...
LLM_MODEL=qwen/qwen-2.5-7b-instruct
LLM_MAX_PROMPT_CHARS=
```

In `services/embeddings/.env`:

```
EMBEDDINGS_BASE_URL=https://api.openai.com/v1
EMBEDDINGS_API_KEY=...
EMBEDDINGS_MODEL=text-embedding-3-small
EMBEDDINGS_MAX_INPUT_CHARS=
```

The empty lines lift the Docker limits that keep a call within the local models (1600 characters per prompt, 2000 per
embedded string), so the service's own defaults apply. Then leave the local models out in `.env` with
`Z402_LLM_MODEL_SCALE=0` and `Z402_EMBED_MODEL_SCALE=0`, and run `docker compose up -d`. A service is ready, and
charges, once its provider lists the model.

## The agent

```bash
docker compose run --rm agent --calls 20            # honest agent, one paid call per second
docker compose run --rm agent --calls 20 --cheat    # one deposit, then refused at its credit limit
docker compose run --rm discover                   # the service catalog, as an agent sees it (no wallet)
```

It pays from Zallet account 0. Each run first checks that the agent still holds 1 ZEC and tops it up if not.

## Stop, restart, wipe

- `docker compose stop` / `docker compose start`, or `docker compose restart`. After a reboot every service comes
  back by itself (`restart: unless-stopped`) and the one-shot jobs do not run again. A restart or a reboot starts
  every container at once: the services wait up to 2 minutes for the facilitator, and the API exits and comes back
  until it answers. Here all were healthy again after 30 s.
- `docker compose down -v` deletes every volume: chain, wallet, Zaino's index, merchant keys, facilitator ledger,
  drops and models. The next `up -d` starts a new chain from height 0.
- The chain and the facilitator ledger go together. The ledger records sessions and deposits by transaction id and
  height on one chain; a new chain reuses the heights and has none of those transactions, so a ledger kept from the
  old one credits deposits that do not exist. The wallet is tied to the chain the same way. Never delete one of the
  `chain`, `zallet`, `zaino` or `facilitator-data` volumes without the others.
- To start a new chain but keep the models and the merchant keys:

  ```bash
  docker compose down
  docker volume rm z402_chain z402_zallet z402_zaino z402_chain-info z402_facilitator-data z402_dropbox-data
  ```

Docker keeps container logs without limit unless the daemon sets a rotating default (`/etc/docker/daemon.json`,
`"log-opts": {"max-size": "10m", "max-file": "3"}`).

`node --test docker/test/` checks this setup without a running Docker daemon: start order, restarts, the smoke
service, image pins, file modes in the images and the limits that fit the local models.
