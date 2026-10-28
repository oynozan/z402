/**
 * The service as a process, the way pnpm start and the container run it, with src/main.ts reading its settings from
 * the environment against a real facilitator and a fake provider. It covers what the in-process tests cannot, which is
 * the env to config wiring, the ready line, a paid call, a clean stop on SIGTERM and a start that names its variable.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import express from "express";
import { startTestStack, TEST_PAY_TO, TEST_TOKEN, type TestStack } from "@z402/service-kit/testing";
import { afterEach, describe, expect, test } from "vitest";
import { startFakeProvider, vectorFor, type FakeProvider } from "./fake-provider.js";

const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));
const START_TIMEOUT_MS = 30_000;

interface Running {
  process: ChildProcess;
  stdout: string;
  stderr: string;
  exit: Promise<number | null>;
}

const children: Running[] = [];
const stacks: TestStack[] = [];
const fakes: FakeProvider[] = [];
afterEach(async () => {
  for (const c of children.splice(0)) c.process.kill("SIGKILL");
  for (const s of stacks.splice(0)) await s.close();
  for (const f of fakes.splice(0)) await f.close();
});

/** Starts src/main.ts with exactly this environment, so nothing leaks in from the shell that runs the tests */
function start(env: Record<string, string>): Running {
  const proc = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
    cwd: PACKAGE_DIR,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", TMPDIR: process.env.TMPDIR ?? "", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const running: Running = {
    process: proc,
    stdout: "",
    stderr: "",
    exit: new Promise((resolve) => proc.once("exit", (code) => resolve(code))),
  };
  proc.stdout?.on("data", (d: Buffer) => (running.stdout += d.toString()));
  proc.stderr?.on("data", (d: Buffer) => (running.stderr += d.toString()));
  children.push(running);
  return running;
}

/** The URL in the ready line, or a failure that shows what the process printed */
async function listening(r: Running): Promise<string> {
  const deadline = Date.now() + START_TIMEOUT_MS - 5_000;
  while (Date.now() < deadline) {
    const url = /^embeddings listening on (http:\/\/\S+)/m.exec(r.stdout)?.[1];
    if (url !== undefined) return url;
    if (r.process.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`no ready line (exit ${r.process.exitCode}), stdout: ${r.stdout}, stderr: ${r.stderr}`);
}

async function facilitator(): Promise<TestStack> {
  // The app is unused, since only the facilitator and the paying client of the stack are needed here
  const stack = await startTestStack({ build: async () => express() });
  stacks.push(stack);
  return stack;
}

function envFor(stack: TestStack, fake: FakeProvider, extra: Record<string, string> = {}): Record<string, string> {
  return {
    HOST: "127.0.0.1",
    PORT: "0",
    Z402_FACILITATOR_URL: stack.env.facilitatorUrl,
    Z402_FACILITATOR_TOKEN: TEST_TOKEN,
    Z402_PAY_TO: TEST_PAY_TO,
    EMBEDDINGS_BASE_URL: fake.url,
    EMBEDDINGS_API_KEY: "sk-main-test-key",
    // Set but empty, which counts as unset, so a price in a local .env cannot replace the service's own
    Z402_PRICE_ZAT: "",
    ...extra,
  };
}

describe("src/main.ts", () => {
  test(
    "serves a paid call from the environment and stops cleanly on SIGTERM",
    async () => {
      const stack = await facilitator();
      const fake = await startFakeProvider({ apiKey: "sk-main-test-key" });
      fakes.push(fake);
      // The stack's facilitator takes one price, 500 zat
      const service = start(envFor(stack, fake, { Z402_PRICE_ZAT: "500" }));
      const url = await listening(service);

      // The ready line says where it listens and with what, and never quotes the key
      const origin = String.raw`http:\/\/127\.0\.0\.1:\d+`;
      const line = `embeddings listening on ${origin} network=zcash:regtest model=nomic-embed-text provider=${origin}`;
      expect(service.stdout).toMatch(new RegExp(`^${line}$`, "m"));
      expect(service.stdout + service.stderr).not.toContain("sk-main-test-key");

      const health = await fetch(`${url}/health`);
      expect(health.status).toBe(200);
      expect(await health.json()).toMatchObject({ ok: true, ready: true, service: "Text embeddings", priceZat: "500" });

      const res = await stack.paidFetch(`${url}/v1/embeddings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: ["hello", "world"] }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: { index: number; embedding: number[] }[] };
      expect(body.data).toMatchObject([
        { index: 0, embedding: vectorFor("hello") },
        { index: 1, embedding: vectorFor("world") },
      ]);
      expect(fake.embedRequests().every((r) => r.authorization === "Bearer sk-main-test-key")).toBe(true);

      service.process.kill("SIGTERM");
      expect(await service.exit).toBe(0);
    },
    START_TIMEOUT_MS,
  );

  test(
    "a model the provider does not list is reported by /health, with the reason on stderr",
    async () => {
      const stack = await facilitator();
      const fake = await startFakeProvider({ models: ["other"] });
      fakes.push(fake);
      const service = start(envFor(stack, fake, { EMBEDDINGS_API_KEY: "" }));
      const url = await listening(service);
      const health = await fetch(`${url}/health`);
      expect(health.status).toBe(503);
      // Its own price, as Z402_PRICE_ZAT is not set
      expect(await health.json()).toMatchObject({
        priceZat: "100",
        routes: [{ path: "/v1/embeddings", priceZat: "100" }],
      });
      expect(service.stderr).toContain("embeddings: not ready, the provider does not list nomic-embed-text");
    },
    START_TIMEOUT_MS,
  );

  test.each([
    ["Z402_PAY_TO", { Z402_PAY_TO: "" }],
    ["Z402_FACILITATOR_URL", { Z402_FACILITATOR_URL: "" }],
    ["EMBEDDINGS_MAX_CHARS", { EMBEDDINGS_MAX_CHARS: "lots" }],
    ["EMBEDDINGS_BASE_URL", { EMBEDDINGS_BASE_URL: "ftp://example.com" }],
    ["Z402_FACILITATOR_URL", { Z402_FACILITATOR_URL: "http://127.0.0.1:1", Z402_FACILITATOR_WAIT_MS: "0" }],
  ])(
    "exits 1 naming %s when it is wrong",
    async (variable, wrong) => {
      const stack = await facilitator();
      const fake = await startFakeProvider();
      fakes.push(fake);
      const service = start(envFor(stack, fake, wrong));
      expect(await service.exit).toBe(1);
      expect(service.stdout).toBe("");
      expect(service.stderr).toContain(`embeddings: ${variable}`);
      expect(service.stderr).not.toContain("sk-main-test-key");
    },
    START_TIMEOUT_MS,
  );
});
