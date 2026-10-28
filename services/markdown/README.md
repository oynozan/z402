# @z402/service-markdown

URL to markdown, one page per paid call (design §4.2, port 4032).

```
GET /v1/markdown?url=<http(s) URL>
→ { "url", "finalUrl", "title", "byline", "markdown", "length", "truncated" }
```

`finalUrl` is where the page came from after redirects, `length` counts the characters of `markdown`, and `truncated`
is true when the page held more than `MARKDOWN_MAX_MARKDOWN_BYTES`. `title` and `byline` may be null.

## Run

```bash
cp .env.example .env    # set Z402_FACILITATOR_URL, the token and Z402_PAY_TO
pnpm --filter @z402/service-markdown start
```

The ready line is `markdown listening on http://127.0.0.1:4032 network=zcash:regtest`. In Docker, `compose.yaml` runs
it and sets the shared `Z402_*` variables; `services/markdown/.env` still sets the `MARKDOWN_*` ones.

## Refused before payment

The page is fetched and converted on the client's unpaid first attempt, then cached for `MARKDOWN_CACHE_MS`; the paid
retry is answered from the cache and never fetches again. A page that cannot be served is refused on that first
attempt, before any voucher exists, so it is never charged:

| Status | `error` | When |
| --- | --- | --- |
| 400 | `invalid_url` | no `url`, not an absolute http(s) URL, credentials in it, or a port outside `MARKDOWN_ALLOWED_PORTS` |
| 403 | `blocked_address` | the host, or a redirect, leads to an address that is not public |
| 413 | `too_large` | a body over `MARKDOWN_MAX_BYTES` (also once decompressed), or a page too heavy to convert |
| 415 | `unsupported_content_type` | not `text/html`, `application/xhtml+xml` or `text/plain` |
| 429 | `rate_limited` | over `MARKDOWN_RATE_PER_MIN` fetches a minute from this IP, with `Retry-After` |
| 502 | `fetch_failed` | DNS or connection failure, too many redirects, or an upstream status of 400 or more (`upstreamStatus`) |
| 502 | `convert_failed` | the page could not be converted |
| 503 | `busy` | `MARKDOWN_MAX_CONCURRENT` fetches running, or the cache full of pages held for paid retries (`Retry-After: 1`) |
| 504 | `fetch_timeout` | no complete answer within `MARKDOWN_TIMEOUT_MS` |

The rate limit counts fetches, not requests: only a cache miss takes a token (a miss that joins a fetch of the same
URL already running takes none). An unpaid attempt and its paid retry therefore cost one token, and a cached page is
never refused for the limit. Behind your own proxy, set `MARKDOWN_TRUST_PROXY` to the number of proxies in front, or
their addresses, so that the limit sees client IPs; `true` is refused, since Express would then take the left-most
`X-Forwarded-For` address, which the client writes itself.

A failure after the voucher counts as paid for the client, so the paid retry must find the page. A page that answered
an unpaid attempt is held for that client's paid retry for `MARKDOWN_CACHE_MS`: other clients' pages cannot push it
out, and a paid request is still answered from it once it is too old for an unpaid attempt, which fetches it again. A
page that finds no room next to the held ones is refused as `busy` on its unpaid attempt. A client holds four pages at
most, its oldest hold going first, so filling the cache takes many clients.

## SSRF guard

- Only `http:` and `https:`, no user or password, and the port (explicit or default) must be allowed.
- Names are resolved through c-ares with the system's DNS servers, A and AAAA, and the lookup is cancelled at the fetch
  deadline. Not `getaddrinfo`: it cannot be stopped, and it runs on the libuv threadpool that zlib and the
  facilitator's own lookups share. So `/etc/hosts` is not read; `localhost` and every name under it are refused
  without asking.
- Every address the host resolves to must be public unicast: not private, loopback, link-local (169.254/16, cloud
  metadata), CGNAT, unique-local, multicast, reserved, unspecified, broadcast, documentation or benchmarking, and no
  IPv4-mapped (judged as the IPv4 it maps), IPv4-compatible, NAT64, 6to4 or Teredo address. An IP literal is judged
  at once; a name with one bad address among good ones is refused.
