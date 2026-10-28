import {
  chmodSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEMO_TERMS, NETWORK_REGTEST } from "@z402-net/protocol";
import { afterEach, beforeEach, describe, expect, test, vi, type Mock } from "vitest";
import {
  Catalog,
  CatalogError,
  CatalogQueryError,
  parseListQuery,
  parseSearchQuery,
  type CatalogOptions,
  type CatalogProvider,
  type ServedResource,
} from "../src/discovery/catalog.js";

// The catalog imports fs functions by name, so only a module mock can show that an fsync precedes a rename
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, fsyncSync: vi.fn(fs.fsyncSync), renameSync: vi.fn(fs.renameSync) };
});

const PAY_TO = `uregtest1${"q".repeat(60)}`;
const OTHER_PAY_TO = `uregtest1${"p".repeat(60)}`;
const TERMS_VERSION = "0123456789abcdef";
const P1: CatalogProvider = {
  id: "1111111111111111",
  network: NETWORK_REGTEST,
  payTo: PAY_TO,
  terms: DEMO_TERMS,
  termsVersion: TERMS_VERSION,
};
const P2: CatalogProvider = { ...P1, id: "2222222222222222", payTo: OTHER_PAY_TO };

const ISO0 = "2026-10-28T12:00:00.000Z";
const MINUTE = 60_000;
const DAY = 86_400_000;
let clock = new Date(ISO0);
const now = () => clock;
const advance = (ms: number) => {
  clock = new Date(clock.getTime() + ms);
};

const ACCEPT_500 = {
  scheme: "prepaid-voucher",
  network: "zcash:regtest",
  asset: "ZEC",
  amount: "500",
  payTo: PAY_TO,
  maxTimeoutSeconds: 300,
  extra: {
    windowZat: "100000",
    creditRatioBps: 2500,
    creditCapZat: "200000",
    zeroConfMinExpiryBlocks: 20,
    termsVersion: TERMS_VERSION,
  },
};
const accept = (over: Record<string, unknown> = {}, p: CatalogProvider = P1) => ({
  ...ACCEPT_500,
  payTo: p.payTo,
  ...over,
});
const bazaar = (method?: string, routeTemplate?: string) => ({
  ...(routeTemplate === undefined ? {} : { routeTemplate }),
  info: { input: { type: "http", ...(method === undefined ? {} : { method }) } },
  schema: { type: "object" },
});
const decl = (over: Record<string, unknown> = {}, p: CatalogProvider = P1) => ({
  resource: "http://127.0.0.1:4021/chunk",
  type: "http",
  x402Version: 2,
  accepts: [accept({}, p)],
  ...over,
});
const body = (...items: unknown[]) => ({ items });
const pay = (over: Record<string, unknown> = {}) => ({
  x402Version: 2,
  resource: { url: "http://127.0.0.1:4021/chunk?session=s1" },
  accepted: accept(),
  payload: { sessionKey: "k", cumulativeZat: "500", sig: "s" },
  extensions: { bazaar: bazaar("GET") },
  ...over,
});

let dir: string;
let log: Mock<(msg: string, err?: unknown) => void>;
const open: Catalog[] = [];

beforeEach(() => {
  clock = new Date(ISO0);
  log = vi.fn<(msg: string, err?: unknown) => void>();
  dir = mkdtempSync(join(tmpdir(), "z402-catalog-"));
});
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(open.splice(0).map((c) => c.close()));
  rmSync(dir, { recursive: true, force: true });
});

const file = () => join(dir, "discovery.json");
function make(o: CatalogOptions = {}): Catalog {
  const c = Catalog.load({ now, log, ...o });
  open.push(c);
  return c;
}
const ALL = parseListQuery({});
const everything = (c: Catalog): ServedResource[] => c.list(parseListQuery({ limit: "100" })).items;
const resources = (c: Catalog) => everything(c).map((i) => i.resource);

function one<T>(xs: readonly T[]): T {
  expect(xs).toHaveLength(1);
  return xs[0] as T;
}

function refusal(f: () => unknown): CatalogError {
  try {
    f();
  } catch (e) {
    if (e instanceof CatalogError) return e;
    throw e;
  }
  throw new Error("expected a CatalogError");
}

/** An extensions object whose JSON is exactly this many bytes */
function sized(bytes: number, ch = "x"): { pad: string } {
  const o = { pad: ch.repeat((bytes - 10) / Buffer.byteLength(ch)) };
  if (Buffer.byteLength(JSON.stringify(o)) !== bytes) throw new Error("fixture is not the size it claims");
  return o;
}

describe("declare: a valid declaration", () => {
  test("is served as a DiscoveryResource with its liveness and no paid calls", () => {
    expect(make().declare(P1, body(decl()))).toStrictEqual([
      {
        resource: "http://127.0.0.1:4021/chunk",
        type: "http",
        x402Version: 2,
        accepts: [ACCEPT_500],
        lastUpdated: ISO0,
        lastSeen: ISO0,
        paidCallsToday: 0,
      },
    ]);
  });

  test("is served again, unchanged, by list, which orders it", () => {
    const c = make();
    const declared = c.declare(P1, body(decl(), decl({ resource: "http://127.0.0.1:4021/b" })));
    expect(declared.map((d) => d.resource)).toStrictEqual(["http://127.0.0.1:4021/chunk", "http://127.0.0.1:4021/b"]);
    expect(c.list(ALL).items).toHaveLength(2);
    for (const item of declared) expect(c.list(ALL).items).toContainEqual(item);
    expect(resources(c)).toStrictEqual(["http://127.0.0.1:4021/b", "http://127.0.0.1:4021/chunk"]);
  });

  test("keeps every optional field and the extensions as declared", () => {
    const extensions = { bazaar: bazaar("GET"), z402: { note: "kept", list: [1, { deep: true }] } };
    const optional = {
      description: "A chunk of text",
      mimeType: "text/plain",
      serviceName: "chunk",
      tags: ["demo", "text"],
      iconUrl: "https://cdn.example.com/chunk.png",
      extensions,
    };
    expect(one(make().declare(P1, body(decl(optional))))).toMatchObject(optional);
  });

  test("serves accepts rebuilt from the validated fields, whatever else the declarer added", () => {
    const noisy = accept({ evil: "x", extra: { ...ACCEPT_500.extra, evil: "y" } });
    const served = one(make().declare(P1, body(decl({ accepts: [noisy] }))));
    expect(served.accepts).toStrictEqual([ACCEPT_500]);
  });

  test("never takes lastUpdated, lastSeen, paidCallsToday or any other field from the declarer", () => {
    const forged = {
      lastUpdated: "2000-01-01T00:00:00.000Z",
      lastSeen: "2000-01-01T00:00:00.000Z",
      paidCallsToday: 99,
    };
    const served = one(make().declare(P1, body(decl({ ...forged, source: "payment", evil: "x" }))));
    expect(served).toStrictEqual({
      resource: "http://127.0.0.1:4021/chunk",
      type: "http",
      x402Version: 2,
      accepts: [ACCEPT_500],
      lastUpdated: ISO0,
      lastSeen: ISO0,
      paidCallsToday: 0,
    });
  });

  test("keeps a copy of what it is given, so changing the body afterwards changes nothing", () => {
    const c = make();
    const extensions = { x: { y: 1 } };
    const tags = ["a"];
    const accepts = [accept()];
    c.declare(P1, body(decl({ extensions, tags, accepts })));
    extensions.x.y = 2;
    tags.push("b");
    accepts[0]!.amount = "1";
    expect(one(everything(c))).toMatchObject({ extensions: { x: { y: 1 } }, tags: ["a"], accepts: [ACCEPT_500] });
  });

  test("hands back copies, so changing an answer never changes the catalog", () => {
    const c = make();
    const served = one(c.declare(P1, body(decl({ tags: ["a"], extensions: { x: { y: 1 } } }))));
    served.accepts[0]!.amount = "1";
    served.tags!.push("b");
    (served.extensions as { x: { y: number } }).x.y = 2;
    expect(one(everything(c))).toMatchObject({ tags: ["a"], extensions: { x: { y: 1 } } });
    expect(one(everything(c)).accepts[0]!.amount).toBe("500");
  });

  test("answers one item per distinct key, in request order, the last of a repeated key winning", () => {
    const served = make().declare(
      P1,
      body(
        decl({ resource: "http://h/b" }),
        decl({ resource: "http://h/a", description: "first" }),
        decl({ resource: "http://h/a?again=1", description: "second" }),
      ),
    );
    expect(served.map((s) => [s.resource, s.description])).toStrictEqual([
      ["http://h/b", undefined],
      ["http://h/a", "second"],
    ]);
  });
});

const accepted: Array<[string, Record<string, unknown>]> = [
  ["the lowest price, 1 zat", { accepts: [accept({ amount: "1" })] }],
  ["a price of exactly windowZat", { accepts: [accept({ amount: "100000" })] }],
  ["4 accepts entries", { accepts: ["1", "2", "3", "4"].map((amount) => accept({ amount })) }],
  ["a 512-character description", { description: "d".repeat(512) }],
  ["an empty description", { description: "" }],
  ["a 128-character mimeType", { mimeType: "m".repeat(128) }],
  ["a 1-character serviceName", { serviceName: "a" }],
  ["a 32-character serviceName", { serviceName: "s".repeat(32) }],
  ["a serviceName from the ends of printable ASCII", { serviceName: " ~" }],
  ["5 tags", { tags: ["a", "b", "c", "d", "e"] }],
  ["a 32-character tag", { tags: ["t".repeat(32)] }],
  ["an https iconUrl", { iconUrl: "https://cdn.example.com/i.png" }],
  ["an iconUrl with a port and a query", { iconUrl: "http://example.com:8080/i.png?v=2" }],
  ["a resource of exactly 2048 characters", { resource: `http://h/${"a".repeat(2039)}` }],
  ["extensions of exactly 8192 bytes", { extensions: sized(8192) }],
  ["extensions of 8192 bytes that are not 8192 characters", { extensions: sized(8192, "é") }],
];

describe("declare: boundaries that are accepted", () => {
  test.each(accepted)("accepts %s", (_name, over) => {
    const served = one(make().declare(P1, body(decl(over))));
    expect(served).toMatchObject(over);
  });

  test("accepts a duplicate tag by keeping the first spelling of it", () => {
    const served = one(make().declare(P1, body(decl({ tags: ["Alpha", "alpha", "BETA", "ALPHA"] }))));
    expect(served.tags).toStrictEqual(["Alpha", "BETA"]);
  });

  test("counts 5 tags after the duplicates are folded", () => {
    const served = one(make().declare(P1, body(decl({ tags: ["a", "A", "b", "c", "d", "e"] }))));
    expect(served.tags).toStrictEqual(["a", "b", "c", "d", "e"]);
  });

  test("takes extensions nested far deeper than recursive code survives, within the byte cap", () => {
    const c = make();
    const deep = `{"a":${"[".repeat(3990)}${"]".repeat(3990)}}`;
    expect(Buffer.byteLength(deep)).toBeLessThanOrEqual(8192);
    c.declare(P1, body(decl({ extensions: JSON.parse(deep) })));
    const served = one(c.list(ALL).items);
    expect(JSON.stringify(served.extensions)).toBe(deep);
  });

  test("takes 32 items in one call", () => {
    const c = make();
    const items = Array.from({ length: 32 }, (_, n) => decl({ resource: `http://h/${n}` }));
    expect(c.declare(P1, body(...items))).toHaveLength(32);
  });
});

