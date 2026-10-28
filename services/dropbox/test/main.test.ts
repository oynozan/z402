import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { afterEach, describe, expect, test, vi } from "vitest";
import { startTestStack, TEST_PAY_TO, TEST_TOKEN, type TestStack } from "@z402/service-kit/testing";

const PACKAGE = fileURLToPath(new URL("..", import.meta.url));

interface Proc {
  child: ChildProcess;
  stdout(): string;
  stderr(): string;
  exited: Promise<number | null>;
}

const procs: Proc[] = [];
const stacks: TestStack[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const proc of procs.splice(0)) proc.child.kill("SIGKILL");
  for (const stack of stacks.splice(0)) await stack.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The real main.ts as a process, with an environment that holds nothing of the developer's own */
function start(settings: Record<string, string>): Proc {
  const own = /^(Z402_|DROPBOX_|PUBLIC_URL$|HOST$|PORT$)/;
  const inherited = Object.entries(process.env).filter(([name]) => !own.test(name));
  const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
    cwd: PACKAGE,
    env: { ...Object.fromEntries(inherited), ...settings },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  child.stdout?.on("data", (chunk: Buffer) => (out += chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => (err += chunk.toString()));
  const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
  const proc = { child, stdout: () => out, stderr: () => err, exited };
  procs.push(proc);
  return proc;
}

async function settings(extra: Record<string, string> = {}): Promise<Record<string, string>> {
  const stack = await startTestStack({ build: async () => express() });
  stacks.push(stack);
  const dir = mkdtempSync(join(tmpdir(), "dropbox-main-"));
  dirs.push(dir);
  return {
    NODE_ENV: "production",
    Z402_FACILITATOR_URL: stack.env.facilitatorUrl,
    Z402_FACILITATOR_TOKEN: TEST_TOKEN,
    Z402_PAY_TO: TEST_PAY_TO,
    PORT: "0",
    DROPBOX_DIR: dir,
    // Nothing listens on port 1, so the service starts without a tip
    DROPBOX_LWD_URL: "http://127.0.0.1:1",
    DROPBOX_TIP_POLL_MS: "200",
    ...extra,
  };
}

describe("main", () => {
  test("starts from the environment, is not ready without a tip, and stops with exit code 0 on SIGTERM", async () => {
    const env = await settings();
    const proc = start(env);

    await vi.waitFor(() => expect(proc.stdout()).toMatch(/listening on http:\/\/\S+/), { timeout: 20_000 });
    const [line] = proc.stdout().trim().split("\n");
    expect(line).toMatch(/^dropbox listening on http:\/\/127\.0\.0\.1:\d+ network=zcash:regtest dir=/);
    expect(line).toContain(`dir=${env["DROPBOX_DIR"]}`);

    const url = /listening on (http:\/\/\S+)/.exec(line ?? "")?.[1];
    const health = await fetch(`${url}/health`);
    expect(health.status).toBe(503);
    expect(await health.json()).toMatchObject({
      ready: false,
      service: "Encrypted drop box",
      priceZat: "500",
      routes: [
        { path: "/v1/drops", priceZat: "500" },
        { path: "/v1/drops/:id/hold", priceZat: "500" },
      ],
    });
    const upload = await fetch(`${url}/v1/drops`, { method: "POST", body: "anything" });
    expect(upload.status).toBe(503);

    // The failure is logged once and not once per poll
    await vi.waitFor(() => expect(proc.stderr()).toContain("dropbox: cannot read the chain tip"), { timeout: 10_000 });
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(proc.stderr().match(/cannot read the chain tip/g)).toHaveLength(1);

    proc.child.kill("SIGTERM");
    expect(await proc.exited).toBe(0);
  }, 60_000);

  test.each([
    ["DROPBOX_MAX_BYTES", "lots", /^dropbox: DROPBOX_MAX_BYTES: expected a whole number/],
    ["DROPBOX_LWD_URL", "localhost:28137", /^dropbox: DROPBOX_LWD_URL: expected an http/],
    ["DROPBOX_MAX_HOLD_BLOCKS", "5", /^dropbox: DROPBOX_MAX_HOLD_BLOCKS: must be at least DROPBOX_BLOCKS_PER_CALL/],
    ["Z402_PAY_TO", "utest1nonsense", /^dropbox: Z402_PAY_TO: not a shielded-only unified address/],
  ])("exits 1 and names %s when it is set to %s", async (name, value, message) => {
    const proc = start(await settings({ [name]: value }));
    expect(await proc.exited).toBe(1);
    expect(proc.stderr()).toMatch(message);
    expect(proc.stdout()).toBe("");
  }, 60_000);

  test("exits 1 naming DROPBOX_DIR when the directory cannot be made", async () => {
    const env = await settings();
    const proc = start({ ...env, DROPBOX_DIR: "/dev/null/drops" });
    expect(await proc.exited).toBe(1);
    expect(proc.stderr()).toMatch(/^dropbox: DROPBOX_DIR: cannot use \/dev\/null\/drops \(ENOTDIR\)/);
  }, 60_000);
});
