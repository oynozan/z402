import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createDropboxService, DropStore, type DropboxConfig, type TipSource } from "../src/index.js";
import { EXAMPLE_AGE_FILE } from "../src/example.js";
import { startTestStack, TEST_NETWORK, TEST_PAY_TO, TEST_PUBLIC_URL, type TestStack } from "@z402/service-kit/testing";
import { ageFile, armor } from "./support.js";

class FakeTips implements TipSource {
  started = 0;
  stopped = 0;
  constructor(public height: number | undefined) {}
  tip(): number | undefined {
    return this.height;
  }
  start(): void {
    this.started += 1;
  }
  stop(): void {
    this.stopped += 1;
  }
}

const quiet = (): void => undefined;

/** A copy in a plain ArrayBuffer, which is what fetch takes as a body */
const raw = (bytes: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(bytes);

const running: TestStack[] = [];
const dirs: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const stack of running.splice(0)) await stack.close();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Harness {
  stack: TestStack;
  tips: FakeTips;
  store: DropStore;
  dir: string;
  config: DropboxConfig;
  logs: string[];
  /** The cumulative zat the paying client has sent, which only moves when a voucher is sent */
  spent: () => bigint | undefined;
}

interface HarnessOptions {
  config?: Partial<DropboxConfig>;
  tips?: FakeTips;
  /** Puts a facilitator in front of the real one that refuses every settlement */
  refuseSettlement?: boolean;
  /** Puts a facilitator in front of the real one that settles this many milliseconds late */
  settleDelayMs?: number;
  /** Called when a settlement request arrives, which is after the handler has answered */
  onSettle?: () => void;
}

/** Forwards to the real facilitator except /settle, which it refuses the way the real one does or passes on late */
async function faultyFacilitator(
  upstream: string,
  o: { refuse: boolean; delayMs: number; onSettle: (() => void) | undefined },
): Promise<{ url: string }> {
  const relay = async (req: IncomingMessage, res: ServerResponse, body: Buffer, delayMs: number): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    try {
      const answer = await fetch(`${upstream}${req.url ?? "/"}`, {
        method: req.method ?? "GET",
        headers: {
          "content-type": "application/json",
          ...(req.headers.authorization === undefined ? {} : { authorization: req.headers.authorization }),
        },
        ...(body.length > 0 && { body: raw(body) }),
      });
      res.writeHead(answer.status, { "content-type": answer.headers.get("content-type") ?? "application/json" });
      res.end(Buffer.from(await answer.arrayBuffer()));
    } catch {
      res.writeHead(502).end();
    }
  };

  const server = createServer((req, res) => {
    const settling = req.method === "POST" && req.url === "/settle";
    if (settling) o.onSettle?.();
    if (settling && o.refuse) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          success: false,
          errorReason: "refused_by_the_test",
          errorMessage: "refused by the test",
          transaction: "",
          network: TEST_NETWORK,
        }),
      );
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => void relay(req, res, Buffer.concat(chunks), settling ? o.delayMs : 0));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

async function dropbox(o: HarnessOptions = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "dropbox-service-"));
  dirs.push(dir);
  const config: DropboxConfig = {
    dir,
    maxBytes: 4096,
    maxTotalBytes: 65_536,
    blocksPerCall: 10,
    maxHoldBlocks: 30,
    lwdUrl: "http://127.0.0.1:1",
    tipPollMs: 10_000,
    ...o.config,
  };
  const tips = o.tips ?? new FakeTips(100);
  const logs: string[] = [];
  const store = new DropStore({ dir, maxTotalBytes: config.maxTotalBytes, log: quiet });
  const stack = await startTestStack({
    build: async (env) => {
      const faulty = o.refuseSettlement === true || o.settleDelayMs !== undefined || o.onSettle !== undefined;
      const facilitatorUrl = faulty
        ? (
            await faultyFacilitator(env.facilitatorUrl, {
              refuse: o.refuseSettlement === true,
              delayMs: o.settleDelayMs ?? 0,
              onSettle: o.onSettle,
            })
          ).url
        : env.facilitatorUrl;
      const log = (line: string): void => void logs.push(line);
      return createDropboxService({ env: { ...env, facilitatorUrl }, config, tips, store, log });
    },
  });
  running.push(stack);
  return { stack, tips, store, dir, config, logs, spent: () => stack.scheme.session(TEST_PAY_TO)?.cumulativeZat };
}