const refused: Array<[string, unknown, RegExp]> = [
  ["an item that is not an object", 5, /^items\[1\]: /],
  ["an item that is null", null, /^items\[1\]: /],
  ["an item that is an array", [], /^items\[1\]: /],
  ["a relative resource", decl({ resource: "/chunk" }), /^items\[1\]\.resource: /],
  ["a resource that is not a string", decl({ resource: 5 }), /^items\[1\]\.resource: /],
  ["a missing resource", decl({ resource: undefined }), /^items\[1\]\.resource: /],
  ["an ftp resource", decl({ resource: "ftp://h/x" }), /^items\[1\]\.resource: /],
  ["a javascript resource", decl({ resource: "javascript:alert(1)" }), /^items\[1\]\.resource: /],
  ["a resource without a host", decl({ resource: "http://" }), /^items\[1\]\.resource: /],
  ["a resource with a user and password", decl({ resource: "http://u:p@h/x" }), /^items\[1\]\.resource: /],
  ["a resource with only a user", decl({ resource: "http://u@h/x" }), /^items\[1\]\.resource: /],
  ["a resource with an empty userinfo", decl({ resource: "http://@h/x" }), /^items\[1\]\.resource: /],
  [
    "a resource with a backslash and an at sign",
    decl({ resource: "http://h\\@evil.example/x" }),
    /^items\[1\]\.resource: /,
  ],
  ["a resource with a backslash for a slash", decl({ resource: "http://h\\chunk" }), /^items\[1\]\.resource: /],
  ["a resource with a backslash in the path", decl({ resource: "http://h/a\\b" }), /^items\[1\]\.resource: /],
  ["a resource with an empty authority", decl({ resource: "http:///chunk" }), /^items\[1\]\.resource: /],
  ["a resource whose authority is a query", decl({ resource: "http://?x=1" }), /^items\[1\]\.resource: /],
  ["a resource written without slashes", decl({ resource: "http:h/chunk" }), /^items\[1\]\.resource: /],
  ["a resource with a newline", decl({ resource: "http://h/a\nb" }), /^items\[1\]\.resource: /],
  ["a resource with a space", decl({ resource: "http://h/a b" }), /^items\[1\]\.resource: /],
  ["a resource of 2049 characters", decl({ resource: `http://h/${"a".repeat(2040)}` }), /^items\[1\]\.resource: /],
  [
    "a canonical resource over 2048 characters",
    decl({ resource: "http://h/x", extensions: { bazaar: bazaar("GET", `/${"a".repeat(2100)}`) } }),
    /^items\[1\]\.resource: /,
  ],
  ["a type other than http", decl({ type: "mcp" }), /^items\[1\]\.type: /],
  ["a missing type", decl({ type: undefined }), /^items\[1\]\.type: /],
  ["x402Version 1", decl({ x402Version: 1 }), /^items\[1\]\.x402Version: /],
  ["x402Version as a string", decl({ x402Version: "2" }), /^items\[1\]\.x402Version: /],
  ["a missing x402Version", decl({ x402Version: undefined }), /^items\[1\]\.x402Version: /],
  ["missing accepts", decl({ accepts: undefined }), /^items\[1\]\.accepts: /],
  ["accepts that is not an array", decl({ accepts: accept() }), /^items\[1\]\.accepts: /],
  ["empty accepts", decl({ accepts: [] }), /^items\[1\]\.accepts: /],
  ["5 accepts entries", decl({ accepts: Array.from({ length: 5 }, () => accept()) }), /^items\[1\]\.accepts: /],
  ["an accepts entry that is not an object", decl({ accepts: ["x"] }), /^items\[1\]\.accepts\[0\]: /],
  ["an accepts entry that is null", decl({ accepts: [accept(), null] }), /^items\[1\]\.accepts\[1\]: /],
  ["another scheme", decl({ accepts: [accept({ scheme: "exact" })] }), /^items\[1\]\.accepts\[0\]\.scheme: /],
  ["a missing scheme", decl({ accepts: [accept({ scheme: undefined })] }), /^items\[1\]\.accepts\[0\]\.scheme: /],
  [
    "another network",
    decl({ accepts: [accept({ network: "zcash:testnet" })] }),
    /^items\[1\]\.accepts\[0\]\.network: /,
  ],
  ["an EVM network", decl({ accepts: [accept({ network: "eip155:1" })] }), /^items\[1\]\.accepts\[0\]\.network: /],
  ["another asset", decl({ accepts: [accept({ asset: "USDC" })] }), /^items\[1\]\.accepts\[0\]\.asset: /],
  [
    "another provider's payTo",
    decl({ accepts: [accept({ payTo: OTHER_PAY_TO })] }),
    /^items\[1\]\.accepts\[0\]\.payTo: /,
  ],
  ["a missing payTo", decl({ accepts: [accept({ payTo: undefined })] }), /^items\[1\]\.accepts\[0\]\.payTo: /],
  [
    "a second entry with another payTo",
    decl({ accepts: [accept(), accept({ payTo: OTHER_PAY_TO })] }),
    /^items\[1\]\.accepts\[1\]\.payTo: /,
  ],
  ["an amount of 0", decl({ accepts: [accept({ amount: "0" })] }), /^items\[1\]\.accepts\[0\]\.amount: /],
  ["a negative amount", decl({ accepts: [accept({ amount: "-1" })] }), /^items\[1\]\.accepts\[0\]\.amount: /],
  [
    "an amount with a leading zero",
    decl({ accepts: [accept({ amount: "01" })] }),
    /^items\[1\]\.accepts\[0\]\.amount: /,
  ],
  ["a fractional amount", decl({ accepts: [accept({ amount: "1.5" })] }), /^items\[1\]\.accepts\[0\]\.amount: /],
  ["an exponent amount", decl({ accepts: [accept({ amount: "1e3" })] }), /^items\[1\]\.accepts\[0\]\.amount: /],
  ["an amount with a space", decl({ accepts: [accept({ amount: " 5" })] }), /^items\[1\]\.accepts\[0\]\.amount: /],
  ["an empty amount", decl({ accepts: [accept({ amount: "" })] }), /^items\[1\]\.accepts\[0\]\.amount: /],
  ["a numeric amount", decl({ accepts: [accept({ amount: 500 })] }), /^items\[1\]\.accepts\[0\]\.amount: /],
  ["a missing amount", decl({ accepts: [accept({ amount: undefined })] }), /^items\[1\]\.accepts\[0\]\.amount: /],
  [
    "an amount of windowZat + 1",
    decl({ accepts: [accept({ amount: "100001" })] }),
    /^items\[1\]\.accepts\[0\]\.amount: /,
  ],
  [
    "an amount too long to be a zat amount",
    decl({ accepts: [accept({ amount: "99999999999999999999" })] }),
    /^items\[1\]\.accepts\[0\]\.amount: /,
  ],
  [
    "a missing maxTimeoutSeconds",
    decl({ accepts: [accept({ maxTimeoutSeconds: undefined })] }),
    /^items\[1\]\.accepts\[0\]\.maxTimeoutSeconds: /,
  ],
  [
    "a maxTimeoutSeconds of 0",
    decl({ accepts: [accept({ maxTimeoutSeconds: 0 })] }),
    /^items\[1\]\.accepts\[0\]\.maxTimeoutSeconds: /,
  ],
  [
    "a negative maxTimeoutSeconds",
    decl({ accepts: [accept({ maxTimeoutSeconds: -5 })] }),
    /^items\[1\]\.accepts\[0\]\.maxTimeoutSeconds: /,
  ],
  [
    "a maxTimeoutSeconds string",
    decl({ accepts: [accept({ maxTimeoutSeconds: "300" })] }),
    /^items\[1\]\.accepts\[0\]\.maxTimeoutSeconds: /,
  ],
  ["a missing extra", decl({ accepts: [accept({ extra: undefined })] }), /^items\[1\]\.accepts\[0\]\.extra: /],
  ["an extra that is a string", decl({ accepts: [accept({ extra: "x" })] }), /^items\[1\]\.accepts\[0\]\.extra: /],
  ["an extra that is an array", decl({ accepts: [accept({ extra: [] })] }), /^items\[1\]\.accepts\[0\]\.extra: /],
  [
    "another windowZat",
    decl({ accepts: [accept({ extra: { ...ACCEPT_500.extra, windowZat: "99999" } })] }),
    /^items\[1\]\.accepts\[0\]\.extra: /,
  ],
  [
    "another creditRatioBps",
    decl({ accepts: [accept({ extra: { ...ACCEPT_500.extra, creditRatioBps: 2501 } })] }),
    /^items\[1\]\.accepts\[0\]\.extra: /,
  ],
  [
    "another creditCapZat",
    decl({ accepts: [accept({ extra: { ...ACCEPT_500.extra, creditCapZat: "200001" } })] }),
    /^items\[1\]\.accepts\[0\]\.extra: /,
  ],
  [
    "another zeroConfMinExpiryBlocks",
    decl({ accepts: [accept({ extra: { ...ACCEPT_500.extra, zeroConfMinExpiryBlocks: 21 } })] }),
    /^items\[1\]\.accepts\[0\]\.extra: /,
  ],
  [
    "an extra missing a term",
    decl({ accepts: [accept({ extra: { ...ACCEPT_500.extra, creditCapZat: undefined } })] }),
    /^items\[1\]\.accepts\[0\]\.extra: /,
  ],
  [
    "another termsVersion",
    decl({ accepts: [accept({ extra: { ...ACCEPT_500.extra, termsVersion: "fedcba9876543210" } })] }),
    /^items\[1\]\.accepts\[0\]\.extra\.termsVersion: /,
  ],
  [
    "a missing termsVersion",
    decl({ accepts: [accept({ extra: { ...ACCEPT_500.extra, termsVersion: undefined } })] }),
    /^items\[1\]\.accepts\[0\]\.extra\.termsVersion: /,
  ],
  ["a description of 513 characters", decl({ description: "d".repeat(513) }), /^items\[1\]\.description: /],
  ["a description that is not a string", decl({ description: 5 }), /^items\[1\]\.description: /],
  ["a null description", decl({ description: null }), /^items\[1\]\.description: /],
  ["a mimeType of 129 characters", decl({ mimeType: "m".repeat(129) }), /^items\[1\]\.mimeType: /],
  ["a mimeType that is not a string", decl({ mimeType: ["text/plain"] }), /^items\[1\]\.mimeType: /],
  ["an empty serviceName", decl({ serviceName: "" }), /^items\[1\]\.serviceName: /],
  ["a serviceName of 33 characters", decl({ serviceName: "s".repeat(33) }), /^items\[1\]\.serviceName: /],
  ["a serviceName with a tab", decl({ serviceName: "a\tb" }), /^items\[1\]\.serviceName: /],
  ["a serviceName with a DEL", decl({ serviceName: "a\u007fb" }), /^items\[1\]\.serviceName: /],
  ["a serviceName that is not ASCII", decl({ serviceName: "café" }), /^items\[1\]\.serviceName: /],
  ["a serviceName that is not a string", decl({ serviceName: 5 }), /^items\[1\]\.serviceName: /],
  ["tags that are not an array", decl({ tags: "a" }), /^items\[1\]\.tags: /],
  ["6 distinct tags", decl({ tags: ["a", "b", "c", "d", "e", "f"] }), /^items\[1\]\.tags: /],
  ["an empty tag", decl({ tags: ["a", ""] }), /^items\[1\]\.tags\[1\]: /],
  ["a tag of 33 characters", decl({ tags: ["t".repeat(33)] }), /^items\[1\]\.tags\[0\]: /],
  ["a tag that is not ASCII", decl({ tags: ["tag", "naïve"] }), /^items\[1\]\.tags\[1\]: /],
  ["a tag with a control character", decl({ tags: ["a\nb"] }), /^items\[1\]\.tags\[0\]: /],
  ["a tag that is not a string", decl({ tags: [5] }), /^items\[1\]\.tags\[0\]: /],
  ["an iconUrl that is not a URL", decl({ iconUrl: "not a url" }), /^items\[1\]\.iconUrl: /],
  ["an iconUrl that is not a string", decl({ iconUrl: 5 }), /^items\[1\]\.iconUrl: /],
  ["an ftp iconUrl", decl({ iconUrl: "ftp://cdn.example.com/i.png" }), /^items\[1\]\.iconUrl: /],
  ["an iconUrl with userinfo", decl({ iconUrl: "https://u:p@cdn.example.com/i.png" }), /^items\[1\]\.iconUrl: /],
  ["an iconUrl on an IPv4 address", decl({ iconUrl: "http://127.0.0.1/i.png" }), /^items\[1\]\.iconUrl: /],
  ["an iconUrl on a private IPv4 address", decl({ iconUrl: "http://10.0.0.5/i.png" }), /^items\[1\]\.iconUrl: /],
  ["an iconUrl on an IPv6 literal", decl({ iconUrl: "http://[::1]/i.png" }), /^items\[1\]\.iconUrl: /],
  ["an iconUrl on localhost", decl({ iconUrl: "http://localhost/i.png" }), /^items\[1\]\.iconUrl: /],
  ["an iconUrl on LOCALHOST", decl({ iconUrl: "http://LocalHost:8080/i.png" }), /^items\[1\]\.iconUrl: /],
  [
    "an iconUrl on localhost with a trailing dot",
    decl({ iconUrl: "http://localhost./i.png" }),
    /^items\[1\]\.iconUrl: /,
  ],
  ["an iconUrl under .localhost", decl({ iconUrl: "http://app.localhost/i.png" }), /^items\[1\]\.iconUrl: /],
  ["an iconUrl on a decimal host", decl({ iconUrl: "http://2130706433/i.png" }), /^items\[1\]\.iconUrl: /],
  ["an iconUrl on a hex host", decl({ iconUrl: "http://0x7f000001/i.png" }), /^items\[1\]\.iconUrl: /],
  [
    "an iconUrl of 2049 characters",
    decl({ iconUrl: `https://cdn.example.com/${"a".repeat(2025)}` }),
    /^items\[1\]\.iconUrl: /,
  ],
  [
    "an iconUrl with a control character",
    decl({ iconUrl: "https://cdn.example.com/a\u0001b" }),
    /^items\[1\]\.iconUrl: /,
  ],
  ["extensions that are an array", decl({ extensions: [] }), /^items\[1\]\.extensions: /],
  ["extensions that are a string", decl({ extensions: "x" }), /^items\[1\]\.extensions: /],
  ["null extensions", decl({ extensions: null }), /^items\[1\]\.extensions: /],
  [
    "extensions that serialize to a string",
    decl({ extensions: { toJSON: () => "text" } }),
    /^items\[1\]\.extensions: /,
  ],
  [
    "extensions that serialize to nothing",
    decl({ extensions: { toJSON: () => undefined } }),
    /^items\[1\]\.extensions: /,
  ],
  ["extensions that cannot be serialized", decl({ extensions: { n: 10n } }), /^items\[1\]\.extensions: /],
  ["extensions of 8193 bytes", decl({ extensions: sized(8193) }), /^items\[1\]\.extensions: /],
  [
    "extensions under 8192 characters but over 8192 bytes",
    decl({ extensions: sized(8194, "é") }),
    /^items\[1\]\.extensions: /,
  ],
  [
    "a lowercase method",
    decl({ extensions: { bazaar: bazaar("get") } }),
    /^items\[1\]\.extensions\.bazaar\.info\.input\.method: /,
  ],
  [
    "a method outside the six",
    decl({ extensions: { bazaar: bazaar("TRACE") } }),
    /^items\[1\]\.extensions\.bazaar\.info\.input\.method: /,
  ],
  [
    "a method that is not a string",
    decl({ extensions: { bazaar: bazaar(5 as unknown as string) } }),
    /^items\[1\]\.extensions\.bazaar\.info\.input\.method: /,
  ],
];

describe("declare: invalid items are refused", () => {
  test.each(refused)("refuses %s, naming its index and field, and applies nothing", (_name, item, field) => {
    const c = make();
    const err = refusal(() => c.declare(P1, body(decl({ resource: "http://h/good" }), item)));
    expect(err.index).toBe(1);
    expect(err.message).toMatch(field);
    expect(c.list(ALL).pagination.total).toBe(0);
  });

  test("refuses by the first invalid item's index when several are invalid", () => {
    const err = refusal(() => make().declare(P1, body(decl(), decl({ type: "x" }), decl({ x402Version: 9 }))));
    expect(err.index).toBe(1);
  });

  test("does not mark the provider as declaring when its declaration is refused", () => {
    const c = make();
    refusal(() => c.declare(P1, body(decl({ type: "x" }))));
    c.recordPaid(P1, pay(), accept());
    expect(resources(c)).toStrictEqual(["http://127.0.0.1:4021/chunk"]);
  });

  test.each<[string, unknown, RegExp]>([
    ["no body", undefined, /^body: /],
    ["a null body", null, /^body: /],
    ["an array body", [], /^body: /],
    ["a string body", "items", /^body: /],
    ["a body without items", {}, /^items: /],
    ["items that are not an array", { items: "x" }, /^items: /],
    ["items that are an object", { items: decl() }, /^items: /],
    ["no items", { items: [] }, /^items: /],
    ["33 items", { items: Array.from({ length: 33 }, (_, n) => decl({ resource: `http://h/${n}` })) }, /^items: /],
  ])("refuses %s with no index", (_name, input, field) => {
    const err = refusal(() => make().declare(P1, input));
    expect(err.index).toBeUndefined();
    expect(err.message).toMatch(field);
  });

  test("never echoes the offending value in its message", () => {
    const secrets = ["SECRETPW", "SECRETQUERY", "SECRETPAYTO", "SECRETICON", "SECRETDESC", "SECRETTYPE"];
    const bad = [
      decl({ resource: "http://user:SECRETPW@h/x?token=SECRETQUERY" }),
      decl({ resource: "http://h/x?token=SECRETQUERY", type: "SECRETTYPE" }),
      decl({ accepts: [accept({ payTo: "uregtest1SECRETPAYTO" })] }),
      decl({ iconUrl: "http://user:SECRETICON@h/i.png" }),
      decl({ description: "SECRETDESC".repeat(60) }),
    ];
    for (const item of bad) {
      const message = refusal(() => make().declare(P1, body(item))).message;
      for (const secret of secrets) expect(message).not.toContain(secret);
    }
  });
});

