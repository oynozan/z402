#!/usr/bin/env node
/*
 * Generates the merchant account with `zdecrypt keygen` and saves it as .secrets/merchant-<network>.json.
 *
 *   node scripts/merchant-keygen.mjs --network <regtest|testnet|mainnet> [--force] [--out <absolute path>]
 *
 * The file holds the seed, which is the only backup of the account. It is created with mode 0600 in a 0700
 * directory. An existing file is replaced only with --force, and the old file is then kept as
 * <file>.replaced-<UTC time> with mode 0600, so no seed is ever destroyed. --out takes an absolute path outside
 * the repository or inside .secrets/, since a key file anywhere else in the work tree can be committed by accident.
 * The only output is the shielded-only address on stdout, plus a backup reminder on stderr. The seed, the UFVK and
 * the UIVK are never printed, and the seed never reaches argv, because zdecrypt draws it from the OS itself.
 * The binary and the default output are found from this file's location, never from the working directory.
 */
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  fchmodSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const ZDECRYPT = join(ROOT, "crates", "zdecrypt", "target", "release", "zdecrypt");
const SECRETS_DIR = join(ROOT, ".secrets");
const ADDRESS_PREFIX = { regtest: "uregtest1", testnet: "utest1", mainnet: "u1" };
const SEED_RE = /^[0-9a-f]{64}$/;

const USAGE = `usage: node scripts/merchant-keygen.mjs --network <regtest|testnet|mainnet> [--force] [--out <absolute path>]

  --network   network of the merchant account (required)
  --force     replace an existing key file, which is kept as <file>.replaced-<UTC time>
  --out       write here instead of .secrets/merchant-<network>.json, an absolute path outside the
              repository or inside its .secrets/ directory

Prints the shielded-only address on stdout. The seed, the UFVK and the UIVK are only written to the file.`;

class Fail extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

/* Arguments */

// Errors never repeat a value, since a seed may have been pasted in the wrong place
function parseArgs(argv) {
  const args = [...argv];
  const opts = { network: undefined, out: undefined, force: false, help: false };
  while (args.length > 0) {
    const token = args.shift();
    const eq = token.startsWith("--") ? token.indexOf("=") : -1;
    const flag = eq < 0 ? token : token.slice(0, eq);
    const take = () => {
      const value = eq < 0 ? args.shift() : token.slice(eq + 1);
      if (value === undefined) throw new Fail(`${flag} needs a value\n\n${USAGE}`, 2);
      return value;
    };
    switch (flag) {
      case "--network":
        opts.network = take();
        break;
      case "--out":
        opts.out = take();
        break;
      case "--force":
      case "-h":
      case "--help":
        if (eq >= 0) throw new Fail(`${flag} takes no value`, 2);
        if (flag === "--force") opts.force = true;
        else opts.help = true;
        break;
      default:
        throw new Fail(`${token.startsWith("--") ? `unknown flag ${flag}` : "unexpected argument"}\n\n${USAGE}`, 2);
    }
  }
  if (opts.help) return opts;
  if (opts.network === undefined) throw new Fail(`--network is required\n\n${USAGE}`, 2);
  if (!Object.hasOwn(ADDRESS_PREFIX, opts.network)) throw new Fail("--network must be regtest, testnet or mainnet", 2);
  if (opts.out !== undefined && !isAbsolute(opts.out)) throw new Fail("--out must be an absolute path", 2);
  return opts;
}

/* Paths */

// Relative to the repo root where the path is inside it
function shown(path) {
  const rel = relative(ROOT, path);
  return rel === "" || rel.startsWith("..") || isAbsolute(rel) ? path : rel;
}

function lstatOrNothing(path) {
  try {
    return lstatSync(path);
  } catch (e) {
    if (e.code === "ENOENT") return undefined;
    throw e;
  }
}

// Where a file at path would really land, with the symlinks of its existing ancestors resolved
function landing(path) {
  const rest = [basename(path)];
  let dir = dirname(path);
  for (;;) {
    try {
      return join(realpathSync.native(dir), ...rest);
    } catch (e) {
      if (e.code !== "ENOENT" || dirname(dir) === dir) throw e;
      rest.unshift(basename(dir));
      dir = dirname(dir);
    }
  }
}

const inside = (base, path) => path === base || path.startsWith(base + sep);

function checkOut(target) {
  const root = realpathSync.native(ROOT);
  const where = landing(target);
  if (inside(root, where) && !inside(join(root, ".secrets"), where)) {
    throw new Fail(
      "--out must be outside the repository or inside its .secrets/ directory, " +
        "since a key file anywhere else in the work tree can be committed by accident",
      2,
    );
  }
}

/* Key generation */

function reasonOf(run) {
  if (run.signal) return ` (killed by ${run.signal})`;
  try {
    const { error } = JSON.parse(run.stdout);
    if (typeof error === "string") return `: ${error.slice(0, 200)}`;
  } catch {
    // stdout is not the error object, so only the exit status is left to report
  }
  return ` (exit ${run.status})`;
}

