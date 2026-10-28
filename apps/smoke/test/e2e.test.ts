/**
 * src/main.ts as a process, paying for real: the real ZalletRpcWallet talks JSON-RPC to a fake Zallet that puts the
 * deposit on the FakeChain of the in-process facilitator, so the process makes a deposit, signs a voucher, and the
 * service verifies it and settles. Only the lightwalletd side is left out, as the first calls ride on the credit that
 * the facilitator gives a deposit it sees in the mempool.
 */
import { startTestStack, type TestStack } from "@z402-net/service-kit/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeServices, type FakeOptions } from "./fakes.js";
import { cleanup, GC_PRELOAD, listen, refusedUrl, start } from "./process.js";

vi.setConfig({ testTimeout: 90_000 });

const stacks: TestStack[] = [];
afterEach(async () => {
  await cleanup();
  for (const stack of stacks.splice(0)) await stack.close();
});

/** 100000 zat is "0.001", the way the wallet writes it */
function zatOf(amount: string): bigint {
  const [whole = "0", fraction = ""] = amount.split(".");
  return BigInt(whole) * 100_000_000n + BigInt(fraction.padEnd(8, "0"));
}

interface Output {
  address: string;
  amount: string;
  memo: string;
}

/** The Zallet calls of a deposit, with z_sendmany broadcasting onto the chain of the stack; `sent` lists the txids */
async function fakeZallet(stack: TestStack): Promise<{ url: string; sent: string[] }> {
  const sent: string[] = [];
  const url = await listen((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const call = JSON.parse(Buffer.concat(chunks).toString()) as { id: number; method: string; params: unknown[] };
      const answer = (body: object): void => {
        res
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ jsonrpc: "2.0", id: call.id, ...body }));
      };
      switch (call.method) {
        case "z_listaccounts":
          return answer({ result: [{ account_uuid: "00000000-0000-0000-0000-000000000001" }] });
        case "z_getbalanceforaccount":
          return answer({ result: { pools: { orchard: { valueZat: 10_000_000 } } } });
        case "z_getaddressforaccount":
          return answer({ result: { address: "uregtest1agent" } });
        case "z_sendmany": {
          const [output] = call.params[1] as Output[];
          if (output === undefined) return answer({ error: { code: -8, message: "no output" } });
          const memo = Buffer.from(output.memo, "hex").toString("utf8");
          sent.push(stack.chain.broadcast({ outputs: [{ to: output.address, valueZat: zatOf(output.amount), memo }] }));
          return answer({ result: `opid-${sent.length}` });
        }
        case "z_getoperationresult": {
          const [ids] = call.params as [string[]];
          return answer({
            result: ids.map((id) => ({ id, status: "success", result: { txid: sent[Number(id.slice(5)) - 1] } })),
          });
        }
        default:
          return answer({ error: { code: -32601, message: `no ${call.method}` } });
      }
    });
  });
  return { url, sent };
}

interface Rig {
  services: FakeServices;
  zallet: { url: string; sent: string[] };
  /** Where the fake services listen */
  url: string;
  /** The flags that point the command at the fake Zallet, and at a lightwalletd that refuses connections */
  wallet: string[];
}

async function rig(fake: FakeOptions = {}): Promise<Rig> {
  const services = new FakeServices(fake);
  const stack = await startTestStack({ build: (env) => services.build(env) });
  stacks.push(stack);
  const zallet = await fakeZallet(stack);
  return { services, zallet, url: stack.url, wallet: ["--zallet-url", zallet.url, "--lightwalletd", await refusedUrl()] };
}

