# Client-track research digest

2026-10-27 · client agent.

**Method.** A 25-agent research workflow covered 9 areas, then fact-checked them:
- x402 client;
- x402 merchant;
- Kage;
- Hanko;
- zingo-cli;
- wallet alternatives;
- Zcash protocol;
- testnet infrastructure;
- protocol design.

Each area's load-bearing claims were re-derived by an independent checker. A completeness critic then raised 6 gaps, each researched separately.

**Raw results.** About 1 MB of JSON, kept outside the repo: `/private/tmp/claude-501/-Users-oynozan-Desktop-Dev-Web3-z402/c930aa64-2dab-492b-a2a2-942f84f5d85a/scratchpad/research-result.json`.

**What this file covers.** Where this track **confirms**, **adds to** or **contradicts** the facilitator track's notes (`docs/research/*.md`), and what the client plan decided as a result. Tags: [ran] live probe, [src] source read, [inf] inference.

## 1. Confirmed independently (both tracks agree)

- **x402 SDK 2.28.0** (published 2026-09-29; canonical repo `x402-foundation/x402`; `coinbase/x402` is now a fork):
  - `SchemeNetworkClient` = `{ scheme, schemeHooks?, findDefaultAsset?, createPaymentPayload(x402Version, req, ctx?) }`.
  - The default spend controls reject asset `ZEC` unless the scheme implements `findDefaultAsset`.
  - `onPaymentResponse` gets `settleResponse` or `paymentRequired`. `{recovered:true}` buys exactly one retry, built from the **original** 402.
  - A final 402 is **returned**, not thrown.
  - Every call is two hops, and nothing is cached. [src: re-read by the client agent in the 2.28.0 sourcemaps]
- **Package layout.** The root `@x402/core` entry exports only `x402Version`; the APIs live on subpaths (`/types`, `/client`, `/http`, `/schemas`). The legacy `module` and `types` fields point at missing files, so resolve through `exports`. [src]
- **Chain.**
  - NU7 is live on testnet (4,465,026, branch `0x77190ad9`).
  - Blocks: 25 s target; measured mean 25.1–25.3 s, median 19 s, p90 53 s.
  - Orchard-receiver payments land as **Ironwood** outputs in v6 transactions.
  - ZIP 302 text memos.
  - A display txid must be byte-reversed for `TxFilter.hash`.
  - Mempool height is 0; the fork sentinel is `2^64−1`.
  - `expiryHeight` sits at bytes 16..20.
  - The ZIP 317 fee is 10,000 zat for a 2-action deposit.
- **Crates.** Stable `zcash_protocol 0.11.0` / `zcash_primitives 0.31.0` / `zcash_client_backend 0.25.0` (2026-10-21) parse NU7, so the build doc's "pre-release crates only" is stale.
- **Scheme id.** `prepaid-voucher` is free; `z402` is taken on npm. No `zcash` CAIP-2 namespace exists, and the community is split between `zcash:` and `bip122:`.

## 2. Added by this track (not in the facilitator notes)

