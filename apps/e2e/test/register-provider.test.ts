import { execFile } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("../../../scripts/register-provider.mjs", import.meta.url));
const REPO = fileURLToPath(new URL("../../..", import.meta.url));

const PAY_TO = `uregtest1${"q".repeat(60)}`;
const UIVK = `uivkregtest1${"q".repeat(80)}`;
const API_KEY = `z402_${"A".repeat(20)}-_${"b".repeat(21)}`;
const OTHER_KEY = `z402_${"C".repeat(43)}`;
const PROVIDER_ID = "0123456789abcdef";
const TOKEN = "reg-token.~+/=";

interface Seen {
  method: string;
  url: string;
  authorization: string | undefined;
  body: unknown;
}

interface Reply {
  status: number;
  body: unknown;
}

let dir: string;
let server: Server;
let base: string;
let seen: Seen[];
let reply: Reply;

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "z402-register-"));
  seen = [];
  reply = { status: 201, body: { providerId: PROVIDER_ID, network: "zcash:regtest", payTo: PAY_TO, apiKey: API_KEY } };
  server = createServer((req, res) => {
    void readBody(req).then((body) => {
      seen.push({ method: req.method ?? "", url: req.url ?? "", authorization: req.headers.authorization, body });
      res.writeHead(reply.status, { "content-type": "application/json" }).end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

function keysFile(keys: Record<string, unknown> = { network: "regtest", uivk: UIVK, orchardOnlyAddress: PAY_TO }): string {
  const path = join(dir, "merchant.view.json");
  writeFileSync(path, JSON.stringify(keys));
  return path;
}

function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [SCRIPT, ...args], { cwd: dir }, (error, stdout, stderr) => {
      resolve({ code: error === null ? 0 : typeof error.code === "number" ? error.code : 1, stdout, stderr });
    });
  });
}

function register(extra: string[] = [], out = join(dir, "provider.key")): Promise<{ code: number; stdout: string; stderr: string }> {
  return run(["--keys", keysFile(), "--facilitator", base, "--out", out, ...extra]);
}

/** Nothing secret in either stream */
function expectNoSecrets(r: { stdout: string; stderr: string }): void {
  for (const secret of [API_KEY, OTHER_KEY, UIVK, TOKEN]) {
    expect(r.stdout).not.toContain(secret);
    expect(r.stderr).not.toContain(secret);
  }
}

/** The key file and nothing else, so no staging file is left behind */
function filesIn(): string[] {
  return readdirSync(dir).filter((f) => f !== "merchant.view.json" && f !== "token").sort();
}

