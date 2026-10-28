/** `src/main.ts` run as `pnpm start` runs it, in a child process whose working directory is the package */
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test, vi } from "vitest";
import { closeAll, deadUrl, hangingOrigin, origin, paymentRequired, router, send402, sendHealth } from "./support/origins.js";

const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));
const SLOW = 30_000;

const children: ChildProcess[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  await closeAll();
});

interface Run {
  child: ChildProcess;
  stdout(): string;
  stderr(): string;
  exited: Promise<number | null>;
  /** The first stdout line, or a rejection carrying stderr if the process exits first */
  firstLine: Promise<string>;
}

/** Starts main with only the given variables, so nothing leaks in from the developer's shell */
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
  return { child, stdout: () => out, stderr: () => err, exited, firstLine };
}

test(
  "prints one ready line, serves the catalog and exits 0 on SIGTERM",
  async () => {
    const svc = await origin(
      router({
        "GET /health": (_req, res) => sendHealth(res, [{ method: "GET", path: "/a", unit: "page" }], { service: "Svc" }),
        "GET /a": (_req, res) => send402(res, paymentRequired("https://svc.example/a", { serviceName: "Svc" })),
      }),
    );
    const api = await origin(router({ "GET /chunk": (_req, res) => send402(res, paymentRequired("https://api.example/chunk")) }));
    const run = runMain({
      DISCOVERY_SERVICES: svc.url,
      DISCOVERY_TARGETS: `GET ${api.url}/chunk`,
      HOST: "127.0.0.1",
      PORT: "0",
    });

    const line = await run.firstLine;
    const ready = /^discovery listening on (http:\/\/127\.0\.0\.1:\d+) services=1$/.exec(line);
    expect(ready, line).not.toBeNull();
    const listed = (await (await fetch(`${ready?.[1]}/discovery/resources?type=http`)).json()) as { items: Array<{ resource: string }> };
    expect(listed.items.map((i) => i.resource)).toEqual(["https://svc.example/a", "https://api.example/chunk"]);
    const status = (await (await fetch(`${ready?.[1]}/discovery/status`)).json()) as Array<Record<string, unknown>>;
    expect(status).toMatchObject([{ serviceName: "Svc", up: true, unit: "page" }]);

    run.child.kill("SIGTERM");
    expect(await run.exited).toBe(0);
    expect(run.stdout()).toBe(`${line}\n`);
  },
  SLOW,
);

test(
  "starts with a dead service, reports it on stderr and keeps stdout to the ready line",
  async () => {
    const dead = await deadUrl();
    const run = runMain({ DISCOVERY_SERVICES: dead, DISCOVERY_TIMEOUT_MS: "500", PORT: "0" });
    const line = await run.firstLine;
    const base = /^discovery listening on (http:\/\/127\.0\.0\.1:\d+) services=1$/.exec(line)?.[1];
    expect(base, line).toBeDefined();

    const status = (await (await fetch(`${base}/discovery/status`)).json()) as Array<{ up: boolean }>;
    expect(status.map((s) => s.up)).toEqual([false]);
    expect(run.stderr()).toContain(`discovery: ${dead} is down (ECONNREFUSED)`);
    expect(run.stdout()).toBe(`${line}\n`);

    run.child.kill("SIGINT");
    expect(await run.exited).toBe(0);
  },
  SLOW,
);

test(
  "SIGTERM during the first refresh ends the process at once, without a ready line",
  async () => {
    const hang = await hangingOrigin();
    const run = runMain({ DISCOVERY_SERVICES: hang.url, DISCOVERY_TIMEOUT_MS: "20000", PORT: "0" });
    await vi.waitFor(() => expect(hang.requests).toHaveLength(1), { timeout: 15_000, interval: 20 });

    const started = performance.now();
    run.child.kill("SIGTERM");
    expect(await run.exited).toBe(0);
    expect(performance.now() - started).toBeLessThan(3000);
    expect(run.stdout()).toBe("");
  },
  SLOW,
);

test(
  "a missing or bad variable exits 1 naming it and prints nothing on stdout",
  async () => {
    const missing = runMain({});
    expect(await missing.exited).toBe(1);
    expect(missing.stderr()).toMatch(/^discovery: DISCOVERY_SERVICES is required/m);
    expect(missing.stdout()).toBe("");

    const bad = runMain({ DISCOVERY_SERVICES: "http://user:hunter2@llm:4031" });
    expect(await bad.exited).toBe(1);
    expect(bad.stderr()).toMatch(/^discovery: DISCOVERY_SERVICES: entry 1 must not contain credentials/m);
    expect(bad.stderr()).not.toContain("hunter2");
    expect(bad.stdout()).toBe("");
  },
  SLOW,
);

test(
  "a port in use exits 1 naming PORT",
  async () => {
    const taken = await origin(() => undefined);
    const dead = await deadUrl();
    const run = runMain({ DISCOVERY_SERVICES: dead, HOST: "127.0.0.1", PORT: new URL(taken.url).port });
    expect(await run.exited).toBe(1);
    expect(run.stderr()).toMatch(/^discovery: PORT: cannot listen on 127\.0\.0\.1:\d+ \(EADDRINUSE\)/m);
    expect(run.stdout()).toBe("");
  },
  SLOW,
);
