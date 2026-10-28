import { readFileSync } from "node:fs";
import { encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";
import type { PaymentRequired, PaymentRequirements, SchemeNetworkClient } from "@x402/core/types";
import { ASSET, NETWORK_REGTEST, REASON, SCHEME, ZEC_DECIMALS, type SessionSnapshot } from "@z402/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runAgent } from "../src/agent.js";
import { FLAG_DEFAULTS, type Flags } from "../src/flags.js";
import { stopAtDepositRefusal } from "../src/log.js";

const SESSION_KEY = `a1b2${"4".repeat(58)}ff`;
const TXID = `3f2a${"0".repeat(58)}c1`;
const PAY_TO = "uregtest1etwrjmjldyyet5pge876dfxerpgmsmarxg920s50y3dgc3wa36xmemqexfyw87jm3h0cttupk92qkrv8uafvjrl2j73d8nck7g35axkz";
const URL_ = "http://127.0.0.1:4021/chunk";

function snapshot(cumulative: number, limit = 100_000): SessionSnapshot {
  return {
    sessionKey: SESSION_KEY,
    cumulativeZat: String(cumulative),
    limitZat: String(limit),
    headroomZat: String(limit - cumulative),
    confirmedZat: "0",
    pendingZat: "100000",
    creditZat: "0",
    tip: 1200,
    deposits: [{ txid: TXID, valueZat: "100000", status: "pending", confirmations: 0, expiryHeight: 1241, zeroConf: true }],
  };
}

const requirements: PaymentRequirements = {
  scheme: SCHEME,
  network: NETWORK_REGTEST,
  amount: "500",
  asset: ASSET,
  payTo: PAY_TO,
  maxTimeoutSeconds: 60,
  extra: {},
};

function paymentRequired(error: string, session?: SessionSnapshot): PaymentRequired {
  return {
    x402Version: 2,
    error,
    resource: { url: URL_ },
    accepts: [{ ...requirements, extra: session === undefined ? {} : { session } }],
  };
}

function paid(cumulative: number): Response {
  const header = encodePaymentResponseHeader({
    success: true,
    transaction: "",
    network: NETWORK_REGTEST,
    payer: SESSION_KEY,
    extra: { session: snapshot(cumulative) },
  });
  return new Response("{}", { status: 200, headers: { "PAYMENT-RESPONSE": header } });
}

function refused(error: string, session: SessionSnapshot): Response {
  const header = encodePaymentRequiredHeader(paymentRequired(error, session));
  return new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": header } });
}

/** The scheme only prices ZEC for the spend controls and hands the wrapper a payload */
const scheme: SchemeNetworkClient = {
  scheme: SCHEME,
  findDefaultAsset: () => ({ asset: ASSET, decimals: ZEC_DECIMALS, symbol: ASSET }),
  createPaymentPayload: async (x402Version) => ({ x402Version, payload: { sig: "x" } }),
};

function flags(over: Partial<Flags> = {}): Flags {
  return { ...FLAG_DEFAULTS, intervalMs: 0, ...over };
}

function lines(): { print: (line: string) => void; out: string[] } {
  const out: string[] = [];
  return { out, print: (line) => out.push(line) };
}

describe("agent.ts, the file shown on camera", () => {
  const source = readFileSync(new URL("../src/agent.ts", import.meta.url), "utf8");

  it("imports nothing from z402, only the stock x402 fetch wrapper and the local loop helpers", () => {
    const from = [...source.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]);
    expect(from).toEqual(["node:timers/promises", "@x402/fetch", "./flags.js", "./log.js"]);
  });

  it("registers the Zcash scheme on a stock client with one line", () => {
    expect(source.match(/new x402Client\(\)/g)).toHaveLength(1);
    expect(source.match(/\.register\(/g)).toHaveLength(1);
    expect(source).toContain("client.register(flags.network, zcashClientScheme);");
    expect(source).toContain("wrapFetchWithPayment(fetch, client)");
  });
});

describe("runAgent", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("makes the calls, prints one line each from the PAYMENT-RESPONSE and finishes", async () => {
    const calls: string[] = [];
    let n = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      calls.push(new Request(input).url);
      n += 1;
      return paid(n * 500);
    });
    const { print, out } = lines();

    const end = await runAgent({ flags: flags({ calls: 3 }), zcashClientScheme: scheme, print });

    expect(end).toBe("finished");
    expect(calls).toEqual([URL_, URL_, URL_]);
    expect(out).toEqual([
      "#001 200  c=500  limit=100,000  conf=0  pend=100,000  credit=0  D1 3f2a…c1 pending",
      "#002 200  c=1,000  limit=100,000  conf=0  pend=100,000  credit=0  D1 3f2a…c1 pending",
      "#003 200  c=1,500  limit=100,000  conf=0  pend=100,000  credit=0  D1 3f2a…c1 pending",
    ]);
  });

  it("calls the target it is given", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      seen.push(new Request(input).url);
      return paid(500);
    });

    await runAgent({ flags: flags({ calls: 1, targets: ["http://merchant.test:9000/chunk"] }), zcashClientScheme: scheme, print: () => {} });

    expect(seen).toEqual(["http://merchant.test:9000/chunk"]);
  });

  describe("several targets", () => {
    const A = "http://a.test:4021/chunk";
    const B = "http://b.test:4023/chunk";

    it("calls them in turn, --calls times each, and tags each line with its target", async () => {
      const seen: string[] = [];
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        const url = new Request(input).url;
        seen.push(url);
        return paid(seen.filter((u) => u === url).length * (url === A ? 500 : 800));
      });
      const { print, out } = lines();

      const end = await runAgent({ flags: flags({ calls: 2, targets: [A, B] }), zcashClientScheme: scheme, print });

      expect(end).toBe("finished");
      expect(seen).toEqual([A, B, A, B]);
      expect(out.map((l) => l.slice(0, l.indexOf("  limit")))).toEqual([
        "#001 [1] 200  c=500",
        "#002 [2] 200  c=800",
        "#003 [1] 200  c=1,000",
        "#004 [2] 200  c=1,600",
      ]);
    });

    it("hands each outcome to onCall with its 0-based target", async () => {
      let n = 0;
      vi.stubGlobal("fetch", async () => paid(++n * 500));
      const calls: Array<[number, string | undefined]> = [];

      await runAgent({
        flags: flags({ calls: 2, targets: [A, B] }),
        zcashClientScheme: scheme,
        print: () => {},
        onCall: (target, outcome) => calls.push([target, outcome.snapshot?.cumulativeZat]),
      });

      expect(calls).toEqual([
        [0, "500"],
        [1, "1000"],
        [0, "1500"],
        [1, "2000"],
      ]);
    });

    it("tags the line of a call that throws", async () => {
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        if (new Request(input).url === B) throw new TypeError("fetch failed");
        return paid(500);
      });
      const { print, out } = lines();

      const end = await runAgent({ flags: flags({ calls: 3, targets: [A, B] }), zcashClientScheme: scheme, print });

      expect(end).toBe("failed");
      expect(out[1]).toBe("#002 [2] ERROR  fetch failed");
    });

    it("waits no interval after the very last call", async () => {
      const starts: number[] = [];
      vi.stubGlobal("fetch", async () => {
        starts.push(Date.now());
        return paid(500);
      });

      await runAgent({ flags: flags({ calls: 1, intervalMs: 150, targets: [A, B] }), zcashClientScheme: scheme, print: () => {} });
      const finished = Date.now();

      expect(starts).toHaveLength(2);
      expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(140);
      expect(finished - starts[1]!).toBeLessThan(100);
    });
  });

  it("paces the calls by --interval-ms, counted from the start of each call", async () => {
    const starts: number[] = [];
    vi.stubGlobal("fetch", async () => {
      starts.push(Date.now());
      return paid(500);
    });

    await runAgent({ flags: flags({ calls: 3, intervalMs: 150 }), zcashClientScheme: scheme, print: () => {} });
    const finished = Date.now();

    expect(starts).toHaveLength(3);
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(140);
    expect(starts[2]! - starts[1]!).toBeGreaterThanOrEqual(140);
    // No gap after the last call
    expect(finished - starts[2]!).toBeLessThan(100);
  });

  it("does not wait on top of a call that already took longer than the interval", async () => {
    vi.stubGlobal("fetch", async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
      return paid(500);
    });
    const started = Date.now();

    await runAgent({ flags: flags({ calls: 2, intervalMs: 30 }), zcashClientScheme: scheme, print: () => {} });

    expect(Date.now() - started).toBeLessThan(250);
  });

  it("logs a refusal the way the cheat demo needs it and carries on when nothing stops it", async () => {
    const fetches: Array<Request> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      fetches.push(req);
      if (!req.headers.has("PAYMENT-SIGNATURE")) {
        return new Response("{}", {
          status: 402,
          headers: { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(paymentRequired("Payment required")) },
        });
      }
      return refused(REASON.depositRequired, snapshot(125_000, 125_000));
    });
    const { print, out } = lines();

    const end = await runAgent({ flags: flags({ calls: 2 }), zcashClientScheme: scheme, print });

    expect(end).toBe("finished");
    expect(out).toHaveLength(2);
    for (const [i, line] of out.entries()) {
      expect(line).toMatch(new RegExp(`^#00${i + 1} 402  REFUSED z402_deposit_required at limit 125,000  c=125,000 `));
    }
  });

  it("stops at the first deposit-required refusal when told to, and prints it first", async () => {
    let n = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      if (!req.headers.has("PAYMENT-SIGNATURE")) {
        return new Response("{}", {
          status: 402,
          headers: { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(paymentRequired("Payment required")) },
        });
      }
      n += 1;
      return n < 3 ? paid(n * 500) : refused(REASON.depositRequired, snapshot(125_000, 125_000));
    });
    const { print, out } = lines();

    const end = await runAgent({
      flags: flags({ calls: 10, cheat: true }),
      zcashClientScheme: scheme,
      print,
      shouldStop: stopAtDepositRefusal,
    });

    expect(end).toBe("stopped");
    expect(out).toHaveLength(3);
    expect(out[2]).toContain("#003 402  REFUSED z402_deposit_required at limit 125,000");
  });

  it("stops the cheat run on a deposit-required refusal that arrives as a failed PAYMENT-RESPONSE", async () => {
    let n = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      if (!req.headers.has("PAYMENT-SIGNATURE")) {
        return new Response("{}", {
          status: 402,
          headers: { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(paymentRequired("Payment required")) },
        });
      }
      n += 1;
      if (n < 3) return paid(n * 500);
      const header = encodePaymentResponseHeader({
        success: false,
        errorReason: REASON.depositRequired,
        transaction: "",
        network: NETWORK_REGTEST,
        payer: SESSION_KEY,
        extra: { session: snapshot(125_000, 125_000) },
      });
      return new Response("{}", { status: 402, headers: { "PAYMENT-RESPONSE": header } });
    });
    const { print, out } = lines();

    const end = await runAgent({
      flags: flags({ calls: 10, cheat: true }),
      zcashClientScheme: scheme,
      print,
      shouldStop: stopAtDepositRefusal,
    });

    expect(end).toBe("stopped");
    expect(out).toHaveLength(3);
    expect(out[2]).toContain("#003 402  REFUSED z402_deposit_required at limit 125,000  c=125,000");
  });

  it("ends 'aborted' without another call once the signal fires", async () => {
    const controller = new AbortController();
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls += 1;
      controller.abort();
      return paid(500);
    });
    const { print, out } = lines();

    const end = await runAgent({ flags: flags({ calls: 5, intervalMs: 10_000 }), zcashClientScheme: scheme, print, signal: controller.signal });

    expect(end).toBe("aborted");
    expect(calls).toBe(1);
    expect(out).toHaveLength(1);
  });

  it("does not report an abort that cut a call short as a failure", async () => {
    const controller = new AbortController();
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      // The stock wrapper hands fetch a Request, so the signal travels inside it
      const requestSignal = new Request(input, init).signal;
      return new Promise<Response>((_resolve, reject) => {
        requestSignal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        setTimeout(() => controller.abort(), 10);
      });
    });
    const { print, out } = lines();

    const end = await runAgent({ flags: flags({ calls: 5 }), zcashClientScheme: scheme, print, signal: controller.signal });

    expect(end).toBe("aborted");
    expect(out).toEqual([]);
  });

  it("logs a thrown error on its own call line and ends 'failed'", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed");
    });
    const { print, out } = lines();

    const end = await runAgent({ flags: flags({ calls: 5 }), zcashClientScheme: scheme, print });

    expect(end).toBe("failed");
    expect(out).toEqual(["#001 ERROR  fetch failed"]);
  });
});
