// Checks of the one-VPS deployment (compose.vps.yaml, docker/caddy/, scripts/vps.sh): node --test docker/test/
// The compose checks read the resolved config through the docker CLI with DOCKER_HOST on a dead socket, so they never
// reach a daemon, and with an env file of their own, so that a local .env.vps cannot change what they see. They are
// skipped where no docker CLI with Compose is installed. The script checks run bash on a copy of scripts/vps.sh in a
// temporary directory and need no Docker at all.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
/** The services of compose.vps.yaml as Compose resolves them with `settings` as the whole env file */
function services(settings = "", files = ["compose.vps.yaml"]) {
  const key = `${files.join(",")}\n${settings}`;
  if (resolved.has(key)) return resolved.get(key);
  const work = mkdtempSync(join(tmpdir(), "z402-vps-"));
  try {
    const file = join(work, "settings.env");
    writeFileSync(file, settings);
    const args = ["compose", ...files.flatMap((f) => ["-f", f]), "--env-file", file, "config", "--format", "json"];
    resolved.set(key, JSON.parse(docker(args, work)));
    return resolved.get(key);
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

/** A checkout with nothing but the script and the template, and a way to run the script in it */
function checkout() {
  const dir = mkdtempSync(join(tmpdir(), "z402-vps-sh-"));
  mkdirSync(join(dir, "scripts"));
  copyFileSync(join(ROOT, "scripts/vps.sh"), join(dir, "scripts/vps.sh"));
  copyFileSync(join(ROOT, ".env.vps.example"), join(dir, ".env.vps.example"));
  const run = (args, input = "") => {
    const r = spawnSync("bash", ["scripts/vps.sh", ...args], { cwd: dir, encoding: "utf8", input });
    return { status: r.status, out: r.stdout, err: r.stderr, all: `${r.stdout}${r.stderr}` };
  };
  const env = () => readFileSync(join(dir, ".env.vps"), "utf8");
  return { dir, run, env, done: () => rmSync(dir, { recursive: true, force: true }) };
}

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

test("vps.sh passes shellcheck", { skip: shellcheckMissing }, () => {
  const r = spawnSync("shellcheck", ["-S", "warning", "scripts/vps.sh"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});
