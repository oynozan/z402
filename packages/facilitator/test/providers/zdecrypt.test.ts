import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEMO_TERMS, NETWORK_TESTNET } from "@z402/protocol";
import { FakeChain } from "@z402/testkit";
import { afterAll, afterEach, describe, expect, test } from "vitest";
import { startFacilitator } from "../../src/app.js";
import { zdecryptNetwork, zdecryptOwns } from "../../src/chain/zdecrypt.js";
import { providerId } from "../../src/providers/id.js";
import { keys, ZDECRYPT_BIN } from "../support/fixtures.js";

// The same registration, with the real zdecrypt deciding who owns an address instead of a stub

const NETWORK = NETWORK_TESTNET;
const OPERATOR = `utest1${"q".repeat(60)}`;
const TOKEN = "t-7c2e91-secret";
const MERCHANT = { payTo: keys.merchant.orchardOnlyAddress, uivk: keys.merchant.uivk };
const ID = providerId(NETWORK, MERCHANT.payTo);

const scratch = mkdtempSync(join(tmpdir(), "z402-real-owns-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const running: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((h) => h.close()));
});

/** What a registration must prove, as the process asks it of zdecrypt */
async function owns(p: { payTo: string; uivk: string }): Promise<boolean> {
  const found = await zdecryptOwns({
    bin: ZDECRYPT_BIN,
    key: p.uivk,
    address: p.payTo,
    network: zdecryptNetwork(NETWORK),
  });
  return found.ownedByKey && !found.hasTransparent;
}

async function boot(dir: string) {
  const handle = await startFacilitator({
    network: NETWORK,
    chain: new FakeChain().viewFor(OPERATOR),
    payTo: OPERATOR,
    priceZat: 500n,
    terms: DEMO_TERMS,
    authToken: TOKEN,
    port: 0,
    log: () => undefined,
    providers: { dir, chainFor: (p) => new FakeChain().viewFor(p.payTo), owns },
  });
  running.push(handle);
  return handle;
}

const register = (url: string, body: unknown) =>
  fetch(`${url}/providers`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("POST /providers with the real zdecrypt", () => {
  test("registers the merchant of the fixtures, whose viewing key owns its address", async () => {
    const dir = join(scratch, "registers");
    const { url } = await boot(dir);
    const res = await register(url, MERCHANT);

    expect(res.status).toBe(201);
    const answer = (await res.json()) as { providerId: string; apiKey: string };
    expect(answer.providerId).toBe(ID);
    expect(JSON.stringify(answer)).not.toContain(keys.merchant.uivk);
    const me = await fetch(`${url}/providers/me`, { headers: { authorization: `Bearer ${answer.apiKey}` } });
    expect(me.status).toBe(200);
    expect(readFileSync(join(dir, "registry.json"), "utf8")).toContain(keys.merchant.uivk);
  });

  test("refuses a viewing key that is not the one of the address as not_owner", async () => {
    const { url } = await boot(join(scratch, "not-owner"));
    const res = await register(url, { payTo: MERCHANT.payTo, uivk: keys.publishedX402Uivk });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "not_owner" });
  });

  test("refuses the full viewing key, which is no unified incoming viewing key", async () => {
    const { url } = await boot(join(scratch, "ufvk"));
    const res = await register(url, { payTo: MERCHANT.payTo, uivk: keys.merchant.ufvk });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("invalid_request");
    expect(body.message).toMatch(/^uivk: /);
    expect(body.message).not.toContain(keys.merchant.ufvk);
  });

  test("keeps the provider through a restart, proving its key owns the address again", async () => {
    const dir = join(scratch, "restarts");
    const first = await boot(dir);
    const { apiKey } = (await (await register(first.url, MERCHANT)).json()) as { apiKey: string };
    await first.close();

    const second = await boot(dir);
    expect(second.providerCount()).toBe(1);
    const me = await fetch(`${second.url}/providers/me`, { headers: { authorization: `Bearer ${apiKey}` } });
    expect(me.status).toBe(200);
  });

  test("refuses to start on a registry whose viewing key was swapped for one that owns nothing there", async () => {
    const dir = join(scratch, "tampered");
    const first = await boot(dir);
    await register(first.url, MERCHANT);
    await first.close();

    const path = join(dir, "registry.json");
    writeFileSync(path, readFileSync(path, "utf8").replace(keys.merchant.uivk, keys.publishedX402Uivk));
    const error = await boot(dir).then(
      () => undefined,
      (e: Error) => e,
    );
    expect(error?.message).toBe(`providersDir: provider ${ID}: the stored viewing key no longer owns its payTo`);
    expect(error?.message).not.toContain(keys.publishedX402Uivk);
  });
});
