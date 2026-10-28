#!/usr/bin/env node
/*
 * A stand-in for the facilitator's Bazaar, for developing the site and taking screenshots without the stack. It is for
 * development only, the site never ships it and never fakes data on its own.
 *
 * GET /discovery/resources and GET /discovery/search answer in the facilitator's shapes for two providers, each with its
 * own payTo: ours, with LLM inference, Text embeddings and the Encrypted drop box, and provider 2 with URL to markdown.
 * Every route has its own price. Each item carries the bazaar declaration its service makes in
 * services/<name>/src/service.ts, as declareDiscoveryExtension builds it and the bazaar server extension enriches it with
 * the method, and for the drop box's hold route with the path parameters and routeTemplate. The z402 extension and the
 * rail's terms ride along. lastSeen gives every status the site reads: LLM inference declares itself every 30 s (up),
 * Text embeddings last did 4 minutes ago (stale), the drop box 38 minutes ago (down), and provider 2 never declares, so
 * it is listed from its paid calls alone (no lastSeen). The calls today grow on the two that take calls while the mock
 * runs. Run it as node scripts/mock-discovery.mjs [port], 4430 by default.
 */
import { createHash } from "node:crypto";
import { createServer } from "node:http";

const port = Number(process.argv[2] ?? 4430);
const NETWORK = "zcash:regtest";
const OURS =
  "uregtest1lx6ena6e2q772tslxf7qfjush8p5jhwnd2mdmwfawdhrwgc5gatxt9vehkgrgfmpa8cfmq2e6tk20vhppecjanufsg8yrytp3psafg4qakxtwjz5et36q0240se0cwhf6r5a";
const PROVIDER_2 =
  "uregtest17zkagwwdzetfwfmxgz9pfv9jf2vvg934nf8fllwu073x5yweflnqxvutm6knf3g65qezx03tlgc9af6psq55u8g0u3uzkmswjvfwgwnvavz0hxmz5kwpudqpsmqz7rff5q2w";
/** The rail's terms, the same for every provider */
const EXTRA = {
  windowZat: "100000",
  creditRatioBps: 2500,
  creditCapZat: "200000",
  zeroConfMinExpiryBlocks: 20,
  termsVersion: "b8d1f0e47c2a9d63",
};
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const MAX_QUERY_CHARS = 256;
const DIGITS_RE = /^[0-9]{1,9}$/;
const SCHEMA = "https://json-schema.org/draft/2020-12/schema";
const OUTPUT_SCHEMA = {
  type: "object",
  properties: { type: { type: "string" }, example: { type: "object" } },
  required: ["type"],
};

/** services/dropbox/src/example.ts */
const EXAMPLE_AGE_FILE = `-----BEGIN AGE ENCRYPTED FILE-----
YWdlLWVuY3J5cHRpb24ub3JnL3YxCi0+IFgyNTUxOSBPdmNBYlMvS0tyVDhEOGpB
YlA1VGtFemg0L3RiZGtaeUdoZ3RHY2NZZkJnCjJCVldJZDk5dlNsQ1hvUHByNkpI
MFo3RjJoQm42OWhra3FmcGhOZE5BWm8KLS0tIC81cVZ1V2d3TElPV1JDRHVWMFNE
SGU3Vkh3YkgrY2xrZzBveWRPdkhJTmMKN+IAvP8CpMguSyc+jfSJnqkU85Zxf+o5
kn1iuo2GGrMRZVi/5w==
-----END AGE ENCRYPTED FILE-----
`;

const EXAMPLE_MARKDOWN =
  "This domain is for use in documentation examples without needing permission. Avoid use in operations.\n\n" +
  "[Learn more](https://iana.org/domains/example)";

