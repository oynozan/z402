import {
  chmodSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { inspect } from "node:util";
import { NETWORK_MAINNET, NETWORK_REGTEST, NETWORK_TESTNET, type ZcashNetwork } from "@z402-net/protocol";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { keyDigest } from "../src/providers/apiKey.js";
import { openRegistry, ProviderRegistry, RegistryError, type ProviderEntry } from "../src/providers/registry.js";

// The registry and the lock import fs functions by name, so only a module mock can fail one step of a write
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    openSync: vi.fn(fs.openSync),
    writeFileSync: vi.fn(fs.writeFileSync),
    fsyncSync: vi.fn(fs.fsyncSync),
    renameSync: vi.fn(fs.renameSync),
  };
});
const real = await vi.importActual<typeof import("node:fs")>("node:fs");

// Real testnet addresses from the protocol and zdecrypt fixtures
const REAL_TESTNET_A =
  "utest1q97m3j4x8x3mfw52ye4r8nx9ye7nuyt54ra0qnf79h2j0v76dqvl2arf9955zk620sjhe3954kc6x364r8rgn4xa6l7nwyr9nyqua6f9";
const REAL_TESTNET_B =
  "utest19wj09n80xgs6njmsl0k2junzcm2093upxp6h7qtfqwymxvn35ewl62pccfcnhqxkmk93p8kprkslnrqfc8ygvg0kn298h7hz2urjyus7";

const A: ProviderEntry = {
  id: "3f9a1c07be52d684",
  payTo: `uregtest1${"q".repeat(60)}`,
  uivk: `uivkregtest1SECRETA${"x".repeat(60)}`,
  keyHash: keyDigest(`z402_${"A".repeat(43)}`),
  createdAt: "2026-10-28T10:00:00.000Z",
  keyIssuedAt: "2026-10-28T10:00:00.000Z",
};
const B: ProviderEntry = {
  id: "a07d5e19c4b3826f",
  payTo: `uregtest1${"p".repeat(60)}`,
  uivk: `uivkregtest1SECRETB${"y".repeat(60)}`,
  keyHash: keyDigest(`z402_${"B".repeat(43)}`),
  createdAt: "2026-10-28T11:00:00.000Z",
  keyIssuedAt: "2026-10-28T11:30:00.000Z",
};
const C: ProviderEntry = {
  id: "5c2e8b14f0d97a63",
  payTo: `uregtest1${"z".repeat(60)}`,
  uivk: `uivkregtest1SECRETC${"w".repeat(60)}`,
  keyHash: keyDigest(`z402_${"C".repeat(43)}`),
  createdAt: "2026-10-28T12:00:00.000Z",
  keyIssuedAt: "2026-10-28T12:00:00.000Z",
};
const ROTATED_A: ProviderEntry = {
  ...A,
  keyHash: keyDigest(`z402_${"R".repeat(43)}`),
  keyIssuedAt: "2026-10-28T13:00:00.000Z",
};

const ENTRY_FIELDS = ["id", "payTo", "uivk", "keyHash", "createdAt", "keyIssuedAt"] as const;
const TIMESTAMP = "an ISO 8601 timestamp like 2026-10-28T12:00:00.000Z";
const REASON = {
  notObject: "not an object",
  extraFields: "fields other than id, payTo, uivk, keyHash, createdAt and keyIssuedAt",
  id: "id is not 16 lowercase hex",
  payTo: "payTo is not valid for zcash:regtest",
  payToLength: "payTo is over 1024 characters",
  uivk: "uivk is not 1 to 1024 characters without whitespace",
  keyHash: "keyHash is not 64 lowercase hex",
  createdAt: `createdAt is not ${TIMESTAMP}`,
  keyIssuedAt: `keyIssuedAt is not ${TIMESTAMP}`,
} as const;

let root: string;
let dir: string;
const opened: ProviderRegistry[] = [];

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "z402-registry-")));
  dir = join(root, "providers.regtest");
});
afterEach(() => {
  for (const registry of opened.splice(0)) registry.close();
  rmSync(root, { recursive: true, force: true });
  vi.mocked(openSync).mockReset().mockImplementation(real.openSync);
  vi.mocked(writeFileSync).mockReset().mockImplementation(real.writeFileSync);
  vi.mocked(fsyncSync).mockReset().mockImplementation(real.fsyncSync);
  vi.mocked(renameSync).mockReset().mockImplementation(real.renameSync);
});

const file = () => join(dir, "registry.json");
const lockFile = () => `${file()}.lock`;
const onDisk = () => readFileSync(file(), "utf8");
const modeOf = (path: string) => statSync(path).mode & 0o777;
const isTemp = (name: string) => name.endsWith(".tmp");
const doc = (providers: unknown, over: Record<string, unknown> = {}) => ({
  version: 1,
  network: NETWORK_REGTEST,
  providers,
  ...over,
});
const written = (providers: ProviderEntry[], network: ZcashNetwork = NETWORK_REGTEST) =>
  `${JSON.stringify({ version: 1, network, providers })}\n`;
