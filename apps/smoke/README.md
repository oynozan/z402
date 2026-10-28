# @z402/smoke

Proves that paid calls work against the four running starter services. It pays one call on each route the way the demo agent does (Zallet, lightwalletd, the prepaid-voucher scheme, the stock `@x402/fetch` wrapper), checks every answer against the contract (`docs/superpowers/specs/2026-10-27-z402-services-design.md`, section 4), prints one line per step and exits 0 only if every step passed.

## Run

After `docker compose up -d`, from the repository root:

```bash
docker compose run --rm smoke
docker compose run --rm smoke --page https://example.org    # a flag given again wins over compose's own
```

The service runs `node --import tsx apps/smoke/src/main.ts` with the flags that reach the services and the wallet inside the compose network:

```
--llm http://llm:4031 --markdown http://markdown:4032 --embeddings http://embeddings:4033 --dropbox http://dropbox:4034
--zallet-url http://zallet:28232 --lightwalletd http://zaino:8137
```

Locally against the Z3 regtest stack, whose defaults every wallet flag has:

```bash
pnpm --filter @z402/smoke start -- --llm http://127.0.0.1:4031 --markdown http://127.0.0.1:4032 \
  --embeddings http://127.0.0.1:4033 --dropbox http://127.0.0.1:4034
```

Each run opens a session of its own with each merchant it pays, so it makes one deposit per merchant (the 100,000 zat window and the fee, spent from Zallet account 0), and then pays each call at the price its service asks. With the services' own prices (200 zat a chunk, 1,000 a page, 100 an embedding call, 500 a drop box upload or hold) the seven paid calls of a full run cost 2,700 zat. The markdown step needs the markdown service to reach `--page` from where it runs; with no internet that step fails with `502 fetch_failed`, and is not charged.

A service without its flag is skipped, and a run with no service at all is a flag error, so it cannot pass by checking nothing. `--help` lists the flags: `--page` (the page the markdown service fetches, `https://example.com`), `--network` (`zcash:regtest`), `--zallet-url`, `--zallet-user`, `--zallet-password`, `--lightwalletd`. The password is a flag, so it shows in the process list; the default is the public regtest one.

## Steps

| Service | Step | Call | Passes when |
| --- | --- | --- | --- |
| llm | `start`, `continue` | `POST /v1/generate` `{"prompt":"Tell a short story about a lighthouse keeper.","maxTokens":96}`, then `{"stream"}` until `done` or 3 chunks in all | each answer is the next chunk of the same stream, with text |
| markdown | `get` | `GET /v1/markdown?url=<page>` | the answer has markdown and a length; the line shows the title |
| embeddings | `embed` | `POST /v1/embeddings` `{"input":["hello world","zcash"]}` | two vectors of `dimensions` finite numbers each |
| dropbox | `upload`, `hold` | `POST /v1/drops` with a synthetic age v1 file, then `POST /v1/drops/<id>/hold` | `201` with a safe id and a delete token, then an expiry that moved out |
| dropbox | `fetch` | free `GET /v1/drops/<id>` | the bytes are the upload, byte for byte, and `X-Expires-At-Height` is the hold's expiry |
| dropbox | `delete` | free `DELETE /v1/drops/<id>` with the delete token | `204`, and the drop is then `404` |

The synthetic file is the header of one X25519 recipient (`age-encryption.org/v1`, a `-> X25519` stanza, a `---` MAC line) and 1024 random bytes. No key opens it, but the drop box only checks the shape. The drop is deleted at the end, and also when the hold or the fetch failed.

## Output

A failing run, shortened:

```
llm start 200 31842 ms chunk 0 "Once upon a time, there lived a lighthouse keeper named Elias." (200 zat)
llm continue 200 1910 ms chunk 1 " Every night he climbed the stairs to light the lamp" (200 zat)
markdown get 502 15012 ms FAIL expected 200, got 502: fetch_failed (not charged)
embeddings embed 413 12 ms FAIL expected 200, got 413: too_many_tokens (not charged)
dropbox upload 201 40 ms id q3Zs0mYbT7cWpAxK1nGhUw, 1192 bytes, held until block 1052 (500 zat)
dropbox hold 200 31 ms held until block 1062 (500 zat)
dropbox fetch 200 5 ms 1192 bytes identical, expires at block 1062
dropbox delete 204 4 ms deleted, then 404
session uregtest1etw…35axkz cumulative 1400 zat after 4 paid calls
smoke FAILED: 2 of 8 steps failed (markdown get, embeddings embed)
```

`<service> <step> <status> <ms> ms <detail>`, where the status is the HTTP status (`ERR` when there was none) and `ms` the time of the whole step, a first deposit included. A paid step that passed ends with what that call cost, which is its service's price. A failed step says `FAIL` and why. For a paid call it also says whether it was charged: a refusal before the voucher costs nothing, while a failure after it is counted by the stock client and paid for with its next voucher (spec section 3.4), so `charged` marks a service that should have refused earlier. The last lines give what each session vouchered in all, one line per merchant (services that share a merchant share its session and its deposit), and the verdict. Here markdown refused before the voucher, so its merchant (provider 2) never got a session; with two merchants paid, the run's paid-call count comes once, on its own line under the sessions. These lines go to stdout. The payment client's progress (the wallet balance, the deposit and its confirmation, which can take a minute on regtest) goes to stderr, as do errors.

Exit status: `0` every step passed, `1` a step failed or the wallet could not be used (unreadable, or under 125,000 zat for one deposit), `2` a flag error. Ctrl-C (exit 130) or SIGTERM (143) gives up on the call in flight, closes the wallet and ends the run; a second signal quits at once. An uploaded drop is then left to expire.

## What it does not trust

- A route that answers without a payment receipt (`PAYMENT-RESPONSE`) was never paid, and fails its step.
- Free routes use the plain `fetch`, never the paying one, so a free route that asks for payment fails its step instead of being paid.
- Redirects are never followed: a paid request carries a voucher, which must not go anywhere but the URL given.
- Text from a service is cut to one line without control characters, escapes or reordering marks before it is printed, and a body is read only up to a limit.
- The drop id goes into a URL only if it is a plain base64url id.

## Tests

```bash
pnpm exec tsc --noEmit
pnpm exec vitest run
```

The flow tests make real paid calls in-process (`@z402/service-kit/testing`: the real facilitator on a FakeChain, a MockWallet, the stock client) against four minimal fakes of the services with the real routes and answer shapes, and break them one way at a time, a voucher the facilitator refuses included. `test/main.test.ts` and `test/e2e.test.ts` run `src/main.ts` as a process: against a fake Zallet that answers the balance, and against one that puts the deposit on the facilitator's FakeChain, so the real `ZalletRpcWallet` pays for a full four-service run, a failing one and an interrupted one.