/** declareDiscoveryExtension for a route with a body, as the bazaar server extension serves it */
function bodyRoute({ method, bodyType, input, inputSchema, pathParams, pathParamsSchema, output }) {
  return {
    info: {
      input: { type: "http", bodyType, body: input, ...(pathParams && { pathParams }), method },
      output: { type: "json", example: output },
    },
    schema: {
      $schema: SCHEMA,
      type: "object",
      properties: {
        input: {
          type: "object",
          properties: {
            type: { type: "string", const: "http" },
            method: { type: "string", enum: [method] },
            bodyType: { type: "string", enum: ["json", "form-data", "text"] },
            body: inputSchema,
            ...(pathParamsSchema && { pathParams: { type: "object", ...pathParamsSchema } }),
          },
          required: ["type", "method", "bodyType", "body"],
          additionalProperties: false,
        },
        output: OUTPUT_SCHEMA,
      },
      required: ["input"],
    },
  };
}

/** declareDiscoveryExtension for a route that takes query parameters */
function queryRoute({ method, input, inputSchema, output }) {
  return {
    info: { input: { type: "http", queryParams: input, method }, output: { type: "json", example: output } },
    schema: {
      $schema: SCHEMA,
      type: "object",
      properties: {
        input: {
          type: "object",
          properties: {
            type: { type: "string", const: "http" },
            method: { type: "string", enum: [method] },
            queryParams: { type: "object", ...inputSchema },
          },
          required: ["type", "method"],
          additionalProperties: false,
        },
        output: OUTPUT_SCHEMA,
      },
      required: ["input"],
    },
  };
}

/*
 * seen is how the service declares itself: every 30 s, not for a while (a fixed age), or never (null). live services
 * take paid calls while the mock runs.
 */