function generate(network) {
  const run = spawnSync(ZDECRYPT, ["keygen", "--network", network, "--pretty"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (run.error) {
    if (run.error.code === "ENOENT") {
      throw new Fail(`zdecrypt is not built at ${shown(ZDECRYPT)}, run: pnpm --filter @z402/facilitator build:native`);
    }
    throw new Fail(`cannot run zdecrypt (${run.error.code ?? "unknown error"})`);
  }
  if (run.status !== 0) throw new Fail(`zdecrypt keygen failed${reasonOf(run)}`);

  let keys;
  try {
    keys = JSON.parse(run.stdout);
  } catch {
    throw new Fail("zdecrypt keygen did not print JSON");
  }
  const address = keys?.orchardOnlyAddress;
  const sound =
    keys?.network === network &&
    SEED_RE.test(keys.seedHex) &&
    typeof keys.ufvk === "string" &&
    typeof keys.uivk === "string" &&
    typeof address === "string" &&
    address.startsWith(ADDRESS_PREFIX[network]);
  if (!sound) throw new Fail(`zdecrypt keygen printed keys that do not look like a ${network} account`);
  return { address, text: run.stdout.endsWith("\n") ? run.stdout : `${run.stdout}\n` };
}

/* Storage */

function stamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

// A second name for the old file, so that replacing the first one cannot lose it
function keepOld(target) {
  const base = `${target}.replaced-${stamp()}`;
  for (let n = 1; ; n += 1) {
    const name = n === 1 ? base : `${base}-${n}`;
    try {
      linkSync(target, name);
    } catch (e) {
      if (e.code === "EEXIST") continue;
      if (e.code === "ENOENT") return undefined;
      throw e;
    }
    try {
      chmodSync(name, 0o600);
    } catch (e) {
      rmSync(name, { force: true });
      if (e.code === "ENOENT") return undefined;
      throw e;
    }
    return name;
  }
}

// The new directory entry must be durable before the address is shown
function syncDir(dir) {
  const fd = openSync(dir, "r");
  try {
    fsyncSync(fd);
  } catch (e) {
    if (e.code !== "EINVAL" && e.code !== "ENOTSUP") throw e;
  } finally {
    closeSync(fd);
  }
}

// Written to a private temp file first, so a crash never leaves half a seed at the target
function store(target, text, replace) {
  const dir = dirname(target);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (dir === SECRETS_DIR) chmodSync(dir, 0o700);

  const tmp = `${target}.${process.pid}.tmp`;
  const fd = openSync(tmp, "wx", 0o600);
  let kept;
  try {
    try {
      fchmodSync(fd, 0o600);
      writeFileSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (replace) kept = keepOld(target);
    try {
      // link fails if the target exists, rename replaces it, and neither follows a symlink at the target
      if (replace) renameSync(tmp, target);
      else linkSync(tmp, target);
    } catch (e) {
      if (kept) rmSync(kept, { force: true });
      throw e;
    }
  } finally {
    rmSync(tmp, { force: true });
  }
  try {
    syncDir(dir);
  } catch (e) {
    const why = `${e.code ?? "error"}`;
    throw new Fail(`cannot sync the directory of ${shown(target)} (${why}), so the new file may not survive a crash`);
  }
  return kept;
}

function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help) {
    console.log(USAGE);
    return;
  }
  const { network, force } = opts;
  const target = resolve(opts.out ?? join(SECRETS_DIR, `merchant-${network}.json`));
  if (opts.out !== undefined) checkOut(target);

  const refusal = new Fail(
    `refusing to replace ${shown(target)}, which may hold the only copy of a seed (--force replaces it)`,
  );
  const old = lstatOrNothing(target);
  if (old?.isDirectory()) throw new Fail(`${shown(target)} is a directory`);
  if (old && !force) throw refusal;

  const { address, text } = generate(network);
  let kept;
  try {
    kept = store(target, text, old !== undefined);
  } catch (e) {
    throw e.code === "EEXIST" ? refusal : e;
  }

  const modeOf = (path) => (statSync(path).mode & 0o777).toString(8);
  const where = `${shown(target)} (mode ${modeOf(target)})`;
  console.log(address);
  if (network === "mainnet") {
    console.error(`WARNING: MAINNET keys. The seed in ${where} controls real money and is the only backup.`);
    console.error("Copy it to offline storage now, and never share it, commit it or paste it into a log.");
  } else {
    console.error(`Saved ${where}. Its seed is the only backup of this account, keep a copy somewhere safe.`);
  }
  if (kept) {
    console.error(`The file it replaced was kept as ${shown(kept)} (mode ${modeOf(kept)}).`);
    if (network === "mainnet") console.error("Its seed may still control funds, so back it up too.");
  }
}

try {
  main(process.argv.slice(2));
} catch (e) {
  console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = e instanceof Fail ? e.exitCode : 1;
}