describe("src/main.ts paying through the real wallet client", () => {
  it("makes the deposit, pays the call, prints it with the session and exits 0", async () => {
    const { services, zallet, url, wallet } = await rig();
    const { code, stdout, stderr } = await start(["--markdown", url, ...wallet]).exit;

    expect(code, `${stdout}\n${stderr}`).toBe(0);
    expect(stderr).toMatch(/^wallet: 10000000 zat spendable$/m);
    expect(stderr).toMatch(/^ {2}\* deposit D1 started, paid inline$/m);
    const lines = stdout.trimEnd().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^markdown get 200 \d+ ms "Example Domain" 76 chars \(500 zat\)$/);
    expect(lines[1]).toBe("session uregtest1qqq…qqqqqq cumulative 500 zat after 1 paid call");
    expect(lines[2]).toBe("smoke ok: 1 step passed on markdown; skipped: llm, embeddings, dropbox");
    expect(zallet.sent).toHaveLength(1);
    expect(services.markdownUrls).toEqual(["https://example.com"]);
  });

  it("pays all four services from one session with one deposit, as the compose run does", async () => {
    const { services, zallet, url, wallet } = await rig();
    const { code, stdout, stderr } = await start(["--llm", url, "--markdown", url, "--embeddings", url, "--dropbox", url, ...wallet])
      .exit;

    expect(code, `${stdout}\n${stderr}`).toBe(0);
    const lines = stdout.trimEnd().split("\n");
    expect(lines).toHaveLength(11);
    expect(lines.slice(0, 9).map((l) => l.split(" ").slice(0, 3).join(" "))).toEqual([
      "llm start 200",
      "llm continue 200",
      "llm continue 200",
      "markdown get 200",
      "embeddings embed 200",
      "dropbox upload 201",
      "dropbox hold 200",
      "dropbox fetch 200",
      "dropbox delete 204",
    ]);
    expect(lines[9]).toBe("session uregtest1qqq…qqqqqq cumulative 3500 zat after 7 paid calls");
    expect(lines[10]).toBe("smoke ok: 9 steps passed on llm, markdown, embeddings, dropbox");
    // One deposit funded seven calls on four services
    expect(zallet.sent).toHaveLength(1);
    expect(stderr.match(/deposit D\d+ started/g)).toEqual(["deposit D1 started"]);
    expect(services.drops.size).toBe(0);
  });

  it("exits 1 and says what a failed service cost when one of the services fails", async () => {
    const { url, wallet } = await rig({
      handlers: { embeddings: (_req, res) => void res.status(502).json({ error: "provider_failed" }) },
    });
    const { code, stdout, stderr } = await start(["--llm", url, "--embeddings", url, ...wallet]).exit;

    expect(code, `${stdout}\n${stderr}`).toBe(1);
    const lines = stdout.trimEnd().split("\n");
    expect(lines.at(-3)).toMatch(
      /^embeddings embed 502 \d+ ms FAIL expected 200, got 502: provider_failed \(charged 500 zat\)$/,
    );
    expect(lines.at(-2)).toBe("session uregtest1qqq…qqqqqq cumulative 2000 zat after 3 paid calls");
    expect(lines.at(-1)).toBe("smoke FAILED: 1 of 4 steps failed (embeddings embed); skipped: markdown, dropbox");
  });

  it("does not leave the process hanging when SIGINT arrives while the paid call is in flight and the abort is lost", async () => {
    const reached: string[] = [];
    const { zallet, url, wallet } = await rig({
      // Takes the paid request, and never answers
      handlers: { markdown: (req) => void reached.push(String(req.query["url"])) },
    });
    // Collecting garbage all the time is what loses the link between the signal and the clone the wrapper sends
    const run = start(["--markdown", url, ...wallet], ["--expose-gc", "--import", GC_PRELOAD]);

    await vi.waitFor(() => expect(reached).toHaveLength(1), { timeout: 60_000, interval: 50 });
    expect(zallet.sent).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 300));
    run.child.kill("SIGINT");
    const exit = await Promise.race([run.exit, new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 20_000))]);

    expect(exit === "hung" ? exit : exit.code, `${run.stdout()}\n${run.stderr()}`).toBe(130);
    const lines = run.stdout().trimEnd().split("\n");
    // The voucher was sent and has no answer, so the call is not free
    expect(lines[0]).toMatch(/^markdown get ERR \d+ ms FAIL .*abort.* \(charged 500 zat\)$/i);
    expect(lines.at(-2)).toBe("session uregtest1qqq…qqqqqq cumulative 500 zat after 0 paid calls");
    expect(lines.at(-1)).toBe("smoke interrupted after 1 step");
  });
});
