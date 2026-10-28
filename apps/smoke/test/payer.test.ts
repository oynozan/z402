import { startTestStack, TEST_PAY_TO, type TestStack } from "@z402/service-kit/testing";
import { MockWallet } from "@z402/testkit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULTS, type Flags } from "../src/flags.js";
import { abortable } from "../src/http.js";
import { createPayer, PREFLIGHT_FLOOR_ZAT, preflight, PreflightError, type Payer } from "../src/payer.js";
import { FakeServices } from "./fakes.js";

vi.setConfig({ testTimeout: 30_000 });

const stacks: TestStack[] = [];
const payers: Payer[] = [];
afterEach(async () => {
  for (const payer of payers.splice(0)) await payer.close();
  for (const stack of stacks.splice(0)) await stack.close();
});

describe("preflight", () => {
  it("returns the balance when it covers one deposit and the fee", async () => {
    expect(await preflight({ spendableBalance: async () => PREFLIGHT_FLOOR_ZAT })).toBe(PREFLIGHT_FLOOR_ZAT);
    expect(PREFLIGHT_FLOOR_ZAT).toBe(125_000n);
  });

  it("says how much is missing when the wallet holds less, so that no deposit waits through its retries", async () => {
    const error = await preflight({ spendableBalance: async () => 99_999n }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PreflightError);
    expect((error as Error).message).toBe(
      "the wallet has 99999 zat spendable, a run needs at least 125000 zat (one deposit of 100000 zat plus up to 25000 zat of fee)",
    );
  });

  it("names the wallet when it cannot be read", async () => {
    const error = await preflight({
      spendableBalance: async () => {
        throw new Error("Zallet z_listaccounts: fetch failed (ECONNREFUSED)");
      },
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PreflightError);
    expect((error as Error).message).toBe(
      "cannot read the spendable balance of the wallet: Zallet z_listaccounts: fetch failed (ECONNREFUSED)",
    );
  });
});

const FLAGS: Flags = { ...DEFAULTS, services: { markdown: "http://unused" } };

interface Rig {
  payer: Payer;
  wallet: MockWallet;
  warnings: string[];
  chainClosed: () => number;
}

async function payerOn(stack: TestStack, o: { balance?: bigint; flags?: Flags } = {}): Promise<Rig> {
  const warnings: string[] = [];
  let closed = 0;
  const wallet = new MockWallet(stack.chain);
  const payer = await createPayer(o.flags ?? FLAGS, (line) => warnings.push(line), {
    wallet: Object.assign(wallet, { spendableBalance: async () => o.balance ?? 10_000_000n }),
    chain: { status: stack.chain.statusSource(), close: () => void (closed += 1) },
    scheme: { pollIntervalMs: 20, facilitatorLagMs: 100 },
  });
  payers.push(payer);
  return { payer, wallet, warnings, chainClosed: () => closed };
}

async function markdownStack(): Promise<TestStack> {
  const fake = new FakeServices();
  const stack = await startTestStack({ build: (env) => fake.build(env) });
  stacks.push(stack);
  return stack;
}

const PAGE = "/v1/markdown?url=https%3A%2F%2Fexample.com";

describe("createPayer", () => {
  it("pays a 402 through the prepaid-voucher client, and tells how much was vouchered to whom", async () => {
    const stack = await markdownStack();
    const { payer, warnings } = await payerOn(stack);

    expect(payer.spent()).toBe(0n);
    expect(payer.sessions()).toEqual([]);

    for (let i = 1; i <= 2; i++) {
      const res = await payer.paidFetch(`${stack.url}${PAGE}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("payment-response")).toBeTruthy();
      await res.arrayBuffer();
      expect(payer.spent()).toBe(BigInt(500 * i));
    }
    expect(payer.sessions()).toEqual([{ payTo: TEST_PAY_TO, cumulativeZat: 1000n }]);

    expect(warnings[0]).toBe("wallet: 10000000 zat spendable");
    // The deposit of the first call is reported while it happens
    expect(warnings.filter((l) => l.startsWith("  * "))).toEqual(
      expect.arrayContaining([expect.stringMatching(/^ {2}\* session [0-9a-f]{4}…[0-9a-f]{2} on zcash:regtest$/), "  * deposit D1 started, paid inline"]),
    );
  });

  it("counts a voucher that was sent and never answered, which the client's own total does not yet", async () => {
    const reached: string[] = [];
    const fake = new FakeServices({ handlers: { markdown: (req) => void reached.push(String(req.query["url"])) } });
    const stack = await startTestStack({ build: (env) => fake.build(env) });
    stacks.push(stack);
    const { payer } = await payerOn(stack);

    const controller = new AbortController();
    // The paid retry is a clone that stops following the signal once the garbage collector runs, as in flow.ts
    const call = abortable(payer.paidFetch(`${stack.url}${PAGE}`, { signal: controller.signal }), controller.signal);
    const outcome = call.then(() => "answered", (e: unknown) => (e as Error).name);
    await vi.waitFor(() => expect(reached).toHaveLength(1));
    controller.abort();
    expect(await outcome).toBe("AbortError");

    // The voucher is out and the service may have settled it, so it is not free
    expect(payer.spent()).toBe(500n);
    expect(payer.sessions()).toEqual([{ payTo: TEST_PAY_TO, cumulativeZat: 500n }]);
  });

  it("only pays on the network it was given, so an offer on another network is not paid", async () => {
    const stack = await markdownStack();
    const { payer, wallet } = await payerOn(stack, { flags: { ...FLAGS, network: "zcash:testnet" } });
    await expect(payer.paidFetch(`${stack.url}${PAGE}`)).rejects.toThrow(/payment payload/);
    expect(wallet.sent).toEqual([]);
    expect(payer.spent()).toBe(0n);
  });

  it("closes the chain client once, however often it is closed", async () => {
    const stack = await markdownStack();
    const { payer, chainClosed } = await payerOn(stack);
    await (await payer.paidFetch(`${stack.url}${PAGE}`)).arrayBuffer();
    await Promise.all([payer.close(), payer.close()]);
    await payer.close();
    expect(chainClosed()).toBe(1);
  });

  it("closes the chain client and the wallet, and throws, when the wallet cannot fund a run", async () => {
    const stack = await markdownStack();
    let chainClosed = 0;
    let walletClosed = 0;
    await expect(
      createPayer(FLAGS, () => undefined, {
        wallet: Object.assign(new MockWallet(stack.chain), {
          spendableBalance: async () => 1000n,
          close: async () => void (walletClosed += 1),
        }),
        chain: { status: stack.chain.statusSource(), close: () => void (chainClosed += 1) },
      }),
    ).rejects.toBeInstanceOf(PreflightError);
    expect(chainClosed).toBe(1);
    expect(walletClosed).toBe(1);
  });

  it("closes the wallet when the payer is closed", async () => {
    const stack = await markdownStack();
    let walletClosed = 0;
    const payer = await createPayer(FLAGS, () => undefined, {
      wallet: Object.assign(new MockWallet(stack.chain), {
        spendableBalance: async () => 10_000_000n,
        close: async () => void (walletClosed += 1),
      }),
      chain: { status: stack.chain.statusSource(), close: () => undefined },
    });
    await payer.close();
    await payer.close();
    expect(walletClosed).toBe(1);
  });
});