describe("declare: the key is provider, canonical resource and method", () => {
  const canonical: Array<[string, string, Record<string, unknown> | undefined, string]> = [
    [
      "drops the query and the fragment",
      "http://127.0.0.1:4021/chunk?a=1&b=2#frag",
      undefined,
      "http://127.0.0.1:4021/chunk",
    ],
    [
      "lowercases the host and drops a default port",
      "HTTP://Example.COM:80/Chunk",
      undefined,
      "http://example.com/Chunk",
    ],
    ["drops the default https port", "https://example.com:443/x", undefined, "https://example.com/x"],
    ["keeps a port that is not the default", "http://h:4021/x", undefined, "http://h:4021/x"],
    ["gives a bare origin the root path", "http://h", undefined, "http://h/"],
    ["resolves dot segments in the path", "http://h/a/../b", undefined, "http://h/b"],
    [
      "uses a valid route template in place of the path",
      "http://h/items/42?x=1",
      { bazaar: bazaar("GET", "/items/:id") },
      "http://h/items/:id",
    ],
    [
      "keeps the port of the origin under a route template",
      "http://h:4021/items/42",
      { bazaar: bazaar("GET", "/items/:id") },
      "http://h:4021/items/:id",
    ],
    [
      "accepts every character the template rule allows",
      "http://h/x",
      { bazaar: bazaar("GET", "/v1/a_b-c.d~e%20f/:x") },
      "http://h/v1/a_b-c.d~e%20f/:x",
    ],
    [
      "accepts a template that needs 4 decode passes",
      "http://h/x",
      { bazaar: bazaar("GET", "/t%25252541") },
      "http://h/t%25252541",
    ],
  ];

  test.each(canonical)("%s", (_name, resource, extensions, expected) => {
    const served = one(
      make().declare(P1, body(decl({ resource, ...(extensions === undefined ? {} : { extensions }) }))),
    );
    expect(served.resource).toBe(expected);
  });

  const invalidTemplates: Array<[string, unknown]> = [
    ["the root path alone", "/"],
    ["a template without a leading slash", "items"],
    ["a template with a space", "/a b"],
    ["a template with a query", "/a?b"],
    ["a template with a fragment", "/a#b"],
    ["a template with a backslash", "/a\\b"],
    ["a template with a non-ASCII character", "/é"],
    ["a template with dot dot", "/a/../b"],
    ["a template with an encoded dot dot", "/a%2e%2e/b"],
    ["a template with a double-encoded dot dot", "/a%252e%252e/b"],
    ["a template with a scheme separator", "/x://y"],
    ["a template with an encoded scheme separator", "/%3A%2F%2F"],
    ["a template with a dangling percent after decoding", "/a%25"],
    ["a template with a bad escape", "/a%zz"],
    ["a template that needs 5 decode passes", "/t%2525252541"],
    ["an empty template", ""],
    ["a template that is not a string", 5],
    ["a null template", null],
  ];

  test.each(invalidTemplates)("falls back to the path for %s", (_name, routeTemplate) => {
    const extensions = { bazaar: { ...bazaar("GET"), routeTemplate } };
    const served = one(make().declare(P1, body(decl({ resource: "http://h/items/42", extensions }))));
    expect(served.resource).toBe("http://h/items/42");
  });

  test("two URLs under one route template are one item", () => {
    const c = make();
    const ext = { bazaar: bazaar("GET", "/items/:id") };
    c.declare(P1, body(decl({ resource: "http://h/items/1", extensions: ext })));
    c.declare(P1, body(decl({ resource: "http://h/items/2", description: "latest", extensions: ext })));
    expect(everything(c)).toMatchObject([{ resource: "http://h/items/:id", description: "latest" }]);
  });

  test("the method is part of the key, and each of the six is accepted", () => {
    const c = make();
    const methods = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"];
    c.declare(P1, body(...methods.map((m) => decl({ extensions: { bazaar: bazaar(m) } }))));
    expect(everything(c)).toHaveLength(6);
  });

  test("a method that is absent is GET", () => {
    const c = make();
    c.declare(
      P1,
      body(decl({ extensions: { bazaar: bazaar(undefined) } }), decl({ extensions: { z402: {} } }), decl()),
    );
    c.declare(P1, body(decl({ extensions: { bazaar: bazaar("GET") } })));
    expect(everything(c)).toHaveLength(1);
  });

  test("an unreadable bazaar extension still declares, as a GET on the path", () => {
    const c = make();
    c.declare(P1, body(decl({ extensions: { bazaar: "not an object" } })));
    expect(resources(c)).toStrictEqual(["http://127.0.0.1:4021/chunk"]);
  });

  test("two providers listing the same URL get two items, each with its own payTo", () => {
    const c = make();
    c.declare(P1, body(decl()));
    c.declare(P2, body(decl({}, P2)));
    expect(everything(c).map((i) => i.accepts[0]?.payTo)).toStrictEqual([PAY_TO, OTHER_PAY_TO]);
  });
});

describe("declare: upsert and liveness", () => {
  test("re-declaring replaces every served field, refreshes lastSeen and keeps the first listing time", () => {
    const c = make();
    c.declare(
      P1,
      body(decl({ description: "old", serviceName: "old", tags: ["old"], extensions: { bazaar: bazaar("GET") } })),
    );
    advance(30_000);
    const served = one(c.declare(P1, body(decl({ accepts: [accept({ amount: "700" })], description: "new" }))));
    expect(served).toStrictEqual({
      resource: "http://127.0.0.1:4021/chunk",
      type: "http",
      x402Version: 2,
      accepts: [{ ...ACCEPT_500, amount: "700" }],
      lastUpdated: ISO0,
      description: "new",
      lastSeen: "2026-10-28T12:00:30.000Z",
      paidCallsToday: 0,
    });
    expect(everything(c)).toStrictEqual([served]);
  });

  test("re-declaring keeps the paid calls and the last payment time", () => {
    const c = make();
    c.declare(P1, body(decl()));
    advance(MINUTE);
    c.recordPaid(P1, pay(), accept());
    advance(MINUTE);
    const served = one(c.declare(P1, body(decl({ description: "changed" }))));
    expect(served).toMatchObject({ paidCallsToday: 1, lastUpdated: "2026-10-28T12:01:00.000Z" });
    expect(served.lastSeen).toBe("2026-10-28T12:02:00.000Z");
  });

  test("declaring one service never removes another service's items", () => {
    const c = make();
    c.declare(P1, body(decl({ resource: "http://svc-a:4030/x" })));
    c.declare(P1, body(decl({ resource: "http://svc-b:4031/y" })));
    c.declare(P1, body(decl({ resource: "http://svc-b:4031/y" })));
    expect(resources(c)).toStrictEqual(["http://svc-a:4030/x", "http://svc-b:4031/y"]);
  });

  test("every item of one call gets the same lastSeen", () => {
    const served = make().declare(P1, body(decl({ resource: "http://h/1" }), decl({ resource: "http://h/2" })));
    expect(served.map((s) => s.lastSeen)).toStrictEqual([ISO0, ISO0]);
  });
});

describe("declare: caps", () => {
  const spread = (n: number, from = 0) =>
    Array.from({ length: n }, (_, i) => decl({ resource: `http://h/${from + i}` }));

  test("a new item past the per-provider cap refuses the call with that item's index", () => {
    const c = make({ maxPerProvider: 3 });
    c.declare(P1, body(...spread(2)));
    const err = refusal(() => c.declare(P1, body(...spread(3, 2))));
    expect(err.index).toBe(1);
    expect(err.message).toMatch(/^items\[1\]: /);
  });

  test("a refused call applies none of its items", () => {
    const c = make({ maxPerProvider: 3 });
    c.declare(P1, body(...spread(2)));
    refusal(() => c.declare(P1, body(...spread(3, 2))));
    expect(resources(c)).toStrictEqual(["http://h/0", "http://h/1"]);
  });

  test("an item that already exists is not new, so a full provider can still heartbeat", () => {
    const c = make({ maxPerProvider: 2 });
    c.declare(P1, body(...spread(2)));
    expect(() => c.declare(P1, body(...spread(2)))).not.toThrow();
  });

  test("a call repeating one new key counts it once", () => {
    const c = make({ maxPerProvider: 1 });
    expect(() => c.declare(P1, body(decl(), decl({ description: "again" })))).not.toThrow();
  });

  test("the cap is per provider", () => {
    const c = make({ maxPerProvider: 1 });
    c.declare(P1, body(decl()));
    expect(() => c.declare(P2, body(decl({}, P2)))).not.toThrow();
  });

  test("a new item past the total cap is refused, whichever provider it is for", () => {
    const c = make({ maxTotal: 2 });
    c.declare(P1, body(decl({ resource: "http://h/1" })));
    c.declare(P2, body(decl({ resource: "http://h/2" }, P2)));
    const err = refusal(() => c.declare(P2, body(decl({ resource: "http://h/3" }, P2))));
    expect(err.index).toBe(0);
    expect(() => c.declare(P2, body(decl({ resource: "http://h/2" }, P2)))).not.toThrow();
  });

  test("a logger that throws turns a refusal at a cap into nothing but the refusal", () => {
    const c = make({
      maxPerProvider: 1,
      log: () => {
        throw new Error("the logger broke");
      },
    });
    c.declare(P1, body(decl({ resource: "http://h/first" })));
    const err = refusal(() => c.declare(P1, body(decl({ resource: "http://h/second" }))));
    expect(err.index).toBe(0);
  });

  test("a refusal at a cap is logged once however often it repeats, and never names a URL", () => {
    const c = make({ maxPerProvider: 1 });
    c.declare(P1, body(decl({ resource: "http://h/first" })));
    for (let i = 0; i < 3; i++) refusal(() => c.declare(P1, body(decl({ resource: "http://h/second" }))));
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]?.[0])).not.toContain("second");
  });

  test("the default caps are 128 items per provider and 4096 in all", () => {
    const c = make();
    const fill = (p: CatalogProvider, items: number) => {
      for (let from = 0; from < items; from += 32) c.declare(p, body(...spread(Math.min(32, items - from), from)));
    };
    fill(P1, 128);
    expect(refusal(() => c.declare(P1, body(decl({ resource: "http://h/one-more" }))))).toBeInstanceOf(CatalogError);
    for (let n = 2; n <= 32; n++) fill({ ...P1, id: String(n).padStart(16, "0") }, 128);
    expect(c.list(ALL).pagination.total).toBe(4096);
    expect(
      refusal(() => c.declare({ ...P1, id: "ffffffffffffffff" }, body(decl({ resource: "http://h/last" })))),
    ).toBeInstanceOf(CatalogError);
    expect(() => c.declare(P1, body(...spread(1)))).not.toThrow();
  });
});

describe("recordPaid: a settled payment", () => {
  test("bumps the matching declared item, ignoring the query string of the paid URL", () => {
    const c = make();
    c.declare(P1, body(decl()));
    advance(5 * MINUTE);
    c.recordPaid(P1, pay(), accept());
    expect(one(everything(c))).toMatchObject({
      paidCallsToday: 1,
      lastUpdated: "2026-10-28T12:05:00.000Z",
      lastSeen: ISO0,
    });
  });

  test("counts each payment of the day", () => {
    const c = make();
    c.declare(P1, body(decl()));
    for (let i = 0; i < 3; i++) c.recordPaid(P1, pay(), accept());
    expect(one(everything(c)).paidCallsToday).toBe(3);
  });

  test("never changes a declared item except lastUpdated and the count", () => {
    const c = make();
    const declared = one(
      c.declare(
        P1,
        body(
          decl({
            description: "real",
            mimeType: "text/plain",
            serviceName: "real",
            tags: ["real"],
            iconUrl: "https://cdn.example.com/real.png",
            extensions: { bazaar: bazaar("GET"), z402: { note: "real" } },
          }),
        ),
      ),
    );
    advance(MINUTE);
    const echoed = {
      resource: {
        url: "http://127.0.0.1:4021/chunk",
        description: "FAKE",
        mimeType: "text/html",
        serviceName: "fake",
        tags: ["fake"],
        iconUrl: "https://evil.example/x.png",
      },
      extensions: { bazaar: bazaar("GET"), z402: { note: "FAKE" } },
    };
    c.recordPaid(P1, pay(echoed), accept({ amount: "99999" }));
    expect(one(everything(c))).toStrictEqual({
      ...declared,
      lastUpdated: "2026-10-28T12:01:00.000Z",
      paidCallsToday: 1,
    });
  });

  test("matches the item of a route template, and only when the payment names the template", () => {
    const c = make();
    c.declare(P1, body(decl({ resource: "http://h/items/1", extensions: { bazaar: bazaar("GET", "/items/:id") } })));
    const url = { url: "http://h/items/77?x=1" };
    c.recordPaid(P1, pay({ resource: url }), accept());
    expect(one(everything(c)).paidCallsToday).toBe(0);
    c.recordPaid(P1, pay({ resource: url, extensions: { bazaar: bazaar("GET", "/items/:id") } }), accept());
    expect(one(everything(c)).paidCallsToday).toBe(1);
  });

  test("matches by the method of the payment's bazaar extension", () => {
    const c = make();
    c.declare(P1, body(decl(), decl({ extensions: { bazaar: bazaar("POST") } })));
    c.recordPaid(P1, pay({ extensions: { bazaar: bazaar("POST") } }), accept());
    expect(everything(c).map((i) => i.paidCallsToday)).toStrictEqual([0, 1]);
  });

  test("reads a method outside the six as GET", () => {
    const c = make();
    c.declare(P1, body(decl()));
    c.recordPaid(P1, pay({ extensions: { bazaar: bazaar("TRACE") } }), accept());
    c.recordPaid(P1, pay({ extensions: { bazaar: bazaar("get") } }), accept());
    expect(one(everything(c)).paidCallsToday).toBe(2);
  });

  test("matches without any bazaar extension, as a GET on the path", () => {
    const c = make();
    c.declare(P1, body(decl()));
    c.recordPaid(P1, pay({ extensions: undefined }), accept());
    expect(one(everything(c)).paidCallsToday).toBe(1);
  });

  test("never touches another provider's item for the same URL", () => {
    const c = make();
    c.declare(P1, body(decl()));
    c.declare(P2, body(decl({}, P2)));
    c.recordPaid(P2, pay(), accept({}, P2));
    expect(everything(c).map((i) => [i.accepts[0]?.payTo, i.paidCallsToday])).toStrictEqual([
      [PAY_TO, 0],
      [OTHER_PAY_TO, 1],
    ]);
  });

  test.each<[string, Record<string, unknown>]>([
    ["x402Version 1", { x402Version: 1 }],
    ["x402Version as a string", { x402Version: "2" }],
    ["no x402Version", { x402Version: undefined }],
    ["no resource", { resource: undefined }],
    ["a null resource", { resource: null }],
    ["a resource url that is not a string", { resource: { url: 5 } }],
    ["a resource url that is not a URL", { resource: { url: "not a url" } }],
    ["an ftp resource url", { resource: { url: "ftp://h/x" } }],
    ["a resource url with userinfo", { resource: { url: "http://u:p@127.0.0.1:4021/chunk" } }],
    ["a resource url over 2048 characters", { resource: { url: `http://127.0.0.1:4021/${"a".repeat(2040)}` } }],
  ])("is ignored for %s", (_name, over) => {
    const c = make();
    c.declare(P1, body(decl()));
    c.recordPaid(P1, pay(over), accept());
    expect(one(everything(c)).paidCallsToday).toBe(0);
    expect(log).not.toHaveBeenCalled();
  });
});