const drops = (h: Harness): string => `${h.stack.url}/v1/drops`;

const upload = (h: Harness, body: Uint8Array | string): Promise<Response> =>
  h.stack.paidFetch(drops(h), {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: typeof body === "string" ? body : raw(body),
  });

/** As the discovery declaration shows it, with an empty JSON object as the body */
const hold = (h: Harness, id: string): Promise<Response> =>
  h.stack.paidFetch(`${drops(h)}/${id}/hold`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });

interface Uploaded {
  id: string;
  deleteToken: string;
  size: number;
  tip: number;
  expiresAtHeight: number;
}

async function uploaded(h: Harness, file: Uint8Array = ageFile({ payload: randomBytes(300) })): Promise<Uploaded> {
  const res = await upload(h, file);
  expect(res.status).toBe(201);
  return (await res.json()) as Uploaded;
}

const expiryOf = async (h: Harness, id: string): Promise<string | null> =>
  (await fetch(`${drops(h)}/${id}`)).headers.get("x-expires-at-height");

const UNKNOWN = "AAAAAAAAAAAAAAAAAAAAAA";

describe("upload", () => {
  test("a paid upload is stored for the blocks one call buys, and fetched back as the same bytes", async () => {
    const h = await dropbox();
    const file = ageFile({ payload: randomBytes(300) });
    const res = await upload(h, file);

    expect(res.status).toBe(201);
    expect(res.headers.get("payment-response")).toBeTruthy();
    const body = (await res.json()) as Uploaded;
    expect(body).toEqual({
      id: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/),
      deleteToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      size: file.length,
      tip: 100,
      expiresAtHeight: 110,
    });
    expect(h.spent()).toBe(500n);

    const got = await fetch(`${drops(h)}/${body.id}`);
    expect(got.status).toBe(200);
    expect(got.headers.get("content-type")).toBe("application/octet-stream");
    expect(got.headers.get("cache-control")).toBe("no-store");
    expect(got.headers.get("x-expires-at-height")).toBe("110");
    expect(Buffer.from(await got.arrayBuffer()).equals(file)).toBe(true);
    // Fetching is free
    expect(h.spent()).toBe(500n);
    const head = await fetch(`${drops(h)}/${body.id}`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });

  test("an armored file is stored as it came", async () => {
    const h = await dropbox();
    const armored = armor(ageFile({ payload: randomBytes(300) }));
    const { id } = await uploaded(h, Buffer.from(armored));
    expect(await (await fetch(`${drops(h)}/${id}`)).text()).toBe(armored);
  });

  test("takes the body as bytes whatever content type it is sent with", async () => {
    const h = await dropbox();
    const file = ageFile({ payload: randomBytes(300) });
    for (const type of ["text/plain", "application/json", "application/x-www-form-urlencoded", "image/png"]) {
      const headers = { "content-type": type };
      const res = await h.stack.paidFetch(drops(h), { method: "POST", headers, body: raw(file) });
      expect(res.status, type).toBe(201);
      const { id } = (await res.json()) as Uploaded;
      expect(Buffer.from(await (await fetch(`${drops(h)}/${id}`)).arrayBuffer()).equals(file), type).toBe(true);
    }
  });

  test("a plaintext upload is refused before payment, and no voucher is ever sent", async () => {
    const h = await dropbox();
    const res = await upload(h, "The launch codes are 0000, please keep them safe.");
    expect(res.status).toBe(415);
    expect(await res.json()).toEqual({
      error: "not_encrypted",
      reason: 'missing the "age-encryption.org/v1" header line',
    });
    expect(h.spent()).toBeUndefined();
    expect(h.store.count).toBe(0);

    const json = await upload(h, JSON.stringify({ secret: "hunter2" }));
    expect(json.status).toBe(415);
    const shaped = await upload(h, ageFile({ payload: Buffer.alloc(300, 0x41) }));
    expect(shaped.status).toBe(415);
    expect(((await shaped.json()) as { reason: string }).reason).toMatch(/ciphertext/);
    expect(h.spent()).toBeUndefined();
  });

  test("an oversize upload is refused before payment", async () => {
    const h = await dropbox({ config: { maxBytes: 1024 } });
    const res = await upload(h, ageFile({ payload: randomBytes(2048) }));
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "too_large" });
    expect(h.spent()).toBeUndefined();

    // A file of exactly the limit is fine
    const limit = ageFile({ payload: randomBytes(1024 - 168) });
    expect(limit.length).toBe(1024);
    expect((await upload(h, limit)).status).toBe(201);
    expect((await upload(h, Buffer.concat([limit, Buffer.from([0])]))).status).toBe(413);
  });

  test("an empty upload is refused before payment", async () => {
    const h = await dropbox();
    const empty = await upload(h, new Uint8Array(0));
    expect(empty.status).toBe(400);
    expect(await empty.json()).toEqual({ error: "empty_body" });
    const none = await h.stack.paidFetch(drops(h), { method: "POST" });
    expect(none.status).toBe(400);
    expect(h.spent()).toBeUndefined();
  });

  test("a full store is refused before payment, and a delete makes room", async () => {
    const h = await dropbox({ config: { maxTotalBytes: 600 } });
    const file = ageFile({ payload: randomBytes(132 + 100) });
    expect(file.length).toBe(400);
    const first = await uploaded(h, file);
    const refused = await upload(h, ageFile({ payload: randomBytes(100) }));
    expect(refused.status).toBe(507);
    expect(await refused.json()).toEqual({ error: "storage_full" });
    expect(h.spent()).toBe(500n);

    const deleted = await fetch(`${drops(h)}/${first.id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${first.deleteToken}` },
    });
    expect(deleted.status).toBe(204);
    expect((await upload(h, ageFile({ payload: randomBytes(100) }))).status).toBe(201);
  });

  test("a tip that is not known refuses before payment", async () => {
    const h = await dropbox({ tips: new FakeTips(undefined) });
    const res = await upload(h, ageFile({ payload: randomBytes(100) }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "not_ready" });
    expect(h.spent()).toBeUndefined();
    const health = await fetch(`${h.stack.url}/health`);
    expect(health.status).toBe(503);
    expect(await health.json()).toMatchObject({ ready: false, service: "Encrypted drop box" });
  });

  test("an upload is refused when the tip goes missing between the check and the handler", async () => {
    const h = await dropbox();
    const tip = vi.spyOn(h.tips, "tip");
    // The readiness gate sees a tip and the handler, a call later, does not
    tip.mockReturnValueOnce(100).mockReturnValueOnce(undefined);
    const res = await upload(h, ageFile({ payload: randomBytes(100) }));
    expect(res.status).toBe(503);
    expect(h.store.count).toBe(0);
  });
});