const without = (e: ProviderEntry, field: keyof ProviderEntry) => {
  const { [field]: _left, ...rest } = e;
  return rest;
};

/** Writes a registry file the way an earlier run or a tamperer would have left it */
function seed(text: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(file(), text);
}

async function open(over: Partial<Parameters<typeof openRegistry>[0]> = {}): Promise<ProviderRegistry> {
  const registry = await openRegistry({ dir, network: NETWORK_REGTEST, ...over });
  opened.push(registry);
  return registry;
}

/** The error an open ends with, after checking it is a RegistryError that names the setting */
async function refused(over: Partial<Parameters<typeof openRegistry>[0]> = {}): Promise<RegistryError> {
  let registry: ProviderRegistry | undefined;
  try {
    registry = await openRegistry({ dir, network: NETWORK_REGTEST, ...over });
  } catch (e) {
    expect(e).toBeInstanceOf(RegistryError);
    expect((e as RegistryError).message).toMatch(/^providersDir: /);
    return e as RegistryError;
  }
  registry.close();
  throw new Error("expected the registry to be refused");
}

function thrown(fn: () => unknown): Error {
  try {
    fn();
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected a throw");
}

/** Every uivk and keyHash value the JSON text holds, long enough that no message could hold one by chance */
function secretsIn(text: string): string[] {
  const found: string[] = [];
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (typeof v === "object" && v !== null) {
      for (const [key, x] of Object.entries(v)) {
        if ((key === "uivk" || key === "keyHash") && typeof x === "string" && x.length >= 8) found.push(x);
        else walk(x);
      }
    }
  };
  try {
    walk(JSON.parse(text));
  } catch {}
  return found;
}

function expectNoSecrets(error: Error, secrets: string[]): void {
  const everything = inspect(error, { depth: 10 });
  for (const secret of secrets) {
    expect(error.message).not.toContain(secret);
    expect(everything).not.toContain(secret);
  }
}

describe("openRegistry on a directory with no registry", () => {
  test("is an empty registry, with the directory and ledgers/ made at 0700 and no registry file", async () => {
    const registry = await open();

    expect(registry).toBeInstanceOf(ProviderRegistry);
    expect(registry.entries()).toEqual([]);
    expect(registry.get(A.payTo)).toBeUndefined();
    expect(modeOf(dir)).toBe(0o700);
    expect(modeOf(join(dir, "ledgers"))).toBe(0o700);
    expect(existsSync(file())).toBe(false);
  });

  test("makes every missing parent of the directory", async () => {
    const nested = join(root, "a", "b", "providers.regtest");

    await open({ dir: nested });

    expect(modeOf(nested)).toBe(0o700);
    expect(existsSync(join(nested, "ledgers"))).toBe(true);
  });

  test("makes private files and directories whatever the umask", async (ctx) => {
    let before: number;
    try {
      before = process.umask(0);
    } catch {
      return ctx.skip();
    }
    try {
      const registry = await open();
      registry.put(A);
    } finally {
      process.umask(before);
    }

    expect(modeOf(dir)).toBe(0o700);
    expect(modeOf(join(dir, "ledgers"))).toBe(0o700);
    expect(modeOf(file())).toBe(0o600);
  });

  test("names its directory and network, a provider's ledger and the catalog", async () => {
    const registry = await open();

    expect(registry.dir).toBe(dir);
    expect(registry.network).toBe(NETWORK_REGTEST);
    expect(registry.ledgerPath(A.id)).toBe(join(dir, "ledgers", `${A.id}.jsonl`));
    expect(registry.catalogPath()).toBe(join(dir, "discovery.json"));
  });

  test.each([
    "",
    "../0123456789abcdef",
    "0123456789ABCDEF",
    "0123456789abcde",
    "0123456789abcdef0",
    "0123456789abcdeg",
  ])(
    "names no ledger for the id %j",
    async (id) => {
      const registry = await open();

      const error = thrown(() => registry.ledgerPath(id));

      expect(error).toBeInstanceOf(RegistryError);
      expect(error.message).toBe("providersDir: a provider id is 16 lowercase hex");
    },
  );

  test("a directory that cannot be created is refused", async () => {
    writeFileSync(join(root, "occupied"), "");
    const blocked = join(root, "occupied", "providers");

    const error = await refused({ dir: blocked });

    expect(error.message).toBe(`providersDir: cannot create ${blocked} (ENOTDIR)`);
  });

  test("a registry file that cannot be read is refused, and leaves no lock", async () => {
    mkdirSync(file(), { recursive: true });

    const error = await refused();

    expect(error.message).toBe(`providersDir: cannot read ${file()} (EISDIR)`);
    expect(existsSync(lockFile())).toBe(false);
  });
});