describe("recordPaid: a provider that never declared is listed from its payments", () => {
  test("creates the item from the requirements, the sanitized resource, the mimeType and the bazaar extension", () => {
    const c = make();
    const resource = { url: "http://127.0.0.1:4021/chunk?session=s1", mimeType: "text/plain" };
    c.recordPaid(P1, pay({ resource, extensions: { bazaar: bazaar("GET"), other: { x: 1 } } }), accept());
    expect(one(everything(c))).toStrictEqual({
      resource: "http://127.0.0.1:4021/chunk",
      type: "http",
      x402Version: 2,
      accepts: [ACCEPT_500],
      lastUpdated: ISO0,
      mimeType: "text/plain",
      extensions: { bazaar: bazaar("GET") },
      paidCallsToday: 1,
    });
  });

  test("takes the accepts entry from the server's requirements, not from what the client says it accepted", () => {
    const c = make();
    c.recordPaid(P1, pay({ accepted: accept({ amount: "1" }) }), accept({ amount: "800" }));
    expect(one(everything(c)).accepts).toStrictEqual([{ ...ACCEPT_500, amount: "800" }]);
  });

  test("keys the item by the route template and the method the payment names", () => {
    const c = make();
    const ext = { bazaar: bazaar("POST", "/items/:id") };
    c.recordPaid(P1, pay({ resource: { url: "http://h/items/9?q=1" }, extensions: ext }), accept());
    c.recordPaid(P1, pay({ resource: { url: "http://h/items/10" }, extensions: ext }), accept());
    expect(one(everything(c))).toMatchObject({ resource: "http://h/items/:id", paidCallsToday: 2 });
  });

  test("a further payment counts the item and changes nothing else, whatever it echoes", () => {
    const c = make();
    c.recordPaid(P1, pay({ resource: { url: "http://127.0.0.1:4021/chunk", mimeType: "text/plain" } }), accept());
    const created = one(everything(c));
    advance(MINUTE);
    c.recordPaid(
      P1,
      pay({ resource: { url: "http://127.0.0.1:4021/chunk", mimeType: "text/html", description: "second" } }),
      accept(),
    );
    expect(one(everything(c))).toStrictEqual({
      ...created,
      lastUpdated: "2026-10-28T12:01:00.000Z",
      paidCallsToday: 2,
    });
  });

  test("lists no lastSeen, since nothing declared it", () => {
    const c = make();
    c.recordPaid(P1, pay(), accept());
    expect("lastSeen" in one(everything(c))).toBe(false);
  });

  test.each<[string, unknown]>([
    ["no extensions", undefined],
    ["extensions without bazaar", {}],
    ["a null bazaar", { bazaar: null }],
    ["a bazaar array", { bazaar: [] }],
    ["a bazaar string", { bazaar: "x" }],
    ["a bazaar number", { bazaar: 5 }],
    ["extensions that are an array", [{ bazaar: {} }]],
  ])("creates nothing for %s", (_name, extensions) => {
    const c = make();
    c.recordPaid(P1, pay({ extensions }), accept());
    expect(everything(c)).toStrictEqual([]);
  });

  test.each<[string, unknown]>([
    ["another provider's payTo", accept({ payTo: OTHER_PAY_TO })],
    ["another network", accept({ network: "zcash:testnet" })],
    ["another scheme", accept({ scheme: "exact" })],
    ["another asset", accept({ asset: "USDC" })],
    ["an amount of 0", accept({ amount: "0" })],
    ["an amount above windowZat", accept({ amount: "100001" })],
    ["an amount that is not canonical", accept({ amount: "05" })],
    ["other terms", accept({ extra: { ...ACCEPT_500.extra, windowZat: "5" } })],
    ["another termsVersion", accept({ extra: { ...ACCEPT_500.extra, termsVersion: "fedcba9876543210" } })],
    ["no extra", accept({ extra: undefined })],
    ["no maxTimeoutSeconds", accept({ maxTimeoutSeconds: undefined })],
    ["requirements that are null", null],
    ["requirements that are a string", "x"],
    ["requirements that are undefined", undefined],
  ])("creates nothing when the requirements carry %s", (_name, requirements) => {
    const c = make();
    c.recordPaid(P1, pay(), requirements);
    expect(everything(c)).toStrictEqual([]);
  });

  test.each<[string, Record<string, unknown>]>([
    ["a mimeType over 128 characters", { mimeType: "m".repeat(129) }],
    ["a null mimeType", { mimeType: null }],
    ["a numeric mimeType", { mimeType: 5 }],
  ])("drops %s and still lists the item", (_name, bad) => {
    const c = make();
    c.recordPaid(P1, pay({ resource: { url: "http://127.0.0.1:4021/chunk", ...bad } }), accept());
    expect(one(everything(c))).toStrictEqual({
      resource: "http://127.0.0.1:4021/chunk",
      type: "http",
      x402Version: 2,
      accepts: [ACCEPT_500],
      lastUpdated: ISO0,
      extensions: { bazaar: bazaar("GET") },
      paidCallsToday: 1,
    });
  });

  test("keeps a mimeType of exactly 128 characters", () => {
    const c = make();
    const mimeType = "m".repeat(128);
    c.recordPaid(P1, pay({ resource: { url: "http://127.0.0.1:4021/chunk", mimeType } }), accept());
    expect(one(everything(c)).mimeType).toBe(mimeType);
  });

  test("creates nothing when the bazaar extension is over 8192 bytes", () => {
    const c = make();
    c.recordPaid(P1, pay({ extensions: { bazaar: { ...bazaar("GET"), pad: "x".repeat(8200) } } }), accept());
    expect(everything(c)).toStrictEqual([]);
  });

  test("skips a new item past the per-provider cap and logs that once", () => {
    const c = make({ maxPerProvider: 1 });
    c.recordPaid(P1, pay({ resource: { url: "http://h/a" } }), accept());
    for (let i = 0; i < 3; i++) c.recordPaid(P1, pay({ resource: { url: "http://h/b" } }), accept());
    expect(resources(c)).toStrictEqual(["http://h/a"]);
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]?.[0])).not.toContain("h/b");
  });

  test("skips a new item past the total cap and logs that once", () => {
    const c = make({ maxTotal: 1 });
    c.recordPaid(P1, pay({ resource: { url: "http://h/a" } }), accept());
    c.recordPaid(P2, pay({ resource: { url: "http://h/b" } }), accept({}, P2));
    c.recordPaid(P2, pay({ resource: { url: "http://h/c" } }), accept({}, P2));
    expect(resources(c)).toStrictEqual(["http://h/a"]);
    expect(log).toHaveBeenCalledTimes(1);
  });

  test("an item it created is replaced by a later declaration, which then lists it as declared", () => {
    const c = make();
    c.recordPaid(P1, pay(), accept());
    advance(MINUTE);
    c.declare(P1, body(decl({ description: "now declared" })));
    expect(one(everything(c))).toStrictEqual({
      resource: "http://127.0.0.1:4021/chunk",
      type: "http",
      x402Version: 2,
      accepts: [ACCEPT_500],
      lastUpdated: ISO0,
      description: "now declared",
      lastSeen: "2026-10-28T12:01:00.000Z",
      paidCallsToday: 1,
    });
  });
});

describe("recordPaid: an item created from a payment keeps only what the server verified", () => {
  const hostile = {
    description: "<script>alert(document.cookie)</script> Official support desk, send funds here",
    serviceName: "PayPal Support",
    tags: ["paypal", "support"],
    iconUrl: "https://tracker.attacker.example/pixel.gif?uid=visitor",
  };
  const echoed = { url: "http://127.0.0.1:4021/chunk", mimeType: "text/plain", ...hostile };
  const FIELDS = Object.keys(hostile);

  test("takes no description, serviceName, tags or iconUrl from the payer, however valid they are", () => {
    const c = make();
    c.recordPaid(P1, pay({ resource: echoed }), accept());
    const item = one(everything(c));
    for (const field of FIELDS) expect(item).not.toHaveProperty(field);
    expect(item).toStrictEqual({
      resource: "http://127.0.0.1:4021/chunk",
      type: "http",
      x402Version: 2,
      accepts: [ACCEPT_500],
      lastUpdated: ISO0,
      mimeType: "text/plain",
      extensions: { bazaar: bazaar("GET") },
      paidCallsToday: 1,
    });
  });

  test("writes none of them to the file, and a search by their text finds nothing", async () => {
    const c = make({ file: file() });
    c.recordPaid(P1, pay({ resource: echoed }), accept());
    await c.flush();
    const text = readFileSync(file(), "utf8");
    for (const word of ["PayPal", "support", "tracker.attacker", "Official"]) expect(text).not.toContain(word);
    expect(c.search(parseSearchQuery({ query: "paypal" })).resources).toStrictEqual([]);
    expect(c.search(parseSearchQuery({ query: "official" })).resources).toStrictEqual([]);
  });

  test("takes no extension but bazaar, and that one only while { bazaar } is at most 8192 bytes", () => {
    const c = make();
    const extensions = { bazaar: bazaar("GET"), z402: { note: "FAKE" }, "x402-other": { x: 1 } };
    c.recordPaid(P1, pay({ extensions }), accept());
    expect(one(everything(c)).extensions).toStrictEqual({ bazaar: bazaar("GET") });
    // The wrapper around bazaar takes 11 of the 8192 bytes
    c.recordPaid(P1, pay({ resource: { url: "http://h/big" }, extensions: { bazaar: sized(8181) } }), accept());
    c.recordPaid(P1, pay({ resource: { url: "http://h/huge" }, extensions: { bazaar: sized(8182) } }), accept());
    expect(resources(c)).toStrictEqual(["http://127.0.0.1:4021/chunk", "http://h/big"]);
  });

  test("a provider that declared keeps every field it declared, beside one that is listed from payments", () => {
    const c = make();
    const optional = {
      description: "A chunk of text",
      mimeType: "text/plain",
      serviceName: "chunk",
      tags: ["demo", "text"],
      iconUrl: "https://cdn.example.com/chunk.png",
      extensions: { bazaar: bazaar("GET"), z402: { note: "kept" } },
    };
    c.declare(P1, body(decl(optional)));
    c.recordPaid(P2, pay({ resource: echoed }), accept({}, P2));
    const items = everything(c);
    const declared = items.find((i) => i.accepts[0]?.payTo === PAY_TO);
    const listed = items.find((i) => i.accepts[0]?.payTo === OTHER_PAY_TO);
    expect(declared).toMatchObject(optional);
    for (const field of FIELDS) expect(listed).not.toHaveProperty(field);
  });

  describe("at most 8 items per provider", () => {
    const urls = (n: number, from = 0) => Array.from({ length: n }, (_, i) => `http://h/${from + i}`);
    const paidFor = (c: Catalog, p: CatalogProvider, list: string[]) => {
      for (const url of list) c.recordPaid(p, pay({ resource: { url } }), accept({}, p));
    };

    test("the 9th distinct resource from payments creates nothing", () => {
      const c = make();
      paidFor(c, P1, urls(9));
      expect(resources(c)).toStrictEqual(urls(8));
    });

    test("a payment for a resource that is listed still counts when the provider is at the cap", () => {
      const c = make();
      paidFor(c, P1, urls(9));
      paidFor(c, P1, ["http://h/3", "http://h/3"]);
      expect(everything(c).map((i) => [i.resource, i.paidCallsToday])).toContainEqual(["http://h/3", 3]);
      expect(resources(c)).toStrictEqual(urls(8));
    });

    test("the cap is per provider", () => {
      const c = make();
      paidFor(c, P1, urls(9));
      paidFor(c, P2, urls(9));
      expect(everything(c)).toHaveLength(16);
      expect(c.list(parseListQuery({ payTo: PAY_TO, limit: "100" })).pagination.total).toBe(8);
      expect(c.list(parseListQuery({ payTo: OTHER_PAY_TO, limit: "100" })).pagination.total).toBe(8);
    });

    test("is logged once per provider, however often it is hit, and never names a URL", () => {
      const c = make();
      paidFor(c, P1, urls(12));
      paidFor(c, P1, urls(12, 20));
      expect(log).toHaveBeenCalledTimes(1);
      paidFor(c, P2, urls(12));
      expect(log).toHaveBeenCalledTimes(2);
      const lines = log.mock.calls.map((call) => String(call[0]));
      expect(lines[0]).toContain(P1.id);
      expect(lines[1]).toContain(P2.id);
      expect(lines.join("\n")).not.toContain("h/");
    });

    test("is not logged for a payment that could not list an item anyway", () => {
      const c = make();
      paidFor(c, P1, urls(8));
      c.recordPaid(P1, pay({ resource: { url: "http://h/no-bazaar" }, extensions: undefined }), accept());
      c.recordPaid(P1, pay({ resource: { url: "http://h/no-terms" } }), accept({ amount: "0" }));
      expect(log).not.toHaveBeenCalled();
    });

    test("is set by maxPaymentItemsPerProvider", () => {
      const c = make({ maxPaymentItemsPerProvider: 2 });
      paidFor(c, P1, urls(3));
      expect(resources(c)).toStrictEqual(urls(2));
    });

    test("counts the items that payments created and no declared one", () => {
      const declaredItem = (resource: string) => ({
        providerId: P1.id,
        resource,
        method: "GET",
        accepts: [ACCEPT_500],
        source: "declared",
        firstListed: ISO0,
        lastSeen: ISO0,
        paidCount: 0,
      });
      const lost = { version: 1, declared: [], items: [declaredItem("http://h/d1"), declaredItem("http://h/d2")] };
      writeFileSync(file(), JSON.stringify(lost));
      const c = make({ file: file(), maxPaymentItemsPerProvider: 1 });
      paidFor(c, P1, ["http://h/p1", "http://h/p2"]);
      expect(resources(c)).toStrictEqual(["http://h/d1", "http://h/d2", "http://h/p1"]);
    });

    test("is no limit on what a provider declares, which the per-provider cap alone bounds", () => {
      const c = make();
      c.declare(P1, body(...urls(20).map((resource) => decl({ resource }))));
      expect(everything(c)).toHaveLength(20);
    });
  });
});

