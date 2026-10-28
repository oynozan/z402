import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEMO_TERMS, isValidPayTo, NETWORK_TESTNET } from "@z402/protocol";
import { FakeChain } from "@z402/testkit";
import { afterAll, afterEach, describe, expect, test } from "vitest";
import { startFacilitator } from "../../src/app.js";
import { zdecryptNetwork, zdecryptOwnsShielded } from "../../src/chain/zdecrypt.js";
import { isValidUivk } from "../../src/config.js";
import { providerId } from "../../src/providers/id.js";
import { keys, ZDECRYPT_BIN } from "../support/fixtures.js";

// The same registration, with the real zdecrypt deciding who owns an address instead of a stub. A key never appears in
// a test name or in what an assertion would print, so every check on a key is on a boolean

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

/** The string with its last character changed within the bech32 alphabet, which breaks the checksum only */
function breakChecksum(s: string): string {
  return s.slice(0, -1) + (s.at(-1) === "q" ? "p" : "q");
}

/** What the process asks of zdecrypt for a registration, which is the function it is given */
const owns = (p: { payTo: string; uivk: string }): Promise<boolean> =>
  zdecryptOwnsShielded({ bin: ZDECRYPT_BIN, key: p.uivk, address: p.payTo, network: zdecryptNetwork(NETWORK) });

async function boot(dir: string, lines: string[] = []) {
  const handle = await startFacilitator({
    network: NETWORK,
    chain: new FakeChain().viewFor(OPERATOR),
    payTo: OPERATOR,
    terms: DEMO_TERMS,
    authToken: TOKEN,
    port: 0,
    log: (msg) => lines.push(msg),
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
    expect(JSON.stringify(answer).includes(keys.merchant.uivk)).toBe(false);
    const me = await fetch(`${url}/providers/me`, { headers: { authorization: `Bearer ${answer.apiKey}` } });
    expect(me.status).toBe(200);
    expect(readFileSync(join(dir, "registry.json"), "utf8").includes(keys.merchant.uivk)).toBe(true);
  });

  test("refuses a viewing key that is not the one of the address as not_owner", async () => {
    const { url } = await boot(join(scratch, "not-owner"));
    const res = await register(url, { payTo: MERCHANT.payTo, uivk: keys.publishedX402Uivk });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "not_owner" });
  });

  // The altered value still has the shape of one, so the checks of the request pass and only zdecrypt can refuse it
  test.each([
    ["a viewing key", { payTo: MERCHANT.payTo, uivk: breakChecksum(MERCHANT.uivk) }],
    ["a payTo", { payTo: breakChecksum(MERCHANT.payTo), uivk: MERCHANT.uivk }],
  ])("%s of the right shape with a bad checksum is a 403 not_owner, never a 500", async (label, body) => {
    expect(isValidUivk(body.uivk, NETWORK)).toBe(true);
    expect(isValidPayTo(body.payTo, NETWORK)).toBe(true);
    const dir = join(scratch, `checksum-${label.replace(/\W/g, "")}`);
    const lines: string[] = [];
    const { url } = await boot(dir, lines);

    const res = await register(url, body);
    const answer = await res.json();
    expect(res.status).toBe(403);
    expect(answer).toMatchObject({ error: "not_owner", message: expect.any(String) });
    expect(JSON.stringify(answer).includes(body.uivk)).toBe(false);
    // Nothing failed, so nothing is logged as a failure, and nothing was opened or stored
    expect(lines.filter((l) => l.includes("registration failed"))).toEqual([]);
    expect(existsSync(join(dir, "registry.json"))).toBe(false);
    expect(readdirSync(join(dir, "ledgers")).filter((n) => n.endsWith(".jsonl"))).toEqual([]);
  });

  test("refuses the full viewing key, which is no unified incoming viewing key", async () => {
    const { url } = await boot(join(scratch, "ufvk"));
    const res = await register(url, { payTo: MERCHANT.payTo, uivk: keys.merchant.ufvk });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("invalid_request");
    expect(body.message).toMatch(/^uivk: /);
    expect(body.message.includes(keys.merchant.ufvk)).toBe(false);
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
    expect(error?.message.includes(keys.publishedX402Uivk)).toBe(false);
  });

  // A stored entry that stopped decoding is one whose key no longer owns its payTo, not a failure to ask
  test.each([["viewing key", "uivk"] as const, ["payTo", "payTo"] as const])(
    "refuses to start on a stored %s that has a bad checksum, as one that no longer owns its payTo",
    async (_name, field) => {
      const dir = join(scratch, `stored-${field}`);
      const first = await boot(dir);
      await register(first.url, MERCHANT);
      await first.close();

      const path = join(dir, "registry.json");
      const registry = JSON.parse(readFileSync(path, "utf8")) as { providers: Array<Record<string, string>> };
      const entry = registry.providers[0] as Record<string, string>;
      entry[field] = breakChecksum(entry[field] as string);
      // The id of a payTo is fixed by it, so the entry keeps one that fits and only zdecrypt can tell
      entry.id = providerId(NETWORK, entry.payTo as string);
      writeFileSync(path, `${JSON.stringify(registry)}\n`);

      const error = await boot(dir).then(
        () => undefined,
        (e: Error) => e,
      );
      expect(error?.message).toBe(
        `providersDir: provider ${entry.id}: the stored viewing key no longer owns its payTo`,
      );
      expect(error?.message.includes(entry.uivk as string)).toBe(false);
    },
  );
});