describe("hold", () => {
  test("a paid hold adds the blocks of one call, and the new expiry is what a fetch reports", async () => {
    const h = await dropbox();
    const { id, expiresAtHeight } = await uploaded(h);
    expect(expiresAtHeight).toBe(110);

    h.tips.height = 105;
    const res = await hold(h, id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id, tip: 105, expiresAtHeight: 120 });
    expect(h.spent()).toBe(1000n);
    await vi.waitFor(async () => expect(await expiryOf(h, id)).toBe("120"));

    // The hold is on disk too
    const reopened = new DropStore({ dir: h.dir, maxTotalBytes: 1, log: quiet });
    expect(reopened.get(id)?.expiresAtHeight).toBe(120);
  });

  test("a hold works without a body too", async () => {
    const h = await dropbox();
    const { id } = await uploaded(h);
    const res = await h.stack.paidFetch(`${drops(h)}/${id}/hold`, { method: "POST" });
    expect(res.status).toBe(200);
    await vi.waitFor(async () => expect(await expiryOf(h, id)).toBe("120"));
  });

  test("a hold at the cap is refused before payment, and the cap moves with the tip", async () => {
    const h = await dropbox({ config: { maxHoldBlocks: 20 } });
    const { id } = await uploaded(h);
    // Uploaded at tip 100 for 110, one hold reaches 120 which is the cap of tip + 20
    expect((await hold(h, id)).status).toBe(200);
    await vi.waitFor(async () => expect(await expiryOf(h, id)).toBe("120"));
    expect(h.spent()).toBe(1000n);

    const refused = await hold(h, id);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: "hold_cap_reached", maxHoldBlocks: 20 });
    expect(h.spent()).toBe(1000n);
    expect(await expiryOf(h, id)).toBe("120");

    h.tips.height = 109;
    expect((await hold(h, id)).status).toBe(409);
    h.tips.height = 110;
    expect((await hold(h, id)).status).toBe(200);
    await vi.waitFor(async () => expect(await expiryOf(h, id)).toBe("130"));
    expect(h.spent()).toBe(1500n);
  });

  test("an unknown or malformed drop is refused before payment", async () => {
    const h = await dropbox();
    const unknown = await hold(h, UNKNOWN);
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: "unknown_drop" });
    for (const id of ["short", "..%2F..%2Fetc", "A".repeat(40)]) {
      expect((await hold(h, id)).status, id).toBe(404);
    }
    expect(h.spent()).toBeUndefined();
  });

  test("an expired drop cannot be held", async () => {
    const h = await dropbox();
    const { id } = await uploaded(h);
    h.tips.height = 110;
    const res = await hold(h, id);
    expect(res.status).toBe(404);
    expect(h.spent()).toBe(500n);
  });

  test("is applied only once the hold was delivered", async () => {
    const h = await dropbox({ refuseSettlement: true });
    const extend = vi.spyOn(h.store, "extend");
    const { meta } = h.store.put({ bytes: ageFile({ payload: randomBytes(300) }), expiresAtHeight: 110 });
    const res = await hold(h, meta.id);
    expect(res.status).toBe(402);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(extend).not.toHaveBeenCalled();
    expect(h.store.get(meta.id)?.expiresAtHeight).toBe(110);
  });

  test("is applied against the drop as it stands when delivery ends, and never past the cap", async () => {
    let watching = false;
    let settling: () => void = () => undefined;
    const settlementUnderWay = new Promise<void>((resolve) => (settling = resolve));
    const h = await dropbox({
      config: { maxHoldBlocks: 20 },
      settleDelayMs: 50,
      onSettle: () => watching && settling(),
    });
    const { id } = await uploaded(h);
    const extend = vi.spyOn(h.store, "extend");

    // The hold passes against 110 and promises 120, then another one lands while it settles
    watching = true;
    const pending = hold(h, id);
    await settlementUnderWay;
    h.store.extend(id, 120);
    const res = await pending;

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ expiresAtHeight: 120 });
    await vi.waitFor(() => expect(extend).toHaveBeenCalledTimes(2));
    // 120 + 10 would pass the cap of 100 + 20
    expect(extend).toHaveBeenLastCalledWith(id, 120);
    expect(h.store.get(id)?.expiresAtHeight).toBe(120);
  });
});