const SERVICES = [
  {
    serviceName: "LLM inference",
    payTo: OURS,
    url: "http://localhost:4031",
    tags: ["llm", "inference", "text"],
    seen: { every: 30_000 },
    live: true,
    routes: [
      {
        path: "/v1/generate",
        price: "200",
        paid: 1284,
        description:
          "Streams qwen2.5-0.5b-instruct output, one chunk of about 32 tokens per paid call: send {prompt} to start, then {stream} to continue.",
        unit: "output chunk",
        note: "The operator sees your prompts. Open-weights model.",
        bazaar: bodyRoute({
          method: "POST",
          bodyType: "json",
          input: { prompt: "Write a haiku about privacy." },
          inputSchema: {
            type: "object",
            properties: {
              prompt: { type: "string", minLength: 1, maxLength: 1600, description: "Starts a stream" },
              system: { type: "string", maxLength: 1600, description: "System prompt, with prompt" },
              maxTokens: {
                type: "integer",
                minimum: 1,
                maximum: 1024,
                description: "Output cap in tokens, with prompt (default 1024)",
              },
              stream: { type: "string", description: "Continues a stream: the id from an earlier answer" },
            },
            oneOf: [{ required: ["prompt"] }, { required: ["stream"] }],
            additionalProperties: false,
          },
          output: { stream: "<id>", index: 0, text: "...", done: false },
        }),
      },
    ],
  },
  {
    serviceName: "URL to markdown",
    payTo: PROVIDER_2,
    url: "http://localhost:4032",
    tags: ["web", "markdown", "scrape"],
    seen: null,
    live: true,
    routes: [
      {
        path: "/v1/markdown",
        price: "1000",
        paid: 412,
        description: "Fetches one public web page and returns its main content as clean markdown.",
        unit: "page",
        note: "The site sees this server's IP, not yours.",
        bazaar: queryRoute({
          method: "GET",
          input: { url: "https://example.com" },
          inputSchema: { properties: { url: { type: "string", pattern: "^https?://" } }, required: ["url"] },
          output: {
            url: "https://example.com/",
            finalUrl: "https://example.com/",
            title: "Example Domain",
            byline: null,
            markdown: EXAMPLE_MARKDOWN,
            length: EXAMPLE_MARKDOWN.length,
            truncated: false,
          },
        }),
      },
    ],
  },
  {
    serviceName: "Text embeddings",
    payTo: OURS,
    url: "http://localhost:4033",
    tags: ["embeddings", "vectors", "rag"],
    seen: { ago: 250_000 },
    live: false,
    routes: [
      {
        path: "/v1/embeddings",
        price: "100",
        paid: 37,
        description: "Embeds up to about 1,000 tokens of text per paid call (OpenAI-style request and answer).",
        unit: "1k tokens",
        note: "About 1,000 tokens per call.",
        bazaar: bodyRoute({
          method: "POST",
          bodyType: "json",
          input: { input: ["The quick brown fox"] },
          inputSchema: {
            type: "object",
            properties: {
              input: {
                description: "A string, or up to 64 strings, with at most 4000 characters in total, at most 2000 per string",
                oneOf: [
                  { type: "string", minLength: 1, maxLength: 2000 },
                  {
                    type: "array",
                    minItems: 1,
                    maxItems: 64,
                    items: { type: "string", minLength: 1, maxLength: 2000 },
                  },
                ],
              },
            },
            required: ["input"],
          },
          output: {
            object: "list",
            model: "nomic-embed-text",
            dimensions: 3,
            data: [{ object: "embedding", index: 0, embedding: [0.0123, -0.0456, 0.0789] }],
            usage: { prompt_tokens: 5, total_tokens: 5 },
          },
        }),
      },
    ],
  },
  {
    serviceName: "Encrypted drop box",
    payTo: OURS,
    url: "http://localhost:4034",
    tags: ["storage", "handoff", "encrypted"],
    seen: { ago: 2_280_000 },
    live: false,
    routes: [
      {
        path: "/v1/drops",
        price: "500",
        paid: 61,
        description: "Holds one age-encrypted blob for 10 blocks; pay again to hold it longer.",
        unit: "10 blocks",
        note: "Only client-side encrypted (age) blobs. Size and time are capped.",
        bazaar: bodyRoute({
          method: "POST",
          bodyType: "text",
          input: EXAMPLE_AGE_FILE,
          inputSchema: { type: "string" },
          output: {
            id: "q3Zs0mYbT7cWpAxK1nGhUw",
            deleteToken: "m4X1rVd9Tq0uYb7LkGfH2sNaPzE8cJwO5iRtBvQeXyA",
            size: 349,
            tip: 1042,
            expiresAtHeight: 1052,
          },
        }),
      },
      {
        path: "/v1/drops/:id/hold",
        price: "500",
        paid: 35,
        description: "Holds an existing drop for 10 more blocks.",
        unit: "10 blocks",
        bazaar: {
          ...bodyRoute({
            method: "POST",
            bodyType: "json",
            input: {},
            inputSchema: { properties: {} },
            // The declared example fills the parameter in, as the bazaar server extension does from the probe path
            pathParams: { id: "example" },
            pathParamsSchema: { properties: { id: { type: "string" } }, required: ["id"] },
            output: { id: "q3Zs0mYbT7cWpAxK1nGhUw", tip: 1046, expiresAtHeight: 1062 },
          }),
          routeTemplate: "/v1/drops/:id/hold",
        },
      },
    ],
  },
];

const started = Date.now();
for (const route of SERVICES.flatMap((s) => s.routes)) route.lastUpdated = new Date(started).toISOString();

/** The facilitator's provider id, which breaks ties in its order */
function providerId(payTo) {
  return createHash("sha256").update(`z402-provider-v1\n${NETWORK}\n${payTo}`).digest("hex").slice(0, 16);
}

function lastSeen(service, now) {
  if (service.seen === null) return undefined;
  const at = service.seen.every === undefined ? now - service.seen.ago : now - ((now - started) % service.seen.every);
  return new Date(at).toISOString();
}

function item(service, route, now) {
  const seen = lastSeen(service, now);
  return {
    resource: `${service.url}${route.path}`,
    type: "http",
    x402Version: 2,
    accepts: [
      {
        scheme: "prepaid-voucher",
        network: NETWORK,
        amount: route.price,
        asset: "ZEC",
        payTo: service.payTo,
        maxTimeoutSeconds: 60,
        extra: EXTRA,
      },
    ],
    lastUpdated: route.lastUpdated,
    description: route.description,
    mimeType: "application/json",
    serviceName: service.serviceName,
    tags: service.tags,
    extensions: {
      bazaar: route.bazaar,
      z402: { unit: route.unit, ...(route.note !== undefined && { note: route.note }) },
    },
    ...(seen !== undefined && { lastSeen: seen }),
    paidCallsToday: route.paid,
  };
}

