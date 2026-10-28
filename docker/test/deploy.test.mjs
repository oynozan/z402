// Checks of the one-command deployment (compose.yaml, docker/): node --test docker/test/
// The compose checks read the resolved config through the docker CLI with DOCKER_HOST on a dead socket, so they never
// reach a daemon, and with an env file of their own, empty unless a check sets something, so a local .env cannot
// change what they see. They are skipped where no docker CLI with Compose is installed.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (path) => readFileSync(join(ROOT, path), "utf8");

function docker(args, work) {
  return execFileSync("docker", args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      ...(process.env.DOCKER_CONFIG !== undefined && { DOCKER_CONFIG: process.env.DOCKER_CONFIG }),
      DOCKER_HOST: `unix://${join(work, "no-daemon.sock")}`,
    },
  });
}

const resolved = new Map();
/** The services of compose.yaml with every profile, as Compose resolves them with `settings` as the whole .env */
function services(settings = "") {
  if (resolved.has(settings)) return resolved.get(settings);
  const work = mkdtempSync(join(tmpdir(), "z402-deploy-"));
  try {
    const file = join(work, "settings.env");
    writeFileSync(file, settings);
    const args = ["compose", "-f", "compose.yaml", "--env-file", file, "--profile", "agent", "--profile", "smoke"];
    resolved.set(settings, JSON.parse(docker([...args, "config", "--format", "json"], work)).services);
    return resolved.get(settings);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function composeMissing() {
  const work = mkdtempSync(join(tmpdir(), "z402-deploy-"));
  try {
    docker(["compose", "version"], work);
    return false;
  } catch {
    return "needs the docker CLI with Compose";
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
const skip = composeMissing();

/** Seconds in a Go duration as Compose prints it, such as 2m0s */
function seconds(duration) {
  const units = { h: 3600, m: 60, s: 1, ms: 0.001 };
  let total = 0;
  for (const [, n, unit] of duration.matchAll(/(\d+(?:\.\d+)?)(h|ms|m|s)/g)) total += Number(n) * units[unit];
  return total;
}

/** The value after `name` in an argument list */
function flag(args, name) {
  const at = args.indexOf(name);
  assert.ok(at !== -1 && at + 1 < args.length, `${name} is not given in ${args.join(" ")}`);
  return args[at + 1];
}

/** KEY=VALUE lines of an env file, comments and blank lines left out */
function envFile(path) {
  const entries = read(path)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]);
  return Object.fromEntries(entries);
}

const JOBS = ["chain-init", "zallet-init", "wallet-fund", "keygen", "markdown-register"];
/** Healthy only once a model is downloaded and loaded, which a slow link can stretch past any start period */
const WAIT_ON_MODELS = ["llm-model", "embed-model", "llm", "embeddings"];

test("compose: up waits for no model download and starts neither the agent nor the smoke test", { skip }, () => {
  const all = services();
  const core = Object.entries(all).filter(([, s]) => s.profiles === undefined);
  assert.ok(core.length > 0);
  for (const [name, s] of core) {
    for (const [dep, { condition }] of Object.entries(s.depends_on ?? {})) {
      assert.equal(all[dep].profiles, undefined, `${name} depends on ${dep}, which up does not start`);
      if (WAIT_ON_MODELS.includes(dep)) {
        assert.equal(condition, "service_started", `${name} waits for ${dep} with ${condition}`);
      }
    }
  }
  assert.deepEqual(all.agent.profiles, ["agent"]);
});

test("compose: after a reboot every long-running service comes back and no one-shot job runs again", { skip }, () => {
  for (const [name, s] of Object.entries(services())) {
    const oneShot = JOBS.includes(name) || s.profiles !== undefined;
    assert.equal(s.restart, oneShot ? "no" : "unless-stopped", `${name} restarts with ${s.restart}`);
  }
});

test("compose: the smoke profile pays every starter service over the compose network", { skip }, () => {
  const smoke = services().smoke;
  assert.ok(smoke !== undefined, "compose.yaml has no smoke service");
  assert.deepEqual(smoke.profiles, ["smoke"]);
  assert.equal(smoke.image, "z402-node:local");
  // In the entrypoint, so that `docker compose run --rm smoke --page <url>` adds to these flags rather than replace them
  const argv = smoke.entrypoint ?? [];
  assert.deepEqual(smoke.command ?? [], []);
  assert.deepEqual(argv.slice(0, 4), ["node", "--import", "tsx", "apps/smoke/src/main.ts"]);
  const flags = argv.slice(4);
  assert.equal(flags.length % 2, 0, `flags without a value: ${flags.join(" ")}`);
  const given = Object.fromEntries(flags.flatMap((value, i) => (i % 2 === 0 ? [[value, flags[i + 1]]] : [])));
  assert.deepEqual(given, {
    "--llm": "http://llm:4031",
    "--markdown": "http://markdown:4032",
    "--embeddings": "http://embeddings:4033",
    "--dropbox": "http://dropbox:4034",
    "--zallet-url": "http://zallet:28232",
    "--lightwalletd": "http://zaino:8137",
  });
  const waits = Object.fromEntries(Object.entries(smoke.depends_on ?? {}).map(([dep, d]) => [dep, d.condition]));
  assert.deepEqual(waits, {
    "wallet-fund": "service_completed_successfully",
    llm: "service_healthy",
    markdown: "service_healthy",
    embeddings: "service_healthy",
    dropbox: "service_healthy",
  });
});

test("compose: the facilitator's start period outlasts its wait for Zaino and its own start", { skip }, () => {
  const deadline = /const TIMEOUT_MS = ([\d_]+);/.exec(read("docker/wait-lightwalletd.mjs"));
  assert.ok(deadline !== null, "docker/wait-lightwalletd.mjs no longer sets TIMEOUT_MS");
  const waitS = Number(deadline[1].replaceAll("_", "")) / 1000;
  const { healthcheck } = services().facilitator;
  // Startup checks, ledger replay and a cold tsx compile after Zaino answers, on a slow CPU
  const ownStartS = 120;
  assert.ok(
    seconds(healthcheck.start_period) >= waitS + ownStartS,
    `start_period ${healthcheck.start_period} ends before wait-lightwalletd's ${waitS} s plus ${ownStartS} s`,
  );
});

test("compose: after a restart the API waits for the facilitator rather than exit and restart", { skip }, () => {
  const { api, facilitator } = services();
  const script = (api.command ?? []).join("\n");
  const wait = script.indexOf("node docker/wait-facilitator.mjs");
  assert.ok(wait !== -1, "the API's command does not run docker/wait-facilitator.mjs");
  assert.ok(wait < script.indexOf("apps/api/src/main.ts"), "the API starts before it waits for the facilitator");
  const deadline = /const TIMEOUT_MS = ([\d_]+);/.exec(read("docker/wait-facilitator.mjs"));
  assert.ok(deadline !== null, "docker/wait-facilitator.mjs no longer sets TIMEOUT_MS");
  const waitS = Number(deadline[1].replaceAll("_", "")) / 1000;
  const startS = seconds(facilitator.healthcheck.start_period);
  assert.ok(waitS >= startS, `wait-facilitator gives up after ${waitS} s, before the facilitator's start period ends`);
  const apiStart = api.healthcheck.start_period;
  assert.ok(seconds(apiStart) >= waitS, `the API's start_period ${apiStart} ends before its wait of ${waitS} s`);
});

test("compose: after a restart Zallet waits for Zebra's RPC, then runs its image's entrypoint", { skip }, () => {
  const { zallet } = services();
  const [shell, flag, script = "", zero] = zallet.entrypoint ?? [];
  assert.deepEqual([shell, flag, zero], ["/bin/sh", "-c", "--"]);
  const wait = script.indexOf("http://zebra:18232/");
  assert.ok(wait !== -1 && wait < script.indexOf("exec "), "Zallet starts before it waits for Zebra's RPC");
  // Compose prints a $ of the script as $$
  const dockerfile = read("docker/zallet.Dockerfile");
  const entrypoint = JSON.parse(/^ENTRYPOINT\s+(\[.*\])$/m.exec(dockerfile)?.[1] ?? "[]");
  assert.ok(entrypoint.length > 0, "docker/zallet.Dockerfile has no ENTRYPOINT");
  const exec = new RegExp(`exec ${entrypoint.join(" ").replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")} "\\$\\$?@"\\n?$`);
  assert.match(script, exec);
  assert.deepEqual(zallet.command, JSON.parse(/^CMD\s+(\[.*\])$/m.exec(dockerfile)?.[1] ?? "null"));
});

test("compose: Zallet's sync logs warnings only, which at info is thousands of lines a second", { skip }, () => {
  const directives = (services().zallet.environment?.RUST_LOG ?? "").split(",");
  assert.ok(directives.includes("zallet_core::components::sync=warn"), `RUST_LOG is ${directives.join(",")}`);
});

/** The services that mount a named volume, each with "ro" or "rw" */
function mounts(all, volume) {
  const found = {};
  for (const [name, s] of Object.entries(all)) {
    for (const v of s.volumes ?? []) {
      if (v.type === "volume" && v.source === volume) found[name] = v.read_only ? "ro" : "rw";
    }
  }
  return found;
}

/** The mount target of a named volume in one service */
function mountOf(service, volume) {
  const found = (service.volumes ?? []).find((v) => v.type === "volume" && v.source === volume);
  assert.ok(found !== undefined, `${volume} is not mounted`);
  return found.target;
}

test("compose: each volume that holds a secret reaches only the containers that use it", { skip }, () => {
  const all = services();
  assert.deepEqual(mounts(all, "keys"), { keygen: "rw", facilitator: "ro" });
  assert.deepEqual(mounts(all, "markdown-keys"), { keygen: "rw", "markdown-register": "ro" });
  // The payTo and API key of provider 2, which only markdown-register writes
  assert.deepEqual(mounts(all, "markdown-runtime"), { "markdown-register": "rw", markdown: "ro" });
  // The facilitator token, which is the operator's API key
  const operator = { keygen: "rw", facilitator: "ro", api: "ro", llm: "ro", embeddings: "ro", dropbox: "ro" };
  assert.deepEqual(mounts(all, "runtime"), operator);
  // The provider registry, which holds the UIVK of every provider
  assert.deepEqual(mounts(all, "facilitator-data"), { facilitator: "rw" });
});

test("compose: markdown is provider 2, with its own payTo and API key from markdown-register", { skip }, () => {
  const all = services();
  const { markdown, keygen } = all;
  const register = all["markdown-register"];
  // No keys volume, and not the operator's runtime volume either
  assert.deepEqual((markdown.volumes ?? []).map((v) => v.source), ["markdown-runtime"]);
  const own = mountOf(markdown, "markdown-runtime");
  assert.equal(markdown.environment.Z402_PAY_TO_FILE, `${own}/pay-to`);
  assert.equal(markdown.environment.Z402_FACILITATOR_TOKEN_FILE, `${own}/api-key`);
  // A payTo or token in services/markdown/.env would shadow the files
  assert.equal(markdown.environment.Z402_PAY_TO, "");
  assert.equal(markdown.environment.Z402_FACILITATOR_TOKEN, "");

  // The job writes pay-to and api-key into --out, and reads the keys file that keygen generates
  assert.equal(flag(register.entrypoint, "--out"), mountOf(register, "markdown-runtime"));
  const keysFile = flag(register.entrypoint, "--keys");
  const inJob = mountOf(register, "markdown-keys");
  assert.ok(keysFile.startsWith(`${inJob}/`), `--keys ${keysFile} is outside ${inJob}`);
  const generated = `${mountOf(keygen, "markdown-keys")}${keysFile.slice(inJob.length)}`;
  assert.ok(keygen.command.join("\n").includes(generated), `keygen does not generate ${generated}`);

  const waits = (s) => Object.fromEntries(Object.entries(s.depends_on ?? {}).map(([dep, d]) => [dep, d.condition]));
  assert.deepEqual(waits(register), { keygen: "service_completed_successfully", facilitator: "service_healthy" });
  assert.equal(waits(markdown)["markdown-register"], "service_completed_successfully");
  // docker compose restart starts the job beside the facilitator, which it then waits for
  const deadline = /const TIMEOUT_MS = ([\d_]+);/.exec(read("docker/register-provider.mjs"));
  assert.ok(deadline !== null, "docker/register-provider.mjs no longer sets TIMEOUT_MS");
  const waitS = Number(deadline[1].replaceAll("_", "")) / 1000;
  assert.ok(waitS >= seconds(all.facilitator.healthcheck.start_period), `markdown-register gives up after ${waitS} s`);

  for (const name of ["api", "llm", "embeddings", "dropbox"]) {
    assert.equal(mountOf(all[name], "runtime"), "/run/z402", name);
  }
  for (const name of ["llm", "embeddings", "dropbox"]) {
    assert.equal(all[name].environment.Z402_PAY_TO_FILE, "/run/z402/pay-to", name);
    assert.equal(all[name].environment.Z402_FACILITATOR_TOKEN_FILE, "/run/z402/facilitator-token", name);
  }
});

test("compose: the facilitator is never published, keeps providers on its volume, serves the catalog", { skip }, () => {
  const { facilitator, web, discover, ...rest } = services();
  assert.deepEqual(facilitator.ports ?? [], [], "the facilitator's port is published");
  assert.ok(facilitator.environment.Z402_PROVIDERS_DIR?.startsWith(`${mountOf(facilitator, "facilitator-data")}/`));
  assert.equal(rest.discovery, undefined, "the discovery container is back");
  assert.equal(web.environment.DISCOVERY_URL, "http://facilitator:4022");
  assert.equal(flag(discover.entrypoint, "--discovery"), "http://facilitator:4022");

  // A registration token in .env reaches the facilitator and the job that registers provider 2 alike
  const gated = services("Z402_REGISTRATION_TOKEN=t-registration\n");
  assert.equal(gated.facilitator.environment.Z402_REGISTRATION_TOKEN, "t-registration");
  assert.equal(gated["markdown-register"].environment.Z402_REGISTRATION_TOKEN, "t-registration");
});

test("wait-facilitator: waits for a facilitator that is not up yet, sends its token, prints nothing", async () => {
  const work = mkdtempSync(join(tmpdir(), "z402-wait-"));
  const listen = (server, port) => new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  try {
    const tokenFile = join(work, "facilitator-token");
    writeFileSync(tokenFile, "t-wait-facilitator\n");
    const free = createServer();
    await listen(free, 0);
    const { port } = free.address();
    await new Promise((resolve) => free.close(resolve));

    const child = spawn(process.execPath, [join(ROOT, "docker/wait-facilitator.mjs"), tokenFile], {
      env: { PATH: process.env.PATH, Z402_FACILITATOR_URL: `http://127.0.0.1:${port}` },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let printed = "";
    child.stdout.on("data", (d) => (printed += d));
    child.stderr.on("data", (d) => (printed += d));
    const exited = new Promise((resolve) => child.on("exit", resolve));
    await new Promise((resolve) => setTimeout(resolve, 2500));
    assert.equal(child.exitCode, null, "it stopped waiting before the facilitator listened");

    const seen = [];
    // A facilitator refusing the probe has still started, which is all the API needs to know
    const facilitator = createServer((req, res) => {
      seen.push([req.method, req.url, req.headers.authorization]);
      res.writeHead(401).end();
    });
    await listen(facilitator, port);
    try {
      assert.equal(await exited, 0);
    } finally {
      facilitator.close();
    }
    assert.deepEqual(seen, [["GET", "/supported", "Bearer t-wait-facilitator"]]);
    assert.equal(printed, "");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

const REGISTER = join(ROOT, "docker/register-provider.mjs");
const BECH32 = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const bech32 = (length) => Array.from(randomBytes(length), (byte) => BECH32[byte % 32]).join("");
/** An API key in the facilitator's format: z402_ and 32 random bytes in base64url */
const newApiKey = () => `z402_${randomBytes(32).toString("base64url")}`;
const providerIdOf = (payTo) =>
  createHash("sha256").update(`z402-provider-v1\nzcash:regtest\n${payTo}`).digest("hex").slice(0, 16);

/** A keys file as `zdecrypt keygen --network regtest` writes it, with made-up values, and an empty directory to fill */
function registerWork() {
  const work = mkdtempSync(join(tmpdir(), "z402-register-"));
  const keys = {
    network: "regtest",
    seedHex: randomBytes(32).toString("hex"),
    ufvk: `uviewregtest1${bech32(300)}`,
    uivk: `uivkregtest1${bech32(200)}`,
    address: `uregtest1${bech32(150)}`,
    addressDiversifierIndex: "0",
    addressReceivers: { orchard: true, sapling: true, transparent: false },
    orchardOnlyAddress: `uregtest1${bech32(100)}`,
    orchardOnlyDiversifierIndex: "0",
  };
  const keysFile = join(work, "merchant-regtest.json");
  writeFileSync(keysFile, `${JSON.stringify(keys, null, 2)}\n`, { mode: 0o600 });
  const out = join(work, "out");
  mkdirSync(out);
  // The payTo is public, but the job prints the provider id in its place
  const secrets = [keys.seedHex, keys.ufvk, keys.uivk, keys.address, keys.orchardOnlyAddress];
  return { work, keys, keysFile, out, payTo: keys.orchardOnlyAddress, secrets };
}

/**
 * The provider routes of a facilitator (design §4.1), as far as markdown-register uses them: GET /providers/me knows
 * the keys it issued, and POST /providers issues one, rotating out the payTo's old one. `refuse(req, n)` may answer the
 * nth request in its place with [status, body].
 */
async function stubFacilitator({ refuse, port = 0 } = {}) {
  const keys = new Map();
  const issued = [];
  const seen = [];
  const provider = (payTo) => ({ providerId: providerIdOf(payTo), network: "zcash:regtest", payTo });
  const issue = (payTo) => {
    const rotated = [...keys.values()].includes(payTo);
    for (const [key, owner] of keys) if (owner === payTo) keys.delete(key);
    const apiKey = newApiKey();
    keys.set(apiKey, payTo);
    issued.push(apiKey);
    return { apiKey, rotated };
  };
  const answer = (req, body) => {
    if (req.method === "GET" && req.url === "/providers/me") {
      const payTo = keys.get(/^Bearer (\S+)$/.exec(req.headers.authorization ?? "")?.[1]);
      return payTo === undefined ? [401, { error: "unauthorized" }] : [200, provider(payTo)];
    }
    if (req.method === "POST" && req.url === "/providers") {
      const { apiKey, rotated } = issue(body.payTo);
      return [rotated ? 200 : 201, { ...provider(body.payTo), apiKey }];
    }
    return [404, { error: "not_found" }];
  };
  const server = createServer((req, res) => {
    let text = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => (text += chunk));
    req.on("end", () => {
      const body = text === "" ? undefined : JSON.parse(text);
      seen.push([req.method, req.url, req.headers.authorization, body]);
      const [status, json] = refuse?.(req, seen.length) ?? answer(req, body);
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(json));
    });
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    keys,
    issued,
    seen,
    issue,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** One run of docker/register-provider.mjs on the work directory, with stdout and stderr together */
function registerProvider(ctx, url, { args = [], env = {} } = {}) {
  const child = spawn(process.execPath, [REGISTER, "--keys", ctx.keysFile, "--out", ctx.out, ...args], {
    // A short wait, so that a run that retries by mistake fails the test rather than hang it
    env: { PATH: process.env.PATH, Z402_FACILITATOR_URL: url, Z402_FACILITATOR_WAIT_MS: "10000", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let printed = "";
  child.stdout.on("data", (d) => (printed += d));
  child.stderr.on("data", (d) => (printed += d));
  return new Promise((resolve) => child.on("close", (code) => resolve({ code, printed })));
}

/** Fails when the output quotes a secret, whole or in part */
function assertQuiet(printed, secrets) {
  for (const secret of secrets) {
    const pieces = [secret, secret.slice(10, 34)].filter((piece) => piece.length >= 8);
    assert.ok(pieces.every((piece) => !printed.includes(piece)), "the output quotes a secret");
  }
}

/** A run against the stub that prints none of the keys file, the keys the stub issued, or `secrets` */
async function register(ctx, stub, { secrets = [], ...o } = {}) {
  const result = await registerProvider(ctx, stub.url, o);
  assertQuiet(result.printed, [...ctx.secrets, ...stub.issued, ...secrets]);
  return result;
}

/** Each file's inode, time, mode and text, which a rewrite with the same text still changes */
function filesOf(dir) {
  return Object.fromEntries(
    readdirSync(dir).map((name) => {
      const s = statSync(join(dir, name));
      return [name, [s.ino, s.mtimeMs, s.mode, readFileSync(join(dir, name), "utf8")]];
    }),
  );
}

test("register-provider: a first run writes the payTo and a 0600 API key, a second changes nothing", async () => {
  const ctx = registerWork();
  const stub = await stubFacilitator();
  try {
    const first = await register(ctx, stub);
    assert.equal(first.code, 0, first.printed);
    assert.deepEqual(stub.seen, [["POST", "/providers", undefined, { payTo: ctx.payTo, uivk: ctx.keys.uivk }]]);
    const [apiKey] = stub.issued;
    assert.deepEqual(readdirSync(ctx.out).sort(), ["api-key", "pay-to"]);
    assert.equal(readFileSync(join(ctx.out, "api-key"), "utf8"), `${apiKey}\n`);
    assert.equal(readFileSync(join(ctx.out, "pay-to"), "utf8"), `${ctx.payTo}\n`);
    for (const name of ["api-key", "pay-to"]) assert.equal(statSync(join(ctx.out, name)).mode & 0o777, 0o600, name);
    assert.match(first.printed, new RegExp(`registered provider ${providerIdOf(ctx.payTo)}`));

    // What every later docker compose up does: the key still works, so nothing is registered or written
    const before = filesOf(ctx.out);
    const second = await register(ctx, stub);
    assert.equal(second.code, 0, second.printed);
    assert.deepEqual(stub.seen.slice(1), [["GET", "/providers/me", `Bearer ${apiKey}`, undefined]]);
    assert.deepEqual(filesOf(ctx.out), before);
    assert.deepEqual(stub.issued, [apiKey]);
  } finally {
    await stub.close();
    rmSync(ctx.work, { recursive: true, force: true });
  }
});

test("register-provider: registers again when the stored key no longer works for this payTo", async (t) => {
  const stored = {
    "a key the facilitator never issued": () => newApiKey(),
    "a key rotated out since": (stub, ctx) => {
      const old = stub.issue(ctx.payTo).apiKey;
      stub.issue(ctx.payTo);
      return old;
    },
    "another provider's key": (stub) => stub.issue(`uregtest1${bech32(100)}`).apiKey,
  };
  for (const [name, plant] of Object.entries(stored)) {
    await t.test(name, async () => {
      const ctx = registerWork();
      const stub = await stubFacilitator();
      try {
        const old = plant(stub, ctx);
        writeFileSync(join(ctx.out, "api-key"), `${old}\n`, { mode: 0o600 });
        const result = await register(ctx, stub, { secrets: [old] });
        assert.equal(result.code, 0, result.printed);
        const apiKey = stub.issued.at(-1);
        assert.notEqual(apiKey, old);
        assert.equal(stub.keys.get(apiKey), ctx.payTo);
        assert.equal(readFileSync(join(ctx.out, "api-key"), "utf8"), `${apiKey}\n`);
        assert.equal(readFileSync(join(ctx.out, "pay-to"), "utf8"), `${ctx.payTo}\n`);
        // The stored key goes to GET /providers/me alone, and the registration carries no key
        assert.deepEqual(
          stub.seen.map(([method, path, authorization]) => [method, path, authorization]),
          [
            ["GET", "/providers/me", `Bearer ${old}`],
            ["POST", "/providers", undefined],
          ],
        );
        assert.match(result.printed, /registering again/);
        assert.match(result.printed, /restart the server that reads/);
      } finally {
        await stub.close();
        rmSync(ctx.work, { recursive: true, force: true });
      }
    });
  }

  await t.test("a key for this payTo on another network", async () => {
    const ctx = registerWork();
    const testnet = { providerId: providerIdOf(ctx.payTo), network: "zcash:testnet", payTo: ctx.payTo };
    const stub = await stubFacilitator({ refuse: (req) => (req.method === "GET" ? [200, testnet] : undefined) });
    try {
      const old = newApiKey();
      writeFileSync(join(ctx.out, "api-key"), `${old}\n`, { mode: 0o600 });
      const result = await register(ctx, stub, { secrets: [old] });
      assert.equal(result.code, 0, result.printed);
      assert.deepEqual(
        stub.seen.map(([method, path]) => `${method} ${path}`),
        ["GET /providers/me", "POST /providers"],
      );
      assert.equal(readFileSync(join(ctx.out, "api-key"), "utf8"), `${stub.issued[0]}\n`);
    } finally {
      await stub.close();
      rmSync(ctx.work, { recursive: true, force: true });
    }
  });

  await t.test("a file that holds no key, which is never sent", async () => {
    const ctx = registerWork();
    const stub = await stubFacilitator();
    try {
      writeFileSync(join(ctx.out, "api-key"), "\n", { mode: 0o600 });
      const result = await register(ctx, stub);
      assert.equal(result.code, 0, result.printed);
      assert.deepEqual(
        stub.seen.map(([method, path]) => `${method} ${path}`),
        ["POST /providers"],
      );
      assert.equal(readFileSync(join(ctx.out, "api-key"), "utf8"), `${stub.issued[0]}\n`);
    } finally {
      await stub.close();
      rmSync(ctx.work, { recursive: true, force: true });
    }
  });
});

test("register-provider: the temporary files of a run that died before its renames are not in the way", async () => {
  const ctx = registerWork();
  const stub = await stubFacilitator();
  try {
    writeFileSync(join(ctx.out, "api-key.tmp"), "z402_", { mode: 0o600 });
    writeFileSync(join(ctx.out, "pay-to.tmp"), "", { mode: 0o600 });
    const result = await register(ctx, stub);
    assert.equal(result.code, 0, result.printed);
    assert.deepEqual(readdirSync(ctx.out).sort(), ["api-key", "pay-to"]);
    assert.equal(readFileSync(join(ctx.out, "api-key"), "utf8"), `${stub.issued[0]}\n`);
    assert.equal(readFileSync(join(ctx.out, "pay-to"), "utf8"), `${ctx.payTo}\n`);
  } finally {
    await stub.close();
    rmSync(ctx.work, { recursive: true, force: true });
  }
});

test("register-provider: --rotate gets a new API key while the stored one still works", async () => {
  const ctx = registerWork();
  const stub = await stubFacilitator();
  try {
    assert.equal((await register(ctx, stub)).code, 0);
    const [old] = stub.issued;
    const result = await register(ctx, stub, { args: ["--rotate"] });
    assert.equal(result.code, 0, result.printed);
    assert.deepEqual(
      stub.seen.map(([method, path]) => `${method} ${path}`),
      ["POST /providers", "POST /providers"],
    );
    const apiKey = stub.issued.at(-1);
    assert.equal(stub.keys.has(old), false);
    assert.equal(readFileSync(join(ctx.out, "api-key"), "utf8"), `${apiKey}\n`);
    assert.match(result.printed, new RegExp(`provider ${providerIdOf(ctx.payTo)} has a new API key`));
    assert.match(result.printed, /restart the server that reads/);
  } finally {
    await stub.close();
    rmSync(ctx.work, { recursive: true, force: true });
  }
});

test("register-provider: waits for a facilitator that is not up yet, and retries a 5xx", async () => {
  const ctx = registerWork();
  const free = createServer();
  await new Promise((resolve) => free.listen(0, "127.0.0.1", resolve));
  const { port } = free.address();
  await new Promise((resolve) => free.close(resolve));
  let stub;
  try {
    let done = false;
    const running = registerProvider(ctx, `http://127.0.0.1:${port}`).then((result) => ((done = true), result));
    await new Promise((resolve) => setTimeout(resolve, 2500));
    assert.equal(done, false, "it stopped waiting before the facilitator listened");

    const busy = [503, { error: "internal_error" }];
    stub = await stubFacilitator({ port, refuse: (_req, n) => (n === 1 ? busy : undefined) });
    const result = await running;
    assert.equal(result.code, 0, result.printed);
    assertQuiet(result.printed, [...ctx.secrets, ...stub.issued]);
    assert.deepEqual(
      stub.seen.map(([method, path]) => `${method} ${path}`),
      ["POST /providers", "POST /providers"],
    );
    assert.equal(readFileSync(join(ctx.out, "api-key"), "utf8"), `${stub.issued[0]}\n`);
  } finally {
    await stub?.close();
    rmSync(ctx.work, { recursive: true, force: true });
  }
});

test("register-provider: a refused registration fails with what it means and writes nothing", async (t) => {
  const TOKEN = "t-registration-wrong";
  const WITH_TOKEN = { Z402_REGISTRATION_TOKEN: TOKEN };
  const NO_WAIT = { Z402_FACILITATOR_WAIT_MS: "0" };
  const refusals = [
    ["401, no registration token", 401, { error: "unauthorized" }, {}, /401 unauthorized: .*set Z402_REGISTRATION_TOKEN/],
    ["401, a wrong registration token", 401, { error: "unauthorized" }, WITH_TOKEN, /refused the registration token/],
    ["403 not_owner", 403, { error: "not_owner", message: "uivk: does not own payTo" }, {}, /403 not_owner: the UIVK/],
    ["403 provider_limit", 403, { error: "provider_limit" }, {}, /403 provider_limit: .*no provider slot/],
    ["403 registration_disabled", 403, { error: "registration_disabled" }, {}, /registration_disabled: .*takes no/],
    ["409 operator", 409, { error: "operator" }, {}, /409 operator: the payTo is the facilitator operator's own/],
    [
      "400 invalid_request, with the facilitator's message",
      400,
      { error: "invalid_request", message: "uivk: not a regtest UIVK" },
      {},
      /400 invalid_request: uivk: not a regtest UIVK$/m,
    ],
    ["a 5xx past the wait", 503, { error: "internal_error" }, NO_WAIT, /answered 503, given up after 0 s/],
  ];
  for (const [name, status, body, env, expected] of refusals) {
    await t.test(name, async () => {
      const ctx = registerWork();
      const stub = await stubFacilitator({ refuse: () => [status, body] });
      try {
        const result = await register(ctx, stub, { env, secrets: [TOKEN] });
        assert.equal(result.code, 1, result.printed);
        assert.match(result.printed, expected);
        assert.deepEqual(readdirSync(ctx.out), []);
        const sent = env.Z402_REGISTRATION_TOKEN === undefined ? undefined : `Bearer ${TOKEN}`;
        assert.deepEqual(stub.seen, [["POST", "/providers", sent, { payTo: ctx.payTo, uivk: ctx.keys.uivk }]]);
      } finally {
        await stub.close();
        rmSync(ctx.work, { recursive: true, force: true });
      }
    });
  }
});

test("register-provider: registers again only on a 401, keeping the stored key on any other answer", async (t) => {
  const answers = [
    ["403", [403, { error: "forbidden" }], /GET \/providers\/me answered 403 forbidden$/m],
    ["404, as from a facilitator without provider routes", [404, { error: "not_found" }], /answered 404 not_found$/m],
    ["200 that names no provider", [200, { ok: true }], /answered 200 without a provider$/m],
  ];
  for (const [name, answer, expected] of answers) {
    await t.test(name, async () => {
      const ctx = registerWork();
      let me = false;
      const stub = await stubFacilitator({ refuse: (req) => (me && req.url === "/providers/me" ? answer : undefined) });
      try {
        assert.equal((await register(ctx, stub)).code, 0);
        const before = filesOf(ctx.out);
        me = true;
        const result = await register(ctx, stub);
        assert.equal(result.code, 1, result.printed);
        assert.match(result.printed, expected);
        assert.deepEqual(
          stub.seen.map(([method, path]) => `${method} ${path}`),
          ["POST /providers", "GET /providers/me"],
        );
        assert.deepEqual(filesOf(ctx.out), before);
      } finally {
        await stub.close();
        rmSync(ctx.work, { recursive: true, force: true });
      }
    });
  }
});

test("register-provider: prints no secret, from keys that do not parse or a facilitator that quotes one", async () => {
  const ctx = registerWork();
  const TOKEN = "t-registration-quoted";
  const quoted = `uivk ${ctx.keys.uivk} with token ${TOKEN} for ${ctx.payTo}`;
  const stub = await stubFacilitator({ refuse: () => [400, { error: "invalid_request", message: quoted }] });
  try {
    // A keys file cut short after the seed, which JSON.parse would quote in its error
    writeFileSync(ctx.keysFile, `{"network":"regtest","seedHex":"${ctx.keys.seedHex}","uivk":"${ctx.keys.uivk}"`);
    const cut = await register(ctx, stub);
    assert.equal(cut.code, 1);
    assert.match(cut.printed, /cannot read the keys in .*\(not JSON\)/);
    assert.deepEqual(stub.seen, []);

    writeFileSync(ctx.keysFile, JSON.stringify(ctx.keys));
    const refused = await register(ctx, stub, { env: { Z402_REGISTRATION_TOKEN: TOKEN }, secrets: [TOKEN] });
    assert.equal(refused.code, 1);
    assert.match(refused.printed, /POST \/providers answered 400 invalid_request$/m);
  } finally {
    await stub.close();
    rmSync(ctx.work, { recursive: true, force: true });
  }
});

test("register-provider: prints no part of a secret that runs past the cut of a long message", async () => {
  const ctx = registerWork();
  // The UIVK starts within the first 300 characters and ends past them
  const quoted = `${"the view-only key does not decode: ".repeat(4)}${ctx.keys.uivk}`;
  const stub = await stubFacilitator({ refuse: () => [400, { error: "invalid_request", message: quoted }] });
  try {
    const result = await register(ctx, stub);
    assert.equal(result.code, 1);
    assert.match(result.printed, /POST \/providers answered 400 invalid_request$/m);
  } finally {
    await stub.close();
    rmSync(ctx.work, { recursive: true, force: true });
  }
});

/** Qwen 2.5's training context, which caps a llama.cpp slot */
const QWEN_TRAIN_CTX = 32768;
/** ChatML markers, plus Qwen's default system prompt when none is sent: 13 to 29 tokens measured */
const TEMPLATE_TOKENS = 32;
/** The llm service's own LLM_MAX_PROMPT_CHARS, in force when docker/env/llm.env leaves it out */
const LLM_DEFAULT_PROMPT_CHARS = 8000;

test("llm: a prompt and a system prompt of the Docker maximum fit one llama.cpp slot", { skip }, () => {
  const chars = Number(envFile("docker/env/llm.env").LLM_MAX_PROMPT_CHARS ?? LLM_DEFAULT_PROMPT_CHARS);
  const args = services()["llm-model"].command;
  const slot = Math.min(Number(flag(args, "--ctx-size")) / Number(flag(args, "--parallel")), QWEN_TRAIN_CTX);
  // The service counts UTF-16 units and checks the prompt and the system prompt apart. A byte-level BPE token covers
  // at least one UTF-8 byte and a UTF-16 unit takes at most three, so 1600 Bamum letters are 4782 Qwen tokens.
  const worst = 2 * 3 * chars + TEMPLATE_TOKENS;
  assert.ok(worst < slot, `${chars}-character prompts may be ${worst} tokens; llama.cpp refuses over ${slot - 1}, once paid`);
});

/** nomic-embed-text's training context */
const NOMIC_TRAIN_CTX = 2048;

test("embeddings: one input of the Docker maximum fits the embedding model's batch", { skip }, () => {
  const perInput = Number(envFile("docker/env/embeddings.env").EMBEDDINGS_MAX_INPUT_CHARS);
  assert.ok(perInput > 0, "docker/env/embeddings.env must cap EMBEDDINGS_MAX_INPUT_CHARS");
  const args = services()["embed-model"].command;
  const batch = Math.min(Number(flag(args, "--ctx-size")), Number(flag(args, "--ubatch-size")), NOMIC_TRAIN_CTX);
  // llama.cpp's WordPiece takes at most one token per code point, plus [CLS] and [SEP]
  assert.ok(perInput + 2 <= batch, `a ${perInput}-character input may be ${perInput + 2} tokens, over ${batch}`);
});

const DOCKERFILES = readdirSync(join(ROOT, "docker"))
  .filter((name) => name.endsWith(".Dockerfile"))
  .map((name) => `docker/${name}`);

/** The instructions of a Dockerfile, continuation lines joined and comments left out */
function instructions(path) {
  return read(path)
    .replace(/\\\n/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

function stages(path) {
  const all = [];
  for (const line of instructions(path)) {
    const from = /^FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?/i.exec(line);
    if (from !== null) all.push({ base: from[1], name: from[2], lines: [] });
    else all.at(-1)?.lines.push(line);
  }
  return all;
}

/** A tag that names one release: x.y.z, a llama.cpp build number, or a digest */
const EXACT = /@sha256:[0-9a-f]{64}$|:[^:/]*\d+\.\d+\.\d+[^:/]*$|:[^:/]*\bb\d+$/;

test("images: every base image and tool is pinned to one release", () => {
  const refs = [];
  for (const path of DOCKERFILES) {
    const names = new Set(stages(path).map((s) => s.name));
    for (const line of instructions(path)) {
      const arg = /^ARG\s+\w+_IMAGE=(\S+)/.exec(line);
      if (arg !== null) refs.push([path, arg[1]]);
      const from = /^FROM\s+(?:--platform=\S+\s+)?(\S+)/.exec(line);
      if (from !== null && !from[1].startsWith("$") && !names.has(from[1])) refs.push([path, from[1]]);
      for (const [, tool] of line.matchAll(/npm install --global (\S+)/g)) refs.push([path, tool.replace("@", ":")]);
    }
  }
  for (const [, image] of read("compose.yaml").matchAll(/^\s+image:\s+(\S+)/gm)) {
    if (!image.endsWith(":local")) refs.push(["compose.yaml", image]);
  }
  assert.ok(refs.length >= 8, `found only ${refs.length} image references`);
  for (const [path, ref] of refs) assert.match(ref, EXACT, `${path}: ${ref} is not one release`);
});

const NORMALIZES = /^RUN\b.*\bchmod -R\b[^&;]*\ba\+rX\b/;

/** Whether files of a stage may still carry the modes they had on the host; an upstream image (undefined) does not */
function hostModes(stage, all) {
  if (stage === undefined || stage.lines.some((line) => NORMALIZES.test(line))) return false;
  const named = (name) => all.find((s) => s.name === name);
  return (
    hostModes(named(stage.base), all) ||
    stage.lines.some((line) => {
      if (!/^COPY\b/.test(line) || /--chown=|--chmod=/.test(line)) return false;
      const from = /--from=(\S+)/.exec(line)?.[1];
      return from === undefined || hostModes(named(from), all);
    })
  );
}

test("images: what the node user reads does not depend on the host's umask", () => {
  // COPY keeps the modes of the build context, and a checkout made under umask 027 or 077 is unreadable to others
  for (const path of DOCKERFILES) {
    const all = stages(path);
    for (const line of all.at(-1).lines.filter((l) => /^COPY\b/.test(l) && !/--chown=|--chmod=/.test(l))) {
      const from = /--from=(\S+)/.exec(line)?.[1];
      assert.ok(from !== undefined, `${path}: "${line}" copies the build context with the host's modes`);
      assert.ok(!hostModes(all.find((s) => s.name === from), all), `${path}: "${line}" keeps the host's modes`);
    }
  }
});

const GIVES_TO_NODE = /^RUN\b.*\bchown\s+(?:-\S+\s+)*node:node\s+([^&;|]+)/;

test("images: every named volume of a Node container has its mount point in the image, owned by node", { skip }, () => {
  // A fresh named volume takes the owner of its mount point in the image, which is root when the image lacks it
  const lines = stages("docker/node.Dockerfile").at(-1).lines;
  const owned = new Set(lines.flatMap((line) => GIVES_TO_NODE.exec(line)?.[1].trim().split(/\s+/) ?? []));
  const targets = Object.entries(services())
    .filter(([, s]) => s.image === "z402-node:local")
    .flatMap(([name, s]) => (s.volumes ?? []).filter((v) => v.type === "volume").map((v) => [name, v.target]));
  assert.ok(targets.length > 0);
  for (const [name, target] of targets) {
    assert.ok(owned.has(target), `${name} mounts a volume on ${target}, which node.Dockerfile does not give to node`);
  }
});

test(".dockerignore keeps settings, keys and local state out of every image", () => {
  const rules = new Set(
    read(".dockerignore")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#")),
  );
  const needed = [".env", "**/.env", "**/.env.*", "!**/.env.example", ".secrets", ".data", ".tools", "wallets"];
  for (const rule of [...needed, "docker/env", "docker/test.env", "compose.yaml"]) {
    assert.ok(rules.has(rule), `.dockerignore lacks ${rule}`);
  }
});