describe("fetch", () => {
  test("answers 404 as JSON for an unknown or malformed id", async () => {
    const h = await dropbox();
    for (const id of [UNKNOWN, "short", "A".repeat(40), "a%2Fb", "%00", `${UNKNOWN.slice(1)}%20`]) {
      const res = await fetch(`${drops(h)}/${id}`);
      expect(res.status, id).toBe(404);
      expect(await res.json(), id).toEqual({ error: "unknown_drop" });
    }
  });
});

describe("expiry", () => {
  test("advancing the tip to the expiry removes the drop, from disk too", async () => {
    const h = await dropbox();
    const { id } = await uploaded(h);
    expect(readdirSync(h.dir)).toHaveLength(2);

    h.tips.height = 109;
    expect((await fetch(`${drops(h)}/${id}`)).status).toBe(200);
    h.tips.height = 110;
    const gone = await fetch(`${drops(h)}/${id}`);
    expect(gone.status).toBe(404);
    expect(await gone.json()).toEqual({ error: "unknown_drop" });
    expect(h.store.count).toBe(0);
    expect(readdirSync(h.dir)).toEqual([]);
  });

  test("a hold keeps the drop past the original expiry", async () => {
    const h = await dropbox();
    const { id } = await uploaded(h);
    expect((await hold(h, id)).status).toBe(200);
    await vi.waitFor(async () => expect(await expiryOf(h, id)).toBe("120"));
    h.tips.height = 115;
    expect((await fetch(`${drops(h)}/${id}`)).status).toBe(200);
    h.tips.height = 120;
    expect((await fetch(`${drops(h)}/${id}`)).status).toBe(404);
  });

  test("a tip that is not known expires nothing", async () => {
    const h = await dropbox();
    const { id } = await uploaded(h);
    h.tips.height = undefined;
    expect((await fetch(`${drops(h)}/${id}`)).status).toBe(200);
    h.tips.height = 500;
    expect((await fetch(`${drops(h)}/${id}`)).status).toBe(404);
  });
});