describe("the lock", () => {
  test("registry.json.lock names this process while the registry is open and is gone once it closes", async () => {
    const registry = await open();

    expect(JSON.parse(readFileSync(lockFile(), "utf8"))).toMatchObject({ pid: process.pid, host: hostname() });
    expect(modeOf(lockFile())).toBe(0o600);

    registry.close();
    expect(existsSync(lockFile())).toBe(false);
  });

  test("a second open of a held directory is refused until the first one closes", async () => {
    const first = await open();

    const error = await refused();
    expect(error.message).toBe(`providersDir: ${file()} is already open in this process`);

    first.close();
    await expect(open()).resolves.toBeInstanceOf(ProviderRegistry);
  });

  test("a directory a live process of this host holds is refused at once, and its lock is left alone", async () => {
    mkdirSync(dir, { recursive: true });
    const since = "2026-10-28T00:00:00.000Z";
    const holder = { pid: process.ppid, host: hostname(), token: "0123456789abcdef", since };
    writeFileSync(lockFile(), JSON.stringify(holder));

    const error = await refused();

    expect(error.message).toContain(`providersDir: ${file()} is in use by pid ${process.ppid} on ${hostname()}`);
    expect(error.message).not.toContain("ledgerPath");
    expect(JSON.parse(readFileSync(lockFile(), "utf8"))).toEqual(holder);
    expect(existsSync(file())).toBe(false);
  });

  test("a refused open leaves nothing locked, so the same directory opens once the file is repaired", async () => {
    seed("{");
    await refused();
    expect(existsSync(lockFile())).toBe(false);

    seed(JSON.stringify(doc([A])));
    const registry = await open();

    expect(registry.entries()).toEqual([A]);
  });

  test("tells onLost, and writes nothing more, once the lock stops naming this start", async () => {
    const onLost = vi.fn<(err: unknown) => void>();
    const registry = await open({ onLost });
    registry.put(A);
    rmSync(lockFile());

    const error = thrown(() => registry.put(B));

    expect(error.message).toMatch(/is no longer locked by this facilitator \(its lock is gone\)/);
    expect(onLost).toHaveBeenCalledTimes(1);
    expect(onLost).toHaveBeenCalledWith(error);
    expect(onDisk()).toBe(written([A]));
    expect(registry.entries()).toEqual([A]);
  });
});

