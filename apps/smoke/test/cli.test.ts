import { startTestStack, TEST_PAY_TO, type TestStack } from "@z402/service-kit/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { smokeMain, summaryLines, type CliIo } from "../src/cli.js";
import { USAGE } from "../src/flags.js";
import type { StepResult } from "../src/flow.js";
import { PreflightError, type Payer } from "../src/payer.js";
import { FakeServices, refuse, type FakeOptions } from "./fakes.js";

vi.setConfig({ testTimeout: 30_000 });

const stacks: TestStack[] = [];
afterEach(async () => {
  for (const stack of stacks.splice(0)) await stack.close();
});

interface Rig {
  stack: TestStack;
  fake: FakeServices;
  out: string[];
  err: string[];
  closes: number;
  created: number;
  argv: string[];
  run: (more?: Partial<CliIo>) => Promise<number>;
}

async function rig(o: { fake?: FakeOptions; services?: string[]; payer?: (stack: TestStack, base: Payer) => Payer } = {}): Promise<Rig> {
  const fake = new FakeServices(o.fake);
  const stack = await startTestStack({ build: (env) => fake.build(env) });
  stacks.push(stack);
  const r: Rig = {
    stack,
    fake,
    out: [],
    err: [],
    closes: 0,
    created: 0,
    argv: (o.services ?? ["llm", "markdown", "embeddings", "dropbox"]).flatMap((name) => [`--${name}`, stack.url]),
    run: async (more = {}) => {
      const base: Payer = {
        paidFetch: stack.paidFetch,
        spent: () => stack.scheme.session(TEST_PAY_TO)?.cumulativeZat ?? 0n,
        sessions: () => {
          const session = stack.scheme.session(TEST_PAY_TO);
          return session === undefined ? [] : [{ payTo: TEST_PAY_TO, cumulativeZat: session.cumulativeZat }];
        },
        close: async () => {
          r.closes += 1;
        },
      };
      return smokeMain(r.argv, {
        print: (line) => r.out.push(line),
        warn: (line) => r.err.push(line),
        createPayer: async () => {
          r.created += 1;
          return o.payer === undefined ? base : o.payer(stack, base);
        },
        ...more,
      });
    },
  };
  return r;
}

const never: CliIo["createPayer"] = async () => {
  throw new Error("no payer should be made");
};

