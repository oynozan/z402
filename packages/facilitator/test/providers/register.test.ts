import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { format, inspect } from "node:util";
import { x402Facilitator } from "@x402/core/facilitator";
import { NETWORK_REGTEST } from "@z402/protocol";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { API_KEY_RE, keyDigest } from "../../src/providers/apiKey.js";
import { providerId } from "../../src/providers/id.js";
import { createRegistrar, RegistrationRefused, type RegistrarDeps } from "../../src/providers/register.js";
import { openRegistry, type ProviderEntry, type ProviderRegistry } from "../../src/providers/registry.js";
import type { ProviderRuntime } from "../../src/runtime.js";

const NETWORK = NETWORK_REGTEST;
const OPERATOR = `uregtest1${"q".repeat(60)}`;
const A = { payTo: `uregtest1${"p".repeat(60)}`, uivk: `uivkregtest1${"sec3ret".repeat(10)}` };
const B = { payTo: `uregtest1${"z".repeat(60)}`, uivk: `uivkregtest1${"w3ak".repeat(10)}` };
const C = { payTo: `uregtest1${"r".repeat(60)}`, uivk: `uivkregtest1${"c0de".repeat(10)}` };
const ID_A = providerId(NETWORK, A.payTo);
const ID_B = providerId(NETWORK, B.payTo);
const T0 = "2026-10-28T12:00:00.000Z";

let root: string;
const registries: ProviderRegistry[] = [];

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "z402-register-")));
});
afterEach(() => {
  for (const registry of registries.splice(0)) registry.close();
  rmSync(root, { recursive: true, force: true });
});

function fakeRuntime(payTo: string, events: string[]): ProviderRuntime {
  return {
    id: providerId(NETWORK, payTo),
    network: NETWORK,
    payTo,
    facilitator: new x402Facilitator(),
    pollNow: vi.fn(async () => {
      events.push("poll");
    }),
    start: vi.fn(() => {
      events.push("start");
    }),
    stop: vi.fn(() => {
      events.push("stop");
    }),
    release: vi.fn(() => {
      events.push("release");
    }),
    extra: () => ({}),
  };
}

type Proof = { payTo: string; uivk: string };

/** A registrar over a real registry, with each step it takes put in `events` in the order it took it */
async function rig(over: Partial<Pick<RegistrarDeps, "max" | "runtimeOf">> = {}) {
  const events: string[] = [];
  const logs: Array<{ msg: string; err?: unknown }> = [];
  const runtimes = new Map<string, ProviderRuntime>();
  let clock = T0;

  const registry = await openRegistry({ dir: join(root, "providers"), network: NETWORK });
  registries.push(registry);
  const put = registry.put.bind(registry);
  vi.spyOn(registry, "put").mockImplementation((entry: ProviderEntry) => {
    events.push("put");
    put(entry);
  });

  const deps = {
    owns: vi.fn(async (_p: Proof): Promise<boolean> => {
      events.push("owns");
      return true;
    }),
    open: vi.fn(async (p: Proof & { ledgerPath: string }): Promise<ProviderRuntime> => {
      events.push("open");
      const runtime = fakeRuntime(p.payTo, events);
      runtimes.set(p.payTo, runtime);
      return runtime;
    }),
    admit: vi.fn((_runtime: ProviderRuntime, _keyHash: string): void => {
      events.push("admit");
    }),
    rekey: vi.fn((_runtime: ProviderRuntime, _keyHash: string, _replacing: string): void => {
      events.push("rekey");
    }),
  };

  const register = createRegistrar({
    network: NETWORK,
    operatorPayTo: OPERATOR,
    registry,
    max: 32,
    runtimeOf: (payTo) => runtimes.get(payTo),
    log: (msg, err) => logs.push(err === undefined ? { msg } : { msg, err }),
    now: () => new Date(clock),
    ...deps,
    ...over,
  });

  return {
    register,
    deps,
    registry,
    events,
    logs,
    runtimes,
    at: (iso: string) => {
      clock = iso;
    },
  };
}

type Rig = Awaited<ReturnType<typeof rig>>;

