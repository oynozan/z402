import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { startTestStack, TEST_PAY_TO, TEST_TOKEN, type TestStack } from "@z402/service-kit/testing";
import express from "express";
import { afterEach, expect, test } from "vitest";
import { fakeProvider, type FakeProvider } from "./fake-provider.js";

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

test("main prints its ready line, serves the 402 and exits 0 on SIGTERM", { timeout: 30_000 }, async () => {
  // Only the facilitator of this stack is used
  const stack: TestStack = await startTestStack({ build: async () => express() });
  cleanup.push(() => stack.close());
  const provider: FakeProvider = await fakeProvider();
  cleanup.push(() => provider.close());

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
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  cleanup.push(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  });

  const url = await readyUrl(child, 20_000);
  const unpaid = await fetch(`${url}/v1/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "hi" }),
  });
  expect(unpaid.status).toBe(402);
  expect(unpaid.headers.get("payment-required")).toBeTruthy();
  expect((await fetch(`${url}/health`)).status).toBe(200);

  const exited = once(child, "exit");
  child.kill("SIGTERM");
  expect(await exited).toEqual([0, null]);
});
