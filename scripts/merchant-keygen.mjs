#!/usr/bin/env node
/*
 * Generates the merchant account with `zdecrypt keygen` and saves it as .secrets/merchant-<network>.json.
 *
 *   node scripts/merchant-keygen.mjs --network <regtest|testnet|mainnet> [--force] [--out <absolute path>]
 *   node scripts/merchant-keygen.mjs --view-only --from <keys file> [--force] [--out <absolute path>]
 *
 * The file holds the seed, which is the only backup of the account. It is created with mode 0600 in a 0700
 * directory. An existing file is replaced only with --force, and the old file is then kept as
 * <file>.replaced-<UTC time> with mode 0600, so no seed is ever destroyed. The keys path is never absent: the new
 * file replaces the old one by an atomic rename, after the old one got a second name or, where the filesystem has
 * no hard links, a copy. A rename that fails after that never deletes the kept file, since it may have happened
 * all the same, and the error names both files. A symbolic link is never replaced. --out takes an absolute path
 * outside the repository or inside .secrets/, since a key file anywhere else in the work tree can be committed by
 * accident. A filesystem that does not keep mode 0600 (FAT, exFAT) is refused on mainnet and warned about elsewhere.
 * --view-only makes no key. It reads a keys file and writes .secrets/merchant-<network>.view.json, which holds only
 * the network, the UIVK and the address, so the facilitator can use it with no seed warning.
 * The only output is the shielded-only address on stdout, plus a backup reminder on stderr. The seed, the UFVK and
 * the UIVK are never printed, and the seed never reaches argv, because zdecrypt draws it from the OS itself.
 * The directory entries are fsynced before the run ends, and a failure there still prints the address, with a warning.
 * The binary and the default output are found from this file's location, never from the working directory.
 */
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
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
// The shapes of a unified incoming viewing key that the facilitator accepts, revision 0 then revision 2
const UIVK_RE = {
  regtest: /^(uivkregtest|uviregtest)1[02-9ac-hj-np-z]+$/,
  testnet: /^(uivktest|uvitest)1[02-9ac-hj-np-z]+$/,
  mainnet: /^(uivk|uvi)1[02-9ac-hj-np-z]+$/,
};
const SEED_RE = /^[0-9a-f]{64}$/;
/** More rounds than two writers can cause, so a path that keeps changing is reported instead of looped on */
const MAX_ATTEMPTS = 5;