const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Every item, by resource, then method, then provider id, as the facilitator orders them */
function listed(now) {
  return SERVICES.flatMap((s) =>
    s.routes.map((r) => ({ item: item(s, r, now), method: r.bazaar.info.input.method, provider: providerId(s.payTo) })),
  )
    .sort((a, b) => compare(a.item.resource, b.item.resource) || compare(a.method, b.method) || compare(a.provider, b.provider))
    .map((entry) => entry.item);
}

/** The filters both routes take, payTo, scheme and network holding for one offer together */
function filtered(items, params) {
  const [type, payTo, scheme, network, extensions] = ["type", "payTo", "scheme", "network", "extensions"].map(
    (name) => params.get(name) || undefined,
  );
  return items.filter(
    (i) =>
      (type === undefined || i.type === type) &&
      i.accepts.some(
        (a) =>
          (payTo === undefined || a.payTo === payTo) &&
          (scheme === undefined || a.scheme === scheme) &&
          (network === undefined || a.network === network),
      ) &&
      (extensions === undefined || Object.hasOwn(i.extensions ?? {}, extensions)),
  );
}

/** A non-negative decimal integer, the fallback when it is not given, or undefined when it is anything else */
function whole(params, name, fallback) {
  const raw = params.get(name);
  if (raw === null || raw === "") return fallback;
  return DIGITS_RE.test(raw) ? Number(raw) : undefined;
}

const clampLimit = (limit) => Math.min(Math.max(limit, 1), MAX_LIMIT);

/** Paid calls arrive on the services that take them, a few every few seconds */
setInterval(() => {
  for (const route of SERVICES.filter((s) => s.live).flatMap((s) => s.routes)) {
    if (Math.random() >= 0.6) continue;
    route.paid += 1 + Math.floor(Math.random() * 3);
    route.lastUpdated = new Date().toISOString();
  }
}, 4000).unref();

function send(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if (req.method !== "GET") return send(res, 405, { error: "method_not_allowed" });
  const params = url.searchParams;

  if (url.pathname === "/discovery/resources") {
    const limit = whole(params, "limit", DEFAULT_LIMIT);
    const offset = whole(params, "offset", 0);
    if (limit === undefined || offset === undefined) {
      return send(res, 400, { error: "invalid_request", message: "limit and offset are whole numbers" });
    }
    const matching = filtered(listed(Date.now()), params);
    const clamped = clampLimit(limit);
    return send(res, 200, {
      x402Version: 2,
      items: matching.slice(offset, offset + clamped),
      pagination: { limit: clamped, offset, total: matching.length },
    });
  }

  if (url.pathname === "/discovery/search") {
    const query = params.get("query") ?? "";
    const limit = whole(params, "limit", DEFAULT_LIMIT);
    const cursor = whole(params, "cursor", 0);
    if (query.length === 0 || query.length > MAX_QUERY_CHARS) {
      return send(res, 400, { error: "invalid_request", message: `query is 1 to ${MAX_QUERY_CHARS} characters` });
    }
    if (limit === undefined || cursor === undefined) {
      return send(res, 400, { error: "invalid_request", message: "limit and cursor are whole numbers" });
    }
    const needle = query.toLowerCase();
    const matching = filtered(listed(Date.now()), params).filter((i) =>
      [i.resource, i.description ?? "", i.serviceName ?? "", ...(i.tags ?? [])].some((text) =>
        text.toLowerCase().includes(needle),
      ),
    );
    const clamped = clampLimit(limit);
    const next = cursor + clamped < matching.length ? String(cursor + clamped) : null;
    return send(res, 200, {
      x402Version: 2,
      resources: matching.slice(cursor, cursor + clamped),
      partialResults: false,
      pagination: { limit: clamped, cursor: next },
    });
  }

  return send(res, 404, { error: "not_found" });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`mock Bazaar on http://127.0.0.1:${port}/discovery/resources`);
});