describe("smokeMain", () => {
  it("prints the usage and exits 0 for --help, before anything else", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await smokeMain(["--llm", "not a url", "--help"], { print: (l) => out.push(l), warn: (l) => err.push(l), createPayer: never });
    expect(code).toBe(0);
    expect(out).toEqual([USAGE]);
    expect(err).toEqual([]);
  });

  it.each([
    [[], /at least one service/],
    [["--llm", "http://l", "--nope"], /--nope/],
    [["--llm", "ftp://l"], /--llm.*http/],
    [["--llm", "http://l", "--network", "bitcoin"], /--network/],
  ])("exits 2 for the flags %j, with the reason and the usage on stderr and nothing on stdout", async (argv, message) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await smokeMain(argv, { print: (l) => out.push(l), warn: (l) => err.push(l), createPayer: never });
    expect(code).toBe(2);
    expect(out).toEqual([]);
    expect(err).toHaveLength(1);
    expect(err[0]).toMatch(message);
    expect(err[0]).toContain(USAGE);
  });

  it("exits 0 when every step passed, and prints the steps, what the session paid and the verdict", async () => {
    const r = await rig();
    expect(await r.run()).toBe(0);

    expect(r.out).toHaveLength(11);
    expect(r.out.slice(0, 9).every((l) => /^\w+ \w+ \d{3} \d+ ms /.test(l))).toBe(true);
    expect(r.out[9]).toBe("session uregtest1qqq…qqqqqq cumulative 3500 zat after 7 paid calls");
    expect(r.out[10]).toBe("smoke ok: 9 steps passed on llm, markdown, embeddings, dropbox");
    expect(r.err).toEqual([]);
    expect(r.created).toBe(1);
    expect(r.closes).toBe(1);
  });

  it("exits 1 when a step failed, and says which", async () => {
    const r = await rig({ fake: { prepare: { embeddings: [(_req, res) => refuse(res, 413, "too_many_tokens")] } } });
    expect(await r.run()).toBe(1);
    expect(r.out.at(-1)).toBe("smoke FAILED: 1 of 9 steps failed (embeddings embed)");
    expect(r.out.at(-2)).toBe("session uregtest1qqq…qqqqqq cumulative 3000 zat after 6 paid calls");
    expect(r.closes).toBe(1);
  });

  it("lists every step that failed", async () => {
    const r = await rig({
      fake: {
        prepare: { embeddings: [(_req, res) => refuse(res, 413, "too_many_tokens")] },
        handlers: { markdown: (_req, res) => refuse(res, 502, "convert_failed") },
      },
    });
    expect(await r.run()).toBe(1);
    expect(r.out.at(-1)).toBe("smoke FAILED: 2 of 9 steps failed (markdown get, embeddings embed)");
  });

  it("names the services it skipped", async () => {
    const r = await rig({ services: ["markdown"] });
    expect(await r.run()).toBe(0);
    expect(r.out.at(-1)).toBe("smoke ok: 1 step passed on markdown; skipped: llm, embeddings, dropbox");
  });

  it("says so when no voucher was signed", async () => {
    const r = await rig({
      services: ["embeddings"],
      fake: { prepare: { embeddings: [(_req, res) => refuse(res, 503, "not_ready")] } },
    });
    expect(await r.run()).toBe(1);
    expect(r.out.at(-2)).toBe("session none, no voucher was signed");
    expect(r.out.at(-1)).toBe("smoke FAILED: 1 of 1 step failed (embeddings embed); skipped: llm, markdown, dropbox");
  });

  it("exits 1 with the reason when the wallet cannot be used, and runs no step", async () => {
    const r = await rig();
    const code = await r.run({
      createPayer: async () => {
        throw new PreflightError("the wallet has 5 zat spendable, a run needs at least 125000 zat");
      },
    });
    expect(code).toBe(1);
    expect(r.out).toEqual([]);
    expect(r.err).toEqual(["the wallet has 5 zat spendable, a run needs at least 125000 zat"]);
    expect(r.fake.requests).toEqual([]);
  });

  it("closes the payer even when the run blows up, and exits 1", async () => {
    const r = await rig({
      payer: (_stack, base) => ({
        ...base,
        spent: () => {
          throw new Error("the ledger broke");
        },
      }),
    });
    expect(await r.run()).toBe(1);
    expect(r.err).toEqual(["the smoke test could not finish: the ledger broke"]);
    expect(r.closes).toBe(1);
  });

  it("does not let a failure to close change the verdict", async () => {
    const r = await rig({
      services: ["markdown"],
      payer: (_stack, base) => ({
        ...base,
        close: async () => {
          throw new Error("grpc went away");
        },
      }),
    });
    expect(await r.run()).toBe(0);
    expect(r.err).toEqual(["closing the wallet failed: grpc went away"]);
    expect(r.out.at(-1)).toMatch(/^smoke ok/);
  });

  it("stops at an interrupt, says so, closes the payer and exits 1", async () => {
    const controller = new AbortController();
    const r = await rig();
    const code = await r.run({
      signal: controller.signal,
      print: (line) => {
        r.out.push(line);
        controller.abort();
      },
    });
    expect(code).toBe(1);
    expect(r.out.filter((l) => /^\w+ \w+ \d{3} /.test(l))).toHaveLength(1);
    expect(r.out.at(-1)).toBe("smoke interrupted after 1 step");
    expect(r.closes).toBe(1);
  });
});

describe("summaryLines", () => {
  const step = (over: Partial<StepResult> = {}): StepResult => ({
    service: "llm",
    step: "start",
    status: 200,
    ms: 1,
    ok: true,
    paid: true,
    detail: "",
    ...over,
  });

  it("prints a line for each merchant paid", () => {
    const lines = summaryLines(
      { ok: true, aborted: false, steps: [step(), step({ service: "markdown", step: "get" })] },
      [
        { payTo: "uregtest1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa11", cumulativeZat: 1000n },
        { payTo: "uregtest1bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb22", cumulativeZat: 500n },
      ],
      { llm: "http://l", markdown: "http://m" },
    );
    expect(lines).toEqual([
      "session uregtest1aaa…aaaa11 cumulative 1000 zat after 2 paid calls",
      "session uregtest1bbb…bbbb22 cumulative 500 zat after 2 paid calls",
      "smoke ok: 2 steps passed on llm, markdown; skipped: embeddings, dropbox",
    ]);
  });

  it("does not count a free step or a failed one as a paid call", () => {
    const lines = summaryLines(
      { ok: false, aborted: false, steps: [step(), step({ paid: false, step: "fetch" }), step({ ok: false, step: "continue" })] },
      [{ payTo: "u1", cumulativeZat: 1000n }],
      { llm: "http://l" },
    );
    expect(lines[0]).toBe("session u1 cumulative 1000 zat after 1 paid call");
    expect(lines[1]).toBe("smoke FAILED: 1 of 3 steps failed (llm continue); skipped: markdown, embeddings, dropbox");
  });
});