describe("delete", () => {
  const remove = (h: Harness, id: string, authorization?: string): Promise<Response> =>
    fetch(`${drops(h)}/${id}`, {
      method: "DELETE",
      ...(authorization !== undefined && { headers: { authorization } }),
    });

  test("needs the token of that drop", async () => {
    const h = await dropbox();
    const a = await uploaded(h);
    const b = await uploaded(h);

    const without = await remove(h, a.id);
    expect(without.status).toBe(401);
    expect(without.headers.get("www-authenticate")).toBe("Bearer");
    expect(await without.json()).toEqual({ error: "unauthorized" });
    expect((await remove(h, a.id, "Basic abc")).status).toBe(401);

    const wrong = await remove(h, a.id, `Bearer ${"x".repeat(43)}`);
    expect(wrong.status).toBe(403);
    expect(await wrong.json()).toEqual({ error: "forbidden" });
    expect((await remove(h, a.id, `Bearer ${b.deleteToken}`)).status).toBe(403);
    expect((await fetch(`${drops(h)}/${a.id}`)).status).toBe(200);
    expect(h.store.count).toBe(2);
  });

  test("with the right token deletes it for good, free of charge", async () => {
    const h = await dropbox();
    const a = await uploaded(h);
    const b = await uploaded(h);
    expect(h.spent()).toBe(1000n);

    const ok = await remove(h, a.id, `Bearer ${a.deleteToken}`);
    expect(ok.status).toBe(204);
    expect(await ok.text()).toBe("");
    expect((await fetch(`${drops(h)}/${a.id}`)).status).toBe(404);
    expect((await fetch(`${drops(h)}/${b.id}`)).status).toBe(200);
    expect(readdirSync(h.dir).sort()).toEqual([`${b.id}.age`, `${b.id}.json`]);
    expect(h.spent()).toBe(1000n);

    expect((await remove(h, a.id, `Bearer ${a.deleteToken}`)).status).toBe(404);
    expect((await remove(h, b.id, `bearer   ${b.deleteToken}`)).status).toBe(204);
  });

  test("answers 404 for an unknown drop whatever the token", async () => {
    const h = await dropbox();
    expect((await remove(h, UNKNOWN, "Bearer abc")).status).toBe(404);
    expect((await remove(h, UNKNOWN)).status).toBe(404);
    expect((await remove(h, "..", "Bearer abc")).status).toBe(404);
  });
});

