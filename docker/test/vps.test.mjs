// Checks of the one-VPS deployment (compose.vps.yaml, docker/caddy/, scripts/vps.sh): node --test docker/test/
// The compose checks read the resolved config through the docker CLI with DOCKER_HOST on a dead socket, so they never
// reach a daemon, and with an env file of their own, so that a local .env.vps cannot change what they see. They are
// skipped where no docker CLI with Compose is installed. The script checks run bash on a copy of scripts/vps.sh in a
// temporary directory and need no Docker at all.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (path) => readFileSync(join(ROOT, path), "utf8");

function docker(args, work, extraEnv = {}) {
  return execFileSync("docker", args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      ...(process.env.DOCKER_CONFIG !== undefined && { DOCKER_CONFIG: process.env.DOCKER_CONFIG }),
      DOCKER_HOST: `unix://${join(work, "no-daemon.sock")}`,
      ...extraEnv,
    },
  });
}

/** A registration token that compose.vps.yaml accepts. The file refuses to be resolved without one */
const TOKEN = "t".repeat(40);

const resolved = new Map();
/** The services of compose.vps.yaml as Compose resolves them with `settings` as the whole env file */
function services(settings = "", files = ["compose.vps.yaml"]) {
  const text = /^Z402_REGISTRATION_TOKEN=/m.test(settings) ? settings : `Z402_REGISTRATION_TOKEN=${TOKEN}\n${settings}`;
  const key = `${files.join(",")}\n${text}`;
  if (resolved.has(key)) return resolved.get(key);
  const work = mkdtempSync(join(tmpdir(), "z402-vps-"));
  try {
    const file = join(work, "settings.env");
    writeFileSync(file, text);
    const args = ["compose", ...files.flatMap((f) => ["-f", f]), "--env-file", file, "config", "--format", "json"];
    resolved.set(key, JSON.parse(docker(args, work)));
    return resolved.get(key);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** What `docker compose config` says when it refuses, or undefined when it resolves; `env` is exported to it */
function refusal(settings, env = {}) {
  const work = mkdtempSync(join(tmpdir(), "z402-vps-"));
  try {
    const file = join(work, "settings.env");
    writeFileSync(file, settings);
    docker(["compose", "-f", "compose.vps.yaml", "--env-file", file, "config", "--format", "json"], work, env);
    return undefined;
  } catch (e) {
    return String(e.stderr);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function composeMissing() {
  const work = mkdtempSync(join(tmpdir(), "z402-vps-"));
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

const bashMissing = spawnSync("bash", ["--version"]).error !== undefined ? "needs bash" : false;
const shellcheckMissing = spawnSync("shellcheck", ["--version"]).error !== undefined ? "needs shellcheck" : false;
const tarMissing = spawnSync("tar", ["--version"]).error !== undefined ? "needs tar" : false;

const ON = "COMPOSE_PROFILES=services\n";
const STARTER = ["llm", "markdown", "embeddings", "dropbox"];
const ALWAYS = ["caddy", "facilitator", "web", "api"];
const GIB = 1024 ** 3;

const names = (config) => Object.keys(config.services).sort();

test("vps compose: the starter services belong to the services profile and nothing else does", { skip }, () => {
  assert.deepEqual(names(services()), [...ALWAYS].sort());
  assert.deepEqual(names(services(ON)), [...ALWAYS, ...STARTER].sort());
  for (const name of STARTER) {
    assert.deepEqual(services(ON).services[name].profiles, ["services"], name);
  }
});

test("vps compose: only Caddy publishes a port, 80 and 443 unless the settings move them", { skip }, () => {
  const published = (config) =>
    Object.entries(config.services).flatMap(([name, s]) =>
      (s.ports ?? []).map((p) => `${name} ${p.host_ip ?? ""}:${p.published}->${p.target}/${p.protocol}`),
    );
  assert.deepEqual(published(services(ON)), [
    "caddy 0.0.0.0:80->80/tcp",
    "caddy 0.0.0.0:443->443/tcp",
    "caddy 0.0.0.0:443->443/udp",
  ]);
  const moved = services("Z402_PUBLISH_HOST=127.0.0.1\nZ402_HTTP_PORT=18080\nZ402_HTTPS_PORT=18443\n");
  assert.deepEqual(published(moved), [
    "caddy 127.0.0.1:18080->80/tcp",
    "caddy 127.0.0.1:18443->443/tcp",
    "caddy 127.0.0.1:18443->443/udp",
  ]);
  // The redirect from www keeps a port that is not 443, and in production the suffix is empty
  assert.equal(moved.services.caddy.environment.Z402_PORT_SUFFIX, ":18443");
  assert.equal(services().services.caddy.environment.Z402_PORT_SUFFIX ?? "", "");
});

test("vps compose: testnet, the operator's view-only keys, no seed, and a facilitator only Caddy reaches", { skip }, () => {
  const { facilitator } = services().services;
  const env = facilitator.environment;
  assert.equal(env.Z402_NETWORK, "testnet");
  assert.equal(env.Z402_LWD_URL, "https://testnet.zec.rocks:443");
  assert.equal(services("Z402_LWD_URL=https://lwd.example:443\n").services.facilitator.environment.Z402_LWD_URL, "https://lwd.example:443");
  for (const name of ["Z402_PAY_TO", "Z402_UIVK", "Z402_FACILITATOR_TOKEN", "Z402_REGISTRATION_TOKEN"]) {
    assert.ok(Object.hasOwn(env, name), `${name} is not passed to the facilitator`);
  }
  const keyed = services("Z402_PAY_TO=utest1x\nZ402_UIVK=uivktest1x\nZ402_REGISTRATION_TOKEN=t\n").services.facilitator;
  assert.equal(keyed.environment.Z402_PAY_TO, "utest1x");
  assert.equal(keyed.environment.Z402_UIVK, "uivktest1x");
  assert.equal(keyed.environment.Z402_REGISTRATION_TOKEN, "t");

  // Nothing of the facilitator, the API or the services can hold a seed: no keys file, no seed in any name
  for (const [name, s] of Object.entries(services(ON).services)) {
    const names = Object.keys(s.environment ?? {});
    assert.ok(!names.some((n) => /SEED|MERCHANT_KEYS_FILE|UFVK/i.test(n)), `${name} is given a seed or a keys file`);
    assert.deepEqual(s.volumes?.filter((v) => v.type === "bind") ?? [], [], `${name} mounts a host path`);
  }

  assert.deepEqual(facilitator.ports ?? [], [], "the facilitator's port is published");
  // The ledger and the providers directory are on the one named volume, at a path the node user owns
  const mount = facilitator.volumes.find((v) => v.type === "volume" && v.source === "facilitator-data");
  assert.ok(mount !== undefined);
  assert.ok(env.Z402_LEDGER.startsWith(`${mount.target}/`));
  assert.ok(env.Z402_PROVIDERS_DIR.startsWith(`${mount.target}/`));
  assert.ok(read("docker/node.Dockerfile").includes(` ${mount.target} `), `${mount.target} is not made in the node image`);
});

test("vps compose: the facilitator's healthcheck asks the public /supported", { skip }, () => {
  const { test: command } = services().services.facilitator.healthcheck;
  assert.deepEqual(command.slice(-1), ["http://127.0.0.1:4022/supported"]);
});

test("vps compose: an empty, missing or exported-empty registration token stops compose itself", { skip }, () => {
  // Plain docker compose, with no scripts/vps.sh in front: the facilitator never starts with POST /providers open
  const why = /required variable Z402_REGISTRATION_TOKEN is missing a value.*POST \/providers would be open/;
  assert.match(refusal("Z402_PAY_TO=utest1x\n") ?? "", why, "a missing token");
  assert.match(refusal("Z402_REGISTRATION_TOKEN=\n") ?? "", why, "an empty token");
  assert.equal(refusal(`Z402_REGISTRATION_TOKEN=${TOKEN}\n`), undefined, "a token of 40 characters");
  // Compose prefers the environment to the env file, even when the variable there is empty
  assert.match(refusal(`Z402_REGISTRATION_TOKEN=${TOKEN}\n`, { Z402_REGISTRATION_TOKEN: "" }) ?? "", why, "an empty export");
  assert.equal(refusal("Z402_REGISTRATION_TOKEN=\n", { Z402_REGISTRATION_TOKEN: TOKEN }), undefined, "an export over an empty file");
  assert.ok(!(refusal("") ?? "").includes(TOKEN), "the message shows a token");
});

test("vps compose: the facilitator's command refuses a token under 32 characters before it waits for lightwalletd", { skip }, () => {
  const [shell, flag, script] = services().services.facilitator.command;
  assert.deepEqual([shell, flag], ["sh", "-c"]);
  // Compose prints a $ of the script as $$
  const run = (token) => {
    const work = mkdtempSync(join(tmpdir(), "z402-vps-cmd-"));
    try {
      const bin = join(work, "bin");
      mkdirSync(bin);
      writeFileSync(join(bin, "node"), `#!/bin/sh\necho "$*" >> "${join(work, "node.log")}"\n`, { mode: 0o755 });
      const env = { PATH: `${bin}:${process.env.PATH}`, ...(token !== undefined && { Z402_REGISTRATION_TOKEN: token }) };
      const r = spawnSync("sh", ["-c", script.replaceAll("$$", "$")], { cwd: work, env, encoding: "utf8" });
      const calls = existsSync(join(work, "node.log")) ? readFileSync(join(work, "node.log"), "utf8").trim().split("\n") : [];
      return { status: r.status, err: r.stderr, calls };
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  };
  for (const token of [undefined, "", "short", "x".repeat(31)]) {
    const r = run(token);
    assert.notEqual(r.status, 0, `a token of ${token?.length ?? "no"} characters started the facilitator`);
    assert.deepEqual(r.calls, [], "node ran before the token was checked");
    if (token !== undefined) assert.match(r.err, /fewer than 32 characters/);
    assert.ok(!r.err.includes("short"), "the token is shown");
  }
  const ok = run("x".repeat(32));
  assert.equal(ok.status, 0, ok.err);
  assert.deepEqual(ok.calls, ["--import tsx docker/wait-lightwalletd.mjs", "--import tsx packages/facilitator/src/main.ts"]);
});

test("vps compose: every service restarts, has a healthcheck, rotates its logs and has a memory limit", { skip }, () => {
  for (const [name, s] of Object.entries(services(ON).services)) {
    assert.equal(s.restart, "unless-stopped", name);
    assert.ok(s.healthcheck?.test?.length > 0, `${name} has no healthcheck`);
    assert.equal(s.logging?.driver, "json-file", name);
    assert.ok(s.logging.options["max-size"] !== undefined && s.logging.options["max-file"] !== undefined, `${name} keeps its log whole`);
    assert.ok(Number(s.mem_limit) > 0, `${name} has no mem_limit`);
  }
});

test("vps compose: the memory limits fit a 4 GB server, with the starter services and without", { skip }, () => {
  const total = (config) => Object.values(config.services).reduce((sum, s) => sum + Number(s.mem_limit), 0);
  // Room is left for the kernel, dockerd, the page cache and a shell: 4 GB less at least 600 MiB
  assert.ok(total(services(ON)) <= 4 * GIB - 600 * 1024 ** 2, `${total(services(ON)) / GIB} GiB of limits`);
  assert.ok(total(services()) < total(services(ON)));
});

test("vps compose: the website is built for its public origin and reads the catalog over the compose network", { skip }, () => {
  const { web } = services().services;
  assert.equal(web.build.args.NEXT_PUBLIC_SITE_URL, "https://z402.net");
  assert.equal(web.environment.DISCOVERY_URL, "http://facilitator:4022");
  assert.equal(services("Z402_DOMAIN=example.org\n").services.web.build.args.NEXT_PUBLIC_SITE_URL, "https://example.org");
  assert.match(read("docker/web.Dockerfile"), /^ARG NEXT_PUBLIC_SITE_URL=$/m);
});

test("vps compose: the API is public at api.<domain> and reaches the facilitator at its https name", { skip }, () => {
  for (const [domain, settings] of [["z402.net", ""], ["example.org", "Z402_DOMAIN=example.org\n"]]) {
    const { services: all } = services(settings);
    assert.equal(all.api.environment.Z402_API_PUBLIC_URL, `https://api.${domain}`);
    // apps/api refuses a plain http:// facilitator off regtest, unless it is on loopback; the alias keeps the name inside
    assert.equal(all.api.environment.Z402_FACILITATOR_URL, `https://facilitator.${domain}`);
    assert.deepEqual(all.caddy.networks.default.aliases, [`facilitator.${domain}`]);
    assert.equal(all.api.environment.Z402_NETWORK, "testnet");
    assert.deepEqual(Object.keys(all.api.depends_on).sort(), ["caddy", "facilitator"]);
  }
});

test("vps compose: each starter service has its own public origin and calls the facilitator over the compose network", { skip }, () => {
  const { services: all } = services(ON);
  for (const name of STARTER) {
    assert.equal(all[name].environment.PUBLIC_URL, `https://${name}.z402.net`, name);
    assert.equal(all[name].environment.Z402_FACILITATOR_URL, "http://facilitator:4022", name);
    assert.equal(all[name].environment.Z402_NETWORK, "testnet", name);
  }
  // llm and embeddings call a hosted provider, and no model runs on the server
  assert.ok(!Object.hasOwn(all, "llm-model") && !Object.hasOwn(all, "embed-model"));
  const hosted = services(ON + "Z402_LLM_BASE_URL=https://p.example/v1\nZ402_LLM_API_KEY=k\nZ402_LLM_MODEL=m\n").services.llm.environment;
  assert.deepEqual([hosted.LLM_BASE_URL, hosted.LLM_API_KEY, hosted.LLM_MODEL], ["https://p.example/v1", "k", "m"]);
  assert.equal(all.dropbox.environment.DROPBOX_LWD_URL, "https://testnet.zec.rocks:443");
});

test("vps compose: the trial on one machine adds the CA hand-over to the API and nothing else", { skip }, () => {
  const plain = services().services;
  const local = services("Z402_TLS=internal\n", ["compose.vps.yaml", "compose.vps.local.yaml"]).services;
  assert.equal(local.caddy.environment.Z402_TLS, "internal");
  assert.equal(plain.caddy.environment.Z402_TLS, "acme");
  assert.equal(plain.api.environment.NODE_EXTRA_CA_CERTS, undefined);
  assert.equal(local.api.environment.NODE_EXTRA_CA_CERTS, "/caddy-config/local-root.crt");
  // The API reads the CA's certificate from Caddy's config volume, never from caddy-data, which holds the CA's key. No
  // volume of its own, so that docker compose down -v with compose.vps.yaml alone removes everything
  assert.deepEqual(local.api.volumes.map((v) => `${v.source}:${v.target}:${v.read_only ?? false}`), ["caddy-config:/caddy-config:true"]);
  assert.equal(Object.keys(services("Z402_TLS=internal\n", ["compose.vps.yaml", "compose.vps.local.yaml"]).volumes).sort().join(), Object.keys(services().volumes).sort().join());
  assert.ok(!local.caddy.volumes.some((v) => v.source === "caddy-data" && v.target !== "/data"));
});

test("caddy: the image is one pinned release, and its Caddyfile gives the services a site only in their profile", () => {
  const dockerfile = read("docker/caddy/Dockerfile");
  const pinned = /^ARG CADDY_IMAGE=(caddy:\d+\.\d+\.\d+(?:-[a-z0-9]+)?)$/m.exec(dockerfile);
  assert.ok(pinned !== null, "docker/caddy/Dockerfile does not pin an official caddy release");
  assert.match(dockerfile, /^FROM \$\{CADDY_IMAGE\}$/m);

  const main = read("docker/caddy/Caddyfile");
  const profile = read("docker/caddy/profiles/services/services.caddy");
  const site = (text, host) => new RegExp(`^${host.replace(".", "\\.")}\\.\\{\\$Z402_DOMAIN:z402\\.net\\} \\{$`, "m").test(text);
  for (const host of ["facilitator", "api", "www"]) assert.ok(site(main, host), `${host} has no site`);
  assert.match(main, /^\{\$Z402_DOMAIN:z402\.net\} \{$/m);

  const { services: all } = services(ON);
  const port = (name) => all[name].environment.PORT ?? { facilitator: "4022", api: "4021", web: "3000" }[name];
  assert.match(main, /reverse_proxy web:3000/);
  assert.match(main, /reverse_proxy facilitator:4022/);
  assert.match(main, /reverse_proxy api:4021/);
  for (const name of STARTER) {
    assert.ok(site(profile, name), `${name} has no site in the profile`);
    assert.ok(!site(main, name), `${name} has a site outside the profile`);
    assert.ok(profile.includes(`reverse_proxy ${name}:${port(name)}\n`), `${name} is not proxied to ${port(name)}`);
  }
  // The profile's directory is picked by the environment, and an empty profile matches no file
  assert.match(main, /^import \/etc\/caddy\/profiles\/\{\$Z402_PROFILES:none\}\/\*\.caddy$/m);
  assert.equal(services().services.caddy.environment.Z402_PROFILES, "");
  assert.equal(services(ON).services.caddy.environment.Z402_PROFILES, "services");
  // Every site takes its certificate setting from the one switch
  assert.match(main, /import tls_\{\$Z402_TLS:acme\}/);
});

/** The Caddyfile of the working tree through `caddy adapt` in the pinned image, or why that cannot be done here */
function adaptedCaddyfile() {
  const pin = /^ARG CADDY_IMAGE=(\S+)$/m.exec(read("docker/caddy/Dockerfile"))?.[1];
  const r = spawnSync("docker", ["run", "--rm", "-i", "--pull", "never", "--entrypoint", "caddy", pin ?? "caddy", "adapt", "--config", "/dev/stdin", "--adapter", "caddyfile"], {
    input: read("docker/caddy/Caddyfile"),
    encoding: "utf8",
    timeout: 60_000,
  });
  if (r.error !== undefined || r.status !== 0) return { skip: `needs a Docker daemon and the ${pin} image: ${r.error?.code ?? r.stderr.split("\n")[0]}` };
  return { config: JSON.parse(r.stdout) };
}
const adapted = adaptedCaddyfile();

const CUT = ["request>headers>Payment-Signature", "request>headers>X-Payment", "request>headers>Authorization", "request>uri"];

test("caddy: the error log never records a voucher header, Authorization or the request URI", () => {
  const main = read("docker/caddy/Caddyfile");
  const global = /^\{\n([\s\S]*?)^\}$/m.exec(main)?.[1] ?? "";
  assert.match(global, /^\tlog \{$/m, "the global options have no log block");
  assert.match(global, /format filter \{\s+wrap json\s+fields \{/);
  for (const field of CUT) {
    assert.match(global, new RegExp(`^\\s+${field} delete$`, "m"), `${field} is not deleted from the log`);
  }
  // The admin API's own requests stay out, as before, and nothing makes the log the access log of every site
  assert.match(global, /^\t\texclude admin\.api$/m);
  assert.ok(!/^\s+log\b/m.test(main.replace(global, "")), "a site has a log of its own that the filter does not cover");
});

test("caddy: the adapted config carries the filter, from the pinned image", { skip: adapted.skip }, () => {
  const log = adapted.config.logging.logs.default;
  assert.equal(log.encoder.format, "filter");
  assert.equal(log.encoder.wrap.format, "json");
  assert.deepEqual(Object.keys(log.encoder.fields).sort(), [...CUT].sort());
  for (const field of CUT) assert.equal(log.encoder.fields[field].filter, "delete", field);
  assert.deepEqual(log.exclude, ["admin.api"]);
});

test("the settings template, .gitignore and .dockerignore keep .env.vps and its keys out of git and the images", () => {
  const ignored = read(".gitignore").split("\n");
  assert.ok(ignored.includes(".env.vps") && ignored.includes(".secrets/"));
  assert.ok(!ignored.includes(".env.vps.example"));
  const rules = read(".dockerignore").split("\n");
  for (const rule of ["**/.env.*", "compose.vps.yaml", "compose.vps.local.yaml", "docker/caddy"]) {
    assert.ok(rules.includes(rule), `.dockerignore lacks ${rule}`);
  }
  const template = read(".env.vps.example");
  for (const line of ["Z402_DOMAIN=z402.net", "Z402_FACILITATOR_TOKEN=", "Z402_REGISTRATION_TOKEN=", "Z402_PAY_TO=", "Z402_UIVK="]) {
    assert.ok(template.split("\n").includes(line), `${line} is missing from .env.vps.example`);
  }
  // Starter services stay off in the template, and no seed has a place in it
  assert.ok(!/^COMPOSE_PROFILES=/m.test(template));
  assert.ok(!/seed/i.test(template.replace(/Never a seed/, "")));
});

// scripts/vps.sh ----------------------------------------------------------------------------------------------------

const UIVK = "uivktest1qpzry9x8gf2tvdw0s3jn54khce6mua7lqpzry9x8gf2tvdw0s3jn54khce6mua7l";
const PAY_TO = "utest1qpzry9x8gf2tvdw0s3jn54khce6mua7lqpzry9x8gf2tvdw0s3jn54khce6mua7l";
const view = (o = {}) => JSON.stringify({ network: "testnet", uivk: UIVK, orchardOnlyAddress: PAY_TO, ...o }, null, 2);

/**
 * A checkout with nothing but the script and the template, and a way to run the script in it. `fake` puts a docker in
 * front of the real one on PATH that records its calls in `calls()` and does what the FAKE_* variables say
 */
function checkout() {
  const dir = mkdtempSync(join(tmpdir(), "z402-vps-sh-"));
  mkdirSync(join(dir, "scripts"));
  copyFileSync(join(ROOT, "scripts/vps.sh"), join(dir, "scripts/vps.sh"));
  copyFileSync(join(ROOT, ".env.vps.example"), join(dir, ".env.vps.example"));
  const bin = join(dir, "fakebin");
  const log = join(dir, "docker.log");
  let fake = false;
  const run = (args, input = "", { env = {}, cwd = dir, timeout } = {}) => {
    const path = fake ? { PATH: `${bin}:${process.env.PATH}`, FAKE_LOG: log, FAKE_RESTORE_STDIN: join(dir, "restore.stdin") } : {};
    const r = spawnSync("bash", [join(dir, "scripts/vps.sh"), ...args], {
      cwd,
      encoding: "utf8",
      input,
      timeout,
      env: { ...process.env, ...path, ...env },
    });
    return { status: r.status, out: r.stdout, err: r.stderr, all: `${r.stdout}${r.stderr}` };
  };
  const env = () => readFileSync(join(dir, ".env.vps"), "utf8");
  const useFakeDocker = () => {
    fake = true;
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "docker"), FAKE_DOCKER, { mode: 0o755 });
  };
  /** The compose subcommands that were called, in order, one per line */
  const calls = () =>
    existsSync(log)
      ? readFileSync(log, "utf8")
          .trim()
          .split("\n")
          .filter((l) => l !== "")
          .map((l) => l.replace(/^compose (?:(?:-f|--env-file|--profile) \S+ ?)*/, ""))
      : [];
  return { dir, run, env, useFakeDocker, calls, done: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A docker that is not one: `info` and `compose version` answer, and the rest is as the FAKE_* variables say */
const FAKE_DOCKER = `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_LOG"
[ "$1" = compose ] || exit 0
shift
while [ $# -gt 0 ]; do
  case $1 in
    -f | --env-file | --profile) shift 2 ;;
    *) break ;;
  esac
done
sub=\${1:-}
[ $# -gt 0 ] && shift
case $sub in
  config) printf 'api\\ncaddy\\nfacilitator\\nweb\\n' ;;
  ps)
    case " $* " in
      *" --quiet "*) ;;
      *" --format "*) echo "facilitator running starting" ;;
      *) echo "NAME STATUS (the fake ps)" ;;
    esac
    ;;
  logs) echo "the fake log of $*" ;;
  up)
    case \${FAKE_UP:-ok} in
      hang) exec sleep 300 ;;
      fail) echo "the fake up failed" >&2; exit 1 ;;
    esac
    ;;
  run)
    case " $* " in
      *" --entrypoint tar "*)
        [ -z "\${FAKE_TAR_FILE:-}" ] || cat "$FAKE_TAR_FILE"
        exit "\${FAKE_TAR_RC:-0}"
        ;;
      *" --entrypoint sh "*)
        cat > "$FAKE_RESTORE_STDIN"
        exit "\${FAKE_RESTORE_RC:-0}"
        ;;
    esac
    ;;
esac
exit 0
`;

/** A tar.gz in `dir` of the files `entries` names (a name ending in / is a directory), and a symlink if asked */
function archive(dir, name, entries, { symlink } = {}) {
  const src = join(dir, `${name}.src`);
  mkdirSync(src, { recursive: true });
  for (const entry of entries) {
    if (entry.endsWith("/")) mkdirSync(join(src, entry), { recursive: true });
    else writeFileSync(join(src, entry), `${entry}\n`);
  }
  if (symlink !== undefined) symlinkSync("/etc/hostname", join(src, symlink));
  const out = join(dir, `${name}.tar.gz`);
  const r = spawnSync("tar", ["-czf", out, "-C", src, "."], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return out;
}

const LEDGER = "facilitator-ledger.testnet.jsonl";
const PROVIDERS = "providers.testnet";

test("vps.sh init: new random tokens in a 0600 file, none printed, and an existing file is never replaced", { skip: bashMissing }, () => {
  const c = checkout();
  try {
    const first = c.run(["init", "example.org"]);
    assert.equal(first.status, 0, first.all);
    const env = c.env();
    const token = (name) => new RegExp(`^${name}=([0-9a-f]{64})$`, "m").exec(env)?.[1];
    assert.ok(token("Z402_FACILITATOR_TOKEN") && token("Z402_REGISTRATION_TOKEN"));
    assert.notEqual(token("Z402_FACILITATOR_TOKEN"), token("Z402_REGISTRATION_TOKEN"));
    assert.match(env, /^Z402_DOMAIN=example\.org$/m);
    assert.equal(statSync(join(c.dir, ".env.vps")).mode & 0o777, 0o600);
    assert.ok(!first.all.includes(token("Z402_FACILITATOR_TOKEN")) && !first.all.includes(token("Z402_REGISTRATION_TOKEN")));

    const before = env;
    const second = c.run(["init"]);
    assert.equal(second.status, 1);
    assert.match(second.err, /never overwrites/);
    assert.equal(c.env(), before, "the second init changed the file");
    assert.equal(c.run(["init", "not a domain"]).status, 1);
  } finally {
    c.done();
  }
});

test("vps.sh keys: imports only the view-only file, never prints the viewing key, refuses the seed", { skip: bashMissing }, () => {
  const c = checkout();
  try {
    assert.match(c.run(["keys"]).out, /never reaches this\s+server/);
    assert.equal(c.run(["keys", "-"], view()).status, 1, "keys needs .env.vps first");
    c.run(["init"]);

    const ok = c.run(["keys", "-"], view());
    assert.equal(ok.status, 0, ok.all);
    assert.ok(!ok.all.includes(UIVK), "the viewing key was printed");
    assert.ok(ok.out.includes(PAY_TO), "the payTo is public and is shown for comparison");
    assert.match(c.env(), new RegExp(`^Z402_PAY_TO=${PAY_TO}$`, "m"));
    assert.match(c.env(), new RegExp(`^Z402_UIVK=${UIVK}$`, "m"));
    assert.equal(statSync(join(c.dir, ".env.vps")).mode & 0o777, 0o600);
    assert.equal(c.env().match(/^Z402_PAY_TO=/gm).length, 1);

    const after = c.env();
    const seed = "ab".repeat(32);
    const refused = [
      [view({ seedHex: seed }), /spending seed/],
      [view({ ufvk: "uviewtest1x" }), /spending seed or the full viewing key/],
      [view({ network: "mainnet" }), /mainnet/],
      [view({ note: "x" }), /not a view-only keys file/],
      [view({ uivk: "uivkregtest1qqq" }), /testnet unified incoming viewing key/],
      [view({ orchardOnlyAddress: "uregtest1qqq" }), /testnet shielded-only unified address/],
      ["not json", /not a view-only keys file/],
      ["", /empty or longer/],
    ];
    for (const [text, why] of refused) {
      const r = c.run(["keys", "-"], text);
      assert.equal(r.status, 1, text.slice(0, 40));
      assert.match(r.err, why);
      assert.ok(!r.all.includes(seed) && !r.all.includes(UIVK), "a key was echoed");
    }
    assert.equal(c.env(), after, "a refused file changed .env.vps");

    // Another account would not open the ledger of this one, so it needs --force
    const other = view({ orchardOnlyAddress: "utest1zzzzzzzzzzzzzzzzzzzzzzzz" });
    assert.equal(c.run(["keys", "-"], other).status, 1);
    assert.equal(c.run(["keys", "--force", "-"], other).status, 0);
    assert.match(c.env(), /^Z402_PAY_TO=utest1zzzzzzzzzzzzzzzzzzzzzzzz$/m);
  } finally {
    c.done();
  }
});

test("vps.sh up: a setting that would only fail later stops it before Docker is asked", { skip: bashMissing }, () => {
  const c = checkout();
  try {
    assert.match(c.run(["up"]).err, /\.env\.vps does not exist/);
    c.run(["init"]);
    assert.match(c.run(["up"]).err, /keys are not imported/);
    c.run(["keys", "-"], view());

    // Each of these ends in an error of its own and none reaches `docker`, so they hold with no Docker installed
    const append = (text) => writeFileSync(join(c.dir, ".env.vps"), `${c.env()}${text}\n`);
    const fails = (why) => {
      const r = c.run(["up"]);
      assert.equal(r.status, 1, r.all);
      assert.match(r.err, why);
    };
    append("Z402_REGISTRATION_TOKEN=short");
    fails(/fewer than 32 characters/);
    append("Z402_REGISTRATION_TOKEN=" + "a".repeat(32));
    append("Z402_TLS=selfsigned");
    fails(/Z402_TLS must be acme or internal/);
    append("Z402_TLS=acme");
    append("COMPOSE_PROFILES=agent");
    fails(/COMPOSE_PROFILES must be empty or services/);
    append("COMPOSE_PROFILES=services");
    fails(/Z402_LLM_BASE_URL is empty/);
    append("Z402_LLM_BASE_URL=https://p.example/v1\nZ402_LLM_MODEL=m\nZ402_EMBEDDINGS_BASE_URL=https://p.example/v1");
    fails(/Z402_EMBEDDINGS_MODEL is empty/);

    assert.equal(c.run(["nonsense"]).status, 2);
    assert.match(c.run(["help"]).out, /init \[domain\]/);
  } finally {
    c.done();
  }
});

/** A checkout with .env.vps made, the keys imported, and a docker that is a fake one */
function readyCheckout() {
  const c = checkout();
  c.run(["init"]);
  c.run(["keys", "-"], view());
  c.useFakeDocker();
  return c;
}

test("vps.sh up: an exported registration token that is empty or short stops it, whatever .env.vps holds", { skip: bashMissing }, () => {
  const c = readyCheckout();
  try {
    // .env.vps holds a good token (init), and docker compose prefers the environment to it, empty or not
    for (const token of ["", "short"]) {
      const r = c.run(["up"], "", { env: { Z402_REGISTRATION_TOKEN: token } });
      assert.equal(r.status, 1, r.all);
      assert.match(r.err, /exported in this shell and is empty or has fewer than 32 characters/);
      assert.ok(!r.all.includes("short"), "the token is shown");
      assert.deepEqual(c.calls(), [], "docker was asked before the token was checked");
    }
    // The same for a short token in the file, which is the other way to open registration
    writeFileSync(join(c.dir, ".env.vps"), `${c.env()}Z402_REGISTRATION_TOKEN=\n`);
    const empty = c.run(["up"]);
    assert.equal(empty.status, 1);
    assert.match(empty.err, /Z402_REGISTRATION_TOKEN in \.env\.vps is empty or has fewer than 32 characters/);
    assert.deepEqual(c.calls(), []);
  } finally {
    c.done();
  }
});

test("vps.sh up: a compose up that never returns is stopped at the deadline, and the log of what is not healthy is shown", { skip: bashMissing }, () => {
  const c = readyCheckout();
  try {
    const started = Date.now();
    const r = c.run(["up"], "", { env: { FAKE_UP: "hang", Z402_WAIT_SECONDS: "2" }, timeout: 60_000 });
    assert.equal(r.status, 1, r.all);
    assert.ok(Date.now() - started < 30_000, `up took ${Date.now() - started} ms to give up`);
    assert.match(r.err, /docker compose up did not finish within 2 s \(Z402_WAIT_SECONDS\)/);
    // diagnose ran: the state of the services, the end of the log of the one that is not healthy, and the rest by name
    assert.match(r.err, /--- facilitator \(starting\): the end of its log/);
    assert.match(r.err, /the fake log of .*facilitator/);
    assert.match(r.err, /Not started yet: api caddy web/);
    const calls = c.calls();
    assert.equal(calls.filter((l) => l.startsWith("up -d --build --remove-orphans")).length, 1);
    assert.ok(calls.some((l) => l.startsWith("logs --no-color --tail=30 facilitator")), calls.join("\n"));

    // A compose up that fails at once is shown the same way, and one that succeeds goes on to the wait
    const failed = c.run(["up"], "", { env: { FAKE_UP: "fail", Z402_WAIT_SECONDS: "2" } });
    assert.equal(failed.status, 1);
    assert.match(failed.err, /docker compose up failed/);
    assert.match(failed.err, /--- facilitator/);
    const waited = c.run(["up"], "", { env: { FAKE_UP: "ok", Z402_WAIT_SECONDS: "1" }, timeout: 60_000 });
    assert.match(waited.err, /not every service was healthy after 1 s/);
  } finally {
    c.done();
  }
});

test("vps.sh restore: an archive that is not a facilitator backup is refused before Docker, and the volume is saved before it is replaced", { skip: bashMissing || tarMissing }, () => {
  const c = readyCheckout();
  try {
    const good = archive(c.dir, "good", [LEDGER, `${PROVIDERS}/`, `${PROVIDERS}/registry.json`, `${PROVIDERS}/ledgers/`]);
    const fresh = archive(c.dir, "fresh", [LEDGER, `${PROVIDERS}/`, `${PROVIDERS}/ledgers/`]);
    const refused = [
      ["a text file", join(c.dir, "scripts/vps.sh"), /not a readable tar\.gz/],
      ["a gzip of text", (() => { const f = join(c.dir, "text.gz"); spawnSync("sh", ["-c", `gzip -c scripts/vps.sh > ${f}`], { cwd: c.dir }); return f; })(), /not a readable tar\.gz/],
      ["no ledger", archive(c.dir, "noledger", [`${PROVIDERS}/`, `${PROVIDERS}/registry.json`]), new RegExp(`has no ${LEDGER}`)],
      ["no providers directory", archive(c.dir, "noproviders", [LEDGER, "other.txt"]), new RegExp(`has no ${PROVIDERS} directory`)],
      ["a certificates archive", archive(c.dir, "caddy", ["caddy/", "caddy/pki/", "caddy/pki/root.crt"]), new RegExp(`has no ${LEDGER}`)],
      ["a link", archive(c.dir, "linked", [LEDGER, `${PROVIDERS}/`], { symlink: "escape" }), /holds a link or a device file/],
    ];
    for (const [what, file, why] of refused) {
      const r = c.run(["restore", file], "yes\n");
      assert.equal(r.status, 1, `${what}: ${r.all}`);
      assert.match(r.err, why, what);
      assert.deepEqual(c.calls(), [], `${what}: Docker was asked, so the volume could have been touched`);
    }
    // A name outside the volume: absolute, or with ..
    for (const [what, entry] of [["an absolute path", `${c.dir}/outside.txt`], ["a .. path", "../outside.txt"]]) {
      writeFileSync(join(c.dir, "outside.txt"), "x\n");
      const out = join(c.dir, "escape.tar.gz");
      const r = spawnSync("tar", ["-czPf", out, "-C", join(c.dir, "scripts"), entry], { encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
      const refusal = c.run(["restore", out], "yes\n");
      assert.equal(refusal.status, 1, `${what}: ${refusal.all}`);
      assert.match(refusal.err, /path outside the volume/, what);
      assert.deepEqual(c.calls(), [], what);
    }

    // Not confirmed: nothing is stopped, copied or replaced
    const no = c.run(["restore", good], "no\n");
    assert.equal(no.status, 1);
    assert.match(no.err, /not restored/);
    assert.ok(!c.calls().some((l) => /^(down|run)\b/.test(l)), c.calls().join("\n"));

    // Confirmed: every container down, the volume saved, and only then replaced, with the archive on standard input
    const yes = c.run(["restore", good], "yes\n", { env: { FAKE_TAR_FILE: fresh } });
    assert.equal(yes.status, 0, yes.all);
    const steps = c.calls().filter((l) => /^(down|run)\b/.test(l));
    assert.equal(steps.length, 3, steps.join("\n"));
    assert.match(steps[0], /^down --remove-orphans$/);
    assert.match(steps[1], /^run --rm -T --no-deps --entrypoint tar facilitator -czf -/);
    assert.match(steps[2], /^run --rm -T --no-deps --entrypoint sh facilitator -c /);
    assert.deepEqual(readFileSync(join(c.dir, "restore.stdin")), readFileSync(good), "the backup was not what the restore read");
    const saved = readdirSync(join(c.dir, ".data/backups")).filter((f) => f.startsWith("z402-vps-before-restore-"));
    assert.equal(saved.length, 1);
    assert.deepEqual(readFileSync(join(c.dir, ".data/backups", saved[0])), readFileSync(fresh), "the saved copy is not the volume");
    assert.match(yes.out, /data from before is kept in \.data\/backups\/z402-vps-before-restore-/);
    assert.equal(statSync(join(c.dir, ".data/backups", saved[0])).mode & 0o777, 0o600);

    // The registry file does not exist before the first provider registers, and a backup of that time restores
    const early = c.run(["restore", fresh], "yes\n", { env: { FAKE_TAR_FILE: good } });
    assert.equal(early.status, 0, early.all);
  } finally {
    c.done();
  }
});

test("vps.sh restore: when the copy of the volume fails nothing is replaced, and when the replacement fails the copy is named", { skip: bashMissing || tarMissing }, () => {
  const c = readyCheckout();
  try {
    const good = archive(c.dir, "good", [LEDGER, `${PROVIDERS}/`]);
    const noCopy = c.run(["restore", good], "yes\n", { env: { FAKE_TAR_RC: "2" } });
    assert.equal(noCopy.status, 1);
    assert.match(noCopy.err, /the copy of the current data failed .* so nothing was restored/);
    assert.ok(!c.calls().some((l) => l.startsWith("run --rm -T --no-deps --entrypoint sh ")), "the volume was replaced without a copy");
    assert.deepEqual(readdirSync(join(c.dir, ".data/backups")), [], "a partial copy was left");

    const broken = c.run(["restore", good], "yes\n", { env: { FAKE_TAR_FILE: good, FAKE_RESTORE_RC: "1" } });
    assert.equal(broken.status, 1);
    assert.match(broken.err, /the restore failed\. The data from before it is in \.data\/backups\/z402-vps-before-restore-/);
  } finally {
    c.done();
  }
});

test("vps.sh passes shellcheck", { skip: shellcheckMissing }, () => {
  const r = spawnSync("shellcheck", ["scripts/vps.sh"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});