describe("recordPaid: a provider that declared is never listed from payments", () => {
  const injected = (url = "http://127.0.0.1:4021/injected") =>
    pay({ resource: { url, description: "buy my coin", serviceName: "scam" } });

  test("a payment for an undeclared resource creates nothing", () => {
    const c = make();
    c.declare(P1, body(decl()));
    c.recordPaid(P1, injected(), accept());
    expect(resources(c)).toStrictEqual(["http://127.0.0.1:4021/chunk"]);
  });

  test("a payment for a declared resource under another method creates nothing", () => {
    const c = make();
    c.declare(P1, body(decl()));
    c.recordPaid(P1, pay({ extensions: { bazaar: bazaar("DELETE") } }), accept());
    expect(everything(c)).toHaveLength(1);
  });

  describe("its first declaration removes the items its payments listed", () => {
    /** P1 listed from payments, as a provider that has never declared is */
    const listed = (urls: string[], o: CatalogOptions = {}): Catalog => {
      const c = make(o);
      for (const url of urls) c.recordPaid(P1, injected(url), accept());
      expect(resources(c)).toStrictEqual([...urls].sort());
      return c;
    };

    test("removes every payment-sourced item of the provider, in the call that marks it as declaring", () => {
      const c = listed(["http://h/one", "http://h/two"]);
      c.declare(P1, body(decl()));
      expect(resources(c)).toStrictEqual(["http://127.0.0.1:4021/chunk"]);
    });

    test("leaves the items that another provider's payments listed", () => {
      const c = listed(["http://h/before"]);
      c.recordPaid(P2, injected("http://h/other"), accept({}, P2));
      c.declare(P1, body(decl()));
      expect(resources(c)).toStrictEqual(["http://127.0.0.1:4021/chunk", "http://h/other"]);
    });

    test("keeps the item it declares itself, with its payment history, and removes the others", () => {
      const c = listed(["http://127.0.0.1:4021/chunk", "http://h/before"]);
      c.declare(P1, body(decl({ description: "now declared" })));
      expect(everything(c)).toMatchObject([
        { resource: "http://127.0.0.1:4021/chunk", description: "now declared", paidCallsToday: 1 },
      ]);
    });

    test("a payment for a removed item's URL then lists nothing and counts nothing", () => {
      const c = listed(["http://h/before"]);
      c.declare(P1, body(decl()));
      c.recordPaid(P1, injected("http://h/before"), accept());
      expect(everything(c)).toMatchObject([{ resource: "http://127.0.0.1:4021/chunk", paidCallsToday: 0 }]);
    });

    test("a payment for a declared item counts it, and lists nothing else", () => {
      const c = listed(["http://h/before"]);
      c.declare(P1, body(decl()));
      c.recordPaid(P1, pay(), accept());
      c.recordPaid(P1, injected("http://h/after"), accept());
      expect(everything(c)).toMatchObject([{ resource: "http://127.0.0.1:4021/chunk", paidCallsToday: 1 }]);
    });

    test("a first declaration that is refused removes nothing, and the provider stays open to payments", () => {
      const c = listed(["http://h/before"]);
      refusal(() => c.declare(P1, body(decl(), decl({ type: "x" }))));
      c.recordPaid(P1, injected("http://h/more"), accept());
      expect(resources(c)).toStrictEqual(["http://h/before", "http://h/more"]);
    });

    test("a first declaration refused at a cap removes nothing either", () => {
      const c = listed(["http://h/before"], { maxPerProvider: 2 });
      const items = ["x", "y", "z"].map((n) => decl({ resource: `http://h/${n}` }));
      expect(refusal(() => c.declare(P1, body(...items))).index).toBe(2);
      expect(resources(c)).toStrictEqual(["http://h/before"]);
    });

    test("the items it removes do not count against the per-provider cap", () => {
      const c = listed(["http://h/a", "http://h/b"], { maxPerProvider: 2 });
      c.declare(P1, body(decl({ resource: "http://h/x" }), decl({ resource: "http://h/y" })));
      expect(resources(c)).toStrictEqual(["http://h/x", "http://h/y"]);
    });

    test("nor against the total cap", () => {
      const c = listed(["http://h/a"], { maxTotal: 2 });
      c.recordPaid(P2, injected("http://h/b"), accept({}, P2));
      c.declare(P1, body(decl({ resource: "http://h/x" })));
      expect(resources(c)).toStrictEqual(["http://h/b", "http://h/x"]);
    });

    test("an item it declares itself is not freed as well, so it still counts against the cap", () => {
      const c = listed(["http://h/a", "http://h/b"], { maxPerProvider: 2 });
      const items = ["a", "x", "y"].map((n) => decl({ resource: `http://h/${n}` }));
      expect(refusal(() => c.declare(P1, body(...items))).index).toBe(2);
      expect(resources(c)).toStrictEqual(["http://h/a", "http://h/b"]);
    });

    test("never removes a declared item, even of a provider whose declaring flag was lost", () => {
      const declaredItem = {
        providerId: P1.id,
        resource: "http://h/old",
        method: "GET",
        accepts: [ACCEPT_500],
        source: "declared",
        firstListed: ISO0,
        lastSeen: ISO0,
        paidCount: 0,
      };
      writeFileSync(file(), JSON.stringify({ version: 1, declared: [], items: [declaredItem] }));
      const c = make({ file: file() });
      c.recordPaid(P1, injected("http://h/before"), accept());
      expect(resources(c)).toStrictEqual(["http://h/before", "http://h/old"]);
      c.declare(P1, body(decl()));
      expect(resources(c)).toStrictEqual(["http://127.0.0.1:4021/chunk", "http://h/old"]);
    });

    test("a provider whose declaring flag was lost is cleaned by its next declaration", async () => {
      const first = make({ file: file() });
      first.declare(P1, body(decl()));
      await first.close();
      writeFileSync(file(), "garbage");
      const second = make({ file: file() });
      second.recordPaid(P1, injected("http://evil.example/steal"), accept());
      expect(resources(second)).toStrictEqual(["http://evil.example/steal"]);
      second.declare(P1, body(decl()));
      expect(resources(second)).toStrictEqual(["http://127.0.0.1:4021/chunk"]);
      second.recordPaid(P1, injected("http://evil.example/again"), accept());
      expect(resources(second)).toStrictEqual(["http://127.0.0.1:4021/chunk"]);
      const third = make({ file: file() });
      third.recordPaid(P1, injected("http://evil.example/again"), accept());
      expect(resources(third)).toStrictEqual(["http://127.0.0.1:4021/chunk"]);
    });
  });

  test("another provider's declaration does not stop this provider's payments from listing", () => {
    const c = make();
    c.declare(P2, body(decl({}, P2)));
    c.recordPaid(P1, injected(), accept());
    expect(everything(c)).toHaveLength(2);
  });

  test("the rule outlives a restart, even after every declared item has aged out", async () => {
    const first = make({ file: file() });
    first.declare(P1, body(decl()));
    await first.close();
    advance(8 * DAY);
    const second = make({ file: file() });
    expect(everything(second)).toStrictEqual([]);
    second.recordPaid(P1, injected(), accept());
    expect(everything(second)).toStrictEqual([]);
  });
});