describe("a registry file", () => {
  test("loads its providers in file order", async () => {
    seed(JSON.stringify(doc([A, B, C])));

    const registry = await open();

    expect(registry.entries()).toEqual([A, B, C]);
    expect(registry.get(B.payTo)).toEqual(B);
    expect(registry.get(`uregtest1${"w".repeat(60)}`)).toBeUndefined();
  });

  test("takes the addresses of real testnet accounts", async () => {
    const entries = [
      { ...A, payTo: REAL_TESTNET_A },
      { ...B, payTo: REAL_TESTNET_B },
    ];
    seed(JSON.stringify(doc(entries, { network: NETWORK_TESTNET })));

    const registry = await open({ network: NETWORK_TESTNET });

    expect(registry.entries()).toEqual(entries);
    expect(registry.get(REAL_TESTNET_B)).toEqual(entries[1]);
  });

  test.each([
    ["a uivk of one character", "u"],
    ["a uivk of 1024 characters", "u".repeat(1024)],
  ])("accepts %s", async (_label, uivk) => {
    seed(JSON.stringify(doc([{ ...A, uivk }])));
    await expect(open()).resolves.toBeInstanceOf(ProviderRegistry);
  });

  test("accepts a payTo of exactly 1024 characters", async () => {
    const payTo = `uregtest1${"q".repeat(1015)}`;
    seed(JSON.stringify(doc([{ ...A, payTo }])));
    const registry = await open();
    expect(registry.get(payTo)).toEqual({ ...A, payTo });
  });

  test.each(["1970-01-01T00:00:00.000Z", "2026-02-28T23:59:59.999Z", "9999-12-31T23:59:59.999Z"])(
    "accepts the timestamp %s",
    async (stamp) => {
      seed(JSON.stringify(doc([{ ...A, createdAt: stamp, keyIssuedAt: stamp }])));
      await expect(open()).resolves.toBeInstanceOf(ProviderRegistry);
    },
  );

  const TOP_LEVEL: Array<[string, string, string]> = [
    ["a file that is not JSON", "{", "not JSON"],
    ["an empty file", "", "not JSON"],
    ["two documents in a row", JSON.stringify(doc([])) + JSON.stringify(doc([])), "not JSON"],
    ["a JSON array", "[]", "not a JSON object"],
    ["null", "null", "not a JSON object"],
    ["a JSON string", '"registry"', "not a JSON object"],
    ["a JSON number", "1", "not a JSON object"],
    ["no version", JSON.stringify({ network: NETWORK_REGTEST, providers: [] }), "version is not 1"],
    ["version 2", JSON.stringify(doc([], { version: 2 })), "version is not 1"],
    ["version 0", JSON.stringify(doc([], { version: 0 })), "version is not 1"],
    ["a version written as a string", JSON.stringify(doc([], { version: "1" })), "version is not 1"],
    ["no network", JSON.stringify({ version: 1, providers: [] }), "network is not a Zcash network"],
    ["a network that is no string", JSON.stringify(doc([], { network: 1 })), "network is not a Zcash network"],
    [
      "a network that does not exist",
      JSON.stringify(doc([], { network: "zcash:fantasy" })),
      "network is not a Zcash network",
    ],
    ["a network in capitals", JSON.stringify(doc([], { network: "ZCASH:REGTEST" })), "network is not a Zcash network"],
    ["no providers", JSON.stringify({ version: 1, network: NETWORK_REGTEST }), "providers is not an array"],
    ["providers as an object", JSON.stringify(doc({})), "providers is not an array"],
    ["providers as null", JSON.stringify(doc(null)), "providers is not an array"],
    ["providers as a string", JSON.stringify(doc("[]")), "providers is not an array"],
    [
      "a field besides the three",
      JSON.stringify(doc([], { extra: true })),
      "fields other than version, network and providers",
    ],
    [
      "a __proto__ field",
      '{"version":1,"network":"zcash:regtest","providers":[],"__proto__":{}}',
      "fields other than version, network and providers",
    ],
  ];

  test.each(TOP_LEVEL)("refuses %s", async (_label, text, reason) => {
    seed(text);

    const error = await refused();

    expect(error.message).toBe(`providersDir: ${file()} is not a valid provider registry (${reason})`);
    expectNoSecrets(error, secretsIn(text));
    expect(existsSync(lockFile())).toBe(false);
  });

  /** Entries that are wrong in one way each, with the reason that names it */
  const BAD_ENTRIES: Array<[string, unknown, string]> = [
    ["an entry that is null", null, REASON.notObject],
    ["an entry that is an array", [A], REASON.notObject],
    ["an entry that is a string", "provider", REASON.notObject],
    ["an entry that is a number", 7, REASON.notObject],
    ["a field besides the six", { ...A, apiKey: `z402_${"A".repeat(43)}` }, REASON.extraFields],
    ["a __proto__ field", JSON.parse(`{"__proto__":{},${JSON.stringify(A).slice(1)}`), REASON.extraFields],
    ...ENTRY_FIELDS.flatMap((field): Array<[string, unknown, string]> => [
      [`no ${field}`, without(A, field), REASON[field]],
      [`${field} as a number`, { ...A, [field]: 7 }, REASON[field]],
      [`${field} as null`, { ...A, [field]: null }, REASON[field]],
    ]),
    ["an id of 15 hex digits", { ...A, id: "3f9a1c07be52d68" }, REASON.id],
    ["an id of 17 hex digits", { ...A, id: "3f9a1c07be52d6840" }, REASON.id],
    ["an id in capitals", { ...A, id: "3F9A1C07BE52D684" }, REASON.id],
    ["an id that is not hex", { ...A, id: "3f9a1c07be52d68g" }, REASON.id],
    ["an id with a trailing newline", { ...A, id: "3f9a1c07be52d68\n" }, REASON.id],
    ["an empty id", { ...A, id: "" }, REASON.id],
    ["a payTo of testnet", { ...A, payTo: `utest1${"q".repeat(60)}` }, REASON.payTo],
    ["a payTo of mainnet", { ...A, payTo: `u1${"q".repeat(60)}` }, REASON.payTo],
    ["a payTo with a transparent receiver", { ...A, payTo: `turegtest1${"q".repeat(60)}` }, REASON.payTo],
    ["a payTo in capitals", { ...A, payTo: A.payTo.toUpperCase() }, REASON.payTo],
    ["a payTo with a trailing space", { ...A, payTo: `${A.payTo} ` }, REASON.payTo],
    ["a payTo that is no address", { ...A, payTo: "treasury" }, REASON.payTo],
    ["an empty payTo", { ...A, payTo: "" }, REASON.payTo],
    ["a payTo of 1025 characters", { ...A, payTo: `uregtest1${"q".repeat(1016)}` }, REASON.payToLength],
    ["a payTo of 59000 characters", { ...A, payTo: `uregtest1${"q".repeat(58_991)}` }, REASON.payToLength],
    ["a payTo of 1025 characters that is no address", { ...A, payTo: "Q".repeat(1025) }, REASON.payToLength],
    ["an empty uivk", { ...A, uivk: "" }, REASON.uivk],
    ["a uivk of 1025 characters", { ...A, uivk: "u".repeat(1025) }, REASON.uivk],
    ["a uivk with a space inside", { ...A, uivk: "uivkregtest1SECRET BAD" }, REASON.uivk],
    ["a uivk with a tab inside", { ...A, uivk: "uivkregtest1SECRET\tBAD" }, REASON.uivk],
    ["a uivk with a newline inside", { ...A, uivk: "uivkregtest1SECRET\nBAD" }, REASON.uivk],
    ["a uivk with a trailing space", { ...A, uivk: `${A.uivk} ` }, REASON.uivk],
    ["a uivk with a leading space", { ...A, uivk: ` ${A.uivk}` }, REASON.uivk],
    ["a uivk with a no-break space", { ...A, uivk: "uivkregtest1SECRET BAD" }, REASON.uivk],
    ["a keyHash of 63 hex digits", { ...A, keyHash: A.keyHash.slice(1) }, REASON.keyHash],
    ["a keyHash of 65 hex digits", { ...A, keyHash: `${A.keyHash}0` }, REASON.keyHash],
    ["a keyHash in capitals", { ...A, keyHash: A.keyHash.toUpperCase() }, REASON.keyHash],
    ["a keyHash that is not hex", { ...A, keyHash: `${A.keyHash.slice(1)}g` }, REASON.keyHash],
    ["a keyHash with a trailing newline", { ...A, keyHash: `${A.keyHash.slice(1)}\n` }, REASON.keyHash],
    ...(["createdAt", "keyIssuedAt"] as const).flatMap((field): Array<[string, unknown, string]> => [
      [`${field} that is no date`, { ...A, [field]: "yesterday" }, REASON[field]],
      [`${field} that is the epoch milliseconds`, { ...A, [field]: 1761645600000 }, REASON[field]],
      [`${field} that is a date alone`, { ...A, [field]: "2026-10-28" }, REASON[field]],
      [`${field} without milliseconds`, { ...A, [field]: "2026-10-28T10:00:00Z" }, REASON[field]],
      [`${field} with an offset`, { ...A, [field]: "2026-10-28T10:00:00.000+00:00" }, REASON[field]],
      [`${field} with a space for the T`, { ...A, [field]: "2026-10-28 10:00:00.000Z" }, REASON[field]],
      [`${field} on a day the month does not have`, { ...A, [field]: "2026-02-30T10:00:00.000Z" }, REASON[field]],
      [`${field} in lowercase`, { ...A, [field]: "2026-10-28t10:00:00.000z" }, REASON[field]],
    ]),
  ];

  test.each(BAD_ENTRIES)("refuses %s", async (_label, bad, reason) => {
    const text = JSON.stringify(doc([A, bad]));
    seed(text);

    const error = await refused();

    expect(error.message).toBe(`providersDir: ${file()} is not a valid provider registry (entry 2: ${reason})`);
    expectNoSecrets(error, secretsIn(text));
    expect(existsSync(lockFile())).toBe(false);
  });

  test.each([
    ["the same payTo twice", [A, B, { ...C, payTo: A.payTo }], "entries 1 and 3 share a payTo"],
    ["the same id twice", [A, B, { ...C, id: B.id }], "entries 2 and 3 share an id"],
    ["the same entry twice", [A, A], "entries 1 and 2 share a payTo"],
    ["a rotated copy of an entry", [A, ROTATED_A], "entries 1 and 2 share a payTo"],
  ])("refuses %s", async (_label, providers, reason) => {
    const text = JSON.stringify(doc(providers));
    seed(text);

    const error = await refused();

    expect(error.message).toBe(`providersDir: ${file()} is not a valid provider registry (${reason})`);
    expectNoSecrets(error, secretsIn(text));
  });

  test.each([NETWORK_MAINNET, NETWORK_TESTNET])(
    "of %s is refused, before its payTo values are judged",
    async (other) => {
      seed(JSON.stringify(doc([A], { network: other })));

      const error = await refused();

      expect(error.message).toBe(`providersDir: ${file()} is the registry of ${other}`);
      expect(existsSync(lockFile())).toBe(false);
    },
  );

  test("of regtest is refused by a testnet facilitator", async () => {
    seed(JSON.stringify(doc([A, B])));

    const error = await refused({ network: NETWORK_TESTNET });

    expect(error.message).toBe(`providersDir: ${file()} is the registry of ${NETWORK_REGTEST}`);
    expectNoSecrets(error, [A.uivk, B.uivk, A.keyHash, B.keyHash]);
  });

  test("that starts with a uivk is refused without quoting any of it", async () => {
    const text = `SECRETUIVK${"x".repeat(60)} is no JSON`;
    seed(text);
    // The premise, that JSON.parse quotes the start of its input
    expect(() => JSON.parse(text)).toThrow(/SECRETUIVK/);

    const error = await refused();

    expect(error.message).toBe(`providersDir: ${file()} is not a valid provider registry (not JSON)`);
    expect(error.cause).toBeUndefined();
    expectNoSecrets(error, ["SECRETUIVK"]);
  });

  test("the helper that finds secrets finds both kinds", () => {
    expect(secretsIn(JSON.stringify(doc([A, B])))).toEqual([A.uivk, A.keyHash, B.uivk, B.keyHash]);
  });
});

