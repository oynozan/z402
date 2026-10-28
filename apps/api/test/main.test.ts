/**
 * `src/main.ts` as `pnpm --filter @z402/api start` runs it, in a child process whose working directory is the
 * package, against a facilitator in this process. The demo script waits for the ready line on stdout.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { startFacilitator } from "@z402/facilitator";
import { DEMO_TERMS, NETWORK_REGTEST } from "@z402-net/protocol";
import { FakeChain } from "@z402/testkit";
import { afterEach, expect, test, vi } from "vitest";

const API_DIR = fileURLToPath(new URL("..", import.meta.url));
/** Relative to the repository root, which is two levels above the child's working directory */
const KEYS_FILE = "apps/api/test/fixtures/merchant-keys.regtest.json";
/** The fixture's orchardOnlyAddress */
const PAY_TO = `uregtest1${"q".repeat(60)}`;
/** The fixture's viewing key, which the API must never read or print */
const UIVK = "uivkregtest1testfixturenotakey";
const TOKEN = "t-main-7d1f-secret";
const SLOW = 30_000;

const facilitators: Array<{ close(): Promise<void> }> = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  for (const f of facilitators.splice(0)) await f.close();
});

async function facilitator(payTo = PAY_TO) {
  const handle = await startFacilitator({
    network: NETWORK_REGTEST,
    chain: new FakeChain({ expiryDelta: 40 }).viewFor(payTo),
    payTo,
    terms: DEMO_TERMS,
    authToken: TOKEN,
    port: 0,
    log: () => undefined,
  });
  facilitators.push(handle);
  return handle;
}

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
    cwd: API_DIR,
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
  "prints exactly one ready line, serves /chunk and exits 0 on SIGTERM",
  async () => {
    const fac = await facilitator();
    const run = runMain({
      Z402_FACILITATOR_URL: fac.url,
      Z402_FACILITATOR_TOKEN: TOKEN,
      Z402_MERCHANT_KEYS_FILE: KEYS_FILE,
      Z402_API_PORT: "0",
    });

    const line = await run.firstLine;
    const ready = /^api listening on (http:\/\/127\.0\.0\.1:\d+) network=zcash:regtest$/.exec(line);
    expect(ready, line).not.toBeNull();
    const res = await fetch(`${ready?.[1]}/chunk`);
    expect(res.status).toBe(402);
    await res.text();
    const required = decodePaymentRequiredHeader(res.headers.get("payment-required") ?? "");
    expect(required.accepts[0]).toMatchObject({ network: "zcash:regtest", amount: "500", payTo: PAY_TO });

    run.child.kill("SIGTERM");
    expect(await run.exited).toBe(0);
    expect(run.stdout()).toBe(`${line}\n`);
    // The fixture is a whole keygen JSON, which regtest takes with a warning
    expect(run.stderr()).toMatch(
      /^api: warning: Z402_MERCHANT_KEYS_FILE: \S+ holds the spending seed; the API needs only Z402_PAY_TO$/m,
    );
    for (const secret of [TOKEN, UIVK]) {
      expect(run.stdout()).not.toContain(secret);
      expect(run.stderr()).not.toContain(secret);
    }
  },
  SLOW,
);

test(
  "a missing variable exits 1 naming it and prints nothing on stdout",
  async () => {
    const run = runMain({ Z402_PAY_TO: PAY_TO });
    expect(await run.exited).toBe(1);
    expect(run.stderr()).toMatch(/^api: Z402_FACILITATOR_URL is required/m);
    expect(run.stdout()).toBe("");
  },
  SLOW,
);

test(
  "a facilitator that pays another address exits 1 naming payTo",
  async () => {
    const fac = await facilitator(`uregtest1${"p".repeat(60)}`);
    const run = runMain({ Z402_FACILITATOR_URL: fac.url, Z402_FACILITATOR_TOKEN: TOKEN, Z402_PAY_TO: PAY_TO });
    expect(await run.exited).toBe(1);
    expect(run.stderr()).toMatch(/^api: payTo:/m);
    expect(run.stderr()).not.toContain(TOKEN);
    expect(run.stdout()).toBe("");
  },
  SLOW,
);

test(
  "Z402_API_PUBLIC_URL lists /chunk in the facilitator's Bazaar, and the ready line is as it was",
  async () => {
    const fac = await facilitator();
    const run = runMain({
      Z402_FACILITATOR_URL: fac.url,
      Z402_FACILITATOR_TOKEN: TOKEN,
      Z402_MERCHANT_KEYS_FILE: KEYS_FILE,
      Z402_API_PORT: "0",
      Z402_API_PUBLIC_URL: "https://api.example.test/",
    });

    const line = await run.firstLine;
    expect(line).toMatch(/^api listening on http:\/\/127\.0\.0\.1:\d+ network=zcash:regtest$/);
    const items = async (): Promise<unknown[]> =>
      ((await (await fetch(`${fac.url}/discovery/resources`)).json()) as { items: unknown[] }).items;
    await vi.waitFor(async () => expect(await items()).toHaveLength(1), { timeout: 10_000 });
    expect(await items()).toMatchObject([
      { resource: "https://api.example.test/chunk", accepts: [{ payTo: PAY_TO, amount: "500" }] },
    ]);
    const listed = new RegExp(
      String.raw`^api: discovery: 1 paid route listed by the facilitator at http://127\.0\.0\.1:\d+, ` +
        String.raw`declared again every 30 s$`,
      "m",
    );
    await vi.waitFor(() => expect(run.stderr()).toMatch(listed), { timeout: 10_000 });

    run.child.kill("SIGTERM");
    expect(await run.exited).toBe(0);
    expect(run.stdout()).toBe(`${line}\n`);
    for (const secret of [TOKEN, UIVK]) {
      expect(run.stdout()).not.toContain(secret);
      expect(run.stderr()).not.toContain(secret);
    }
  },
  SLOW,
);

test(
  "a Z402_API_PUBLIC_URL with credentials exits 1 naming it, without quoting it or asking the facilitator",
  async () => {
    const run = runMain({
      Z402_FACILITATOR_URL: "http://127.0.0.1:9",
      Z402_PAY_TO: PAY_TO,
      Z402_API_PUBLIC_URL: "https://agent:hunter2@api.example.test",
    });
    expect(await run.exited).toBe(1);
    expect(run.stderr()).toMatch(/^api: Z402_API_PUBLIC_URL: must not carry credentials$/m);
    expect(run.stderr()).not.toContain("hunter2");
    expect(run.stdout()).toBe("");
  },
  SLOW,
);
