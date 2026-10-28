// Discovery items as the real stack serves them, trimmed from a recorded list of the four starter services
import type { DiscoveryResource, DiscoveryStatusEntry } from "../src/lib/discovery-types";

export const PAY_TO = `uregtest1${"q".repeat(60)}`;

export const EXTRA = {
  windowZat: "100000",
  creditRatioBps: 2500,
  creditCapZat: "200000",
  zeroConfMinExpiryBlocks: 20,
  termsVersion: "4796846a9fa927e8",
};

export const AGE_FILE = "-----BEGIN AGE ENCRYPTED FILE-----\nYWdlLWVuY3J5cHRpb24ub3JnL3YxCi0+\n-----END AGE ENCRYPTED FILE-----\n";

interface ItemOptions {
  serviceName?: string;
  tags?: string[];
  description?: string;
  z402?: { unit?: string; note?: string };
  input?: Record<string, unknown>;
  output?: unknown;
  amount?: string;
  extensions?: Record<string, unknown>;
}

export function item(resource: string, o: ItemOptions = {}): DiscoveryResource {
  const info: Record<string, unknown> = { input: { type: "http", ...o.input } };
  if (o.output !== undefined) info.output = { type: "json", example: o.output };
  return {
    resource,
    type: "http",
    x402Version: 2,
    accepts: [
      {
        scheme: "prepaid-voucher",
        network: "zcash:regtest",
        amount: o.amount ?? "500",
        asset: "ZEC",
        payTo: PAY_TO,
        maxTimeoutSeconds: 60,
        extra: EXTRA,
      },
    ],
    lastUpdated: "2026-10-28T07:50:20.049Z",
    ...(o.description !== undefined && { description: o.description }),
    mimeType: "application/json",
    ...(o.serviceName !== undefined && { serviceName: o.serviceName }),
    ...(o.tags !== undefined && { tags: o.tags }),
    extensions: o.extensions ?? {
      bazaar: { info, schema: { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object" } },
      z402: o.z402 ?? {},
    },
  };
}

export const LLM = item("http://localhost:4031/v1/generate", {
  serviceName: "LLM inference",
  tags: ["llm", "inference", "text"],
  description: "Streams qwen2.5-0.5b-instruct output, one chunk of about 32 tokens per paid call.",
  z402: { unit: "output chunk", note: "The operator sees your prompts. Open-weights model." },
  input: { bodyType: "json", body: { prompt: "Write a haiku about privacy." }, method: "POST" },
  output: { stream: "<id>", index: 0, text: "...", done: false },
});

export const MARKDOWN = item("http://localhost:4032/v1/markdown", {
  serviceName: "URL to markdown",
  tags: ["web", "markdown", "scrape"],
  description: "Fetches one public web page and returns its main content as clean markdown.",
  z402: { unit: "page", note: "The site sees this server's IP, not yours." },
  input: { queryParams: { url: "https://example.com" }, method: "GET" },
  output: { url: "https://example.com/", title: "Example Domain", truncated: false },
});

export const EMBEDDINGS = item("http://localhost:4033/v1/embeddings", {
  serviceName: "Text embeddings",
  tags: ["embeddings", "vectors", "rag"],
  description: "Embeds up to about 1,000 tokens of text per paid call (OpenAI-style request and answer).",
  z402: { unit: "1k tokens", note: "About 1,000 tokens per call." },
  input: { bodyType: "json", body: { input: ["The quick brown fox"] }, method: "POST" },
  output: { object: "list", dimensions: 3 },
});

export const DROPS = item("http://localhost:4034/v1/drops", {
  serviceName: "Encrypted drop box",
  tags: ["storage", "handoff", "encrypted"],
  description: "Holds one age-encrypted blob for 10 blocks; pay again to hold it longer.",
  z402: { unit: "10 blocks", note: "Only client-side encrypted (age) blobs. Size and time are capped." },
  input: { bodyType: "text", body: AGE_FILE, method: "POST" },
  output: { id: "q3Zs0mYbT7cWpAxK1nGhUw", size: 349, expiresAtHeight: 1052 },
});

export const HOLD = item("http://localhost:4034/v1/drops/:id/hold", {
  serviceName: "Encrypted drop box",
  tags: ["storage", "handoff", "encrypted"],
  description: "Holds an existing drop for 10 more blocks.",
  z402: { unit: "10 blocks" },
  input: { bodyType: "json", body: {}, pathParams: { id: "example" }, method: "POST" },
  output: { id: "q3Zs0mYbT7cWpAxK1nGhUw", tip: 1046, expiresAtHeight: 1062 },
});

export const ITEMS = [LLM, MARKDOWN, EMBEDDINGS, DROPS, HOLD];

export const status = (over: DiscoveryStatusEntry): DiscoveryStatusEntry => ({
  serviceName: "LLM inference",
  url: "http://localhost:4031",
  up: true,
  ready: true,
  latencyMs: 3,
  checkedAt: "2026-10-28T07:50:20.043Z",
  callsToday: 12,
  unit: "output chunk",
  priceZat: "500",
  ...over,
});
