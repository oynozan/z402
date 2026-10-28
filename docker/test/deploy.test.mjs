// Checks of the one-command deployment (compose.yaml, docker/): node --test docker/test/
// The compose checks read the resolved config through the docker CLI with DOCKER_HOST on a dead socket, so they never
// reach a daemon, and with an empty env file, so a local .env cannot change what they see. They are skipped where no
// docker CLI with Compose is installed.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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

let resolved;
/** The services of compose.yaml with every profile, as Compose resolves them with no .env */
function services() {
  if (resolved !== undefined) return resolved;
  const work = mkdtempSync(join(tmpdir(), "z402-deploy-"));
  try {
    const empty = join(work, "empty.env");
    writeFileSync(empty, "");
    const args = ["compose", "-f", "compose.yaml", "--env-file", empty, "--profile", "agent", "--profile", "smoke"];
    resolved = JSON.parse(docker([...args, "config", "--format", "json"], work)).services;
    return resolved;
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

const JOBS = ["chain-init", "zallet-init", "wallet-fund", "keygen"];
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

test("compose: the facilitator is never published, and the website and discover read its catalog", { skip }, () => {
  const { facilitator, web, discover, ...rest } = services();
  assert.deepEqual(facilitator.ports ?? [], [], "the facilitator's port is published");
  assert.equal(rest.discovery, undefined, "the discovery container is back");
  assert.equal(web.environment.DISCOVERY_URL, "http://facilitator:4022");
  assert.equal(flag(discover.entrypoint, "--discovery"), "http://facilitator:4022");
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