- The connection is pinned to the checked addresses through the socket's `lookup`, so DNS rebinding cannot change
  where it goes. Redirects are followed one hop at a time, at most `MARKDOWN_MAX_REDIRECTS`, each checked again.
- Each request has an agent of its own: no pooled socket, and no proxy from `HTTP_PROXY` or `HTTPS_PROXY`, even with
  `NODE_USE_ENV_PROXY` set. One deadline covers the lookups, connections, redirects and body, whatever the upstream
  answers (a `101` included).
- Requests carry fixed headers only (User-Agent, Accept, Accept-Encoding): no cookies, nothing from the caller. The
  site sees this server's IP.

## Conversion

jsdom on the final URL (scripts never run, nothing else is loaded), Readability for the main content (the whole body
when it finds none, or when the document is more than 64 levels deep or 40,000 elements large), links and images made
absolute (other schemes dropped), then turndown with `#` headings, fenced code and `-` bullets; scripts, styles,
`noscript`, iframes and forms are removed. The title and the byline are cut at 1 KiB each. The charset comes from a
byte order mark, `Content-Type` or a `<meta>` tag, else UTF-8. `text/plain` is returned as it is.

Conversions run on worker threads, `MARKDOWN_CONVERT_WORKERS` of them, each with a heap of `MARKDOWN_WORKER_HEAP_MB`
and the `MARKDOWN_TIMEOUT_MS` deadline. A page that runs out of either ends only its worker and is refused as
`too_large`, so the server itself never stalls or runs out of memory. The heap also sets the page budget,
(heap − 64) × 300 start tags (38,400 by default, while long Wikipedia articles have about 22,000), and nesting deeper
than 512 elements is refused.

Memory: about 330 MB idle with its one warm worker, and a busy worker can add up to its heap. With the defaults the
very worst page brings that to about 520 MB, so 512 MB only just holds it and 768 MB leaves room.

## Environment

The shared variables are in the kit (`Z402_NETWORK`, `Z402_FACILITATOR_URL`, `Z402_FACILITATOR_TOKEN[_FILE]`,
`Z402_PAY_TO[_FILE]`, `Z402_PRICE_ZAT`, `PUBLIC_URL`, `HOST`, `PORT`). This service's own, each explained in
`.env.example`:

| Variable | Default |
| --- | --- |
| `MARKDOWN_ALLOWED_PORTS` | `80,443,8080,8443` |
| `MARKDOWN_MAX_BYTES` | `5242880` (5 MiB) |
| `MARKDOWN_MAX_MARKDOWN_BYTES` | `1048576` (1 MiB) |
| `MARKDOWN_TIMEOUT_MS` | `15000` |
| `MARKDOWN_MAX_REDIRECTS` | `5` |
| `MARKDOWN_RATE_PER_MIN` | `30` |
| `MARKDOWN_MAX_CONCURRENT` | `4` |
| `MARKDOWN_CONVERT_WORKERS` | `1` |
| `MARKDOWN_WORKER_HEAP_MB` | `192` |
| `MARKDOWN_CACHE_MS` | `60000` |
| `MARKDOWN_CACHE_ENTRIES` | `100` |
| `MARKDOWN_CACHE_BYTES` | `33554432` (32 MiB) |
| `MARKDOWN_USER_AGENT` | `z402-markdown/0.1` |
| `MARKDOWN_TRUST_PROXY` | off |

A bad value stops the start with exit 1 and a `markdown: <VARIABLE>: ...` line on stderr.

## Tests

```bash
pnpm --filter @z402/service-markdown test
pnpm --filter @z402/service-markdown typecheck
```

The service tests make real paid calls in-process (the kit's test stack) against a local page server, with the address
policy relaxed for 127.0.0.1 only. `main.test.ts` runs `src/main.ts` under tsx, the way production does, and checks
that the strict policy refuses internal addresses.