### 2.1 Funding: no automated faucet is reliable on the NU7 chain [ran]
- **Valar** (0.125 TAZ per 24 h) has paid nobody since **2026-10-23 16:09 UTC**. Every claim fails with "the wallet cannot pay this address" (GitHub issue #5, no reply). *The facilitator track's notes still list Valar as the faucet.*
- **Fauzec** (1 TAZ per 24 h, API without captcha): its wallet follows the NU7 tip, but no NU7 drip has been publicly confirmed. One forum user reported drips landing on the dead pre-NU7 fork.
- **The only confirmed source in the last 72 h** is manual sends by ZecHub's `dismad`, on forum thread `https://forum.zcashcommunity.com/t/57087`. Replies came in 6 min to 7 h.
- **Ruled out:**
  - Jino Labs (waiting on a Zallet NU7 release);
  - the Skyhook bridge (522);
  - `faucet.zecpages.com`;
  - `testnet.zecfaucet.com`.
- **Verify a receipt** with `curl -s https://api.testnet.cipherscan.app/api/tx/<txid>`: version 6, `hasIronwood`, `isCanonical`. A 404 means the transaction is not on the NU7 chain.
- **Budget.** One demo run needs about 250,000 zat. 1 TAZ is about 400 runs.

### 2.2 zingo-cli: which build actually sent on NU7 testnet [src+inf]
- **The evidence commit.** The only observed post-NU7 testnet sends (Hanko, Kage and sibling repos, 2026-10-20 to 22) used zingolib **`0a5cb69abf1ea7e516fe50ca57f3fcdc446bd7ed`** (v7.0.0+263), a default **Nym** build with `nym-proxy` beside it.
- **The proven invocation** was one `execFile` per operation:
  ```
  zingo-cli --chain testnet --server https://testnet.zec.rocks:443 --data-dir <dir> --waitsync quicksend '[{"address","amount","memo"}]'
  ```
- **Nakednet.** `--no-default-features --features nakednet-test-mode` at that commit keeps the same command line, stdout JSON and exit codes. It drops the Nym startup wait and hedged sends to the dead zaino host. Nobody has sent with it yet.
- **Plan decision.** Build `0a5cb69` nakednet. Fall back to the `zingolib_v7.0.0` tag. **Not** `v8.0.0-rc.0`: it changed startup paths after the evidence commit, and no send with it is recorded. *The facilitator track recommended v8.0.0-rc.0; the facilitator does not use zingo-cli, so this is the client agent's call.*

### 2.3 zingo-cli behaviours that shape the adapter [src]
- **`--waitsync` and wallet creation.** `--waitsync` sets `shutdown_on_completion` **only when the wallet is created** in that session. A wallet created without it syncs continuously forever after, and every later one-shot `--waitsync` command blocks indefinitely. → Create the wallet with `--waitsync` on its first invocation.
- **stdout is not clean in one-shot mode.** Tracing ERROR events go to **stdout** (ANSI-coloured unless `NO_COLOR` is set). → Set `RUST_LOG=off` and `NO_COLOR=1`, then extract the JSON object from stdout.
- **A failed transmit can still be mined.** One of Kage's sends exited 1 with "Send error / Transmission error", yet the transaction was mined.
  - zingo keeps the record as `failed` and **frees its inputs**.
  - `transmit` refuses `failed` transactions, so they cannot be rebroadcast.
  - Recovery: `--offline messages "<memo>"` → JSON `{"value_transfers":[{txid,status,kind,memos,…}]}`. The filter is a **substring** match, so keep only `kind:"sent"` with an exact memo match. Then check `GetTransaction`.
  - Never resend after a transmit error.
- **Spend policy.** Symmetric 3 confirmations for all notes (`settings min_confirmations` changes it).
- **REPL prompt.** With `TERM` in {dumb, cons25, emacs}, the REPL prints a prompt even on a pipe. Moot, because the plan uses one-shot only.

### 2.4 testnet.zec.rocks is a load balancer with an edge cache [ran]
- **`GetLatestBlock` and `GetLightdInfo`** are served from an edge cache. It lagged the backends by 0–9.2 s: 1 block behind in about 15 % of samples, 2 blocks behind 4 times.
- **`GetTransaction`** is uncached and balanced per request across `eu-ams`, `gcp-34-107-39-34`, `na-jfk`, `na-lax` and `na-iah-zakura`. Two concurrent requests landed on different backends 45 % of the time.
- **Direct backend:** `na-lax.testnet.zec.rocks:443` (same operator; not on the status list).
- **First-sight skew across backends:** up to about 16 s. One backend answered NOT_FOUND 8 times over 3.7 s for a transaction another backend already held.
  - → The facilitator's first-sight window should be **30 s**, not 15 s.
  - → A deposit is "missing" only after definitive `-5` answers for **≥ 120 s and ≥ 2 new blocks**, ideally from ≥ 2 backends (the `x-backend` header).
- **Confirmation is backend-consistent.** No backend reported a transaction mined later than it served the block (0 anomalies in 183 samples). So "mined per `GetTransaction`" is consistent across backends within about 1 s.
- **Reorgs.** Zakura saw 21 reorgs in 24 h on 2026-10-26. Keep re-checking 1-conf deposits until final.

### 2.5 Fallback infrastructure [src+ran]
- **No independent public NU7 indexer exists:**
  - zaino: 503;
  - cipherscan: HTTP JSON only;
  - zec.pro: 521;
  - zecdev: stuck on NU6.3.
- **Self-hosted warm standby:**
  - `zfnd/zebra:7.0.0` from the ZFND testnet snapshot (11.4 GiB, height 4,531,081, 2026-10-23);
  - lightwalletd **v0.6.0 `--nocache`**;
  - both Hanko (`ZPV_LWD_URL`) and a nakednet zingo-cli (`--server`) can use it unpatched.
  - Not Zaino 0.10.1, which has a placeholder NU7 branch id.
- **Regtest** needs patches on both sides; last resort.

### 2.6 Other
- **Ed25519.** `node:crypto` raw key formats exist from Node 24.15 / 26; the DER-prefix import works on Node 22+. Node 26.5+ rejects small-order EdDSA points in `verify`.
- **Possible deadline.** If z402 targets the same Zecathon as Kage, the stated deadline is **2026-10-28 23:59 UTC**. [inf; confirm with the user]

## 3. Contradictions and resolutions

| Topic | Tracks said | Resolution |
|---|---|---|
| zingo-cli pin | facilitator: `v8.0.0-rc.0`; client: `0a5cb69` / `v7.0.0` | `0a5cb69` nakednet (evidence of real sends); fallback `v7.0.0` |
| Adapter mode | facilitator: long-lived REPL; client research: one-shot (the proven invocation) | **One-shot.** The REPL plus a wallet created with `--waitsync` would stop syncing after the first sync. |
| Faucet | facilitator: Valar | Valar is down since 10-23; use dismad (forum) and try Fauzec |
| First-sight window | build doc 15 s | Recommend 30 s (facilitator's call; `depositWaitMs`) |
| Missing-deposit rule | protocol.md v0-draft: ≥ 3 not-founds over ≥ 60 s | Propose ≥ 120 s and ≥ 2 new blocks (contract change pending ACK) |
| Scheme id candidates | some areas: `batch-settlement` | `prepaid-voucher` (semantics differ: value moves first) |
| Build-doc demo | "local speed" and "never stalls" | Contradictory at 25 s blocks; resolved by option A (p = 500 at 1 call/s), the user's decision |

## 4. Open after research (need execution)

- A real Nym-free zingo-cli send: its latency and its exact stderr text.
- Whether a TAZ request is answered in time.
- Whether the facilitator's decryptor sees our first deposit inside its window.
