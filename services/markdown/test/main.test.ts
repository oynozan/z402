/**
 * `src/main.ts` in a child process, the way `pnpm start` runs it (tsx, working directory = the package), against the
 * kit's in-process facilitator. Production runs the conversion workers under tsx, which this is the only test of, and
 * production keeps the strict address policy, which this checks from outside.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startTestStack, TEST_PAY_TO, TEST_TOKEN, type TestStack } from "@z402/service-kit/testing";
import express from "express";
import { afterEach, expect, test } from "vitest";

const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));
const SLOW = 60_000;

const children: ChildProcess[] = [];
const stacks: TestStack[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  for (const stack of stacks.splice(0)) await stack.close();
});

/** A facilitator to start against; the kit's stack brings one, around an empty app */
async function facilitatorUrl(): Promise<string> {
  const stack = await startTestStack({ build: async () => express() });
  stacks.push(stack);
  return stack.facilitator.url;
}

interface Run {
  stderr(): string;
  exited: Promise<number | null>;
  /** The first stdout line, or a rejection carrying stderr if the process exits first */
  firstLine: Promise<string>;
  child: ChildProcess;
}

/** Starts main with only the given variables, so nothing leaks in from the developer's shell or a local .env */
function runMain(vars: Record<string, string>): Run {
  const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
    cwd: PACKAGE_DIR,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", TMPDIR: process.env.TMPDIR ?? "", ...vars },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let out = "";
  let err = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => (err += chunk));
  const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  const firstLine = new Promise<string>((resolve, reject) => {
    child.stdout?.on("data", (chunk: string) => {
      out += chunk;
      const end = out.indexOf("\n");
      if (end >= 0) resolve(out.slice(0, end));
    });
    void exited.then((code) => reject(new Error(`main exited with ${code} before a line: ${err}`)));
  });
  firstLine.catch(() => undefined);
  return { stderr: () => err, exited, firstLine, child };
}

test(
  "starts, keeps the strict address policy, converts on workers and stops on SIGTERM",
  async () => {
    const run = runMain({
      Z402_FACILITATOR_URL: await facilitatorUrl(),
      Z402_FACILITATOR_TOKEN: TEST_TOKEN,
      Z402_PAY_TO: TEST_PAY_TO,
      // Set but empty, which counts as unset, so a price in a local .env cannot replace the service's own
      Z402_PRICE_ZAT: "",
      HOST: "127.0.0.1",
      PORT: "0",
    });
    const line = await run.firstLine;
    const match = /^markdown listening on (http:\/\/127\.0\.0\.1:\d+) network=zcash:regtest$/.exec(line);
    expect(match, line).not.toBeNull();
    const origin = match?.[1] ?? "";

    expect(await (await fetch(`${origin}/health`)).json()).toMatchObject({
      ready: true,
      service: "URL to markdown",
      priceZat: "1000",
      routes: [{ path: "/v1/markdown", priceZat: "1000" }],
    });
    for (const target of [
      "http://127.0.0.1/",
      "http://localhost:8080/",
      "http://169.254.169.254/latest/meta-data/",
      "http://[::1]/",
      "http://10.0.0.1:8443/",
      "http://[::ffff:192.168.1.1]/",
    ]) {
      const res = await fetch(`${origin}/v1/markdown?url=${encodeURIComponent(target)}`);
      expect(res.status, target).toBe(403);
      expect(await res.json()).toEqual({ error: "blocked_address" });
    }
    const probe = await fetch(`${origin}/v1/markdown`, { headers: { "x-z402-probe": "1" } });
    expect(probe.status).toBe(402);
    const required = JSON.parse(Buffer.from(probe.headers.get("payment-required") ?? "", "base64").toString("utf8"));
    expect(required.accepts[0].amount).toBe("1000");
    // The pool starts one worker at start and says so on stderr if it has to fall back to the main thread
    expect(run.stderr()).not.toContain("main thread");

    run.child.kill("SIGTERM");
    expect(await run.exited).toBe(0);
  },
  SLOW,
);

test(
  "a bad variable stops the start with exit 1 and a line that names it",
  async () => {
    const run = runMain({
      Z402_FACILITATOR_URL: "http://127.0.0.1:9",
      Z402_PAY_TO: TEST_PAY_TO,
      MARKDOWN_ALLOWED_PORTS: "80,ssh",
    });
    expect(await run.exited).toBe(1);
    expect(run.stderr()).toMatch(/^markdown: MARKDOWN_ALLOWED_PORTS: /m);
  },
  SLOW,
);
