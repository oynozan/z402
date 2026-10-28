import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { startTestStack, TEST_PAY_TO, TEST_TOKEN, type TestStack } from "@z402/service-kit/testing";
import express from "express";
import { afterEach, expect, test, vi } from "vitest";
import { fakeProvider, gate, type FakeProvider } from "./fake-provider.js";

const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));
const READY_RE = /^llm listening on (http:\/\/127\.0\.0\.1:\d+) model=test-model network=zcash:regtest$/m;
const OWN_VARIABLE_RE = /^(Z402_|LLM_|PUBLIC_URL$|HOST$|PORT$)/;

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c();
});

/** The ready line's URL, or the process's output when it exits or stays silent */
function readyUrl(child: ChildProcess, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = "";
    let err = "";
    const timer = setTimeout(() => reject(new Error(`no ready line in ${timeoutMs} ms\n${out}${err}`)), timeoutMs);
    child.stdout?.on("data", (d: Buffer) => {
      out += d.toString();
      const url = READY_RE.exec(out)?.[1];
      if (url !== undefined) {
        clearTimeout(timer);
        resolve(url);
      }
    });
    child.stderr?.on("data", (d: Buffer) => {
      err += d.toString();
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`exited with ${code}\n${out}${err}`));
    });
  });
}

/** The service as its own process, in front of `provider` and the facilitator of `stack` */
function startMain(stack: TestStack, provider: FakeProvider, more: Record<string, string> = {}): ChildProcess {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([k]) => !OWN_VARIABLE_RE.test(k)));
  const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
    cwd: PACKAGE_DIR,
    env: {
      ...inherited,
      Z402_FACILITATOR_URL: stack.facilitator.url,
      Z402_FACILITATOR_TOKEN: TEST_TOKEN,
      Z402_PAY_TO: TEST_PAY_TO,
      HOST: "127.0.0.1",
      PORT: "0",
      LLM_BASE_URL: provider.baseUrl,
      LLM_MODEL: "test-model",
      ...more,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  cleanup.push(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  });
  return child;
}

async function facilitatorOnly(): Promise<TestStack> {
  // Only the facilitator and the paying client of this stack are used
  const stack = await startTestStack({ build: async () => express() });
  cleanup.push(() => stack.close());
  return stack;
}

async function fake(o: Parameters<typeof fakeProvider>[0] = {}): Promise<FakeProvider> {
  const provider = await fakeProvider(o);
  cleanup.push(() => provider.close());
  return provider;
}

test("main prints its ready line, serves the 402 at 200 zat and exits 0 on SIGTERM", { timeout: 30_000 }, async () => {
  const stack = await facilitatorOnly();
  const child = startMain(stack, await fake());

  const url = await readyUrl(child, 20_000);
  const unpaid = await fetch(`${url}/v1/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "hi" }),
  });
  expect(unpaid.status).toBe(402);
  const required = JSON.parse(Buffer.from(unpaid.headers.get("payment-required") ?? "", "base64").toString("utf8"));
  expect(required.accepts[0].amount).toBe("200");
  const health = await fetch(`${url}/health`);
  expect(health.status).toBe(200);
  expect(await health.json()).toMatchObject({ priceZat: "200", routes: [{ path: "/v1/generate", priceZat: "200" }] });

  const exited = once(child, "exit");
  child.kill("SIGTERM");
  expect(await exited).toEqual([0, null]);
});

test("SIGTERM with a paid call in flight answers it unsettled and exits 0 at once", { timeout: 30_000 }, async () => {
  const stack = await facilitatorOnly();
  const hold = gate();
  const provider = await fake({ reply: () => ({ steps: [hold, "a", "b", "c"] }) });
  // The stack's facilitator takes one price, 500 zat
  const child = startMain(stack, provider, { Z402_PRICE_ZAT: "500" });
  const url = await readyUrl(child, 20_000);

  const call = stack.paidFetch(`${url}/v1/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "hi" }),
  });
  await vi.waitFor(() => expect(provider.chats).toHaveLength(1), { timeout: 10_000 });

  const exited = once(child, "exit");
  const stopping = Date.now();
  child.kill("SIGTERM");
  const res = await call;
  expect([res.status, await res.json()]).toEqual([503, { error: "stream_closed" }]);
  expect(res.headers.get("payment-response")).toBeNull();
  expect(await exited).toEqual([0, null]);
  expect(Date.now() - stopping).toBeLessThan(2_000);
  await vi.waitFor(() => expect(provider.aborted).toBe(1));
  hold.open();
});
