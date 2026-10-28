# @z402/service-dropbox

An encrypted drop box for agents, on port 4034. One agent uploads an [age](https://age-encryption.org)-encrypted file, hands the id to another agent, and the file is held for a number of blocks. Design: `docs/superpowers/specs/2026-10-27-z402-services-design.md` section 4.4.

| Route | Cost | Answer |
| --- | --- | --- |
| `POST /v1/drops` | one call (`Z402_PRICE_ZAT`) | `201 { id, deleteToken, size, tip, expiresAtHeight }`, held for 10 blocks |
| `POST /v1/drops/:id/hold` | one call | `200 { id, tip, expiresAtHeight }`, 10 blocks more, at most 1000 past the tip |
| `GET /v1/drops/:id` | free | the bytes, with an `X-Expires-At-Height` header |
| `DELETE /v1/drops/:id` | free | `204`, with `Authorization: Bearer <deleteToken>` |

A drop is gone once the chain tip reaches its `expiresAtHeight`, so time is counted in blocks. The id is all it takes to fetch a drop and the delete token, which only the upload's answer carries, is all it takes to delete it. The server keeps a SHA-256 of the token and never the token.

## Make the file

```bash
age-keygen -o key.txt                      # prints the public key, age1...
age -r age1... -a -o note.age note.txt     # -a writes ASCII armor, leave it out for binary
```

From code, with the [`age-encryption`](https://www.npmjs.com/package/age-encryption) package (typage):

```ts
import { Encrypter } from "age-encryption";

const e = new Encrypter();
e.addRecipient("age1...");
const file = await e.encrypt(plaintext); // upload these bytes as the body
```

Pay with any x402 client that has the `prepaid-voucher` scheme registered, as `apps/agent` does:

```ts
const res = await paidFetch("http://127.0.0.1:4034/v1/drops", { method: "POST", body: file });
const { id, deleteToken, expiresAtHeight } = await res.json();
```

## Refused before payment

Everything that can be refused is refused on the unpaid first attempt, before a voucher exists, so a refused call costs nothing.

| Status | `error` | When |
| --- | --- | --- |
| 400 | `empty_body` | The upload has no body |
| 413 | `too_large` | The body is over `DROPBOX_MAX_BYTES` |
| 415 | `not_encrypted` | The body is not age-shaped, `reason` says why |
| 507 | `storage_full` | The drops on disk would pass `DROPBOX_MAX_TOTAL_BYTES` |
| 404 | `unknown_drop` | A hold for a drop that is unknown or expired |
| 409 | `hold_cap_reached` | A hold would take the drop past `DROPBOX_MAX_HOLD_BLOCKS` beyond the tip, `maxHoldBlocks` says how many |
| 503 | `not_ready` | The chain tip is not known |

A drop is stored when the paid call reaches the handler and removed again if the call then fails to deliver, for example when the facilitator refuses to settle. A hold is applied only once its call was delivered.

## The age check is a plausibility check

An upload must start with the age v1 header (`age-encryption.org/v1`, recipient stanzas, a header MAC line) or be the ASCII armor of one, and its payload must be at least 32 bytes and look like ciphertext (an entropy of at least 7 bits per byte from 512 bytes up, and enough distinct byte values below that). This is not proof of encryption. The header MAC cannot be checked without the file key, and nothing can tell ciphertext from random bytes, so someone can wrap garbage or plaintext in that shape and get it stored. What the check catches is the honest mistake of uploading plaintext, JSON or a key file.

## Run

Needs the facilitator (`Z402_FACILITATOR_URL`) and a lightwalletd endpoint (Zaino, `DROPBOX_LWD_URL`) for the chain tip. Without a tip the service starts, answers `/health` with 503 and refuses paid calls until lightwalletd answers. While the tip is unknown, fetch and delete keep working and nothing expires. One process per `DROPBOX_DIR`.

```bash
cp .env.example .env   # fill in Z402_PAY_TO and Z402_FACILITATOR_TOKEN
pnpm exec tsx --env-file=.env src/main.ts
```

Under `docker compose up` the service is configured by `docker/env/dropbox.env` and then this directory's `.env`, which wins. Compose sets the facilitator, the payTo, the port and the price itself, and puts `DROPBOX_DIR` on the `dropbox-data` volume and `DROPBOX_LWD_URL` at Zaino, so leave those two commented out in `.env` there.

The ready line goes to stdout, the logs to stderr:

```
dropbox listening on http://127.0.0.1:4034 network=zcash:regtest dir=/.../.data/dropbox
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `DROPBOX_DIR` | `.data/dropbox` | Where the drops live, as `<id>.age` and `<id>.json`. A relative path is relative to the working directory. |
| `DROPBOX_MAX_BYTES` | `1048576` | Largest upload |
| `DROPBOX_MAX_TOTAL_BYTES` | `268435456` | Largest total of all stored uploads |
| `DROPBOX_BLOCKS_PER_CALL` | `10` | Blocks one paid call buys |
| `DROPBOX_MAX_HOLD_BLOCKS` | `1000` | A drop is never held more than this many blocks past the tip |
| `DROPBOX_LWD_URL` | `http://127.0.0.1:28137` | lightwalletd gRPC endpoint, plaintext for `http://` |
| `DROPBOX_TIP_POLL_MS` | `10000` | How often the tip is read, at most 30000 |

The variables every paid service shares (`Z402_*`, `PUBLIC_URL`, `HOST`, `PORT`) are in `.env.example` and in section 3.1 of the design. Every problem exits 1 with a `dropbox: ...` line that names the variable at fault.

## Test

```bash
pnpm exec tsc --noEmit
pnpm exec vitest run
```

The service tests make real paid calls through the in-process stack of `@z402/service-kit/testing`. `test/fixtures.ts` holds files written by the age reference implementation, with keys that were thrown away.