/** Entries put refuses for the reasons load does, each with the reason that names the field at fault */
const BAD_PUTS: Array<[string, unknown, string]> = [
  ["null", null, REASON.notObject],
  ["a field besides the six", { ...B, apiKey: `z402_${"A".repeat(43)}` }, REASON.extraFields],
  ...ENTRY_FIELDS.map((field): [string, unknown, string] => [`no ${field}`, without(B, field), REASON[field]]),
  ["an id of 15 hex digits", { ...B, id: B.id.slice(1) }, REASON.id],
  ["an id in capitals", { ...B, id: B.id.toUpperCase() }, REASON.id],
  ["a payTo of testnet", { ...B, payTo: REAL_TESTNET_A }, REASON.payTo],
  ["a payTo of mainnet", { ...B, payTo: `u1${"q".repeat(60)}` }, REASON.payTo],
  ["a payTo of 1025 characters", { ...B, payTo: `uregtest1${"q".repeat(1016)}` }, REASON.payToLength],
  ["a uivk with a space inside", { ...B, uivk: "uivkregtest1SECRET BAD" }, REASON.uivk],
  ["a uivk of 1025 characters", { ...B, uivk: "u".repeat(1025) }, REASON.uivk],
  ["a keyHash in capitals", { ...B, keyHash: B.keyHash.toUpperCase() }, REASON.keyHash],
  ["a keyHash of 63 hex digits", { ...B, keyHash: B.keyHash.slice(1) }, REASON.keyHash],
  ["a createdAt without milliseconds", { ...B, createdAt: "2026-10-28T11:00:00Z" }, REASON.createdAt],
  ["a keyIssuedAt that is no date", { ...B, keyIssuedAt: "soon" }, REASON.keyIssuedAt],
];