const USAGE = `usage: node scripts/merchant-keygen.mjs --network <regtest|testnet|mainnet> [--force] [--out <absolute path>]
       node scripts/merchant-keygen.mjs --view-only --from <keys file> [--force] [--out <absolute path>]

  --network    network of the merchant account (required, except with --view-only, which reads it from the file)
  --view-only  make no key. Read the keys file given by --from and write the facilitator's keys file, which holds
               only network, uivk and orchardOnlyAddress, to .secrets/merchant-<network>.view.json
  --from       the keys file to read for --view-only
  --force      replace an existing key file. The old one is kept as <file>.replaced-<UTC time> and set to
               mode 0600, since key files must be 0600. A symbolic link is refused, replace it by hand
  --out        write here instead of .secrets/merchant-<network>.json, an absolute path outside the
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
  const opts = { network: undefined, out: undefined, from: undefined, force: false, viewOnly: false, help: false };
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
      case "--from":
        opts.from = take();
        break;
      case "--force":
      case "--view-only":
      case "-h":
      case "--help":
        if (eq >= 0) throw new Fail(`${flag} takes no value`, 2);
        if (flag === "--force") opts.force = true;
        else if (flag === "--view-only") opts.viewOnly = true;
        else opts.help = true;
        break;
      default:
        throw new Fail(`${token.startsWith("--") ? `unknown flag ${flag}` : "unexpected argument"}\n\n${USAGE}`, 2);
    }
  }
  if (opts.help) return opts;
  if (opts.viewOnly && opts.from === undefined) throw new Fail(`--view-only needs --from\n\n${USAGE}`, 2);
  if (!opts.viewOnly && opts.from !== undefined) throw new Fail(`--from is only for --view-only\n\n${USAGE}`, 2);
  if (opts.network === undefined && !opts.viewOnly) throw new Fail(`--network is required\n\n${USAGE}`, 2);
  if (opts.network !== undefined && !Object.hasOwn(ADDRESS_PREFIX, opts.network)) {
    throw new Fail("--network must be regtest, testnet or mainnet", 2);
  }
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

// The three fields of a keys file that the facilitator needs, and nothing the file holds besides, the seed above all
function readView(from, expected) {
  const path = resolve(from);
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    throw new Fail(`cannot read ${shown(path)} (${e.code ?? "unknown error"})`);
  }
  let keys;
  try {
    keys = JSON.parse(text);
  } catch {
    throw new Fail(`${shown(path)} is not valid JSON`);
  }
  const { network, uivk, orchardOnlyAddress: address } = typeof keys === "object" && keys !== null ? keys : {};
  if (typeof network !== "string" || !Object.hasOwn(ADDRESS_PREFIX, network)) {
    throw new Fail(`${shown(path)} has no network of regtest, testnet or mainnet`);
  }
  if (expected !== undefined && expected !== network) {
    throw new Fail(`${shown(path)} holds ${network} keys, not ${expected} keys`, 2);
  }
  const sound =
    typeof uivk === "string" &&
    UIVK_RE[network].test(uivk) &&
    typeof address === "string" &&
    address.startsWith(ADDRESS_PREFIX[network]);
  if (!sound) throw new Fail(`${shown(path)} has no uivk and orchardOnlyAddress that fit ${network}`);
  return { network, address, text: `${JSON.stringify({ network, uivk, orchardOnlyAddress: address }, null, 2)}\n` };
}

/* Storage */

// Link failures that mean this filesystem has no hard links, as FAT and exFAT have none
const NO_HARD_LINKS = new Set(["ENOTSUP", "EPERM", "EXDEV", "EMLINK"]);

function stamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

function syncFile(path) {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

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

// A second name for the old file, or a copy where there are no second names, so that replacing it cannot lose it
function keepOld(target) {
  const base = `${target}.replaced-${stamp()}`;
  for (let n = 1; ; n += 1) {
    const name = n === 1 ? base : `${base}-${n}`;
    let copied = false;
    try {
      linkSync(target, name);
    } catch (e) {
      if (e.code === "EEXIST") continue;
      if (e.code === "ENOENT") return undefined;
      try {
        copyFileSync(target, name, constants.COPYFILE_EXCL);
        copied = true;
      } catch (c) {
        if (c.code === "EEXIST") continue;
        if (c.code === "ENOENT") return undefined;
        throw c;
      }
    }
    try {
      chmodSync(name, 0o600);
      if (copied) syncFile(name);
      // The name must be on disk before the rename, and it must still be there
      syncDir(dirname(name));
      lstatSync(name);
    } catch (e) {
      // Nothing was replaced yet, so the old key is still at the target and this name can go
      rmSync(name, { force: true });
      // The name existed a moment ago, so a missing one means the old key is not safe and nothing is replaced
      if (e.code === "ENOENT") {
        throw new Fail(`${shown(name)} vanished right after the old key was kept, so ${shown(target)} was not replaced`);
      }
      throw e;
    }
    return name;
  }
}

// An exclusive create needs link, which fails with an error of its own where hard links do not exist
function publish(tmp, target) {
  try {
    linkSync(tmp, target);
  } catch (e) {
    if (!NO_HARD_LINKS.has(e.code)) throw e;
    throw new Fail(
      `cannot create ${shown(target)} here, the filesystem has no hard links for the exclusive create; ` +
        "create the file on another filesystem and copy it here",
    );
  }
}

// A rename that reports an error may still have happened, so the kept file stays whatever the error is
function replace(tmp, target, kept) {
  try {
    renameSync(tmp, target);
  } catch (e) {
    throw new Fail(
      `the rename onto ${shown(target)} failed (${e.code ?? "error"}), and it may still have happened. ` +
        `The old key is kept as ${shown(kept)}. The state is unknown, ` +
        `so check which key ${shown(target)} holds before you use it`,
    );
  }
  return kept;
}

// Takes the target exclusively when nothing is there, and keeps what is there before replacing it
function place(tmp, target, { force, refusal }) {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const kept = force ? keepOld(target) : undefined;
    if (kept) return replace(tmp, target, kept);
    try {
      publish(tmp, target);
      return undefined;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      // Without --force a file in the way is final, with it a file that appeared since keepOld looked is kept next
      if (!force) throw refusal;
    }
  }
  throw new Fail(`${shown(target)} kept changing while it was being replaced, so nothing was replaced`);
}

// The directories that mkdir -p is about to create, deepest first
function missingDirs(dir) {
  const made = [];
  for (let d = dir; lstatOrNothing(d) === undefined; d = dirname(d)) made.push(d);
  return made;
}

// A directory that cannot be synced is reported by the caller after the address, since the new key is in place by then
function syncDirs(dirs) {
  let ok = true;
  for (const dir of new Set(dirs)) {
    try {
      syncDir(dir);
    } catch {
      ok = false;
    }
  }
  return ok;
}

// Written to a private temp file first, so a crash never leaves half a seed at the target
function store(target, text, { force, mainnet, refusal }) {
  const dir = dirname(target);
  const made = missingDirs(dir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (dir === SECRETS_DIR) chmodSync(dir, 0o700);

  const tmp = `${target}.${process.pid}.tmp`;
  const fd = openSync(tmp, "wx", 0o600);
  let kept;
  let modes = true;
  try {
    try {
      fchmodSync(fd, 0o600);
      // FAT and exFAT accept chmod and keep the mode of their mount, so the mode is read back before a key is written
      modes = (fstatSync(fd).mode & 0o777) === 0o600;
      if (!modes && mainnet) {
        throw new Fail(
          "this filesystem does not keep file modes, so a mainnet key file would be readable by other users; " +
            "write it somewhere else",
          2,
        );
      }
      writeFileSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    kept = place(tmp, target, { force, refusal });
  } finally {
    rmSync(tmp, { force: true });
  }
  return { kept, durable: syncDirs([dir, ...made.map((d) => dirname(d))]), modes };
}

function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help) {
    console.log(USAGE);
    return;
  }
  const { force } = opts;
  const view = opts.viewOnly ? readView(opts.from, opts.network) : undefined;
  const network = view?.network ?? opts.network;
  const target = resolve(opts.out ?? join(SECRETS_DIR, `merchant-${network}${view ? ".view" : ""}.json`));
  if (opts.out !== undefined) checkOut(target);

  const refusal = new Fail(
    view
      ? `refusing to replace ${shown(target)} (--force replaces it)`
      : `refusing to replace ${shown(target)}, which may hold the only copy of a seed (--force replaces it)`,
  );
  const old = lstatOrNothing(target);
  if (old?.isDirectory()) throw new Fail(`${shown(target)} is a directory`);
  if (old?.isSymbolicLink()) throw new Fail("the key file is a symbolic link; replace it by hand", 2);
  if (old && !force) throw refusal;

  const { address, text } = view ?? generate(network);
  const { kept, durable, modes } = store(target, text, { force, mainnet: network === "mainnet", refusal });

  const modeOf = (path) => (statSync(path).mode & 0o777).toString(8);
  const where = `${shown(target)} (mode ${modeOf(target)})`;
  console.log(address);
  if (view) {
    console.error(`Saved ${where}`);
  } else if (network === "mainnet") {
    console.error(`WARNING: MAINNET keys. The seed in ${where} controls real money and is the only backup.`);
    console.error("Copy it to offline storage now, and never share it, commit it or paste it into a log.");
  } else {
    console.error(`Saved ${where}. Its seed is the only backup of this account, keep a copy somewhere safe.`);
  }
  if (!modes) console.error("warning: this filesystem does not keep file modes; the key file is readable by other users");
  if (kept) {
    console.error(`The file it replaced was kept as ${shown(kept)} (mode ${modeOf(kept)}).`);
    if (network === "mainnet" && !view) console.error("Its seed may still control funds, so back it up too.");
  }
  if (!durable) {
    console.error("warning: the new key is in place but its directory entry may not survive a power loss; run sync");
    process.exitCode = 1;
  }
}

try {
  main(process.argv.slice(2));
} catch (e) {
  console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = e instanceof Fail ? e.exitCode : 1;
}
