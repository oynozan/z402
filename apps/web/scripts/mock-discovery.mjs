#!/usr/bin/env node
/*
 * A stand-in for apps/discovery, for developing the site and taking screenshots without the stack. It is for
 * development only, the site never ships it and never fakes data on its own.
 *
 * GET /discovery/resources and GET /discovery/status answer in the shapes the real service serves for the four starter
 * services. Each item carries the bazaar declaration its service makes in services/<name>/src/service.ts, as
 * declareDiscoveryExtension builds it and the bazaar server extension enriches it with the method, and for the drop
 * box's hold route with the path parameters and routeTemplate. The z402 extension and the facilitator's terms ride
 * along. Text embeddings reports itself as starting, as it does while its model loads, the other three are up, and
 * their calls today grow while the mock runs. Run it as node scripts/mock-discovery.mjs [port], 4430 by default.
 */
import { createServer } from "node:http";

const port = Number(process.argv[2] ?? 4430);
const PRICE_ZAT = "500";
const NETWORK = "zcash:regtest";
const PAY_TO =
  "uregtest1lx6ena6e2q772tslxf7qfjush8p5jhwnd2mdmwfawdhrwgc5gatxt9vehkgrgfmpa8cfmq2e6tk20vhppecjanufsg8yrytp3psafg4qakxtwjz5et36q0240se0cwhf6r5a";
const EXTRA = {
  windowZat: "100000",
  creditRatioBps: 2500,
  creditCapZat: "200000",
  zeroConfMinExpiryBlocks: 20,
  termsVersion: "4796846a9fa927e8",
};
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

const SERVICES = [
  {
    serviceName: "LLM inference",
    url: "http://localhost:4031",
    tags: ["llm", "inference", "text"],
    ready: true,
    callsToday: 1284,
    routes: [
      {
        path: "/v1/generate",
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
    url: "http://localhost:4032",
    tags: ["web", "markdown", "scrape"],
    ready: true,
    callsToday: 412,
    routes: [
      {
        path: "/v1/markdown",
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
    url: "http://localhost:4033",
    tags: ["embeddings", "vectors", "rag"],
    ready: false,
    callsToday: 0,
    routes: [
      {
        path: "/v1/embeddings",
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
    url: "http://localhost:4034",
    tags: ["storage", "handoff", "encrypted"],
    ready: true,
    callsToday: 96,
    routes: [
      {
        path: "/v1/drops",
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
        description: "Holds an existing drop for 10 more blocks.",
        unit: "10 blocks",
        bazaar: {
          ...bodyRoute({
            method: "POST",
            bodyType: "json",
            input: {},
            inputSchema: { properties: {} },
            // The probe path is /v1/drops/example/hold, so the server extension fills the parameter in from it
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

const started = new Date().toISOString();

function item(service, route) {
  return {
    resource: `${service.url}${route.path}`,
    type: "http",
    x402Version: 2,
    accepts: [
      {
        scheme: "prepaid-voucher",
        network: NETWORK,
        amount: PRICE_ZAT,
        asset: "ZEC",
        payTo: PAY_TO,
        maxTimeoutSeconds: 60,
        extra: EXTRA,
      },
    ],
    lastUpdated: started,
    description: route.description,
    mimeType: "application/json",
    serviceName: service.serviceName,
    tags: service.tags,
    extensions: {
      bazaar: route.bazaar,
      z402: { unit: route.unit, ...(route.note !== undefined && { note: route.note }) },
    },
  };
}

/** Paid calls arrive on the services that are ready, a few every few seconds */
setInterval(() => {
  for (const service of SERVICES) {
    if (service.ready && Math.random() < 0.6) service.callsToday += 1 + Math.floor(Math.random() * 3);
  }
}, 4000).unref();

function send(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "cache-control": status === 200 ? "max-age=5" : "no-store",
  });
  res.end(JSON.stringify(body));
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if (req.method !== "GET") return send(res, 405, { error: "method_not_allowed" });

  if (url.pathname === "/discovery/resources") {
    const all = SERVICES.flatMap((s) => s.routes.map((r) => item(s, r)));
    const type = url.searchParams.get("type");
    const matching = type === null || type === "" ? all : all.filter((i) => i.type === type);
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 100) || 100, 1), 1000);
    const offset = Math.max(Number(url.searchParams.get("offset") ?? 0) || 0, 0);
    return send(res, 200, {
      x402Version: 2,
      items: matching.slice(offset, offset + limit),
      pagination: { limit, offset, total: matching.length },
    });
  }

  // An array, one entry per configured service, as apps/discovery serves it
  if (url.pathname === "/discovery/status") {
    const now = new Date().toISOString();
    return send(
      res,
      200,
      SERVICES.map((s) => ({
        serviceName: s.serviceName,
        url: s.url,
        up: true,
        ready: s.ready,
        latencyMs: 1 + Math.floor(Math.random() * 6),
        checkedAt: now,
        callsToday: s.callsToday,
        unit: s.routes[0].unit,
        priceZat: PRICE_ZAT,
      })),
    );
  }

  if (url.pathname === "/discovery/search") {
    return send(res, 404, {
      error: "not_supported",
      message: "There is no search: pull the list and match on your own machine.",
    });
  }
  if (url.pathname === "/health") return send(res, 200, { ok: true, items: SERVICES.flatMap((s) => s.routes).length });
  return send(res, 404, { error: "not_found" });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`mock discovery on http://127.0.0.1:${port}/discovery/resources`);
});