describe("put", () => {
  test("appends a provider, which get and entries then answer for", async () => {
    const registry = await open();

    registry.put(A);
    registry.put(B);

    expect(registry.entries()).toEqual([A, B]);
    expect(registry.get(A.payTo)).toEqual(A);
    expect(registry.get(B.payTo)).toEqual(B);
  });

  test("writes the strict document, compact, with the fields in order and a newline at the end", async () => {
    const registry = await open();

    registry.put(A);
    registry.put({
      keyIssuedAt: B.keyIssuedAt,
      createdAt: B.createdAt,
      keyHash: B.keyHash,
      uivk: B.uivk,
      payTo: B.payTo,
      id: B.id,
    });

    expect(onDisk()).toBe(written([A, B]));
    expect(onDisk()).toMatch(
      /^\{"version":1,"network":"zcash:regtest","providers":\[\{"id":"3f9a1c07be52d684","payTo":"/,
    );
  });

  test("writes a registry file of 0600, and leaves nothing but the registry, its lock and ledgers/", async () => {
    const registry = await open();

    registry.put(A);

    expect(modeOf(file())).toBe(0o600);
    expect(readdirSync(dir).sort()).toEqual(["ledgers", "registry.json", "registry.json.lock"]);
    registry.close();
    expect(readdirSync(dir).sort()).toEqual(["ledgers", "registry.json"]);
  });

  test("replaces the entry of a payTo where it stands, which is how a key is rotated", async () => {
    const registry = await open();
    registry.put(A);
    registry.put(B);
    registry.put(C);

    registry.put(ROTATED_A);

    expect(registry.entries()).toEqual([ROTATED_A, B, C]);
    expect(registry.get(A.payTo)).toEqual(ROTATED_A);
    expect(onDisk()).toBe(written([ROTATED_A, B, C]));
  });

  test("keeps a provider across a close and a new openRegistry", async () => {
    const first = await open();
    first.put(A);
    first.put(B);
    first.put(ROTATED_A);
    first.close();

    const second = await open();
    expect(second.entries()).toEqual([ROTATED_A, B]);
    expect(second.get(B.payTo)).toEqual(B);
    second.put(C);
    second.close();

    const third = await open();
    expect(third.entries()).toEqual([ROTATED_A, B, C]);
    expect(onDisk()).toBe(written([ROTATED_A, B, C]));
  });

  test("keeps real testnet providers across a reopen", async () => {
    const first = await open({ network: NETWORK_TESTNET });
    first.put({ ...A, payTo: REAL_TESTNET_A });
    first.put({ ...B, payTo: REAL_TESTNET_B });
    first.close();

    const second = await open({ network: NETWORK_TESTNET });

    expect(second.entries().map((e) => e.payTo)).toEqual([REAL_TESTNET_A, REAL_TESTNET_B]);
    expect(JSON.parse(onDisk())).toMatchObject({ version: 1, network: NETWORK_TESTNET });
  });

  test("takes a key hash made by keyDigest", async () => {
    const registry = await open();
    registry.put({ ...A, keyHash: keyDigest("z402_" + "k".repeat(43)) });
    expect(registry.get(A.payTo)?.keyHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("stores frozen copies, so neither the caller nor a reader can change the registry", async () => {
    const registry = await open();
    const given = { ...A };

    registry.put(given);
    given.keyHash = B.keyHash;
    const before = registry.entries();
    registry.put(B);

    expect(registry.get(A.payTo)).toEqual(A);
    expect(before).toEqual([A]);
    expect(Object.isFrozen(before)).toBe(true);
    expect(Object.isFrozen(registry.get(A.payTo))).toBe(true);
    expect(() => {
      (registry.get(A.payTo) as ProviderEntry).keyHash = B.keyHash;
    }).toThrow(TypeError);
  });

  test.each(BAD_PUTS)("refuses %s, leaving the file and the memory as they were", async (_label, bad, reason) => {
    const registry = await open();
    registry.put(A);
    const before = onDisk();

    const error = thrown(() => registry.put(bad as ProviderEntry));

    expect(error).toBeInstanceOf(RegistryError);
    expect(error.message).toBe(`providersDir: cannot store the provider (${reason})`);
    expectNoSecrets(error, secretsIn(JSON.stringify({ providers: [bad] })));
    expect(onDisk()).toBe(before);
    expect(registry.entries()).toEqual([A]);
    expect(readdirSync(dir).filter(isTemp)).toEqual([]);
  });

  test("refuses an id that belongs to another payTo", async () => {
    const registry = await open();
    registry.put(A);
    registry.put(B);

    const error = thrown(() => registry.put({ ...C, id: B.id }));

    expect(error).toBeInstanceOf(RegistryError);
    expect(error.message).toBe("providersDir: cannot store the provider (the id belongs to another payTo)");
    expect(registry.entries()).toEqual([A, B]);
    expect(onDisk()).toBe(written([A, B]));
  });

  test("refuses to give a registered payTo another id, which would orphan its ledger", async () => {
    const registry = await open();
    registry.put(A);

    const error = thrown(() => registry.put({ ...A, id: C.id }));

    expect(error).toBeInstanceOf(RegistryError);
    expect(error.message).toBe("providersDir: cannot store the provider (the id of a registered payTo cannot change)");
    expect(registry.entries()).toEqual([A]);
    expect(onDisk()).toBe(written([A]));
  });

  test("syncs the temp file before the rename and the directory after it", async () => {
    const registry = await open();
    for (const fn of [openSync, writeFileSync, fsyncSync, renameSync]) vi.mocked(fn).mockClear();

    registry.put(A);

    const opens = vi.mocked(openSync).mock;
    const temp = opens.calls.find((call) => call[1] === "wx");
    if (temp === undefined) throw new Error("no temp file was opened");
    const [tempPath, flags, mode] = temp;
    expect(dirname(String(tempPath))).toBe(dir);
    expect(flags).toBe("wx");
    expect(mode).toBe(0o600);
    const fdOf = (path: unknown) => opens.results[opens.calls.findIndex((call) => call[0] === path)]?.value;

    const syncs = vi.mocked(fsyncSync).mock;
    expect(syncs.calls).toEqual([[fdOf(tempPath)], [fdOf(dir)]]);
    expect(vi.mocked(renameSync).mock.calls).toEqual([[tempPath, file()]]);
    const [write] = vi.mocked(writeFileSync).mock.invocationCallOrder;
    const [syncFile, syncDir] = syncs.invocationCallOrder;
    const [rename] = vi.mocked(renameSync).mock.invocationCallOrder;
    expect(write).toBeLessThan(syncFile ?? 0);
    expect(syncFile).toBeLessThan(rename ?? 0);
    expect(rename).toBeLessThan(syncDir ?? 0);
  });

  test("checks the lock before it touches the disk", async () => {
    const registry = await open();
    rmSync(lockFile());
    for (const fn of [openSync, writeFileSync, renameSync]) vi.mocked(fn).mockClear();

    expect(() => registry.put(A)).toThrow(/is no longer locked by this facilitator/);

    expect(vi.mocked(openSync).mock.calls.filter((call) => call[1] === "wx")).toEqual([]);
    expect(vi.mocked(writeFileSync)).not.toHaveBeenCalled();
    expect(vi.mocked(renameSync)).not.toHaveBeenCalled();
    expect(existsSync(file())).toBe(false);
  });
});

describe("a put that fails part-way", () => {
  const fault = (code: string) => Object.assign(new Error(`${code}: injected by the test`), { code });

  const STEPS: Array<[string, (error: Error) => void]> = [
    ["writing the temp file", (e) => vi.mocked(writeFileSync).mockImplementationOnce(() => { throw e; })],
    ["fsyncing the temp file", (e) => vi.mocked(fsyncSync).mockImplementationOnce(() => { throw e; })],
    ["renaming the temp file into place", (e) => vi.mocked(renameSync).mockImplementationOnce(() => { throw e; })],
  ];

  test.each(STEPS)("%s fails, and the error comes out as it went in", async (_step, inject) => {
    const registry = await open();
    registry.put(A);
    const before = onDisk();
    const listing = readdirSync(dir).sort();
    const injected = fault("EIO");
    inject(injected);

    const error = thrown(() => registry.put(B));

    expect(error).toBe(injected);
    expect(onDisk()).toBe(before);
    expect(registry.entries()).toEqual([A]);
    expect(registry.get(B.payTo)).toBeUndefined();
    expect(readdirSync(dir).sort()).toEqual(listing);

    registry.put(B);
    expect(onDisk()).toBe(written([A, B]));
  });

  test("a rotation that fails leaves the old key hash in the file and the memory", async () => {
    const registry = await open();
    registry.put(A);
    const injected = fault("ENOSPC");
    vi.mocked(writeFileSync).mockImplementationOnce(() => {
      throw injected;
    });

    expect(thrown(() => registry.put(ROTATED_A))).toBe(injected);

    expect(registry.get(A.payTo)).toEqual(A);
    expect(onDisk()).toBe(written([A]));
  });

  test("a failure to fsync the directory, after the rename, still leaves the memory as it was", async () => {
    const registry = await open();
    registry.put(A);
    const injected = fault("EIO");
    vi.mocked(fsyncSync)
      .mockImplementationOnce(real.fsyncSync)
      .mockImplementationOnce(() => {
        throw injected;
      });

    expect(thrown(() => registry.put(B))).toBe(injected);

    expect(registry.entries()).toEqual([A]);
    expect(readdirSync(dir).filter(isTemp)).toEqual([]);
    // The rename had happened, so the file already holds B while the memory does not
    expect(JSON.parse(onDisk()).providers).toEqual([A, B]);

    // The next put writes the memory's list again, so file and memory agree
    registry.put(C);
    expect(onDisk()).toBe(written([A, C]));
  });

  const asRoot = process.getuid?.() === 0;
  test.skipIf(asRoot)("a directory nobody may write to fails the put and changes nothing", async () => {
    const registry = await open();
    registry.put(A);
    const before = onDisk();
    chmodSync(dir, 0o500);
    let error: Error;
    try {
      error = thrown(() => registry.put(B));
    } finally {
      chmodSync(dir, 0o700);
    }

    expect((error as NodeJS.ErrnoException).code).toBe("EACCES");
    expect(onDisk()).toBe(before);
    expect(registry.entries()).toEqual([A]);
    expect(readdirSync(dir).sort()).toEqual(["ledgers", "registry.json", "registry.json.lock"]);
    expectNoSecrets(error, [A.uivk, B.uivk, A.keyHash, B.keyHash]);

    registry.put(B);
    expect(onDisk()).toBe(written([A, B]));
  });
});

describe("close", () => {
  test("releases the lock, and the second call does nothing", async () => {
    const registry = await open();
    registry.close();
    expect(existsSync(lockFile())).toBe(false);

    const next = await open();
    registry.close();

    expect(existsSync(lockFile())).toBe(true);
    expect(() => next.put(A)).not.toThrow();
  });

  test("refuses every later put, and writes nothing", async () => {
    const registry = await open();
    registry.put(A);
    registry.close();

    const error = thrown(() => registry.put(B));

    expect(error.message).toMatch(/is no longer locked by this facilitator \(it released the lock\)/);
    expect(onDisk()).toBe(written([A]));
    expect(registry.entries()).toEqual([A]);
  });

  test("leaves the file, and the answers of get and entries, for a closed registry", async () => {
    const registry = await open();
    registry.put(A);
    registry.close();

    expect(registry.get(A.payTo)).toEqual(A);
    expect(registry.entries()).toEqual([A]);
    expect(onDisk()).toBe(written([A]));
  });
});
