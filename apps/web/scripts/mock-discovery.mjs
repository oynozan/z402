#!/usr/bin/env node
/*
 * A stand-in for apps/discovery, for developing the site and taking screenshots without the stack.
 * Serves GET /discovery/resources and GET /discovery/status in the shapes the real service uses, for the four
 * starter services. Text embeddings reports itself as starting, the other three are up, and their calls today grow
 * while it runs. Run it as node scripts/mock-discovery.mjs [port], 4430 by default.
 */
import { createServer } from "node:http";

const port = Number(process.argv[2] ?? 4430);
const PRICE_ZAT = "500";
const NETWORK = "zcash:regtest";
const PAY_TO = "uregtest1mock0z402merchant0shielded0only0address0for0the0site0preview0x";
const EXTRA = { windowZat: "100000", creditRatioBps: 2500, creditCapZat: "200000", zeroConfMinExpiryBlocks: 20 };

const SERVICES = [
  {
    serviceName: "LLM inference",
    url: "http://localhost:4031",
    tags: ["llm", "chat", "inference"],
    ready: true,
    callsToday: 128,
    routes: [
      {
        method: "POST",
        path: "/v1/generate",
        unit: "output chunk",
        note: "The operator sees prompts. The default model is open-weights.",
        description: "Streams a completion, one chunk of about 32 tokens per paid call.",
        input: { bodyType: "json", body: { prompt: "Write a haiku about privacy." } },
      },
    ],
  },
  {
    serviceName: "URL to markdown",
    url: "http://localhost:4032",
    tags: ["markdown", "scrape", "readability"],
    ready: true,
    callsToday: 41,
    routes: [
      {
        method: "GET",
        path: "/v1/markdown",
        unit: "page",
        note: "The site sees the server's IP, not the agent's.",
        description: "Fetches one public page and returns its readable content as markdown.",
        input: { queryParams: { url: "https://example.com" } },
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
        method: "POST",
        path: "/v1/embeddings",
        unit: "1k tokens",
        note: "About 1,000 tokens per call.",
        description: "Embeds up to about 1,000 tokens of text per paid call (OpenAI-style request and answer).",
        input: { bodyType: "json", body: { input: "shielded payments for agents" } },
      },
    ],
  },
  {
    serviceName: "Encrypted drop box",
    url: "http://localhost:4034",
    tags: ["storage", "age", "encrypted"],
    ready: true,
    callsToday: 9,
    routes: [
      {
        method: "POST",
        path: "/v1/drops",
        unit: "10 blocks",
        note: "Client-side encrypted blobs only. Size and time are capped.",
        description: "Stores one age-encrypted file for 10 blocks past the current tip.",
        input: { bodyType: "text", body: {} },
      },
      {
        method: "POST",
        path: "/v1/drops/:id/hold",
        unit: "10 blocks",
        note: "Client-side encrypted blobs only. Size and time are capped.",
        description: "Holds an existing drop for 10 more blocks, up to 1,000 past the tip.",
        input: { bodyType: "json", body: {}, pathParams: { id: "example" } },
      },
    ],
  },
];

const started = new Date().toISOString();

function item(service, route) {
  const { method, input } = route;
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
      bazaar: {
        info: { input: { type: "http", method, ...input }, output: { type: "json" } },
        schema: { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object" },
      },
      z402: { unit: route.unit, note: route.note },
    },
  };
}

/** Calls arrive on the services that are up, a few every few seconds */
setInterval(() => {
  for (const service of SERVICES) {
    if (service.ready && Math.random() < 0.6) service.callsToday += 1 + Math.floor(Math.random() * 3);
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

  if (url.pathname === "/discovery/resources") {
    const all = SERVICES.flatMap((s) => s.routes.map((r) => item(s, r)));
    const type = url.searchParams.get("type");
    const matching = type === null ? all : all.filter((i) => i.type === type);
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 100) || 100, 1), 1000);
    const offset = Math.max(Number(url.searchParams.get("offset") ?? 0) || 0, 0);
    return send(res, 200, {
      x402Version: 2,
      items: matching.slice(offset, offset + limit),
      pagination: { limit, offset, total: matching.length },
    });
  }

  if (url.pathname === "/discovery/status") {
    const now = new Date().toISOString();
    return send(res, 200, {
      updatedAt: now,
      services: SERVICES.map((s) => ({
        serviceName: s.serviceName,
        url: s.url,
        up: true,
        ready: s.ready,
        latencyMs: 2 + Math.floor(Math.random() * 6),
        checkedAt: now,
        callsToday: s.callsToday,
        unit: s.routes[0].unit,
        priceZat: PRICE_ZAT,
      })),
    });
  }

  if (url.pathname === "/health") return send(res, 200, { ok: true });
  return send(res, 404, { error: "not_found" });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`mock discovery on http://127.0.0.1:${port}/discovery/resources`);
});