describe("a delivery that does not happen", () => {
  test("a refused settlement removes the upload, so no call that failed leaves a free drop", async () => {
    const h = await dropbox({ refuseSettlement: true });
    const put = vi.spyOn(h.store, "put");
    const res = await upload(h, ageFile({ payload: randomBytes(300) }));

    expect(res.status).toBe(402);
    expect(put).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(h.store.count).toBe(0));
    expect(h.store.usedBytes).toBe(0);
    expect(readdirSync(h.dir)).toEqual([]);
  });

  test("a client that goes away before the answer leaves no drop either", async () => {
    const h = await dropbox();
    const real = h.store.put.bind(h.store);
    const abort = new AbortController();
    // The client hangs up while the handler stores the upload, before the answer is sent
    vi.spyOn(h.store, "put").mockImplementation((o) => {
      const stored = real(o);
      abort.abort();
      return stored;
    });
    await expect(
      h.stack.paidFetch(drops(h), {
        method: "POST",
        body: raw(ageFile({ payload: randomBytes(300) })),
        signal: abort.signal,
      }),
    ).rejects.toThrow();
    await vi.waitFor(() => expect(h.store.count).toBe(0));
    expect(readdirSync(h.dir)).toEqual([]);
  });

  test("a failure in the handler answers 500 as JSON, logs it, and leaves nothing behind", async () => {
    const h = await dropbox();
    vi.spyOn(h.store, "put").mockImplementation(() => {
      throw new Error("ENOSPC: no space left on device");
    });
    const res = await upload(h, ageFile({ payload: randomBytes(300) }));
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toMatch(/json/);
    expect(await res.json()).toEqual({ error: "internal_error" });
    expect(h.logs).toEqual(["dropbox: request failed: ENOSPC: no space left on device"]);
    expect(h.store.count).toBe(0);
  });
});

