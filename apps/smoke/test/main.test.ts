/**
 * The command as a process, the way `pnpm start` and the container run it, with the real wallet and chain clients. It
 * covers what the in-process tests cannot: the exit status, what goes to stdout and stderr, the flags reaching Zallet,
 * and that the process ends by itself once the wallet and the lightwalletd client are closed.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, GC_PRELOAD, listen, refusedUrl, run, start } from "./process.js";

vi.setConfig({ testTimeout: 60_000 });

afterEach(cleanup);

/** The two Zallet calls the preflight makes, answering only to the credentials it was given */
async function fakeZallet(balanceZat: number, auth: { user: string; password: string }): Promise<{ url: string; methods: string[] }> {
  const methods: string[] = [];
  const expected = `Basic ${Buffer.from(`${auth.user}:${auth.password}`).toString("base64")}`;
  const url = await listen((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      if (req.headers.authorization !== expected) {
        res.writeHead(401).end();
        return;
      }
      const call = JSON.parse(Buffer.concat(chunks).toString()) as { id: number; method: string };
      methods.push(call.method);
      const result =
        call.method === "z_listaccounts"
          ? [{ account_uuid: "00000000-0000-0000-0000-000000000001" }]
          : { pools: { orchard: { valueZat: balanceZat } } };
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: call.id, result }));
    });
  });
  return { url, methods };
}

describe("src/main.ts", () => {
  it("prints the usage and exits 0 for --help", async () => {
    const exit = await run(["--help"]);
    expect(exit.code).toBe(0);
    expect(exit.stdout).toMatch(/^usage: pnpm --filter @z402\/smoke start/);
    expect(exit.stderr).toBe("");
  });

  it("exits 2 with the reason on stderr when the flags are wrong", async () => {
    const exit = await run(["--markdown", "http://127.0.0.1:1", "--bogus"]);
    expect(exit.code).toBe(2);
    expect(exit.stdout).toBe("");
    expect(exit.stderr).toMatch(/--bogus/);
    expect(exit.stderr).toMatch(/usage:/);
  });

  it("exits 2 when no service was given, since a run that checks nothing must not pass", async () => {
    const exit = await run([]);
    expect(exit.code).toBe(2);
    expect(exit.stdout).toBe("");
    expect(exit.stderr).toMatch(/at least one service/);
  });

  it("exits 1 at once, naming the wallet, when Zallet cannot be reached", async () => {
    const closed = await refusedUrl();
    const exit = await run(["--markdown", closed, "--zallet-url", closed, "--lightwalletd", closed]);
    expect(exit.code).toBe(1);
    expect(exit.stdout).toBe("");
    expect(exit.stderr).toMatch(/^cannot read the spendable balance of the wallet: Zallet z_listaccounts: fetch failed \(ECONNREFUSED\)\n$/);
  });

  it("exits 1 when the wallet cannot fund a deposit", async () => {
    const zallet = await fakeZallet(5_000, { user: "zebra", password: "zebra" });
    const exit = await run(["--markdown", "http://127.0.0.1:1", "--zallet-url", zallet.url, "--lightwalletd", "http://127.0.0.1:1"]);
    expect(exit.code).toBe(1);
    expect(exit.stderr).toMatch(/the wallet has 5000 zat spendable, a run needs at least 125000 zat/);
  });

  it("reads the wallet with the credentials it was given, runs the steps, prints the verdict and ends by itself", async () => {
    const zallet = await fakeZallet(10_000_000, { user: "alice", password: "s3cret" });
    const seen: string[] = [];
    const service = await listen((req, res) => {
      seen.push(`${req.method} ${req.url}`);
      res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: "convert_failed" }));
    });
    const exit = await run([
      "--markdown", service,
      "--page", "https://example.org/a b",
      "--zallet-url", zallet.url,
      "--zallet-user", "alice",
      "--zallet-password", "s3cret",
      "--lightwalletd", "http://127.0.0.1:1",
    ]);

    expect(exit.code).toBe(1);
    expect(zallet.methods).toEqual(["z_listaccounts", "z_getbalanceforaccount"]);
    expect(seen).toEqual(["GET /v1/markdown?url=https%3A%2F%2Fexample.org%2Fa%20b"]);

    const lines = exit.stdout.trimEnd().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^markdown get 500 \d+ ms FAIL expected 200, got 500: convert_failed \(not charged\)$/);
    expect(lines[1]).toBe("session none, no voucher was signed");
    expect(lines[2]).toBe("smoke FAILED: 1 of 1 step failed (markdown get); skipped: llm, embeddings, dropbox");
    expect(exit.stderr).toBe("wallet: 10000000 zat spendable\n");
  });

  it("gives up on the call in flight at SIGINT, says so, and exits 130", async () => {
    const zallet = await fakeZallet(10_000_000, { user: "zebra", password: "zebra" });
    const hits: string[] = [];
    // Takes the request and never answers
    const service = await listen((req) => void hits.push(req.url ?? ""));
    const closed = await refusedUrl();
    const { child, exit } = start(["--markdown", service, "--zallet-url", zallet.url, "--lightwalletd", closed]);

    await vi.waitFor(() => expect(hits).toHaveLength(1), { timeout: 30_000, interval: 50 });
    child.kill("SIGINT");
    const done = await exit;

    expect(done.code).toBe(130);
    expect(done.stderr).toMatch(/SIGINT: stopping at the next step, then closing the wallet/);
    const lines = done.stdout.trimEnd().split("\n");
    expect(lines[0]).toMatch(/^markdown get ERR \d+ ms FAIL .*abort.* \(not charged\)$/i);
    expect(lines.at(-1)).toBe("smoke interrupted after 1 step");
  });

  it("ends by itself after SIGINT even when the request in flight never notices the abort", async () => {
    const zallet = await fakeZallet(10_000_000, { user: "zebra", password: "zebra" });
    const hits: string[] = [];
    const service = await listen((req) => void hits.push(req.url ?? ""));
    const closed = await refusedUrl();
    // A garbage collection drops the link from the signal to the request the payment wrapper sends, so the abort never
    // reaches it and its socket stays open, to a service that will never answer
    const { child, exit } = start(["--markdown", service, "--zallet-url", zallet.url, "--lightwalletd", closed], [
      "--expose-gc",
      "--import",
      GC_PRELOAD,
    ]);

    await vi.waitFor(() => expect(hits).toHaveLength(1), { timeout: 30_000, interval: 50 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    child.kill("SIGINT");
    const done = await exit;

    expect(done.code).toBe(130);
    expect(done.stdout.trimEnd().split("\n").at(-1)).toBe("smoke interrupted after 1 step");
  });

  it("does not print the wallet password anywhere", async () => {
    const zallet = await fakeZallet(10_000_000, { user: "alice", password: "hunter2-secret" });
    const service = await listen((_req, res) => void res.writeHead(500).end());
    const exit = await run([
      "--markdown", service,
      "--zallet-url", zallet.url,
      "--zallet-user", "alice",
      "--zallet-password", "hunter2-secret",
      "--lightwalletd", "http://127.0.0.1:1",
    ]);
    expect(exit.stdout + exit.stderr).not.toContain("hunter2-secret");
  });
});