/** The refusal a registration ends with, failing the test if it succeeds */
async function refused(call: Promise<unknown>): Promise<RegistrationRefused> {
  try {
    await call;
  } catch (e) {
    expect(e).toBeInstanceOf(RegistrationRefused);
    return e as RegistrationRefused;
  }
  throw new Error("expected the registration to be refused");
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const stored = (r: Rig, payTo: string) => r.registry.get(payTo);
const failing = (message: string) => () => {
  throw new Error(message);
};

describe("a new provider", () => {
  test("is proven the owner, opened, polled, started and stored, and only then admitted", async () => {
    const r = await rig();
    await r.register(A);
    expect(r.events).toEqual(["owns", "open", "poll", "start", "put", "admit"]);
  });

  test("is answered 201 with its id, the network, its payTo and a key of the right shape", async () => {
    const r = await rig();
    expect(await r.register(A)).toEqual({
      status: 201,
      body: { providerId: ID_A, network: NETWORK, payTo: A.payTo, apiKey: expect.stringMatching(API_KEY_RE) },
    });
  });

  test("is stored with the digest of its key and never the key, under the time of the registration", async () => {
    const r = await rig();
    const { body } = await r.register(A);
    expect(stored(r, A.payTo)).toEqual({
      id: ID_A,
      payTo: A.payTo,
      uivk: A.uivk,
      keyHash: keyDigest(body.apiKey),
      createdAt: T0,
      keyIssuedAt: T0,
    });
    expect(readFileSync(join(root, "providers", "registry.json"), "utf8")).not.toContain(body.apiKey);
  });

  test("is opened with its own viewing key at the ledger of its id in the providers directory", async () => {
    const r = await rig();
    await r.register(A);
    expect(r.deps.open).toHaveBeenCalledTimes(1);
    expect(r.deps.open).toHaveBeenCalledWith({
      payTo: A.payTo,
      uivk: A.uivk,
      ledgerPath: join(root, "providers", "ledgers", `${ID_A}.jsonl`),
    });
  });

  test("is admitted with its runtime and the digest of the key it was given", async () => {
    const r = await rig();
    const { body } = await r.register(A);
    expect(r.deps.admit).toHaveBeenCalledTimes(1);
    expect(r.deps.admit).toHaveBeenCalledWith(r.runtimes.get(A.payTo), keyDigest(body.apiKey));
    expect(r.deps.rekey).not.toHaveBeenCalled();
  });

  test("is given a key that no other registration got", async () => {
    const r = await rig();
    const keys = [(await r.register(A)).body.apiKey, (await r.register(B)).body.apiKey];
    expect(new Set(keys).size).toBe(2);
  });

  test("is logged with its id and payTo and no key", async () => {
    const r = await rig();
    await r.register(A);
    expect(r.logs).toEqual([{ msg: `facilitator: registered provider ${ID_A} payTo=${A.payTo}` }]);
  });

  test("may name the network of the facilitator", async () => {
    const r = await rig();
    await expect(r.register({ ...A, network: NETWORK })).resolves.toMatchObject({ status: 201 });
  });

  test("whose runtime cannot be opened leaves nothing stored and nothing admitted", async () => {
    const r = await rig();
    r.deps.open.mockRejectedValueOnce(new Error("ledgerPath: the ledger is not writable (EACCES)"));
    const refusal = await refused(r.register(A));

    expect(refusal).toMatchObject({ status: 500, code: "internal_error" });
    expect(r.events).toEqual(["owns"]);
    expect(r.registry.entries()).toEqual([]);
    expect(r.deps.admit).not.toHaveBeenCalled();
    expect(r.logs.map((l) => l.msg)).toEqual(["facilitator: provider registration failed"]);
  });

  test("whose entry cannot be stored has its runtime stopped and released, and is answered 500", async () => {
    const r = await rig();
    vi.mocked(r.registry.put).mockImplementationOnce(() => {
      r.events.push("put");
      throw new Error("EIO: the disk is gone");
    });
    const refusal = await refused(r.register(A));

    expect(refusal).toMatchObject({ status: 500, code: "internal_error" });
    expect(r.events).toEqual(["owns", "open", "poll", "start", "put", "stop", "release"]);
    expect(r.deps.admit).not.toHaveBeenCalled();
    expect(r.registry.entries()).toEqual([]);
    expect(r.logs.map((l) => l.msg)).toEqual(["facilitator: provider registration failed"]);
  });

  test("whose registration failed can be tried again", async () => {
    const r = await rig();
    vi.mocked(r.registry.put).mockImplementationOnce(failing("EIO: the disk is gone"));
    await refused(r.register(A));
    await expect(r.register(A)).resolves.toMatchObject({ status: 201 });
    expect(r.registry.entries().map((e) => e.id)).toEqual([ID_A]);
  });
});

describe("a provider that is registered", () => {
  test("is answered 200 with a new key, and the new hash is stored before the swap", async () => {
    const r = await rig();
    const first = await r.register(A);
    r.events.length = 0;
    r.at("2026-10-28T13:30:00.000Z");
    const second = await r.register(A);

    expect(second).toEqual({
      status: 200,
      body: { providerId: ID_A, network: NETWORK, payTo: A.payTo, apiKey: expect.stringMatching(API_KEY_RE) },
    });
    expect(second.body.apiKey).not.toBe(first.body.apiKey);
    expect(r.events).toEqual(["owns", "put", "rekey"]);
    expect(r.deps.rekey).toHaveBeenCalledWith(
      r.runtimes.get(A.payTo),
      keyDigest(second.body.apiKey),
      keyDigest(first.body.apiKey),
    );
  });

  test("keeps its creation time, id and viewing key and moves only the key and when it was issued", async () => {
    const r = await rig();
    await r.register(A);
    r.at("2026-10-28T13:30:00.000Z");
    const second = await r.register({ ...A, uivk: `uivkregtest1${"0ther".repeat(12)}` });

    expect(stored(r, A.payTo)).toEqual({
      id: ID_A,
      payTo: A.payTo,
      uivk: A.uivk,
      keyHash: keyDigest(second.body.apiKey),
      createdAt: T0,
      keyIssuedAt: "2026-10-28T13:30:00.000Z",
    });
  });

  test("does not open a second runtime", async () => {
    const r = await rig();
    await r.register(A);
    await r.register(A);
    expect(r.deps.open).toHaveBeenCalledTimes(1);
    expect(r.deps.admit).toHaveBeenCalledTimes(1);
  });

  test("keeps its old key when the new hash cannot be stored", async () => {
    const r = await rig();
    const first = await r.register(A);
    vi.mocked(r.registry.put).mockImplementationOnce(failing("EIO: the disk is gone"));

    const refusal = await refused(r.register(A));
    expect(refusal).toMatchObject({ status: 500, code: "internal_error" });
    expect(r.deps.rekey).not.toHaveBeenCalled();
    expect(stored(r, A.payTo)?.keyHash).toBe(keyDigest(first.body.apiKey));
    expect(r.runtimes.get(A.payTo)?.stop).not.toHaveBeenCalled();
    expect(r.runtimes.get(A.payTo)?.release).not.toHaveBeenCalled();
  });

  test("rotates when the registry is full, since it takes no new place", async () => {
    const r = await rig({ max: 1 });
    await r.register(A);
    await expect(r.register(A)).resolves.toMatchObject({ status: 200 });
    await expect(r.register(A)).resolves.toMatchObject({ status: 200 });
  });

  test("rotates in a registry that holds more than the limit, as when the limit was lowered", async () => {
    const r = await rig();
    await r.register(A);
    await r.register(B);
    const lowered = createRegistrar({
      network: NETWORK,
      operatorPayTo: OPERATOR,
      registry: r.registry,
      max: 1,
      runtimeOf: (payTo) => r.runtimes.get(payTo),
      log: () => undefined,
      ...r.deps,
    });

    await expect(lowered(A)).resolves.toMatchObject({ status: 200 });
    expect(await refused(lowered(C))).toMatchObject({ status: 403, code: "provider_limit" });
  });

  test("is logged as a rotation, with its id and no key", async () => {
    const r = await rig();
    await r.register(A);
    r.logs.length = 0;
    await r.register(A);
    expect(r.logs).toEqual([{ msg: `facilitator: rotated the key of provider ${ID_A}` }]);
  });

  test("whose runtime is missing is refused before anything is stored", async () => {
    const r = await rig({ runtimeOf: () => undefined });
    await r.register(A);
    const before = readFileSync(join(root, "providers", "registry.json"), "utf8");
    const refusal = await refused(r.register(A));

    expect(refusal).toMatchObject({ status: 500, code: "internal_error" });
    expect(readFileSync(join(root, "providers", "registry.json"), "utf8")).toBe(before);
    expect(r.deps.rekey).not.toHaveBeenCalled();
  });
});

describe("a request that is refused", () => {
  const bad = (what: string, body: unknown, message: RegExp) => ({ what, body, message });

  test.each([
    bad("a body that is a string", "payTo", /^the request body must be a JSON object$/),
    bad("a body that is null", null, /^the request body must be a JSON object$/),
    bad("a body that is an array", [A], /^the request body must be a JSON object$/),
    bad("no payTo", { uivk: A.uivk }, /^payTo: /),
    bad("a payTo that is a number", { payTo: 7, uivk: A.uivk }, /^payTo: /),
    bad("a payTo of another network", { payTo: `utest1${"q".repeat(60)}`, uivk: A.uivk }, /^payTo: /),
    bad("a payTo with a transparent receiver", { payTo: `turegtest1${"q".repeat(60)}`, uivk: A.uivk }, /^payTo: /),
    bad("a payTo that is not an address", { payTo: "not-an-address", uivk: A.uivk }, /^payTo: /),
    bad("no uivk", { payTo: A.payTo }, /^uivk: /),
    bad("a uivk that is a number", { payTo: A.payTo, uivk: 7 }, /^uivk: /),
    bad("a uivk of another network", { payTo: A.payTo, uivk: `uivktest1${"q".repeat(100)}` }, /^uivk: /),
    bad("a uivk that is an address", { payTo: A.payTo, uivk: B.payTo }, /^uivk: /),
    bad("a uivk with a space in it", { payTo: A.payTo, uivk: `${A.uivk} x` }, /^uivk: /),
    bad("a uivk of 1025 characters", { payTo: A.payTo, uivk: `uivkregtest1${"q".repeat(1013)}` }, /^uivk: /),
    bad("another network", { ...A, network: "zcash:testnet" }, /^network: /),
    bad("a network that is a number", { ...A, network: 5 }, /^network: /),
    bad("a network that is null", { ...A, network: null }, /^network: /),
  ])("$what is invalid_request naming the field, before any proof or any file", async ({ body, message }) => {
    const r = await rig();
    const refusal = await refused(r.register(body));

    expect(refusal).toMatchObject({ status: 400, code: "invalid_request" });
    expect(refusal.message).toMatch(message);
    expect(r.events).toEqual([]);
    expect(r.registry.entries()).toEqual([]);
  });

  test("a message never carries the value it refuses", async () => {
    const r = await rig();
    for (const body of [
      { payTo: "payto-do-not-echo", uivk: A.uivk },
      { payTo: A.payTo, uivk: "uivk-do-not-echo" },
      { ...A, network: "network-do-not-echo" },
    ]) {
      expect((await refused(r.register(body))).message).not.toMatch(/do-not-echo/);
    }
  });

  test("the operator's payTo is a 409 operator, with no proof asked for", async () => {
    const r = await rig();
    const refusal = await refused(r.register({ payTo: OPERATOR, uivk: A.uivk }));
    expect(refusal).toMatchObject({ status: 409, code: "operator" });
    expect(r.events).toEqual([]);
    expect(r.registry.entries()).toEqual([]);
  });

  test("a viewing key that does not own the payTo is a 403 not_owner, and nothing is opened or stored", async () => {
    const r = await rig();
    r.deps.owns.mockResolvedValueOnce(false);
    const refusal = await refused(r.register(A));

    expect(refusal).toMatchObject({ status: 403, code: "not_owner" });
    expect(refusal.message).toMatch(/transparent/);
    expect(r.deps.open).not.toHaveBeenCalled();
    expect(r.registry.entries()).toEqual([]);
  });

  test("the proof is asked of the viewing key and the payTo that were sent", async () => {
    const r = await rig();
    await r.register(A);
    expect(r.deps.owns).toHaveBeenCalledWith({ payTo: A.payTo, uivk: A.uivk });
  });

  test("a proof that cannot be made is a 500 internal_error, logged without the viewing key", async () => {
    const r = await rig();
    r.deps.owns.mockRejectedValueOnce(new Error("zdecrypt could not be started (ENOENT)"));
    const refusal = await refused(r.register(A));

    expect(refusal).toMatchObject({ status: 500, code: "internal_error" });
    expect(r.deps.open).not.toHaveBeenCalled();
    expect(r.registry.entries()).toEqual([]);
    expect(r.logs).toHaveLength(1);
    expect(String(r.logs[0]?.err)).toBe("Error: zdecrypt could not be started (ENOENT)");
  });

  test("a new provider past the limit is a 403 provider_limit before any proof is asked", async () => {
    const r = await rig({ max: 1 });
    await r.register(A);
    r.events.length = 0;
    const refusal = await refused(r.register(B));

    expect(refusal).toMatchObject({ status: 403, code: "provider_limit" });
    expect(r.events).toEqual([]);
    expect(r.registry.get(B.payTo)).toBeUndefined();
  });

  test("a limit of 0 refuses every new provider", async () => {
    const r = await rig({ max: 0 });
    expect(await refused(r.register(A))).toMatchObject({ status: 403, code: "provider_limit" });
  });
});

describe("registrations", () => {
  test("run one at a time, each finished before the next begins", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const r = await rig();
    r.deps.open.mockImplementationOnce(async (p) => {
      r.events.push("open");
      await gate;
      const runtime = fakeRuntime(p.payTo, r.events);
      r.runtimes.set(p.payTo, runtime);
      return runtime;
    });

    const first = r.register(A);
    const second = r.register(B);
    await flush();
    expect(r.events).toEqual(["owns", "open"]);

    release();
    await Promise.all([first, second]);
    expect(r.events).toEqual([
      ...["owns", "open", "poll", "start", "put", "admit"],
      ...["owns", "open", "poll", "start", "put", "admit"],
    ]);
    expect(r.registry.entries().map((e) => e.id)).toEqual([ID_A, ID_B]);
  });

  test("count against the limit one after the other", async () => {
    const r = await rig({ max: 1 });
    const results = await Promise.allSettled([r.register(A), r.register(B)]);
    expect(results[0]).toMatchObject({ status: "fulfilled", value: { status: 201 } });
    expect(results[1]).toMatchObject({ status: "rejected", reason: { status: 403, code: "provider_limit" } });
    expect(r.deps.open).toHaveBeenCalledTimes(1);
  });

  test("of one payTo twice at once are a registration and a rotation, and the second key is in force", async () => {
    const r = await rig();
    const [first, second] = await Promise.all([r.register(A), r.register(A)]);
    expect([first.status, second.status]).toEqual([201, 200]);
    expect(stored(r, A.payTo)?.keyHash).toBe(keyDigest(second.body.apiKey));
    expect(r.deps.open).toHaveBeenCalledTimes(1);
  });

  test("go on after one that failed", async () => {
    const r = await rig();
    r.deps.owns.mockRejectedValueOnce(new Error("zdecrypt could not be started (ENOENT)"));
    const results = await Promise.allSettled([r.register(A), r.register(B)]);
    expect(results[0]).toMatchObject({ status: "rejected", reason: { status: 500 } });
    expect(results[1]).toMatchObject({ status: "fulfilled", value: { status: 201 } });
  });

  test("that are refused for their body do not wait for one that is under way", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const r = await rig();
    r.deps.open.mockImplementationOnce(async (p) => {
      await gate;
      const runtime = fakeRuntime(p.payTo, r.events);
      r.runtimes.set(p.payTo, runtime);
      return runtime;
    });
    const slow = r.register(A);
    await flush();

    expect(await refused(r.register({ uivk: B.uivk }))).toMatchObject({ status: 400 });
    expect(await refused(r.register({ payTo: OPERATOR, uivk: B.uivk }))).toMatchObject({ status: 409 });
    release();
    await slow;
  });
});

describe("what registration lets out", () => {
  test("no log line or error carries a viewing key, an API key or a key hash, and no answer carries one", async () => {
    const r = await rig();
    vi.mocked(r.registry.put).mockImplementationOnce(failing("EIO: the disk is gone"));
    const failed = await refused(r.register(B));
    const created = await r.register(A);
    const rotated = await r.register(A);

    const hashes = [keyDigest(created.body.apiKey), keyDigest(rotated.body.apiKey)];
    const keys = [created.body.apiKey, rotated.body.apiKey];
    const logged = [
      ...r.logs.map((l) => format(l.msg, ...(l.err === undefined ? [] : [l.err])) + inspect(l.err, { depth: 10 })),
      inspect(failed, { depth: 10 }),
    ].join("\n");
    // A prefix is enough to find a value that was quoted whole or in part
    for (const secret of [A.uivk, B.uivk, ...keys, ...hashes]) expect(logged).not.toContain(secret.slice(0, 24));

    const answers = JSON.stringify([created.body, rotated.body]);
    for (const secret of [A.uivk, B.uivk, ...hashes]) expect(answers).not.toContain(secret.slice(0, 24));
  });
});