describe("recordPaid: it never throws", () => {
  const hostile: Array<[string, unknown, unknown]> = [
    ["no arguments", undefined, undefined],
    ["null arguments", null, null],
    ["numbers", 5, 5],
    ["strings", "x", "x"],
    ["arrays", [], []],
    ["a payload without a version", {}, accept()],
    ["a payload with a null resource", { x402Version: 2, resource: null }, accept()],
  ];

  test.each(hostile)("for %s", (_name, payload, requirements) => {
    const c = make();
    expect(() => c.recordPaid(P1, payload, requirements)).not.toThrow();
    expect(everything(c)).toStrictEqual([]);
  });

  test("when reading the payload itself throws, and it logs the error", () => {
    const c = make();
    const boom = new Error("boom");
    const payload = {
      x402Version: 2,
      get resource(): never {
        throw boom;
      },
    };
    expect(() => c.recordPaid(P1, payload, accept())).not.toThrow();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[1]).toBe(boom);
  });

  test("when the payload is circular", () => {
    const c = make();
    const ext: Record<string, unknown> = { info: {} };
    ext.self = ext;
    expect(() => c.recordPaid(P1, pay({ extensions: { bazaar: ext } }), accept())).not.toThrow();
    expect(everything(c)).toStrictEqual([]);
  });

  test("even when the logger throws", () => {
    const c = make({
      log: () => {
        throw new Error("the logger broke");
      },
    });
    const payload = {
      x402Version: 2,
      get resource(): never {
        throw new Error("boom");
      },
    };
    expect(() => c.recordPaid(P1, payload, accept())).not.toThrow();
  });

  test("and logs to console.error when no log is injected", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const c = Catalog.load({ now });
    open.push(c);
    const payload = {
      get x402Version(): never {
        throw new Error("boom");
      },
    };
    c.recordPaid(P1, payload, accept());
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("served times", () => {
  test("lastUpdated is the first listing until a payment, then the latest payment", () => {
    const c = make();
    c.declare(P1, body(decl()));
    advance(MINUTE);
    c.declare(P1, body(decl()));
    expect(one(everything(c)).lastUpdated).toBe(ISO0);
    advance(MINUTE);
    c.recordPaid(P1, pay(), accept());
    expect(one(everything(c)).lastUpdated).toBe("2026-10-28T12:02:00.000Z");
    advance(MINUTE);
    c.declare(P1, body(decl()));
    expect(one(everything(c)).lastUpdated).toBe("2026-10-28T12:02:00.000Z");
  });

  test("paidCallsToday restarts at 00:00 UTC without any new payment", () => {
    const c = make();
    clock = new Date("2026-10-28T23:59:59.999Z");
    c.declare(P1, body(decl()));
    c.recordPaid(P1, pay(), accept());
    c.recordPaid(P1, pay(), accept());
    expect(one(everything(c)).paidCallsToday).toBe(2);
    advance(1);
    expect(one(everything(c)).paidCallsToday).toBe(0);
    expect(one(everything(c)).lastUpdated).toBe("2026-10-28T23:59:59.999Z");
  });

  test("the first payment of a new day counts from 1 again", () => {
    const c = make();
    clock = new Date("2026-10-28T23:59:59.999Z");
    c.declare(P1, body(decl()));
    c.recordPaid(P1, pay(), accept());
    c.recordPaid(P1, pay(), accept());
    advance(1);
    c.recordPaid(P1, pay(), accept());
    expect(one(everything(c)).paidCallsToday).toBe(1);
    advance(DAY);
    expect(one(everything(c)).paidCallsToday).toBe(0);
  });

  test("a payment 24 hours later, on the next UTC day, does not add to the earlier day's count", () => {
    const c = make();
    c.declare(P1, body(decl()));
    c.recordPaid(P1, pay(), accept());
    advance(DAY);
    c.recordPaid(P1, pay(), accept());
    expect(one(everything(c)).paidCallsToday).toBe(1);
  });
});

describe("list", () => {
  const spread = (n: number, p: CatalogProvider = P1) =>
    Array.from({ length: n }, (_, i) => decl({ resource: `http://h/${String(i).padStart(3, "0")}` }, p));

  test("answers the standard shape for an empty catalog", () => {
    expect(make().list(ALL)).toStrictEqual({
      x402Version: 2,
      items: [],
      pagination: { limit: 20, offset: 0, total: 0 },
    });
  });

  test("orders by resource, then method, then provider id, whatever the order of arrival", () => {
    const c = make();
    const at = (resource: string, method?: string) => decl({ resource, extensions: { bazaar: bazaar(method) } });
    c.declare(P1, body(at("http://b.example/x", "GET"), at("http://a.example/y", "POST")));
    c.declare(P2, body(decl({ resource: "http://a.example/y", extensions: { bazaar: bazaar("GET") } }, P2)));
    c.declare(P1, body(at("http://a.example/y", "GET"), at("http://a.example/y", "DELETE")));
    const method = (i: ServedResource) =>
      (i.extensions as { bazaar: { info: { input: { method: string } } } }).bazaar.info.input.method;
    expect(everything(c).map((i) => [i.resource, method(i), i.accepts[0]?.payTo])).toStrictEqual([
      ["http://a.example/y", "DELETE", PAY_TO],
      ["http://a.example/y", "GET", PAY_TO],
      ["http://a.example/y", "GET", OTHER_PAY_TO],
      ["http://a.example/y", "POST", PAY_TO],
      ["http://b.example/x", "GET", PAY_TO],
    ]);
  });

  test("keeps its order when the catalog grows after a listing, by declaration or by payment", () => {
    const c = make();
    c.declare(P1, body(decl({ resource: "http://h/c" })));
    expect(resources(c)).toStrictEqual(["http://h/c"]);
    c.declare(P1, body(decl({ resource: "http://h/b" })));
    expect(resources(c)).toStrictEqual(["http://h/b", "http://h/c"]);
    c.recordPaid(P2, pay({ resource: { url: "http://h/a" } }), accept({}, P2));
    expect(resources(c)).toStrictEqual(["http://h/a", "http://h/b", "http://h/c"]);
  });

  test("defaults to 20 items from offset 0 and reports the total", () => {
    const c = make();
    c.declare(P1, body(...spread(25)));
    const page = c.list(ALL);
    expect(page.items).toHaveLength(20);
    expect(page.pagination).toStrictEqual({ limit: 20, offset: 0, total: 25 });
    expect(page.items[0]?.resource).toBe("http://h/000");
  });

  test("pages with limit and offset, the last page being short", () => {
    const c = make();
    c.declare(P1, body(...spread(25)));
    const page = c.list(parseListQuery({ limit: "10", offset: "20" }));
    expect(page.items.map((i) => i.resource)).toStrictEqual([
      "http://h/020",
      "http://h/021",
      "http://h/022",
      "http://h/023",
      "http://h/024",
    ]);
    expect(page.pagination).toStrictEqual({ limit: 10, offset: 20, total: 25 });
  });

  test("an offset at or past the total is an empty page that still reports the total", () => {
    const c = make();
    c.declare(P1, body(...spread(3)));
    for (const offset of ["3", "4", "1000"]) {
      expect(c.list(parseListQuery({ offset }))).toStrictEqual({
        x402Version: 2,
        items: [],
        pagination: { limit: 20, offset: Number(offset), total: 3 },
      });
    }
  });

  test("clamps limit to 1..100 even when called without parseListQuery", () => {
    const c = make();
    for (let from = 0; from < 128; from += 32) {
      const items = Array.from({ length: 32 }, (_, i) => decl({ resource: `http://h/${from + i}` }));
      c.declare(P1, body(...items));
    }
    expect(c.list({ limit: 0, offset: 0 }).items).toHaveLength(1);
    expect(c.list({ limit: 1000, offset: 0 }).items).toHaveLength(100);
    expect(c.list({ limit: 1000, offset: 0 }).pagination.limit).toBe(100);
  });

  describe("filters", () => {
    const seeded = () => {
      const c = make();
      c.declare(
        P1,
        body(
          decl({ resource: "http://h/with", extensions: { bazaar: bazaar("GET"), z402: {} } }),
          decl({ resource: "http://h/without" }),
        ),
      );
      c.declare(P2, body(decl({ resource: "http://h/other" }, P2)));
      return c;
    };
    const filtered = (c: Catalog, q: Record<string, string>) => c.list(parseListQuery(q)).items.map((i) => i.resource);

    test("type matches http and nothing else", () => {
      const c = seeded();
      expect(filtered(c, { type: "http" })).toHaveLength(3);
      expect(filtered(c, { type: "mcp" })).toStrictEqual([]);
    });

    test("payTo matches an accepts entry's payTo exactly", () => {
      const c = seeded();
      expect(filtered(c, { payTo: OTHER_PAY_TO })).toStrictEqual(["http://h/other"]);
      expect(filtered(c, { payTo: PAY_TO })).toStrictEqual(["http://h/with", "http://h/without"]);
      expect(filtered(c, { payTo: PAY_TO.slice(0, 20) })).toStrictEqual([]);
    });

    test("scheme and network match an accepts entry", () => {
      const c = seeded();
      expect(filtered(c, { scheme: "prepaid-voucher" })).toHaveLength(3);
      expect(filtered(c, { scheme: "exact" })).toStrictEqual([]);
      expect(filtered(c, { network: "zcash:regtest" })).toHaveLength(3);
      expect(filtered(c, { network: "zcash:testnet" })).toStrictEqual([]);
    });

    test("extensions matches an item that carries that key", () => {
      const c = seeded();
      expect(filtered(c, { extensions: "z402" })).toStrictEqual(["http://h/with"]);
      expect(filtered(c, { extensions: "bazaar" })).toStrictEqual(["http://h/with"]);
      expect(filtered(c, { extensions: "absent" })).toStrictEqual([]);
    });

    test("extensions never matches a key that only the prototype chain has", () => {
      const c = seeded();
      for (const extensions of ["constructor", "toString", "hasOwnProperty", "__proto__", "valueOf"]) {
        expect(filtered(c, { extensions })).toStrictEqual([]);
      }
    });

    test("filters combine, and the total counts only what they match", () => {
      const c = seeded();
      const page = c.list(parseListQuery({ payTo: PAY_TO, extensions: "z402", limit: "1" }));
      expect(page.items.map((i) => i.resource)).toStrictEqual(["http://h/with"]);
      expect(page.pagination).toStrictEqual({ limit: 1, offset: 0, total: 1 });
    });

    test("offset counts within the filtered items", () => {
      const c = seeded();
      expect(filtered(c, { payTo: PAY_TO, offset: "1" })).toStrictEqual(["http://h/without"]);
    });
  });
});

describe("search", () => {
  const seeded = () => {
    const c = make();
    c.declare(
      P1,
      body(
        decl({
          resource: "http://h.example/weather",
          description: "Forecast for the Week",
          serviceName: "Meteo",
          tags: ["Rain", "sun"],
          mimeType: "application/json",
          extensions: { z402: { note: "uniquewordinextensions" } },
        }),
        decl({ resource: "http://h.example/stocks", description: "Quotes" }),
      ),
    );
    c.declare(P2, body(decl({ resource: "http://other.example/weather-radar" }, P2)));
    return c;
  };
  const found = (c: Catalog, q: Record<string, string>) =>
    c.search(parseSearchQuery(q)).resources.map((r) => r.resource);

  test("answers the standard shape", () => {
    const answer = seeded().search(parseSearchQuery({ query: "stocks" }));
    expect(answer).toMatchObject({ x402Version: 2, partialResults: false, pagination: { limit: 20, cursor: null } });
    expect(answer.resources.map((r) => r.resource)).toStrictEqual(["http://h.example/stocks"]);
  });

  test.each([
    ["the resource", "WEATHER"],
    ["the description", "forecast for"],
    ["the serviceName", "meteo"],
    ["a tag", "RAIN"],
    ["a later tag", "Sun"],
  ])("matches a case-insensitive substring of %s", (_name, query) => {
    expect(found(seeded(), { query })).toContain("http://h.example/weather");
  });

  test.each([
    ["the mimeType", "application"],
    ["the extensions", "uniquewordinextensions"],
    ["the payTo", "uregtest1qqq"],
    ["the network", "regtest"],
  ])("does not search %s", (_name, query) => {
    expect(found(seeded(), { query })).toStrictEqual([]);
  });

  test("returns matches in the same order as list", () => {
    expect(found(seeded(), { query: "weather" })).toStrictEqual([
      "http://h.example/weather",
      "http://other.example/weather-radar",
    ]);
  });

  test("applies the list filters", () => {
    const c = seeded();
    expect(found(c, { query: "weather", payTo: OTHER_PAY_TO })).toStrictEqual(["http://other.example/weather-radar"]);
    expect(found(c, { query: "weather", extensions: "z402" })).toStrictEqual(["http://h.example/weather"]);
    expect(found(c, { query: "weather", type: "mcp" })).toStrictEqual([]);
  });

  test("pages with a cursor that is a decimal offset, and the last page's cursor is null", () => {
    const c = make();
    c.declare(P1, body(...Array.from({ length: 5 }, (_, i) => decl({ resource: `http://h/item${i}` }))));
    const seen: string[] = [];
    let cursor: string | undefined;
    const cursors: Array<string | null> = [];
    for (let guard = 0; guard < 10; guard++) {
      const page = c.search(
        parseSearchQuery({ query: "item", limit: "2", ...(cursor === undefined ? {} : { cursor }) }),
      );
      seen.push(...page.resources.map((r) => r.resource));
      cursors.push(page.pagination.cursor);
      if (page.pagination.cursor === null) break;
      cursor = page.pagination.cursor;
    }
    expect(seen).toStrictEqual(Array.from({ length: 5 }, (_, i) => `http://h/item${i}`));
    expect(cursors).toStrictEqual(["2", "4", null]);
  });

  test("a page that ends exactly at the last match has a null cursor", () => {
    const c = make();
    c.declare(P1, body(...Array.from({ length: 4 }, (_, i) => decl({ resource: `http://h/item${i}` }))));
    expect(c.search(parseSearchQuery({ query: "item", limit: "2", cursor: "2" })).pagination.cursor).toBeNull();
  });

  test("a cursor past the end is an empty page with a null cursor", () => {
    const c = seeded();
    const page = c.search(parseSearchQuery({ query: "weather", cursor: "50" }));
    expect(page.resources).toStrictEqual([]);
    expect(page.pagination.cursor).toBeNull();
  });

  test("reports the clamped limit, also when called without parseSearchQuery", () => {
    const c = seeded();
    expect(c.search(parseSearchQuery({ query: "weather", limit: "9999" })).pagination.limit).toBe(100);
    expect(c.search({ query: "weather", limit: 9999 }).pagination.limit).toBe(100);
    const none = c.search({ query: "weather", limit: 0 });
    expect(none.pagination.limit).toBe(1);
    expect(none.resources).toHaveLength(1);
  });

  test.each(["abc", "-1", "1.5", "", "01", " 1", "1e2", "0x10"])(
    "refuses the cursor %j when called directly",
    (cursor) => {
      expect(() => seeded().search({ query: "weather", limit: 20, cursor })).toThrow(CatalogQueryError);
    },
  );

  test("refuses a query that is empty or over 256 characters when called directly", () => {
    const c = seeded();
    expect(() => c.search({ query: "", limit: 20 })).toThrow(CatalogQueryError);
    expect(() => c.search({ query: "q".repeat(257), limit: 20 })).toThrow(CatalogQueryError);
  });
});

describe("parseListQuery", () => {
  test("defaults to a limit of 20 and an offset of 0, with no filters", () => {
    expect(parseListQuery({})).toStrictEqual({ limit: 20, offset: 0 });
  });

  test("reads every parameter", () => {
    expect(
      parseListQuery({
        type: "http",
        payTo: "u1",
        scheme: "prepaid-voucher",
        network: "zcash:regtest",
        extensions: "bazaar",
        limit: "5",
        offset: "10",
      }),
    ).toStrictEqual({
      type: "http",
      payTo: "u1",
      scheme: "prepaid-voucher",
      network: "zcash:regtest",
      extensions: "bazaar",
      limit: 5,
      offset: 10,
    });
  });

  test("ignores parameters it does not know", () => {
    expect(parseListQuery({ cursor: "x", query: "y", unknown: ["a", "b"] })).toStrictEqual({ limit: 20, offset: 0 });
  });

  test("reads the null-prototype object a query parser hands over", () => {
    const q = Object.assign(Object.create(null) as Record<string, unknown>, { limit: "5", type: "http" });
    expect(parseListQuery(q)).toStrictEqual({ type: "http", limit: 5, offset: 0 });
  });

  test.each([
    ["0", 1],
    ["1", 1],
    ["50", 50],
    ["100", 100],
    ["101", 100],
    ["99999999999999999999999999", 100],
    ["9".repeat(400), 100],
  ])("clamps limit %s to %i", (limit, expected) => {
    expect(parseListQuery({ limit }).limit).toBe(expected);
  });

  test.each(["-1", "1.5", "abc", "", " 5", "5 ", "1e2", "+5", "0x10", "٣", "01", "00"])(
    "refuses the limit %j",
    (limit) => {
      expect(() => parseListQuery({ limit })).toThrow(CatalogQueryError);
    },
  );

  test.each(["-1", "1.5", "abc", "", " 5", "1e2", "+5", "007", "1234567890123456"])(
    "refuses the offset %j",
    (offset) => {
      expect(() => parseListQuery({ offset })).toThrow(CatalogQueryError);
    },
  );

  test("takes an offset of 0 and of 15 digits", () => {
    expect(parseListQuery({ offset: "0" }).offset).toBe(0);
    expect(parseListQuery({ offset: "999999999999999" }).offset).toBe(999999999999999);
  });

  test.each(["type", "payTo", "scheme", "network", "extensions", "limit", "offset"])(
    "refuses an array for %s",
    (name) => {
      expect(() => parseListQuery({ [name]: ["1", "2"] })).toThrow(CatalogQueryError);
      expect(() => parseListQuery({ [name]: [] })).toThrow(CatalogQueryError);
    },
  );

  test("refuses a value that is not a string", () => {
    expect(() => parseListQuery({ limit: 5 })).toThrow(CatalogQueryError);
    expect(() => parseListQuery({ type: { a: "b" } })).toThrow(CatalogQueryError);
    expect(() => parseListQuery({ type: null })).toThrow(CatalogQueryError);
  });

  test("names the parameter and never echoes its value", () => {
    try {
      parseListQuery({ limit: "SECRETVALUE" });
      throw new Error("expected a CatalogQueryError");
    } catch (e) {
      expect(e).toBeInstanceOf(CatalogQueryError);
      expect((e as Error).message).toMatch(/^limit: /);
      expect((e as Error).message).not.toContain("SECRETVALUE");
    }
  });
});

describe("parseSearchQuery", () => {
  test("requires a query and defaults the limit to 20", () => {
    expect(parseSearchQuery({ query: "chunk" })).toStrictEqual({ query: "chunk", limit: 20 });
  });

  test("reads the filters, the limit and the cursor", () => {
    expect(parseSearchQuery({ query: "q", payTo: "u1", extensions: "bazaar", limit: "7", cursor: "14" })).toStrictEqual(
      {
        query: "q",
        payTo: "u1",
        extensions: "bazaar",
        limit: 7,
        cursor: "14",
      },
    );
  });

  test("ignores offset, which search does not take", () => {
    expect(parseSearchQuery({ query: "q", offset: "5" })).toStrictEqual({ query: "q", limit: 20 });
  });

  test("says that a missing query is required", () => {
    expect(() => parseSearchQuery({})).toThrow(/^query: is required/);
  });

  test("takes a query of 1 and of 256 characters", () => {
    expect(parseSearchQuery({ query: "q" }).query).toBe("q");
    expect(parseSearchQuery({ query: "q".repeat(256) }).query).toHaveLength(256);
  });

  test.each([
    ["a missing query", {}],
    ["an empty query", { query: "" }],
    ["a query of 257 characters", { query: "q".repeat(257) }],
    ["an array query", { query: ["a", "b"] }],
    ["a query that is not a string", { query: 5 }],
    ["an array cursor", { query: "q", cursor: ["1"] }],
    ["a cursor that is not a number", { query: "q", cursor: "abc" }],
    ["a negative cursor", { query: "q", cursor: "-1" }],
    ["a fractional cursor", { query: "q", cursor: "1.5" }],
    ["an empty cursor", { query: "q", cursor: "" }],
    ["a cursor with a leading zero", { query: "q", cursor: "01" }],
    ["a cursor of 16 digits", { query: "q", cursor: "1234567890123456" }],
    ["a limit that is not a number", { query: "q", limit: "ten" }],
    ["an array limit", { query: "q", limit: ["1", "2"] }],
    ["an array filter", { query: "q", payTo: ["a", "b"] }],
  ])("refuses %s", (_name, q) => {
    expect(() => parseSearchQuery(q)).toThrow(CatalogQueryError);
  });

  test("clamps the limit like the list does", () => {
    expect(parseSearchQuery({ query: "q", limit: "0" }).limit).toBe(1);
    expect(parseSearchQuery({ query: "q", limit: "500" }).limit).toBe(100);
  });
});

describe("persistence", () => {
  const readFile = () =>
    JSON.parse(readFileSync(file(), "utf8")) as { version: number; declared: string[]; items: unknown[] };

  test("a catalog round trips through its file, liveness, payments and all", async () => {
    const a = make({ file: file() });
    a.declare(
      P1,
      body(
        decl({ description: "d", extensions: { bazaar: bazaar("GET"), z402: { v: 1 } } }),
        decl({ resource: "http://127.0.0.1:4021/b" }),
      ),
    );
    a.recordPaid(P2, pay({ resource: { url: "http://h/paid", mimeType: "text/plain" } }), accept({}, P2));
    advance(MINUTE);
    a.recordPaid(P1, pay(), accept());
    const before = a.list(ALL);
    await a.close();
    expect(make({ file: file() }).list(ALL)).toStrictEqual(before);
  });

  test("writes the documented format, mode 0600, and leaves no temp file behind", async () => {
    const c = make({ file: file() });
    c.declare(P1, body(decl({ description: "A chunk" })));
    advance(30 * MINUTE);
    c.recordPaid(P1, pay(), accept());
    await c.flush();
    expect(readFile()).toStrictEqual({
      version: 1,
      declared: [P1.id],
      items: [
        {
          providerId: P1.id,
          resource: "http://127.0.0.1:4021/chunk",
          method: "GET",
          accepts: [ACCEPT_500],
          description: "A chunk",
          source: "declared",
          firstListed: ISO0,
          lastSeen: ISO0,
          lastPaid: "2026-10-28T12:30:00.000Z",
          paidDay: "2026-10-28",
          paidCount: 1,
        },
      ],
    });
    expect(statSync(file()).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toStrictEqual(["discovery.json"]);
  });

  test("a payment-sourced item is stored with its source and no lastSeen", async () => {
    const c = make({ file: file() });
    c.recordPaid(P1, pay(), accept());
    await c.flush();
    expect(readFile()).toMatchObject({
      declared: [],
      items: [{ source: "payment", firstListed: ISO0, lastPaid: ISO0, paidDay: "2026-10-28", paidCount: 1 }],
    });
    expect("lastSeen" in (readFile().items[0] as object)).toBe(false);
  });

  test("loads a file written by hand in the documented format", () => {
    writeFileSync(
      file(),
      JSON.stringify({
        version: 1,
        declared: [P1.id],
        items: [
          {
            providerId: P1.id,
            resource: "http://127.0.0.1:4021/chunk",
            method: "GET",
            accepts: [ACCEPT_500],
            description: "A chunk",
            source: "declared",
            firstListed: "2026-10-28T09:00:00.000Z",
            lastSeen: "2026-10-28T11:59:30.000Z",
            lastPaid: "2026-10-28T11:00:00.000Z",
            paidDay: "2026-10-28",
            paidCount: 3,
          },
        ],
      }),
    );
    expect(one(make({ file: file() }).list(ALL).items)).toStrictEqual({
      resource: "http://127.0.0.1:4021/chunk",
      type: "http",
      x402Version: 2,
      accepts: [ACCEPT_500],
      lastUpdated: "2026-10-28T11:00:00.000Z",
      description: "A chunk",
      lastSeen: "2026-10-28T11:59:30.000Z",
      paidCallsToday: 3,
    });
  });

  test("a missing file starts an empty catalog without a word", () => {
    const c = make({ file: file() });
    expect(c.list(ALL).pagination.total).toBe(0);
    expect(log).not.toHaveBeenCalled();
  });

  test("a file in a directory that does not exist yet is created, with its directories", async () => {
    const nested = join(dir, "providers.zcash:regtest", "discovery.json");
    const c = make({ file: nested });
    c.declare(P1, body(decl()));
    await c.flush();
    expect(existsSync(nested)).toBe(true);
  });

  test("a catalog without a file flushes and closes without a file to write", async () => {
    const c = make();
    c.declare(P1, body(decl()));
    await expect(c.flush()).resolves.toBeUndefined();
    await expect(c.close()).resolves.toBeUndefined();
    expect(c.list(ALL).pagination.total).toBe(1);
  });

  test("flush with nothing changed writes nothing", async () => {
    const c = make({ file: file() });
    await c.flush();
    expect(existsSync(file())).toBe(false);
  });

  test("a refused declaration writes nothing", async () => {
    const c = make({ file: file() });
    refusal(() => c.declare(P1, body(decl({ type: "x" }))));
    await c.flush();
    expect(existsSync(file())).toBe(false);
  });

  test("the declaring flag is on disk before declare returns, so a crash cannot reopen the provider", () => {
    make({ file: file() }).declare(P1, body(decl()));
    const restarted = make({ file: file() });
    restarted.recordPaid(P1, pay({ resource: { url: "http://evil.example/x" } }), accept());
    expect(resources(restarted)).toStrictEqual(["http://127.0.0.1:4021/chunk"]);
  });

  test("a first declaration is on disk with its removals before declare returns, so a crash loses none", async () => {
    const a = make({ file: file() });
    a.recordPaid(P1, pay({ resource: { url: "http://h/before" } }), accept());
    await a.flush();
    expect(resources(make({ file: file() }))).toStrictEqual(["http://h/before"]);
    a.declare(P1, body(decl()));
    const restarted = make({ file: file() });
    expect(resources(restarted)).toStrictEqual(["http://127.0.0.1:4021/chunk"]);
    restarted.recordPaid(P1, pay({ resource: { url: "http://evil.example/x" } }), accept());
    expect(resources(restarted)).toStrictEqual(["http://127.0.0.1:4021/chunk"]);
  });

  test("writes through a temp file and a rename, so the file a reader holds is never rewritten", async () => {
    const c = make({ file: file() });
    c.declare(P1, body(decl({ resource: "http://h/1" })));
    await c.flush();
    const held = join(dir, "held.json");
    linkSync(file(), held);
    c.declare(P1, body(decl({ resource: "http://h/2" })));
    await c.flush();
    expect((JSON.parse(readFileSync(held, "utf8")) as { items: unknown[] }).items).toHaveLength(1);
    expect(readFile().items).toHaveLength(2);
  });

  test("fsyncs the temp file before renaming it over the catalog file", () => {
    const c = make({ file: file() });
    vi.mocked(fsyncSync).mockClear();
    vi.mocked(renameSync).mockClear();
    c.declare(P1, body(decl()));
    const fsync = vi.mocked(fsyncSync).mock;
    const rename = vi.mocked(renameSync).mock;
    expect(fsync.calls).toHaveLength(1);
    expect(rename.calls).toHaveLength(1);
    expect(fsync.invocationCallOrder[0]).toBeLessThan(rename.invocationCallOrder[0]!);
  });

  describe("timing", () => {
    const fake = () => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    /** A catalog where P1 has declared, which is written at once, so that what a test changes next follows the delay */
    const declared = (o: CatalogOptions = {}): Catalog => {
      const c = make({ file: file(), ...o });
      c.declare(P1, body(decl({ resource: "http://h/first" })));
      return c;
    };

    test("a change is written within writeDelayMs, and not before", () => {
      fake();
      const c = declared({ writeDelayMs: 2000 });
      c.declare(P1, body(decl({ resource: "http://h/second" })));
      vi.advanceTimersByTime(1999);
      expect(readFile().items).toHaveLength(1);
      vi.advanceTimersByTime(1);
      expect(readFile().items).toHaveLength(2);
    });

    test("a provider's first declaration is written at once, before any delay", () => {
      fake();
      const c = make({ file: file(), writeDelayMs: 2000 });
      c.declare(P1, body(decl()));
      expect(readFile()).toMatchObject({ declared: [P1.id], items: [{ resource: "http://127.0.0.1:4021/chunk" }] });
    });

    test("changes inside the window share one write", () => {
      fake();
      const c = make({ file: file(), writeDelayMs: 2000 });
      c.declare(P1, body(decl({ resource: "http://h/1" })));
      vi.advanceTimersByTime(1500);
      c.declare(P1, body(decl({ resource: "http://h/2" })));
      vi.advanceTimersByTime(500);
      expect(readFile().items).toHaveLength(2);
    });

    test("a steady stream of changes is still written within writeDelayMs of the first", () => {
      fake();
      const c = make({ file: file(), writeDelayMs: 2000 });
      for (let n = 0; n < 4; n++) {
        c.declare(P1, body(decl({ resource: `http://h/${n}` })));
        vi.advanceTimersByTime(500);
      }
      expect(readFile().items).toHaveLength(4);
    });

    test("a change after a write schedules the next write", () => {
      fake();
      const c = make({ file: file(), writeDelayMs: 2000 });
      c.declare(P1, body(decl({ resource: "http://h/1" })));
      vi.advanceTimersByTime(2000);
      c.declare(P1, body(decl({ resource: "http://h/2" })));
      expect(readFile().items).toHaveLength(1);
      vi.advanceTimersByTime(2000);
      expect(readFile().items).toHaveLength(2);
    });

    test("a payment that only counts an existing item is a change too", async () => {
      const c = make({ file: file() });
      c.declare(P1, body(decl()));
      await c.flush();
      c.recordPaid(P1, pay(), accept());
      await c.flush();
      expect(readFile().items).toMatchObject([{ paidCount: 1 }]);
    });

    test("flush writes only when something changed since the last write", async () => {
      const c = make({ file: file() });
      c.declare(P1, body(decl()));
      await c.flush();
      rmSync(file());
      await c.flush();
      expect(existsSync(file())).toBe(false);
    });

    test("a payment is a change too", () => {
      fake();
      const c = make({ file: file(), writeDelayMs: 100 });
      c.recordPaid(P1, pay(), accept());
      vi.advanceTimersByTime(100);
      expect(readFile().items).toHaveLength(1);
    });

    test("the write delay defaults to 2000 ms", () => {
      fake();
      const c = declared();
      c.declare(P1, body(decl({ resource: "http://h/second" })));
      vi.advanceTimersByTime(1999);
      expect(readFile().items).toHaveLength(1);
      vi.advanceTimersByTime(1);
      expect(readFile().items).toHaveLength(2);
    });

    test("the timer is unref'd, so it never keeps the process alive", () => {
      fake();
      const spy = vi.spyOn(globalThis, "setTimeout");
      const c = make({ file: file() });
      c.declare(P1, body(decl()));
      const timer = spy.mock.results[0]?.value as { hasRef(): boolean };
      expect(spy).toHaveBeenCalledTimes(1);
      expect(timer.hasRef()).toBe(false);
    });

    test("a catalog without a file schedules no timer", () => {
      fake();
      const spy = vi.spyOn(globalThis, "setTimeout");
      make().declare(P1, body(decl()));
      expect(spy).not.toHaveBeenCalled();
    });

    test("flush writes at once, before the delay", async () => {
      fake();
      const c = declared({ writeDelayMs: 2000 });
      c.declare(P1, body(decl({ resource: "http://h/second" })));
      await c.flush();
      expect(readFile().items).toHaveLength(2);
    });

    test("close flushes the pending change at once", async () => {
      fake();
      const c = declared({ writeDelayMs: 2000 });
      c.declare(P1, body(decl({ resource: "http://h/second" })));
      await c.close();
      expect(readFile().items).toHaveLength(2);
    });

    test("close leaves no timer behind, so a change after it is never written", async () => {
      fake();
      const c = make({ file: file(), writeDelayMs: 2000 });
      c.declare(P1, body(decl({ resource: "http://h/before" })));
      await c.close();
      c.declare(P1, body(decl({ resource: "http://h/after" })));
      vi.advanceTimersByTime(10_000);
      expect(readFile().items).toHaveLength(1);
      expect(c.list(ALL).pagination.total).toBe(2);
    });

    test("a first declaration after close is not written either", async () => {
      const c = make({ file: file() });
      await c.close();
      c.declare(P1, body(decl()));
      expect(existsSync(file())).toBe(false);
      expect(c.list(ALL).pagination.total).toBe(1);
    });

    test("close can be called twice", async () => {
      const c = make({ file: file() });
      c.declare(P1, body(decl()));
      await c.close();
      await expect(c.close()).resolves.toBeUndefined();
    });
  });

  describe("a write that fails", () => {
    test("is logged, never thrown, and leaves no temp file", async () => {
      const c = make({ file: file() });
      mkdirSync(file());
      expect(() => c.declare(P1, body(decl()))).not.toThrow();
      expect(log).toHaveBeenCalledTimes(1);
      await expect(c.flush()).resolves.toBeUndefined();
      expect(log).toHaveBeenCalledTimes(2);
      expect(readdirSync(dir)).toStrictEqual(["discovery.json"]);
      expect(statSync(file()).isDirectory()).toBe(true);
      expect(c.list(ALL).pagination.total).toBe(1);
    });

    test("is written again by the timer after a first declaration whose write failed", () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const c = make({ file: file(), writeDelayMs: 2000 });
      mkdirSync(file());
      c.declare(P1, body(decl()));
      rmSync(file(), { recursive: true });
      vi.advanceTimersByTime(2000);
      expect(readFile().declared).toStrictEqual([P1.id]);
    });

    test("is tried again at the next flush", async () => {
      const c = make({ file: file() });
      mkdirSync(file());
      c.declare(P1, body(decl()));
      await c.flush();
      rmSync(file(), { recursive: true });
      await c.flush();
      expect(readFile().items).toHaveLength(1);
    });
  });

  describe("a file that cannot be used", () => {
    const stored = {
      providerId: P1.id,
      resource: "http://127.0.0.1:4021/chunk",
      method: "GET",
      accepts: [ACCEPT_500],
      source: "declared",
      firstListed: ISO0,
      lastSeen: ISO0,
      paidCount: 0,
    };
    const store = (over: Record<string, unknown> = {}, item: Record<string, unknown> = {}) =>
      JSON.stringify({ version: 1, declared: [P1.id], items: [{ ...stored, ...item }], ...over });

    const bad: Array<[string, string]> = [
      ["truncated JSON", store().slice(0, 40)],
      ["text that is not JSON", "garbage"],
      ["an empty file", ""],
      ["a JSON array", "[]"],
      ["a JSON null", "null"],
      ["another version", store({ version: 2 })],
      ["a missing version", store({ version: undefined })],
      ["items that are not an array", store({ items: {} })],
      ["declared that is not an array", store({ declared: "x" })],
      ["declared with a non-string", store({ declared: [5] })],
      ["an item that is not an object", store({ items: [5] })],
      ["an item with an unknown method", store({}, { method: "FOO" })],
      ["an item with an unknown source", store({}, { source: "magic" })],
      ["an item with a date that is not a date", store({}, { firstListed: "yesterday" })],
      ["an item with no firstListed", store({}, { firstListed: undefined })],
      ["an item with a lastSeen that is not a string", store({}, { lastSeen: 5 })],
      ["an item with a date that is not the format the catalog writes", store({}, { firstListed: "2026-10-28" })],
      ["an item with an accepts entry that lacks its fields", store({}, { accepts: [{ scheme: "prepaid-voucher" }] })],
      [
        "an item with a payTo that is not a string in an accepts entry",
        store({}, { accepts: [{ ...ACCEPT_500, payTo: 5 }] }),
      ],
      [
        "an item with an amount that is not a string in an accepts entry",
        store({}, { accepts: [{ ...ACCEPT_500, amount: 500 }] }),
      ],
      [
        "an item with a maxTimeoutSeconds of 0 in an accepts entry",
        store({}, { accepts: [{ ...ACCEPT_500, maxTimeoutSeconds: 0 }] }),
      ],
      ["an item with a negative paidCount", store({}, { paidCount: -1 })],
      ["an item with a fractional paidCount", store({}, { paidCount: 1.5 })],
      ["an item with a paidDay that is not a day", store({}, { paidDay: "today" })],
      ["an item with accepts that are not an array", store({}, { accepts: {} })],
      ["an item with no accepts", store({}, { accepts: [] })],
      ["an item whose accepts entry is not an object", store({}, { accepts: [5] })],
      ["an item with a resource that is not a string", store({}, { resource: 5 })],
      ["an item with a providerId that is not a string", store({}, { providerId: 5 })],
      ["an item with tags that are not an array", store({}, { tags: "x" })],
      ["an item with extensions that are an array", store({}, { extensions: [] })],
      ["the same key twice", JSON.stringify({ version: 1, declared: [], items: [stored, stored] })],
    ];

    test.each(bad)("%s is set aside and the catalog starts empty", (_name, content) => {
      writeFileSync(file(), content);
      const c = make({ file: file() });
      expect(c.list(ALL).pagination.total).toBe(0);
      const aside = `${file()}.bad-${clock.getTime()}`;
      expect(readdirSync(dir)).toStrictEqual([`discovery.json.bad-${clock.getTime()}`]);
      expect(readFileSync(aside, "utf8")).toBe(content);
      expect(log).toHaveBeenCalledTimes(1);
      expect(log.mock.calls[0]?.[1]).toBeInstanceOf(Error);
    });

    test("an unreadable file is set aside too", () => {
      mkdirSync(file());
      const c = make({ file: file() });
      expect(c.list(ALL).pagination.total).toBe(0);
      expect(readdirSync(dir)).toStrictEqual([`discovery.json.bad-${clock.getTime()}`]);
      expect(log).toHaveBeenCalledTimes(1);
    });

    test.skipIf(process.getuid?.() === 0)("a file that cannot be moved aside still starts an empty catalog", () => {
      writeFileSync(file(), "garbage");
      chmodSync(dir, 0o500);
      try {
        const c = make({ file: file() });
        expect(c.list(ALL).pagination.total).toBe(0);
        expect(log).toHaveBeenCalledTimes(1);
        expect(String(log.mock.calls[0]?.[0])).toContain("could not be set aside");
      } finally {
        chmodSync(dir, 0o700);
      }
    });

    test("the catalog then works and writes a fresh file next to the one set aside", async () => {
      writeFileSync(file(), "garbage");
      const c = make({ file: file() });
      c.declare(P1, body(decl()));
      await c.flush();
      expect(readFile().items).toHaveLength(1);
      expect(readdirSync(dir).sort()).toStrictEqual(["discovery.json", `discovery.json.bad-${clock.getTime()}`]);
    });

    test("what it logs says which file and never includes the file's content", () => {
      writeFileSync(file(), "SECRETCONTENT");
      make({ file: file() });
      expect(String(log.mock.calls[0]?.[0])).toContain(file());
      expect(String(log.mock.calls[0]?.[0])).not.toContain("SECRETCONTENT");
    });
  });

  describe("the 7-day drop at load", () => {
    const seed = async (fill: (c: Catalog) => void): Promise<void> => {
      const c = make({ file: file() });
      fill(c);
      await c.close();
    };

    test("drops an item last seen more than 7 days ago, and keeps one seen exactly 7 days ago", async () => {
      await seed((c) => c.declare(P1, body(decl())));
      advance(7 * DAY);
      expect(resources(make({ file: file() }))).toStrictEqual(["http://127.0.0.1:4021/chunk"]);
      advance(1);
      expect(resources(make({ file: file() }))).toStrictEqual([]);
    });

    test("judges an item by the newest of lastSeen, lastPaid and firstListed", async () => {
      await seed((c) => {
        c.declare(
          P1,
          body(
            decl({ resource: "http://h/seen" }),
            decl({ resource: "http://h/paid" }),
            decl({ resource: "http://h/idle" }),
          ),
        );
        advance(5 * DAY);
        c.declare(P1, body(decl({ resource: "http://h/seen" })));
        c.recordPaid(P1, pay({ resource: { url: "http://h/paid" } }), accept());
      });
      advance(5 * DAY);
      expect(resources(make({ file: file() }))).toStrictEqual(["http://h/paid", "http://h/seen"]);
      advance(2 * DAY + 1);
      expect(resources(make({ file: file() }))).toStrictEqual([]);
    });

    test("judges a payment-sourced item by its last payment, since it has no lastSeen", async () => {
      await seed((c) => {
        c.recordPaid(P1, pay(), accept());
        advance(6 * DAY);
        c.recordPaid(P1, pay(), accept());
      });
      advance(6 * DAY);
      expect(resources(make({ file: file() }))).toStrictEqual(["http://127.0.0.1:4021/chunk"]);
    });

    test("judges an item that carries only a first listing by that time", () => {
      const item = (firstListed: string) => ({
        providerId: P1.id,
        resource: "http://127.0.0.1:4021/chunk",
        method: "GET",
        accepts: [ACCEPT_500],
        source: "payment",
        firstListed,
        paidCount: 0,
      });
      const write = (firstListed: string) =>
        writeFileSync(file(), JSON.stringify({ version: 1, declared: [], items: [item(firstListed)] }));
      write(new Date(clock.getTime() - 7 * DAY).toISOString());
      expect(everything(make({ file: file() }))).toHaveLength(1);
      write(new Date(clock.getTime() - 7 * DAY - 1).toISOString());
      expect(everything(make({ file: file() }))).toHaveLength(0);
    });

    test("judges a payment-sourced item with no later payment by its first listing", async () => {
      await seed((c) => c.recordPaid(P1, pay(), accept()));
      advance(7 * DAY + 1);
      expect(resources(make({ file: file() }))).toStrictEqual([]);
    });

    test("keeps the paid count of a kept item only for the day it was counted", async () => {
      await seed((c) => {
        c.declare(P1, body(decl()));
        c.recordPaid(P1, pay(), accept());
      });
      advance(2 * DAY);
      expect(one(make({ file: file() }).list(ALL).items).paidCallsToday).toBe(0);
    });
  });
});

describe("the byte budget", () => {
  const sizeOf = (item: unknown): number => Buffer.byteLength(JSON.stringify(item));
  const text = (n: number) => "d".repeat(n);
  /** The default resource of decl, which pay names too */
  const chunk = (n = 200) => decl({ description: text(n) });
  const named = (name: string, n = 200, p: CatalogProvider = P1) =>
    decl({ resource: `http://h/${name}`, description: text(n) }, p);
  let probes = 0;

  /** The bytes the stored items take as JSON once `fill` has run, measured on a throwaway catalog's own file */
  async function measure(fill: (c: Catalog) => void): Promise<number> {
    const path = join(dir, `probe-${probes++}.json`);
    const probe = make({ file: path });
    fill(probe);
    await probe.flush();
    const { items } = JSON.parse(readFileSync(path, "utf8")) as { items: unknown[] };
    return items.reduce<number>((n, item) => n + sizeOf(item), 0);
  }
  const weigh = (...items: Array<Record<string, unknown>>) => measure((c) => c.declare(P1, body(...items)));

  describe("a declaration", () => {
    test("that fills the budget exactly is taken, and the next new item is refused", async () => {
      const c = make({ maxBytes: await weigh(named("a"), named("b")) });
      expect(() => c.declare(P1, body(named("a"), named("b")))).not.toThrow();
      expect(refusal(() => c.declare(P1, body(named("c")))).message).toBe("the catalog is full");
      expect(resources(c)).toStrictEqual(["http://h/a", "http://h/b"]);
    });

    test("that passes the budget by one byte is refused whole, as the catalog is full, naming no item", async () => {
      const c = make({ maxBytes: (await weigh(named("a"), named("b"))) - 1 });
      const err = refusal(() => c.declare(P1, body(named("a"), named("b"))));
      expect(err.message).toBe("the catalog is full");
      expect(err.index).toBeUndefined();
      expect(everything(c)).toStrictEqual([]);
    });

    test("that is refused applies none of its items, even one that would fit", async () => {
      const c = make({ maxBytes: await weigh(named("a"), named("b")) });
      c.declare(P1, body(named("a")));
      refusal(() => c.declare(P1, body(named("a", 300), named("b"))));
      expect(one(everything(c))).toMatchObject({ resource: "http://h/a", description: text(200) });
    });

    test("is logged once however often it is refused, and never names a URL", async () => {
      const c = make({ maxBytes: (await weigh(named("a"))) - 1 });
      for (let i = 0; i < 3; i++) refusal(() => c.declare(P1, body(named("secret-path"))));
      expect(log).toHaveBeenCalledTimes(1);
      expect(String(log.mock.calls[0]?.[0])).not.toContain("secret-path");
    });

    test("counts the item it replaces, so a heartbeat of a catalog at the budget still passes", async () => {
      const c = make({ maxBytes: await weigh(named("a"), named("b")) });
      c.declare(P1, body(named("a"), named("b")));
      advance(30_000);
      expect(() => c.declare(P1, body(named("a"), named("b")))).not.toThrow();
      expect(everything(c).map((i) => i.lastSeen)).toStrictEqual(Array(2).fill("2026-10-28T12:00:30.000Z"));
    });

    test("that makes an item larger by more than the room left is refused, and by less is taken", async () => {
      const c = make({ maxBytes: (await weigh(named("a"))) + 10 });
      c.declare(P1, body(named("a")));
      expect(() => c.declare(P1, body(named("a", 210)))).not.toThrow();
      expect(refusal(() => c.declare(P1, body(named("a", 211)))).message).toBe("the catalog is full");
      expect(one(everything(c)).description).toBe(text(210));
    });

    test("that makes an item smaller frees room for another provider's", async () => {
      const heavy = decl({ resource: "http://h/a", extensions: sized(3000) });
      const c = make({ maxBytes: await weigh(heavy) });
      c.declare(P1, body(heavy));
      refusal(() => c.declare(P2, body(named("b", 0, P2))));
      c.declare(P1, body(named("a", 0)));
      expect(() => c.declare(P2, body(named("b", 0, P2)))).not.toThrow();
      expect(resources(c)).toStrictEqual(["http://h/a", "http://h/b"]);
    });

    test("counts the bytes of the payment-sourced items its first declaration drops", async () => {
      const declared = await weigh(named("a", 400));
      const c = make({ maxBytes: declared });
      c.recordPaid(P1, pay({ resource: { url: "http://h/before" } }), accept());
      expect(resources(c)).toStrictEqual(["http://h/before"]);
      expect(() => c.declare(P1, body(named("a", 400)))).not.toThrow();
      expect(resources(c)).toStrictEqual(["http://h/a"]);
    });

    test("is judged after the item caps, which name the item that breaks them", async () => {
      const c = make({ maxBytes: 1, maxPerProvider: 1 });
      expect(refusal(() => c.declare(P1, body(named("a"), named("b")))).message).toMatch(/^items\[1\]: /);
    });
  });

  describe("a payment", () => {
    const paidFor = (url: string) => pay({ resource: { url } });

    test("that would pass the budget creates nothing, and that is logged once however often it repeats", async () => {
      const one = await measure((c) => c.recordPaid(P1, paidFor("http://h/a"), accept()));
      const c = make({ maxBytes: one });
      c.recordPaid(P1, paidFor("http://h/a"), accept());
      for (let i = 0; i < 3; i++) c.recordPaid(P1, paidFor("http://h/b"), accept());
      expect(resources(c)).toStrictEqual(["http://h/a"]);
      expect(log).toHaveBeenCalledTimes(1);
      expect(String(log.mock.calls[0]?.[0])).not.toContain("h/b");
    });

    test("that fills the budget exactly creates its item", async () => {
      const both = await measure((c) => {
        c.recordPaid(P1, paidFor("http://h/a"), accept());
        c.recordPaid(P1, paidFor("http://h/b"), accept());
      });
      const c = make({ maxBytes: both });
      c.recordPaid(P1, paidFor("http://h/a"), accept());
      c.recordPaid(P1, paidFor("http://h/b"), accept());
      expect(resources(c)).toStrictEqual(["http://h/a", "http://h/b"]);
      expect(log).not.toHaveBeenCalled();
    });

    test("is logged once for the budget, whether a declaration or a payment hit it", () => {
      const c = make({ maxBytes: 1 });
      refusal(() => c.declare(P1, body(named("a"))));
      c.recordPaid(P2, paidFor("http://h/b"), accept({}, P2));
      c.recordPaid(P1, paidFor("http://h/c"), accept());
      expect(log).toHaveBeenCalledTimes(1);
    });

    test("that only counts an item is never refused, and neither is the heartbeat after it", async () => {
      const c = make({ maxBytes: await weigh(chunk()) });
      c.declare(P1, body(chunk()));
      advance(MINUTE);
      c.recordPaid(P1, pay(), accept());
      // The count added lastPaid and paidDay, which takes the stored bytes a few over the budget
      expect(one(everything(c)).paidCallsToday).toBe(1);
      advance(MINUTE);
      expect(() => c.declare(P1, body(chunk()))).not.toThrow();
      expect(one(everything(c))).toMatchObject({ paidCallsToday: 1, lastSeen: "2026-10-28T12:02:00.000Z" });
    });

    test("that is refused takes no room, so the next one that fits is created", async () => {
      const c = make({ maxBytes: await measure((m) => m.recordPaid(P1, paidFor("http://h/a"), accept())) });
      const padded = { bazaar: { ...bazaar("GET"), pad: text(2000) } };
      c.recordPaid(P2, pay({ resource: { url: "http://h/big" }, extensions: padded }), accept({}, P2));
      expect(everything(c)).toStrictEqual([]);
      c.recordPaid(P1, paidFor("http://h/a"), accept());
      expect(resources(c)).toStrictEqual(["http://h/a"]);
    });
  });

  describe("at load", () => {
    /** Four declared items of known age, the oldest of which is paid last, so that it is the newest to be seen */
    async function seeded(): Promise<Map<string, number>> {
      const first = make({ file: file() });
      first.declare(P1, body(named("a")));
      advance(MINUTE);
      first.declare(P1, body(named("b")));
      advance(MINUTE);
      first.declare(P1, body(named("c")));
      advance(MINUTE);
      first.declare(P1, body(named("d")));
      first.recordPaid(P1, pay({ resource: { url: "http://h/a" } }), accept());
      await first.close();
      const { items } = JSON.parse(readFileSync(file(), "utf8")) as { items: Array<{ resource: string }> };
      return new Map(items.map((item) => [item.resource.slice("http://h/".length), sizeOf(item)]));
    }
    const room = (sizes: Map<string, number>, ...names: string[]) => names.reduce((n, name) => n + sizes.get(name)!, 0);

    test("keeps a file that fits as it is, and says nothing", async () => {
      const sizes = await seeded();
      const c = make({ file: file(), maxBytes: room(sizes, "a", "b", "c", "d") });
      expect(resources(c)).toStrictEqual(["http://h/a", "http://h/b", "http://h/c", "http://h/d"]);
      expect(log).not.toHaveBeenCalled();
    });

    test("drops the oldest items until the rest fit, and says so once, naming the file and no item", async () => {
      const sizes = await seeded();
      const c = make({ file: file(), maxBytes: room(sizes, "a", "c", "d") });
      // b was seen at 12:01, the oldest sign of life of the four, while a was paid at 12:03
      expect(resources(c)).toStrictEqual(["http://h/a", "http://h/c", "http://h/d"]);
      expect(log).toHaveBeenCalledTimes(1);
      expect(String(log.mock.calls[0]?.[0])).toContain(file());
      expect(String(log.mock.calls[0]?.[0])).not.toContain("h/b");
    });

    test("judges age by the newest of lastSeen, lastPaid and firstListed", async () => {
      const sizes = await seeded();
      const c = make({ file: file(), maxBytes: room(sizes, "a", "d") });
      // a was declared first and paid at 12:03, which counts as newer than b and c
      expect(resources(c)).toStrictEqual(["http://h/a", "http://h/d"]);
    });

    test("drops down to the item that does fit, when only one does", async () => {
      const sizes = await seeded();
      const c = make({ file: file(), maxBytes: room(sizes, "d") });
      expect(resources(c)).toStrictEqual(["http://h/d"]);
      expect(log).toHaveBeenCalledTimes(1);
    });

    test("drops everything when no item fits, and still starts", async () => {
      await seeded();
      const c = make({ file: file(), maxBytes: 1 });
      expect(everything(c)).toStrictEqual([]);
      expect(log).toHaveBeenCalledTimes(1);
    });

    test("drops equally old items in a fixed order", async () => {
      const first = make({ file: file() });
      first.declare(P1, body(named("a"), named("b")));
      await first.close();
      const { items } = JSON.parse(readFileSync(file(), "utf8")) as { items: unknown[] };
      const c = make({ file: file(), maxBytes: sizeOf(items[0]) });
      expect(resources(c)).toStrictEqual(["http://h/b"]);
    });

    test("keeps a provider that declared closed to payment listings, whatever of its items is dropped", async () => {
      const room = await measure((m) => m.recordPaid(P1, pay(), accept()));
      const first = make({ file: file() });
      first.declare(P1, body(named("a", 512)));
      await first.close();
      const c = make({ file: file(), maxBytes: room });
      expect(everything(c)).toStrictEqual([]);
      c.recordPaid(P1, pay(), accept());
      expect(everything(c)).toStrictEqual([]);
    });

    test("counts the items it keeps, so a declaration is judged against what the file left", async () => {
      const sizes = await seeded();
      const c = make({ file: file(), maxBytes: room(sizes, "a", "c", "d") });
      refusal(() => c.declare(P1, body(named("e"))));
      expect(() => c.declare(P1, body(named("c"), named("d")))).not.toThrow();
    });
  });

  test("is 16 MiB unless told otherwise", async () => {
    const big = (n: number) => decl({ resource: `http://h/${String(n).padStart(5, "0")}`, extensions: sized(8192) });
    const stored = await weigh(big(0));
    const c = make();
    let accepted = 0;
    for (let n = 0; ; n++) {
      const provider = { ...P1, id: String(Math.floor(n / 128)).padStart(16, "0") };
      try {
        c.declare(provider, body(big(n)));
      } catch (e) {
        expect(e).toBeInstanceOf(CatalogError);
        expect((e as CatalogError).message).toBe("the catalog is full");
        break;
      }
      accepted++;
    }
    expect(accepted).toBe(Math.floor((16 * 1024 * 1024) / stored));
  });
});

describe("options", () => {
  test.each<[string, CatalogOptions, RegExp]>([
    ["a blank file", { file: "  " }, /^file: /],
    ["an empty file", { file: "" }, /^file: /],
    ["a maxPerProvider of 0", { maxPerProvider: 0 }, /^maxPerProvider: /],
    ["a fractional maxPerProvider", { maxPerProvider: 1.5 }, /^maxPerProvider: /],
    ["a maxTotal of 0", { maxTotal: 0 }, /^maxTotal: /],
    ["a maxBytes of 0", { maxBytes: 0 }, /^maxBytes: /],
    ["a fractional maxBytes", { maxBytes: 1.5 }, /^maxBytes: /],
    ["a maxPaymentItemsPerProvider of 0", { maxPaymentItemsPerProvider: 0 }, /^maxPaymentItemsPerProvider: /],
    ["a fractional maxPaymentItemsPerProvider", { maxPaymentItemsPerProvider: 1.5 }, /^maxPaymentItemsPerProvider: /],
    ["a negative writeDelayMs", { writeDelayMs: -1 }, /^writeDelayMs: /],
    ["a fractional writeDelayMs", { writeDelayMs: 0.5 }, /^writeDelayMs: /],
  ])("load refuses %s", (_name, o, field) => {
    expect(() => Catalog.load(o)).toThrow(field);
  });

  test("load takes no options at all", async () => {
    const c = Catalog.load();
    expect(c.list(ALL).pagination.total).toBe(0);
    await c.close();
  });

  test("a writeDelayMs of 0 is accepted", async () => {
    const c = make({ file: file(), writeDelayMs: 0 });
    c.declare(P1, body(decl()));
    await c.close();
    expect(existsSync(file())).toBe(true);
  });
});