describe("register-provider.mjs", () => {
  it("posts the payTo, the UIVK and the network, saves the key with mode 0600 and prints only the ids", async () => {
    const out = join(dir, "provider.key");
    const r = await register([], out);

    expect(r.code).toBe(0);
    expect(seen).toEqual([
      { method: "POST", url: "/providers", authorization: undefined, body: { payTo: PAY_TO, uivk: UIVK, network: "zcash:regtest" } },
    ]);
    expect(readFileSync(out, "utf8")).toBe(`${API_KEY}\n`);
    expect(statSync(out).mode & 0o777).toBe(0o600);
    expect(filesIn()).toEqual(["provider.key"]);
    expect(r.stdout).toBe(`providerId ${PROVIDER_ID}\npayTo ${PAY_TO}\nkey file ${out}\n`);
    expect(r.stderr).toBe("Registered.\n");
    expectNoSecrets(r);
  });

  it("reads only the three fields of a full keys file", async () => {
    const path = keysFile({ network: "regtest", uivk: UIVK, orchardOnlyAddress: PAY_TO, seedHex: "ab".repeat(32), ufvk: "uviewregtest1secret" });
    const r = await run(["--keys", path, "--facilitator", base, "--out", join(dir, "provider.key")]);

    expect(r.code).toBe(0);
    expect(seen[0]?.body).toEqual({ payTo: PAY_TO, uivk: UIVK, network: "zcash:regtest" });
  });

  it("sends the registration token as a bearer and never prints it", async () => {
    const tokenFile = join(dir, "token");
    writeFileSync(tokenFile, `${TOKEN}\n`);
    const r = await register(["--registration-token-file", tokenFile]);

    expect(r.code).toBe(0);
    expect(seen[0]?.authorization).toBe(`Bearer ${TOKEN}`);
    expectNoSecrets(r);
  });

  it("treats 200 as a rotation and says the old key stopped working", async () => {
    reply = { status: 200, body: { ...(reply.body as object), apiKey: OTHER_KEY } };
    const r = await register();

    expect(r.code).toBe(0);
    expect(readFileSync(join(dir, "provider.key"), "utf8")).toBe(`${OTHER_KEY}\n`);
    expect(r.stderr).toContain("its key was rotated, and the old key no longer works");
    expectNoSecrets(r);
  });

  it("refuses an existing key file before asking for a key, and replaces it with --force", async () => {
    const out = join(dir, "provider.key");
    writeFileSync(out, "old\n");

    const refused = await register([], out);
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain("exists, pass --force to replace it");
    expect(seen).toEqual([]);
    expect(readFileSync(out, "utf8")).toBe("old\n");

    const forced = await register(["--force"], out);
    expect(forced.code).toBe(0);
    expect(readFileSync(out, "utf8")).toBe(`${API_KEY}\n`);
    expect(statSync(out).mode & 0o777).toBe(0o600);
    expect(filesIn()).toEqual(["provider.key"]);
  });

  it.each([
    [400, "invalid_request", "uivk: expected a regtest UIVK"],
    [401, "unauthorized", "a registration token is required"],
    [403, "not_owner", "the UIVK does not own payTo"],
    [403, "provider_limit", "the facilitator holds its 32 providers"],
    [403, "registration_disabled", "this facilitator takes no registrations"],
    [409, "operator", "payTo is the operator's"],
    [500, "internal_error", "the registry could not be written"],
  ])("a %i %s refusal exits 1 with its code and message, and leaves no file", async (status, error, message) => {
    reply = { status, body: { error, message, echoed: UIVK } };
    const r = await register();

    expect(r.code).toBe(1);
    expect(r.stderr).toBe(`error: the facilitator refused with ${status} ${error}: ${message}\n`);
    expect(filesIn()).toEqual([]);
    expectNoSecrets(r);
  });

  it("refuses a success answer that does not carry a usable key for this payTo, and saves nothing", async () => {
    for (const body of [
      { providerId: PROVIDER_ID, network: "zcash:regtest", payTo: PAY_TO, apiKey: "not-a-key" },
      { providerId: PROVIDER_ID, network: "zcash:regtest", payTo: `uregtest1${"p".repeat(60)}`, apiKey: API_KEY },
      { providerId: PROVIDER_ID, network: "zcash:testnet", payTo: PAY_TO, apiKey: API_KEY },
      { providerId: "nope", network: "zcash:regtest", payTo: PAY_TO, apiKey: API_KEY },
      "plain text",
    ]) {
      reply = { status: 201, body };
      const r = await register();
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("without a {providerId, network, payTo, apiKey} for this payTo");
      expect(filesIn()).toEqual([]);
      expectNoSecrets(r);
    }
  });

  it("exits 1 when the facilitator cannot be reached, and leaves no file", async () => {
    const r = await run(["--keys", keysFile(), "--facilitator", "http://127.0.0.1:1", "--out", join(dir, "provider.key")]);

    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/^error: cannot reach http:\/\/127\.0\.0\.1:1\/providers: /);
    expect(filesIn()).toEqual([]);
  });

  it("exits 1 on a keys file without a usable uivk and address", async () => {
    const path = keysFile({ network: "regtest", uivk: "uivktest1abc", orchardOnlyAddress: PAY_TO });
    const r = await run(["--keys", path, "--facilitator", base, "--out", join(dir, "provider.key")]);

    expect(r.code).toBe(1);
    expect(r.stderr).toContain("has no uivk and orchardOnlyAddress that fit regtest");
    expect(r.stderr).not.toContain("uivktest1abc");
    expect(seen).toEqual([]);
  });

  it.each([
    [["--facilitator", "http://x", "--out", "/tmp/k"], /--keys is required/],
    [["--keys", "k", "--out", "/tmp/k"], /--facilitator is required/],
    [["--keys", "k", "--facilitator", "http://x"], /--out is required/],
    [["--keys"], /--keys needs a value/],
    [["--bogus"], /unknown flag --bogus/],
    [["--force=yes"], /--force takes no value/],
  ])("exits 2 on the usage error %j", async (args, message) => {
    const r = await run(args);

    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(message);
  });

  it.each([
    ["ftp://127.0.0.1", /--facilitator must be an http\(s\) URL/],
    ["http://user:pw@127.0.0.1", /--facilitator must carry no credentials/],
    ["http://127.0.0.1/?a=1", /--facilitator must carry no query or fragment/],
  ])("exits 2 on the facilitator URL %s", async (url, message) => {
    const r = await run(["--keys", keysFile(), "--facilitator", url, "--out", join(dir, "provider.key")]);

    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(message);
  });

  it("off regtest, sends the UIVK over plaintext http to a loopback host only", async () => {
    const testnet = { network: "testnet", uivk: `uivktest1${"q".repeat(80)}`, orchardOnlyAddress: `utest1${"q".repeat(60)}` };
    const remote = await run(["--keys", keysFile(testnet), "--facilitator", "http://facilitator.example", "--out", join(dir, "k")]);
    expect(remote.code).toBe(2);
    expect(remote.stderr).toContain("use https:// off regtest");

    reply = { status: 201, body: { providerId: PROVIDER_ID, network: "zcash:testnet", payTo: testnet.orchardOnlyAddress, apiKey: API_KEY } };
    const local = await run(["--keys", keysFile(testnet), "--facilitator", base, "--out", join(dir, "k")]);
    expect(local.code).toBe(0);
    expect(seen[0]?.body).toMatchObject({ network: "zcash:testnet" });
  });

  it("refuses a key file in the work tree outside .secrets/", async () => {
    const r = await register([], join(REPO, "apps", "e2e", "provider.key"));

    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--out must be outside the repository or inside its .secrets/ directory");
    expect(seen).toEqual([]);
  });

  it("strips a trailing slash from the facilitator URL", async () => {
    const r = await run(["--keys", keysFile(), "--facilitator", `${base}/`, "--out", join(dir, "provider.key")]);

    expect(r.code).toBe(0);
    expect(seen[0]?.url).toBe("/providers");
  });
});
