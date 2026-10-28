import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { decodePaymentSignatureHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { startTestStack, TEST_NETWORK, TEST_PAY_TO, type TestStack } from "@z402/service-kit/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SERVICE_NAMES, type ServiceName } from "../src/flags.js";
import { runFlow, type FlowOptions, type FlowResult } from "../src/flow.js";
import { ageRefusal } from "./age-shape.js";
import { FakeServices, refuse, type FakeOptions } from "./fakes.js";

vi.setConfig({ testTimeout: 30_000 });

const stacks: TestStack[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const stack of stacks.splice(0)) await stack.close();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

interface Setup {
  fake?: FakeOptions;
  /** The services that get a URL, all four by default */
  only?: ServiceName[];
  page?: string;
  flow?: Partial<Omit<FlowOptions, "services" | "page" | "paidFetch" | "print">>;
  onLine?: (line: string) => void;
}

interface Run {
  stack: TestStack;
  fake: FakeServices;
  lines: string[];
  result: FlowResult;
  /** What the paying client has vouchered so far, which only moves when a voucher is signed */
  vouchered: () => bigint;
}

async function smoke(setup: Setup = {}): Promise<Run> {
  const fake = new FakeServices(setup.fake);
  const stack = await startTestStack({ build: (env) => fake.build(env) });
  stacks.push(stack);
  const vouchered = (): bigint => stack.scheme.session(TEST_PAY_TO)?.cumulativeZat ?? 0n;
  const lines: string[] = [];
  const services = Object.fromEntries((setup.only ?? SERVICE_NAMES).map((name) => [name, stack.url]));
  const result = await runFlow({
    services,
    page: setup.page ?? "https://example.com",
    paidFetch: stack.paidFetch,
    print: (line) => {
      lines.push(line);
      setup.onLine?.(line);
    },
    spent: vouchered,
    ...setup.flow,
  });
  return { stack, fake, lines, result, vouchered };
}

interface Line {
  service: string;
  step: string;
  status: string;
  ms: number;
  detail: string;
}

function parse(line: string): Line {
  const m = /^(\w+) (\w+) (\d{3}|ERR) (\d+) ms (.+)$/.exec(line);
  if (m === null) throw new Error(`not a step line: ${JSON.stringify(line)}`);
  return { service: m[1] ?? "", step: m[2] ?? "", status: m[3] ?? "", ms: Number(m[4]), detail: m[5] ?? "" };
}

const find = (lines: string[], service: string, step: string): Line => {
  const line = lines.map(parse).find((l) => l.service === service && l.step === step);
  if (line === undefined) throw new Error(`no ${service} ${step} line in ${JSON.stringify(lines)}`);
  return line;
};

/** A server that records whether anything reaches it, standing in for a third party */
async function thirdParty(): Promise<{ url: string; requests: { url: string; voucher: string | undefined }[] }> {
  const requests: { url: string; voucher: string | undefined }[] = [];
  const server = createServer((req, res) => {
    requests.push({ url: req.url ?? "", voucher: req.headers["payment-signature"] as string | undefined });
    res.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests };
}

describe("a run against all four services", () => {
  it("pays each route, checks each answer and prints one timed line per step", async () => {
    const { lines, result, fake, vouchered } = await smoke();

    expect(result.ok).toBe(true);
    expect(result.aborted).toBe(false);
    expect(lines.map((l) => parse(l).service + " " + parse(l).step)).toEqual([
      "llm start",
      "llm continue",
      "llm continue",
      "markdown get",
      "embeddings embed",
      "dropbox upload",
      "dropbox hold",
      "dropbox fetch",
      "dropbox delete",
    ]);
    expect(lines.map((l) => parse(l).status)).toEqual(["200", "200", "200", "200", "200", "201", "200", "200", "204"]);

    expect(find(lines, "llm", "start").detail).toBe('chunk 0 "Hello there," (500 zat)');
    const continues = lines.map(parse).filter((l) => l.step === "continue");
    expect(continues.map((l) => l.detail)).toEqual(['chunk 1 " nice to" (500 zat)', 'chunk 2 " meet you" (500 zat)']);
    expect(find(lines, "markdown", "get").detail).toBe('"Example Domain" 76 chars (500 zat)');
    expect(find(lines, "embeddings", "embed").detail).toBe("2 vectors, 8 dimensions, model fake-embed, 4 tokens (500 zat)");

    const upload = find(lines, "dropbox", "upload").detail;
    const size = fake.uploads[0]?.length ?? 0;
    expect(upload).toMatch(new RegExp(`^id [A-Za-z0-9_-]{22}, ${size} bytes, held until block 1052 \\(500 zat\\)$`));
    expect(find(lines, "dropbox", "hold").detail).toBe("held until block 1062 (500 zat)");
    expect(find(lines, "dropbox", "fetch").detail).toBe(`${size} bytes identical, expires at block 1062`);
    expect(find(lines, "dropbox", "delete").detail).toBe("deleted, then 404");

    // What the services received
    expect(fake.prompts).toEqual(["Tell a short story about a lighthouse keeper."]);
    expect(fake.maxTokens).toEqual([96]);
    expect(fake.inputs).toEqual([["hello world", "zcash"]]);
    expect(fake.markdownUrls).toEqual(["https://example.com"]);
    expect(fake.uploads).toHaveLength(1);
    expect(ageRefusal(fake.uploads[0] ?? Buffer.alloc(0))).toBeUndefined();
    expect(size).toBeGreaterThan(1024);
    expect(fake.deleted).toHaveLength(1);
    expect(fake.drops.size).toBe(0);

    // Seven calls were paid, 500 zat each, and the two free steps cost nothing
    expect(result.steps.filter((s) => s.paid && s.ok)).toHaveLength(7);
    expect(vouchered()).toBe(3500n);
  });

  it("times every step", async () => {
    const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
    const { lines, result } = await smoke({
      only: ["embeddings"],
      fake: {
        handlers: {
          embeddings: async (_req, res) => {
            await delay(120);
            res.json({ object: "list", model: "m", dimensions: 1, data: [{ index: 0, embedding: [0.5] }, { index: 1, embedding: [0.25] }] });
          },
        },
      },
    });
    expect(parse(lines[0] ?? "").ms).toBeGreaterThanOrEqual(115);
    expect(result.steps[0]?.ms).toBe(parse(lines[0] ?? "").ms);
  });

  it("stops asking for chunks once the stream is done", async () => {
    const { lines, result, fake } = await smoke({ only: ["llm"], fake: { chunks: ["Hi", " there"] } });
    expect(lines).toHaveLength(2);
    expect(find(lines, "llm", "continue").detail).toBe('chunk 1 " there" (done, stop) (500 zat)');
    expect(result.ok).toBe(true);
    expect([...fake.streams.values()][0]?.next).toBe(2);
  });

  it("stops at three chunks when the stream goes on", async () => {
    const { lines, fake, vouchered } = await smoke({ only: ["llm"] });
    expect(lines).toHaveLength(3);
    expect([...fake.streams.values()][0]?.next).toBe(3);
    expect(vouchered()).toBe(1500n);
  });

  it("stops after the first chunk when it is also the last", async () => {
    const { lines } = await smoke({ only: ["llm"], fake: { chunks: ["Hello"] } });
    expect(lines).toHaveLength(1);
    expect(find(lines, "llm", "start").detail).toBe('chunk 0 "Hello" (done, stop) (500 zat)');
  });

  it("checks only the services that have a URL", async () => {
    const { lines, fake } = await smoke({ only: ["markdown"] });
    expect(lines).toHaveLength(1);
    expect(fake.requests.every((r) => r.includes("/v1/markdown"))).toBe(true);
  });

  it("sends the page as a query value, whatever characters it has", async () => {
    const page = "https://example.org/a b?x=1&y=2#frag";
    const { fake } = await smoke({ only: ["markdown"], page });
    expect(fake.markdownUrls).toEqual([page]);
  });
});

describe("a step that fails", () => {
  it("refused before payment is shown with its reason, and was not charged", async () => {
    const { lines, result, vouchered } = await smoke({
      fake: { prepare: { embeddings: [(_req, res) => refuse(res, 413, "too_many_tokens")] } },
    });
    expect(find(lines, "embeddings", "embed")).toMatchObject({
      status: "413",
      detail: "FAIL expected 200, got 413: too_many_tokens (not charged)",
    });
    // The other services are still checked
    expect(lines).toHaveLength(9);
    expect(result.ok).toBe(false);
    expect(result.steps.find((s) => s.service === "embeddings")?.ok).toBe(false);
    expect(vouchered()).toBe(3000n);
  });

  it("failing after payment is shown as charged, since the client pays for it with its next voucher", async () => {
    const { lines, result, vouchered } = await smoke({
      fake: { handlers: { markdown: (_req, res) => refuse(res, 502, "convert_failed") } },
    });
    expect(find(lines, "markdown", "get")).toMatchObject({
      status: "502",
      detail: "FAIL expected 200, got 502: convert_failed (charged 500 zat)",
    });
    expect(find(lines, "embeddings", "embed").detail).toMatch(/\(500 zat\)$/);
    expect(result.ok).toBe(false);
    expect(vouchered()).toBe(3500n);
  });

  it("answering 200 without a payment receipt means the route is not behind the paywall", async () => {
    const { lines, result, vouchered } = await smoke({ fake: { unpaid: ["embeddings"] } });
    const line = find(lines, "embeddings", "embed");
    expect(line.status).toBe("200");
    expect(line.detail).toMatch(/^FAIL no payment receipt/);
    expect(line.detail).toMatch(/\(not charged\)$/);
    expect(result.ok).toBe(false);
    expect(vouchered()).toBe(3000n);
  });

  it("says what the answer got wrong", async () => {
    const { lines, result } = await smoke({
      only: ["llm"],
      fake: { handlers: { generate: (_req, res) => void res.json({ stream: "s", index: 4, text: "x", done: false }) } },
    });
    expect(find(lines, "llm", "start")).toMatchObject({ status: "200" });
    expect(find(lines, "llm", "start").detail).toBe("FAIL index 4, expected 0 (charged 500 zat)");
    expect(lines).toHaveLength(1);
    expect(result.ok).toBe(false);
  });

  it("an answer that is not JSON is a failure, not a crash", async () => {
    const { lines } = await smoke({
      only: ["markdown"],
      fake: { handlers: { markdown: (_req, res) => void res.type("text/plain").send("<html>oops</html>") } },
    });
    expect(find(lines, "markdown", "get").detail).toMatch(/^FAIL the answer is not JSON: .*oops.* \(charged 500 zat\)$/);
  });

  it("a service that is down is an ERR line, and the others are still checked", async () => {
    const dead = createServer();
    await new Promise<void>((resolve) => dead.listen(0, "127.0.0.1", resolve));
    const port = (dead.address() as AddressInfo).port;
    await new Promise<void>((resolve) => dead.close(() => resolve()));

    const fake = new FakeServices();
    const stack = await startTestStack({ build: (env) => fake.build(env) });
    stacks.push(stack);
    const lines: string[] = [];
    const result = await runFlow({
      services: { llm: `http://127.0.0.1:${port}`, markdown: stack.url },
      page: "https://example.com",
      paidFetch: stack.paidFetch,
      print: (line) => lines.push(line),
      spent: () => stack.scheme.session(TEST_PAY_TO)?.cumulativeZat ?? 0n,
    });
    expect(lines).toHaveLength(2);
    expect(find(lines, "llm", "start").status).toBe("ERR");
    expect(find(lines, "llm", "start").detail).toMatch(/^FAIL .*ECONNREFUSED.* \(not charged\)$/);
    expect(find(lines, "markdown", "get").status).toBe("200");
    expect(result.ok).toBe(false);
  });

  it("a service on another network than the run pays on is said so in a line, not with the whole offer", async () => {
    const fake = new FakeServices();
    const stack = await startTestStack({ build: (env) => fake.build(env) });
    stacks.push(stack);
    // The client can pay on testnet only, and the service asks for regtest
    const paidFetch = wrapFetchWithPayment(fetch, new x402Client().register("zcash:testnet", stack.scheme));
    const lines: string[] = [];
    const result = await runFlow({ services: { markdown: stack.url }, page: "https://example.com", paidFetch, print: (l) => lines.push(l), spent: () => 0n });
    expect(find(lines, "markdown", "get")).toMatchObject({
      status: "ERR",
      detail: "FAIL the service asks for payment on zcash:regtest, which this run is not set to pay on (see --network) (not charged)",
    });
    expect(result.ok).toBe(false);
    expect(fake.requests).toEqual(["GET /v1/markdown"]);
  });

  it("a voucher the facilitator refuses is shown with the reason from its 402, and was not charged", async () => {
    const fake = new FakeServices();
    const stack = await startTestStack({ build: (env) => fake.build(env) });
    stacks.push(stack);
    // Every voucher leaves with a broken signature, which the facilitator refuses whatever the route costs
    const breaking: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      const header = request.headers.get("payment-signature");
      if (header !== null) {
        const payment = decodePaymentSignatureHeader(header);
        const sig = String(payment.payload["sig"]);
        payment.payload = { ...payment.payload, sig: `${sig.startsWith("0") ? "1" : "0"}${sig.slice(1)}` };
        request.headers.set("payment-signature", encodePaymentSignatureHeader(payment));
      }
      return fetch(request);
    };
    const paidFetch = wrapFetchWithPayment(breaking, new x402Client().register(TEST_NETWORK, stack.scheme));
    const lines: string[] = [];
    const result = await runFlow({
      services: { markdown: stack.url },
      page: "https://example.com",
      paidFetch,
      print: (line) => lines.push(line),
      spent: () => stack.scheme.session(TEST_PAY_TO)?.cumulativeZat ?? 0n,
    });
    expect(find(lines, "markdown", "get")).toMatchObject({
      status: "402",
      detail: "FAIL expected 200, got 402: payment refused: z402_invalid_signature (not charged)",
    });
    expect(fake.markdownUrls).toEqual([]);
    expect(result.ok).toBe(false);
  });
});

describe("prices", () => {
  it("each paid line shows what its own call cost, since every service sets its own price", async () => {
    const fake = new FakeServices();
    const stack = await startTestStack({ build: (env) => fake.build(env) });
    stacks.push(stack);
    // The stack's facilitator takes 500 zat a call, so the payer counts each call at its service's price instead
    const prices: [RegExp, bigint][] = [
      [/^\/v1\/generate$/, 200n],
      [/^\/v1\/markdown$/, 1_000n],
      [/^\/v1\/embeddings$/, 100n],
      [/^\/v1\/drops/, 500n],
    ];
    let spent = 0n;
    const paidFetch: typeof fetch = async (input, init) => {
      const res = await stack.paidFetch(input, init);
      const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
      if (res.headers.has("payment-response")) spent += prices.find(([route]) => route.test(path))?.[1] ?? 0n;
      return res;
    };
    const lines: string[] = [];
    const result = await runFlow({
      services: Object.fromEntries(SERVICE_NAMES.map((name) => [name, stack.url])),
      page: "https://example.com",
      paidFetch,
      print: (line) => lines.push(line),
      spent: () => spent,
    });
    expect(result.ok).toBe(true);
    expect(lines.map((l) => /\((\d+) zat\)$/.exec(parse(l).detail)?.[1] ?? "free")).toEqual([
      "200",
      "200",
      "200",
      "1000",
      "100",
      "500",
      "500",
      "free",
      "free",
    ]);
  });
});

describe("what a hostile or broken service can do", () => {
  it("cannot put terminal escapes or reordering marks on the screen through what it says", async () => {
    const ESC = String.fromCodePoint(0x1b);
    const CSI = String.fromCodePoint(0x9b);
    const RLO = String.fromCodePoint(0x202e);
    const hostile = `x${ESC}[2J${ESC}]0;owned${String.fromCodePoint(7)}${CSI}31m${RLO}y\r\nz`;
    const { lines } = await smoke({
      only: ["llm", "markdown"],
      fake: {
        chunks: [hostile, hostile],
        handlers: {
          markdown: (req, res) =>
            void res.json({ url: String(req.query["url"]), title: hostile, markdown: "m", length: 1, truncated: false }),
        },
      },
    });
    expect(lines.length).toBeGreaterThanOrEqual(3);
    for (const line of lines) {
      for (const char of line) {
        const point = char.codePointAt(0) ?? 0;
        const unsafe = point < 0x20 || (point >= 0x7f && point <= 0x9f) || (point >= 0x202a && point <= 0x202e) || (point >= 0x2066 && point <= 0x2069);
        expect(unsafe, `U+${point.toString(16)} in ${JSON.stringify(line)}`).toBe(false);
      }
    }
    expect(find(lines, "llm", "start").detail).toContain("[2J");
  });

  it("is not followed to another origin when it redirects a paid call, so no voucher leaves", async () => {
    const third = await thirdParty();
    const { lines, result } = await smoke({
      only: ["llm"],
      fake: { handlers: { generate: (_req, res) => void res.redirect(307, `${third.url}/collect`) } },
    });
    expect(third.requests).toEqual([]);
    const line = find(lines, "llm", "start");
    expect(line.status).toBe("307");
    expect(line.detail).toMatch(/^FAIL expected 200, got 307: redirected to http:\/\/127\.0\.0\.1:\d+\/collect \(not followed\)/);
    expect(result.ok).toBe(false);
  });

  it("is not followed to another origin when it redirects the first attempt either", async () => {
    const third = await thirdParty();
    const { lines } = await smoke({
      only: ["embeddings"],
      fake: { prepare: { embeddings: [(_req, res) => void res.redirect(302, `${third.url}/elsewhere`)] } },
    });
    expect(third.requests).toEqual([]);
    expect(find(lines, "embeddings", "embed").status).toBe("302");
  });

  it("cannot make the flow send anything to a path of its choosing through the id of a drop", async () => {
    const { lines, fake, result } = await smoke({
      only: ["dropbox"],
      fake: {
        handlers: {
          upload: (req, res) =>
            void res.status(201).json({ id: "../health", deleteToken: "abc", size: (req.body as Buffer).length, tip: 1042, expiresAtHeight: 1052 }),
        },
      },
    });
    expect(lines).toHaveLength(1);
    expect(find(lines, "dropbox", "upload").detail).toMatch(/^FAIL id is not a plain drop id/);
    expect(fake.requests).toEqual(["POST /v1/drops", "POST /v1/drops"]);
    expect(result.ok).toBe(false);
  });

  it("cannot make the flow read more than the upload from a free route", async () => {
    let closed = false;
    const { lines, fake } = await smoke({
      only: ["dropbox"],
      fake: {
        handlers: {
          fetch: (_req, res) => {
            res.type("application/octet-stream");
            const push = (): void => {
              if (res.destroyed || res.writableEnded) return;
              res.write(Buffer.alloc(65_536));
              setImmediate(push);
            };
            res.on("close", () => {
              closed = true;
            });
            push();
          },
        },
      },
    });
    expect(find(lines, "dropbox", "fetch").detail).toMatch(/^FAIL .*longer than the .* bytes uploaded/);
    await vi.waitFor(() => expect(closed).toBe(true));
    // The drop is still removed
    expect(fake.deleted).toHaveLength(1);
  });

  it("does not pay for a route that is free by asking for payment, and still says so", async () => {
    const { lines, result, vouchered } = await smoke({ only: ["dropbox"], fake: { paywalled: ["fetch"] } });
    const line = find(lines, "dropbox", "fetch");
    expect(line.status).toBe("402");
    expect(line.detail).toMatch(/^FAIL expected 200, got 402/);
    expect(result.ok).toBe(false);
    // Upload and hold were paid, the fetch was not
    expect(vouchered()).toBe(1000n);
  });
});

describe("the drop box steps", () => {
  it("still deletes the drop when the hold failed, and does not compare the expiry it never got", async () => {
    const { lines, fake, result } = await smoke({
      only: ["dropbox"],
      fake: { handlers: { hold: (_req, res) => refuse(res, 502, "provider_failed") } },
    });
    expect(find(lines, "dropbox", "hold").detail).toBe("FAIL expected 200, got 502: provider_failed (charged 500 zat)");
    expect(find(lines, "dropbox", "fetch").detail).toMatch(/bytes identical, expires at block 1052$/);
    expect(find(lines, "dropbox", "delete").status).toBe("204");
    expect(fake.drops.size).toBe(0);
    expect(result.ok).toBe(false);
  });

  it("fails when the bytes come back changed, and says where", async () => {
    const { lines } = await smoke({
      only: ["dropbox"],
      fake: {
        handlers: {
          fetch: (req, res, fake) => {
            const bytes = Buffer.from(fake.drops.get(String(req.params["id"]))?.bytes ?? Buffer.alloc(0));
            bytes[600] = (bytes[600] ?? 0) ^ 0xff;
            res.set("X-Expires-At-Height", "1062").send(bytes);
          },
        },
      },
    });
    expect(find(lines, "dropbox", "fetch").detail).toBe("FAIL the bytes differ from the upload at byte 600");
    expect(find(lines, "dropbox", "delete").status).toBe("204");
  });

  it.each([
    ["shorter", (b: Buffer) => b.subarray(0, 500), /^FAIL the answer has 500 bytes, the upload had \d+$/],
    ["longer", (b: Buffer) => Buffer.concat([b, Buffer.from("x")]), /^FAIL the answer is longer than the \d+ bytes uploaded$/],
  ])("fails when the bytes come back %s", async (_name, change, message) => {
    const { lines } = await smoke({
      only: ["dropbox"],
      fake: {
        handlers: {
          fetch: (req, res, fake) => {
            res.send(change(Buffer.from(fake.drops.get(String(req.params["id"]))?.bytes ?? Buffer.alloc(0))));
          },
        },
      },
    });
    expect(find(lines, "dropbox", "fetch").detail).toMatch(message);
  });

  it("fails when the hold was answered but not applied", async () => {
    const { lines } = await smoke({
      only: ["dropbox"],
      fake: {
        handlers: {
          hold: (req, res, fake) => {
            const drop = fake.drops.get(String(req.params["id"]));
            res.json({ id: req.params["id"], tip: 1042, expiresAtHeight: (drop?.expiresAtHeight ?? 0) + 10 });
          },
        },
      },
    });
    expect(find(lines, "dropbox", "hold").status).toBe("200");
    expect(find(lines, "dropbox", "fetch").detail).toBe("FAIL X-Expires-At-Height is 1052, the hold said 1062: the hold was not applied");
  });

  it("fails when the drop can still be read after the delete", async () => {
    const { lines } = await smoke({
      only: ["dropbox"],
      fake: { handlers: { delete: (_req, res) => void res.status(204).end() } },
    });
    expect(find(lines, "dropbox", "delete")).toMatchObject({ status: "204", detail: "FAIL the drop can still be read after the delete (200)" });
  });

  it("fails when the upload is refused before payment, and goes no further", async () => {
    const { lines, vouchered } = await smoke({
      only: ["dropbox"],
      fake: { prepare: { upload: [(_req, res) => void res.status(415).json({ error: "not_encrypted", reason: "nope" })] } },
    });
    expect(lines).toHaveLength(1);
    expect(find(lines, "dropbox", "upload")).toMatchObject({ status: "415", detail: "FAIL expected 201, got 415: not_encrypted (nope) (not charged)" });
    expect(vouchered()).toBe(0n);
  });
});

describe("the flow itself", () => {
  it("builds each URL from the base given, with or without a path prefix or a trailing slash", async () => {
    const urls: string[] = [];
    const paidFetch: typeof fetch = async (input) => {
      urls.push(String(input instanceof Request ? input.url : input));
      return new Response("{}", { status: 500 });
    };
    await runFlow({
      services: { llm: "http://h:1/prefix", markdown: "http://h:2", embeddings: "http://h:3/e", dropbox: "http://h:4/d" },
      page: "https://example.com",
      paidFetch,
      print: () => undefined,
    });
    expect(urls).toEqual([
      "http://h:1/prefix/v1/generate",
      "http://h:2/v1/markdown?url=https%3A%2F%2Fexample.com",
      "http://h:3/e/v1/embeddings",
      "http://h:4/d/v1/drops",
    ]);
  });

  it("asks fetch for no redirects, and the paid calls carry the signal", async () => {
    const seen: { redirect: string | undefined; signal: boolean }[] = [];
    const paidFetch: typeof fetch = async (_input, init) => {
      seen.push({ redirect: init?.redirect, signal: init?.signal instanceof AbortSignal });
      return new Response("{}", { status: 500 });
    };
    await runFlow({ services: { llm: "http://h:1" }, page: "https://example.com", paidFetch, print: () => undefined, signal: new AbortController().signal });
    expect(seen).toEqual([{ redirect: "manual", signal: true }]);
  });

  it("stops before the next step once it is aborted", async () => {
    const controller = new AbortController();
    const { lines, result } = await smoke({
      flow: { signal: controller.signal },
      onLine: () => controller.abort(),
    });
    expect(lines).toHaveLength(1);
    expect(result.aborted).toBe(true);
    expect(result.ok).toBe(false);
  });

  it("returns from an abort even when the fetch never notices it, which a payment retry can do after a garbage collection", async () => {
    const controller = new AbortController();
    const paidFetch: typeof fetch = () => new Promise<Response>(() => undefined);
    setTimeout(() => controller.abort(), 30);
    const lines: string[] = [];
    const result = await Promise.race([
      runFlow({ services: { llm: "http://h:1", markdown: "http://h:2" }, page: "https://example.com", paidFetch, print: (l) => lines.push(l), signal: controller.signal }),
      new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 3000)),
    ]);
    expect(result).not.toBe("hung");
    expect(lines).toHaveLength(1);
    expect(find(lines, "llm", "start")).toMatchObject({ status: "ERR" });
    expect(find(lines, "llm", "start").detail).toMatch(/^FAIL .*abort/i);
    expect((result as FlowResult).aborted).toBe(true);
  });

  it("reports an abort in the middle of a call as a failed step and stops there", async () => {
    const controller = new AbortController();
    const { lines, result } = await smoke({
      only: ["embeddings", "dropbox"],
      flow: { signal: controller.signal },
      fake: {
        handlers: {
          embeddings: () => {
            controller.abort();
          },
        },
      },
    });
    expect(lines).toHaveLength(1);
    expect(find(lines, "embeddings", "embed").status).toBe("ERR");
    expect(result.aborted).toBe(true);
  });
});
