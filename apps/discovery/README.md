# @z402/discovery

The Bazaar catalog of the z402 services. It asks each service for its unpaid 402 and serves what it learns at `GET /discovery/resources`, which the stock x402 client reads unchanged:

```ts
const bazaar = withBazaar(new HTTPFacilitatorClient({ url: "http://127.0.0.1:4030" })).extensions.bazaar;
const { items } = await bazaar.listResources({ type: "http" });
```

It is its own process on purpose. It never holds a key, and a service that hangs, lies or dies can only fail its own probe: every request has a deadline, every failure is caught, and nothing a service sends reaches a log line unchecked. There is no `/discovery/search`, because a server that matches intents learns what every agent wants. Agents pull the list and pick on their own machine.

## Run it

```bash
DISCOVERY_SERVICES=http://127.0.0.1:4031,http://127.0.0.1:4032 \
DISCOVERY_TARGETS="GET http://127.0.0.1:4021/chunk" \
pnpm --filter @z402/discovery start
```

The first refresh runs before the port opens, so the ready line means the catalog is filled with whatever was up. The line goes to stdout and the logs to stderr:

```
discovery listening on http://127.0.0.1:4030 services=2
```

SIGINT and SIGTERM close it (exit 1 if that takes more than 5 s). The logs say when a service goes down, comes back, stops being ready or fails a route probe, and do not repeat a line while nothing changes.

## Environment

An empty variable counts as unset. A problem exits 1 with a `discovery: ...` line on stderr that names the variable and never quotes a URL, which could carry credentials.

| Variable | Default | Meaning |
| --- | --- | --- |
| `DISCOVERY_SERVICES` | none | Comma-separated URLs of services built on `@z402/service-kit`, for example `http://llm:4031,http://markdown:4032`. At least this or `DISCOVERY_TARGETS` is required. |
| `DISCOVERY_TARGETS` | none | Comma-separated `METHOD url` entries for paid routes that are not built on the kit, for example `GET http://api:4021/chunk`. They get the route probe only, and are listed after the services. |
| `DISCOVERY_REFRESH_MS` | `30000` | Time between refreshes, 1000 or more. While anything is down or not ready the next one comes after 5 s at most, so a service that starts late is listed quickly. |
| `DISCOVERY_TIMEOUT_MS` | `5000` | The deadline of each request, body included. |
| `HOST` | `127.0.0.1` | The address to listen on. |
| `PORT` | `4030` | 0 to 65535, where 0 picks a free port. |

## Endpoints

| Request | Answer |
| --- | --- |
| `GET /discovery/resources?type&payTo&scheme&network&extensions&limit&offset` | `{ x402Version: 2, items, pagination: { limit, offset, total } }`. The filters are exact. `payTo`, `scheme` and `network` must hold for one offer of the item together, `extensions` is a key the item carries. `limit` is 1 to 1000 (default 100), `offset` 0 or more, and anything else is a 400. |
| `GET /discovery/status` | An array with one entry for each `DISCOVERY_SERVICES` entry, in order, as below. |
| `GET /health` | `{ ok: true, items }` |
| `GET /discovery/search` | 404 `{ error: "not_supported", ... }` |
| anything else | 404 `{ error: "not_found" }` |

Answers carry `Access-Control-Allow-Origin: *`, and a browser preflight is answered. The two catalog endpoints send `Cache-Control: max-age=5`, and `/health` and every error send `no-store`.

An item has the shape of the Bazaar's `DiscoveryResource`: `resource` (the URL from the 402), `type: "http"`, `x402Version`, `accepts`, `lastUpdated` (when its last good probe was), `description`, `mimeType`, `serviceName`, `tags`, `iconUrl` and `extensions` (the bazaar declaration and the kit's `z402: { unit, note }`, as received). The order is the order of the configuration, then the order of each service's routes.

A status entry is `{ serviceName, url, up, ready, latencyMs, checkedAt, callsToday, unit, priceZat }`. `url` is the public origin taken from the service's resource URLs, `unit` is what one call to its first route buys, and `callsToday` is the kit's count of paid calls since 00:00 UTC. `up` means `/health` answered 200 or 503 with a kit health, `ready` is what the service says. A service that was never reachable has `null` for everything it has not told, and one that is down keeps its name, `url`, `unit` and `priceZat` with `up: false`, `latencyMs` and `callsToday` null.

## What a refresh does

For each service, all in parallel, `GET {service}/health` says which routes it has (`routes: [{ method, path, probePath?, unit }]`). Then each route gets an unpaid request with its method to `probePath ?? path`, with `Accept: application/json`, `X-Z402-Probe: 1` and no body. The probe header makes a kit service skip its own request checks and answer the 402. The answer has to be a 402 with a `PAYMENT-REQUIRED` header that decodes to x402 version 2 with an `accepts` entry and an http(s) `resource.url`, and its `bazaar` extension, if any, has to pass the Bazaar's spec check. The service name, tags and icon go through the Bazaar's own sanitizer.

The 402 also has to be about the route that was probed, and small, shallow and printable, because the catalog serves it to every agent and page that asks:

- The path of `resource.url` ends in the route's `path` or its `probePath` (for a target, in the path of its URL). A 402 that names another route would list its terms under that route's URL and push the real one out of the catalog.
- `resource.url` is at most 2048 characters with no space, control or format character (a bidi override, a zero-width space).
- The requirements nest at most 64 levels. At most 32 `accepts` entries are kept.
- `description` becomes one line of at most 500 characters, and `mimeType` is kept only when it is printable ASCII of at most 128 characters.

A route that fails any of that is skipped and its last good item, if there is one, stays. The same goes for a service that is down or not ready: its items stay with their old `lastUpdated`. A route that a service that is up stops listing is dropped.

Limits: `/health` is read up to 64 KiB and 32 routes, redirects are not followed, a route is only ever probed on its own service's origin and below the path of its URL (services can share an origin behind a gateway, so a route with `..` or an encoded dot, slash or backslash is skipped), and the `PAYMENT-REQUIRED` header has to fit the 16 KiB that Node's HTTP client accepts for a whole response header block (a route that goes over is logged as `response headers are larger than Node accepts (16 KiB)`, and an agent that is a Node client could not read its 402 either). Node's fetch also refuses the ports on the WHATWG bad-port list, such as 6000, which show as `bad port`. The ports of the starter services (4021 to 4034) are fine.

## Tests

```bash
pnpm --filter @z402/discovery test
pnpm --filter @z402/discovery typecheck
```

The tests run a real kit-based paid service with its facilitator in the test process (`@z402/service-kit/testing`) and point the catalog at it, read the endpoint with the stock client, and use fake services that hang, trickle, redirect and send malformed 402s. `main.test.ts` runs `src/main.ts` as a child process.