describe("what the service declares", () => {
  test("lists both paid routes in /health, ready", async () => {
    const h = await dropbox();
    const health = await fetch(`${h.stack.url}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({
      ok: true,
      ready: true,
      service: "Encrypted drop box",
      routes: [
        { method: "POST", path: "/v1/drops", unit: "10 blocks" },
        { method: "POST", path: "/v1/drops/:id/hold", probePath: "/v1/drops/example/hold", unit: "10 blocks" },
      ],
    });
  });

  test("an unpaid upload gets a 402 that declares the route for discovery", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(quiet);
    const h = await dropbox();
    const res = await fetch(drops(h), { method: "POST", body: raw(ageFile({ payload: randomBytes(300) })) });
    expect(res.status).toBe(402);
    const required = decode(res);
    expect(required.resource).toMatchObject({
      url: `${TEST_PUBLIC_URL}/v1/drops`,
      description: "Holds one age-encrypted blob for 10 blocks; pay again to hold it longer.",
      mimeType: "application/json",
      serviceName: "Encrypted drop box",
      tags: ["storage", "handoff", "encrypted"],
    });
    expect(required.accepts[0]).toMatchObject({
      scheme: "prepaid-voucher",
      amount: "500",
      asset: "ZEC",
      payTo: TEST_PAY_TO,
    });
    expect(required.extensions.z402).toEqual({
      unit: "10 blocks",
      note: "Only client-side encrypted (age) blobs. Size and time are capped.",
    });
    const info = required.extensions.bazaar.info;
    expect(info.input).toMatchObject({ type: "http", method: "POST", bodyType: "text", body: EXAMPLE_AGE_FILE });
    expect(required.extensions.bazaar.schema.properties.input.properties.body).toEqual({ type: "string" });
    expect(info.output.example).toEqual({
      id: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/),
      deleteToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      size: EXAMPLE_AGE_FILE.length,
      tip: expect.any(Number),
      expiresAtHeight: expect.any(Number),
    });
    // The declarations validate, or the SDK says so on the console
    expect(warn.mock.calls.filter((call) => String(call[0]).includes("bazaar"))).toEqual([]);
    expect(h.store.count).toBe(0);
  });

  test("a discovery probe of the upload route needs no body to get its 402", async () => {
    const h = await dropbox();
    const probe = await fetch(drops(h), { method: "POST", headers: { "x-z402-probe": "1" } });
    expect(probe.status).toBe(402);
    expect(decode(probe).extensions.z402).toMatchObject({ unit: "10 blocks" });
    expect((await fetch(drops(h), { method: "POST" })).status).toBe(400);
  });

  test("a discovery probe of the hold route gets a 402 without a real drop", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(quiet);
    const h = await dropbox();
    const res = await fetch(`${drops(h)}/example/hold`, { method: "POST", headers: { "x-z402-probe": "1" } });
    expect(res.status).toBe(402);
    const required = decode(res);
    expect(required.resource).toMatchObject({
      url: `${TEST_PUBLIC_URL}/v1/drops/:id/hold`,
      description: "Holds an existing drop for 10 more blocks.",
    });
    expect(required.extensions.z402).toEqual({ unit: "10 blocks" });
    expect(required.extensions.bazaar.info.input).toMatchObject({
      method: "POST",
      bodyType: "json",
      body: {},
      pathParams: { id: "example" },
    });
    expect(required.extensions.bazaar.schema.properties.input.properties.pathParams).toMatchObject({
      type: "object",
      required: ["id"],
    });
    expect(warn.mock.calls.filter((call) => String(call[0]).includes("bazaar"))).toEqual([]);
    // Without the probe header the same request is refused as an unknown drop, before payment
    expect((await fetch(`${drops(h)}/example/hold`, { method: "POST" })).status).toBe(404);
  });
});

describe("what cannot be had without paying", () => {
  test("another spelling of a paid path still asks for payment", async () => {
    const h = await dropbox();
    const file = ageFile({ payload: randomBytes(300) });
    for (const path of ["/V1/DROPS", "/v1/drops/", "/v1/Drops", "//v1//drops"]) {
      const res = await fetch(`${h.stack.url}${path}`, { method: "POST", body: raw(file) });
      expect(res.status, path).toBe(402);
    }
    expect(h.store.count).toBe(0);

    const { id } = await uploaded(h);
    for (const path of [`/V1/DROPS/${id}/HOLD`, `/v1/drops/${id}/hold/`, `/v1/drops/${id}//hold`]) {
      const res = await fetch(`${h.stack.url}${path}`, { method: "POST" });
      expect(res.status, path).toBe(402);
    }
    expect(h.store.get(id)?.expiresAtHeight).toBe(110);
  });

  test("the wrong method is refused before payment", async () => {
    const h = await dropbox();
    expect((await fetch(drops(h))).status).toBe(405);
    expect((await fetch(`${drops(h)}/${UNKNOWN}/hold`)).status).toBe(405);
    expect((await fetch(`${drops(h)}/${UNKNOWN}`, { method: "POST" })).status).toBe(404);
  });

  test("an unknown path answers JSON", async () => {
    const h = await dropbox();
    const res = await fetch(`${h.stack.url}/nowhere`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });
});

describe("lifecycle", () => {
  test("starts the tip source when it is built and stops it on close", async () => {
    const h = await dropbox();
    expect(h.tips.started).toBe(1);
    expect(h.tips.stopped).toBe(0);
    await h.stack.close();
    expect(h.tips.stopped).toBe(1);
  });

  test("names DROPBOX_DIR when the directory cannot be used", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dropbox-service-"));
    dirs.push(dir);
    const blocked = join(dir, "file");
    writeFileSync(blocked, "x");
    const config: DropboxConfig = {
      dir: join(blocked, "inside"),
      maxBytes: 1,
      maxTotalBytes: 1,
      blocksPerCall: 10,
      maxHoldBlocks: 10,
      lwdUrl: "http://127.0.0.1:1",
      tipPollMs: 1000,
    };
    const tips = new FakeTips(100);
    await expect(
      startTestStack({ build: (env) => createDropboxService({ env, config, tips, log: quiet }) }),
    ).rejects.toThrow(/^DROPBOX_DIR: cannot use /);
    expect(tips.started).toBe(0);
  });
});

interface Decoded {
  resource: Record<string, unknown>;
  accepts: Array<Record<string, unknown>>;
  extensions: {
    z402: Record<string, unknown>;
    bazaar: {
      info: { input: Record<string, unknown>; output: { example: Record<string, unknown> } };
      schema: { properties: { input: { properties: { body: unknown; pathParams: Record<string, unknown> } } } };
    };
  };
}

function decode(res: Response): Decoded {
  return JSON.parse(Buffer.from(res.headers.get("payment-required") ?? "", "base64").toString("utf8")) as Decoded;
}
