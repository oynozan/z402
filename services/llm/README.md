# @z402/service-llm

LLM inference sold per output chunk, on port 4031. Each paid call (`Z402_PRICE_ZAT`, 500 zat by default) returns one chunk of about `LLM_CHUNK_TOKENS` tokens, streamed from any OpenAI-compatible `chat/completions` API (Ollama by default), so an agent stops paying as soon as it has enough.

The operator sees the prompts and the output.

## Route

`POST /v1/generate`, JSON body:

| Call | Body |
| --- | --- |
| Start | `{"prompt": "...", "system": "...", "maxTokens": 256}` (`system` and `maxTokens` optional) |
| Continue | `{"stream": "<id from the last answer>"}` |

Answer: `{"stream": "<id>", "index": 0, "text": "...", "done": false}`. The last chunk has `"done": true` and the provider's `finishReason`, such as `"stop"` or `"length"`. A provider that sends more than `maxTokens` deltas, or more than 256 characters a token, is cut off there with `"length"`.

An unpaid call gets the 402, whose offer is base64 JSON in the `PAYMENT-REQUIRED` header:

```bash
curl -si http://127.0.0.1:4031/v1/generate -H 'content-type: application/json' \
  -d '{"prompt":"Write a haiku about privacy."}'
```

Refused before payment, so never charged:

| Status | `error` |
| --- | --- |
| 400 | `invalid_request` (with a `message`), also for text with a lone surrogate, which providers refuse |
| 404 | `unknown_stream` |
| 409 | `stream_busy`: another call on this stream is in flight; `payment_in_flight`: the same voucher is already paying for a call |
| 410 | `stream_finished`: every chunk was delivered |
| 413 | `body_too_large` |
| 502 | `provider_failed`: the stream's generation failed |
| 503 | `too_many_streams`, or `not_ready` while the provider does not list `LLM_MODEL` |

After payment, rare, never settled but counted by the client: 502 `provider_failed`, 504 `chunk_timeout`, 503 `too_many_streams` when paid starts that all found room arrive together at the limit, and 503 `stream_closed` while the service shuts down.

`GET /health` answers 200 once the provider lists `LLM_MODEL` as loaded, 503 otherwise.

## Environment

Every variable, with its default and a comment, is in `.env.example`. The service reads `services/llm/.env` when it exists; a variable set in the environment wins. An empty value counts as unset, and a bad one stops the start with an `llm: ...` line naming it.

Under Docker, compose reads `docker/env/llm.env` (llama.cpp server at `http://llm-model:8080/v1`, model `qwen2.5-0.5b-instruct`) and then `services/llm/.env`, which wins. A hosted provider and its key go there.

| Variable | Default | Meaning |
| --- | --- | --- |
| `Z402_FACILITATOR_URL` | none | Required |
| `Z402_PAY_TO` / `_FILE` | none | Required, the facilitator's merchant address |
| `Z402_FACILITATOR_TOKEN` / `_FILE` | none | The facilitator's bearer token |
| `Z402_NETWORK`, `Z402_PRICE_ZAT` | `regtest`, `500` | Must match the facilitator |
| `PUBLIC_URL`, `HOST`, `PORT` | `http://localhost:4031`, `127.0.0.1`, `4031` | |
| `LLM_BASE_URL` | `http://127.0.0.1:11434/v1` | OpenAI-compatible API root |
| `LLM_API_KEY` / `_FILE` | none | Sent as a bearer token when set |
| `LLM_MODEL` | `qwen2.5:0.5b` | `name` also matches `name:latest` |
| `LLM_CHUNK_TOKENS` | `32` | Tokens per paid chunk, 1 to 512 |
| `LLM_MAX_TOKENS` | `1024` | Output cap per stream, 1 to 32768 |
| `LLM_MAX_PROMPT_CHARS` | `8000` | For the prompt and the system prompt each |
| `LLM_MAX_STREAMS` | `64` | Streams live at once |
| `LLM_STREAM_IDLE_MS` | `600000` | An idle stream is dropped and its generation stopped |
| `LLM_CHUNK_TIMEOUT_MS` | `60000` | Wait for one chunk, at most 60000 |

## Run

Start the facilitator first, then, from the repository root:

```bash
ollama pull qwen2.5:0.5b
cp services/llm/.env.example services/llm/.env   # set Z402_PAY_TO
Z402_FACILITATOR_TOKEN="$(cat .data/manual-token)" pnpm --filter @z402/service-llm start
```

```
llm listening on http://127.0.0.1:4031 model=qwen2.5:0.5b network=zcash:regtest
```

Another provider only needs `LLM_BASE_URL`, `LLM_API_KEY` and `LLM_MODEL`, for example `https://openrouter.ai/api/v1`. The 402 note says "Open-weights model.", so pick one.

`pnpm --filter @z402/service-llm test` runs the tests against a fake provider and an in-process facilitator.
