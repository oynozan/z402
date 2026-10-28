# @z402/service-embeddings

Text embeddings for agents, billed per call: one paid call embeds up to about 1,000 tokens. It asks any OpenAI-compatible provider (Ollama by default) and answers in the OpenAI shape. Design: `docs/superpowers/specs/2026-10-27-z402-services-design.md` §4.3.

`POST /v1/embeddings` costs 100 zat, or `Z402_PRICE_ZAT` when set, and is paid with `prepaid-voucher` through `@z402/service-kit`. While the provider lists the model, the route is declared to the facilitator's catalog every 30 s.

```json
{ "input": "The quick brown fox" }
```

`input` is a string or an array of 1 to `EMBEDDINGS_MAX_INPUTS` strings. The answer:

```json
{
  "object": "list",
  "model": "nomic-embed-text",
  "dimensions": 768,
  "data": [{ "object": "embedding", "index": 0, "embedding": [0.0123, -0.0456, "..."] }],
  "usage": { "prompt_tokens": 5, "total_tokens": 5 }
}
```

`usage` is the provider's. A provider that reports none gets an estimate (about 4 characters a token) and `"usageEstimated": true`. The provider sees the text, which with the default Ollama is the operator's own machine.

## Refused before payment

These are answered on the unpaid first attempt, so no voucher is sent and nothing is counted:

| Status | Body | When |
| --- | --- | --- |
| 400 | `{ "error": "invalid_request", "message" }` | The body is not JSON, or `input` is missing, not a string or array of strings, too many strings, or holds an empty or blank string or one with an unpaired surrogate (`"\ud800"`), which is not text and which a strict provider refuses to parse |
| 413 | `{ "error": "too_many_tokens", "maxChars" }` | The inputs hold more than `EMBEDDINGS_MAX_CHARS` characters in total or one string holds more than `EMBEDDINGS_MAX_INPUT_CHARS`, counted in Unicode code points (an emoji is one), or the body is over 256 kB, or over 12 bytes for each of `EMBEDDINGS_MAX_CHARS` when that is more, which is what a call at the cap weighs when a client writes every character as an escape |
| 405 | `{ "error": "method_not_allowed" }` | Any method but POST |
| 503 | `{ "error": "not_ready" }` | The provider is down or does not list the model (checked about every 10 s) |

After payment a call fails only when the provider does: `502 { "error": "provider_failed" }`. The client counts such a call, which is why the 503 above exists. A call is never failed for being long.

The provider is trusted to be up and not to be right: its answer is read up to 1 MiB plus 256 KiB for each input (8 MiB for the model list) and cut off there, an error status is not read at all, and a list that does not hold one finite vector of the same length for each input, by a distinct index, is refused as a failure of the provider.

## Settings

An empty variable counts as unset, and a bad one stops the start with a line naming it. The shared `Z402_*`, `PUBLIC_URL`, `HOST` and `PORT` (4033) are in `packages/service-kit`. `Z402_PRICE_ZAT` replaces the 100 zat price of a call, from 1 to the facilitator's `windowZat`.

| Variable | Default | Meaning |
| --- | --- | --- |
| `EMBEDDINGS_BASE_URL` | `http://127.0.0.1:11434/v1` | The provider's OpenAI-style base URL, without credentials |
| `EMBEDDINGS_API_KEY` | none | Sent as a bearer token. `EMBEDDINGS_API_KEY_FILE` reads it from a file instead |
| `EMBEDDINGS_MODEL` | `nomic-embed-text` | The service is ready only while the provider lists it (`name` and `name:latest` are one model) |
| `EMBEDDINGS_MAX_CHARS` | `4000` | Most characters in one call, summed over all inputs (1 to 60000). Keep it within the model's context, since a provider that rejects a long input can only do so after payment |
| `EMBEDDINGS_MAX_INPUT_CHARS` | unlimited | Most characters in one input string (1 to 60000). A local model with a short context needs it: Docker sets 2000 for the bundled model, whose limit is 2048 tokens per string |
| `EMBEDDINGS_MAX_INPUTS` | `64` | Most strings in one call (1 to 2048) |

## Run and test

```bash
ollama pull nomic-embed-text
cd services/embeddings
cp .env.example .env    # set Z402_FACILITATOR_URL and Z402_PAY_TO in it
node --env-file=.env --import tsx src/main.ts
```

The ready line goes to stdout, logs to stderr. `pnpm test` needs no provider: it runs a fake one, the real facilitator and a paying client in-process, plus `src/main.ts` as a child process.
