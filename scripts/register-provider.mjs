#!/usr/bin/env node
/*
 * Registers a provider with the facilitator (POST /providers) and saves the API key it issues.
 *
 *   node scripts/register-provider.mjs --keys <keys file> --facilitator <url> --out <key file>
 *                                      [--registration-token-file <file>] [--force]
 *
 * The keys file is a merchant-keygen file, best the --view-only one: only its network, uivk and orchardOnlyAddress
 * are read, and only these three leave this process. Registering a payTo that is already registered
 * rotates its key, and the old key stops working at once.
 * The facilitator shows a key once, so the key file is opened (mode 0600, under umask 077) before the request is
 * sent: a key is never issued with nowhere to go. An existing key file is replaced only with --force. The new file
 * gets its final name by a link, or a rename with --force, so the key file is never half written.
 * The output names the providerId, the payTo and the key file. The key and the UIVK are never printed.
 * Exit codes: 0 registered, 1 refused or failed, 2 usage.
 */
import {
  closeSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const ADDRESS_PREFIX = { regtest: "uregtest1", testnet: "utest1", mainnet: "u1" };
// The shapes of a unified incoming viewing key that the facilitator accepts, revision 0 then revision 2
const UIVK_RE = {
  regtest: /^(uivkregtest|uviregtest)1[02-9ac-hj-np-z]+$/,
  testnet: /^(uivktest|uvitest)1[02-9ac-hj-np-z]+$/,
  mainnet: /^(uivk|uvi)1[02-9ac-hj-np-z]+$/,
};
const API_KEY_RE = /^z402_[A-Za-z0-9_-]{43}$/;
const PROVIDER_ID_RE = /^[0-9a-f]{16}$/;
/** An RFC 6750 b64token, the facilitator's rule for every bearer token */
const TOKEN_RE = /^[A-Za-z0-9\-._~+/]+=*$/;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
/** The facilitator proves key ownership and opens the provider's ledger before it answers, which can take a while */
const TIMEOUT_MS = 120_000;
const MESSAGE_CHARS = 300;

const USAGE = `usage: node scripts/register-provider.mjs --keys <keys file> --facilitator <url> --out <key file>
                                          [--registration-token-file <file>] [--force]

  --keys                     a merchant-keygen keys file, best the --view-only one. Its network, uivk and
                             orchardOnlyAddress are read, and nothing else
  --facilitator              the facilitator's base URL. Off regtest, http:// is allowed to a loopback host only
  --out                      where to save the API key, outside the repository or inside its .secrets/ directory
  --registration-token-file  a file holding the facilitator's registration token, when it asks for one
  --force                    replace an existing key file

Prints the providerId, the payTo and the key file. The API key and the UIVK are never printed.`;

class Fail extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

/* Arguments */

function parseArgs(argv) {
  const args = [...argv];
  const opts = { keys: undefined, facilitator: undefined, out: undefined, tokenFile: undefined, force: false, help: false };
  const valued = { "--keys": "keys", "--facilitator": "facilitator", "--out": "out", "--registration-token-file": "tokenFile" };
  while (args.length > 0) {
    const token = args.shift();
    const eq = token.startsWith("--") ? token.indexOf("=") : -1;
    const flag = eq < 0 ? token : token.slice(0, eq);
    if (Object.hasOwn(valued, flag)) {
      const value = eq < 0 ? args.shift() : token.slice(eq + 1);
      if (value === undefined || value === "") throw new Fail(`${flag} needs a value\n\n${USAGE}`, 2);
      opts[valued[flag]] = value;
    } else if (flag === "--force" || flag === "--help" || flag === "-h") {
      if (eq >= 0) throw new Fail(`${flag} takes no value`, 2);
      if (flag === "--force") opts.force = true;
      else opts.help = true;
    } else {
      throw new Fail(`${token.startsWith("--") ? `unknown flag ${flag}` : "unexpected argument"}\n\n${USAGE}`, 2);
    }
  }
  if (opts.help) return opts;
  for (const [flag, key] of [["--keys", "keys"], ["--facilitator", "facilitator"], ["--out", "out"]]) {
    if (opts[key] === undefined) throw new Fail(`${flag} is required\n\n${USAGE}`, 2);
  }
  return opts;
}

/* Inputs */

// Relative to the repo root where the path is inside it
function shown(path) {
  const rel = relative(ROOT, path);
  return rel === "" || rel.startsWith("..") || isAbsolute(rel) ? path : rel;
}

// Only the three fields the facilitator needs, so a full keys file's seed is never kept or sent
function readKeys(file) {
  const path = resolve(file);
  let keys;
  try {
    keys = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Fail(e instanceof SyntaxError ? `${shown(path)} is not valid JSON` : `cannot read ${shown(path)} (${e.code ?? "unknown error"})`);
  }
  const { network, uivk, orchardOnlyAddress: payTo } = typeof keys === "object" && keys !== null ? keys : {};
  if (typeof network !== "string" || !Object.hasOwn(ADDRESS_PREFIX, network)) {
    throw new Fail(`${shown(path)} has no network of regtest, testnet or mainnet`);
  }
  const sound = typeof uivk === "string" && UIVK_RE[network].test(uivk) && typeof payTo === "string" && payTo.startsWith(ADDRESS_PREFIX[network]);
  if (!sound) throw new Fail(`${shown(path)} has no uivk and orchardOnlyAddress that fit ${network}`);
  return { network, uivk, payTo };
}

function facilitatorUrl(raw, network) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Fail("--facilitator is not a URL", 2);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Fail("--facilitator must be an http(s) URL", 2);
  if (url.username !== "" || url.password !== "") throw new Fail("--facilitator must carry no credentials", 2);
  if (url.search !== "" || url.hash !== "") throw new Fail("--facilitator must carry no query or fragment", 2);
  // The UIVK reveals every incoming payment, so off regtest it travels in clear only to this machine
  if (network !== "regtest" && url.protocol === "http:" && !LOOPBACK.has(url.hostname)) {
    throw new Fail("--facilitator: use https:// off regtest, http:// is allowed to a loopback host only", 2);
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

function readToken(file) {
  let token;
  try {
    token = readFileSync(resolve(file), "utf8").replace(/\r?\n$/, "");
  } catch (e) {
    throw new Fail(`cannot read the registration token file (${e.code ?? "unknown error"})`);
  }
  if (!TOKEN_RE.test(token)) throw new Fail("the registration token file does not hold one token of letters, digits and -._~+/");
  return token;
}

/* The key file */

// Where a file at path would really land, with the symlinks of its parent resolved
function landing(path) {
  try {
    return join(realpathSync.native(dirname(path)), basename(path));
  } catch (e) {
    throw new Fail(`--out: cannot use the directory ${shown(dirname(path))} (${e.code ?? "unknown error"})`, 2);
  }
}

const inside = (base, path) => path === base || path.startsWith(base + sep);

function checkOut(out, force) {
  const target = resolve(out);
  const where = landing(target);
  const root = realpathSync.native(ROOT);
  if (inside(root, where) && !inside(join(root, ".secrets"), where)) {
    throw new Fail("--out must be outside the repository or inside its .secrets/ directory, since a key file anywhere else in the work tree can be committed by accident", 2);
  }
  let existing;
  try {
    existing = lstatSync(target);
  } catch (e) {
    if (e.code !== "ENOENT") throw new Fail(`--out: cannot check ${shown(target)} (${e.code ?? "unknown error"})`);
  }
  if (existing?.isSymbolicLink()) throw new Fail(`--out: ${shown(target)} is a symbolic link, replace it by hand`, 2);
  if (existing !== undefined && !force) throw new Fail(`--out: ${shown(target)} exists, pass --force to replace it`, 2);
  return target;
}

/** A new 0600 file beside the target, opened before the request so that an issued key always has somewhere to go */
function openStaging(target) {
  process.umask(0o077);
  const staging = join(dirname(target), `.${basename(target)}.${process.pid}.tmp`);
  try {
    return { staging, fd: openSync(staging, "wx", 0o600) };
  } catch (e) {
    throw new Fail(`--out: cannot create a file in ${shown(dirname(target))} (${e.code ?? "unknown error"})`);
  }
}

function discard({ staging, fd }) {
  try {
    closeSync(fd);
  } catch {
    // Already closed
  }
  rmSync(staging, { force: true });
}

function publish({ staging, fd }, target, apiKey, force) {
  writeSync(fd, `${apiKey}\n`);
  fsyncSync(fd);
  closeSync(fd);
  if (force) {
    renameSync(staging, target);
  } else {
    try {
      linkSync(staging, target);
    } catch (e) {
      // The key is valid and shown nowhere else, so it stays where it is rather than being lost
      throw new Fail(`the key could not be saved as ${shown(target)} (${e.code ?? "unknown error"}); it is in ${shown(staging)}, rename it by hand`);
    }
    rmSync(staging, { force: true });
  }
  try {
    const dir = openSync(dirname(target), "r");
    try {
      fsyncSync(dir);
    } finally {
      closeSync(dir);
    }
  } catch {
    console.error("warning: the key file is in place but its directory entry may not survive a power loss; run sync");
  }
}

/* The request */

/** One line of the facilitator's own text, clipped, so that it cannot bend the terminal */
function oneLine(text) {
  const line = String(text).replace(/[\p{Cc}\p{Cf}\u2028\u2029]+/gu, " ").trim();
  return line.length > MESSAGE_CHARS ? `${line.slice(0, MESSAGE_CHARS - 1)}…` : line;
}

async function register(base, body, token) {
  let res;
  try {
    res = await fetch(`${base}/providers`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token === undefined ? {} : { authorization: `Bearer ${token}` }) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    const reason = e?.name === "TimeoutError" ? `no answer within ${TIMEOUT_MS / 1000} s` : oneLine(e?.cause?.code ?? e?.message ?? e);
    throw new Fail(`cannot reach ${base}/providers: ${reason}`);
  }
  let answer;
  try {
    answer = await res.json();
  } catch {
    answer = undefined;
  }
  if (res.status !== 200 && res.status !== 201) {
    const code = typeof answer?.error === "string" ? ` ${oneLine(answer.error)}` : "";
    const message = typeof answer?.message === "string" ? `: ${oneLine(answer.message)}` : "";
    throw new Fail(`the facilitator refused with ${res.status}${code}${message}`);
  }
  const { providerId, network, payTo, apiKey } = typeof answer === "object" && answer !== null ? answer : {};
  const sound =
    typeof providerId === "string" &&
    PROVIDER_ID_RE.test(providerId) &&
    network === body.network &&
    payTo === body.payTo &&
    typeof apiKey === "string" &&
    API_KEY_RE.test(apiKey);
  if (!sound) throw new Fail(`the facilitator answered ${res.status} without a {providerId, network, payTo, apiKey} for this payTo`);
  return { providerId, apiKey, rotated: res.status === 200 };
}

async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help) {
    console.log(USAGE);
    return;
  }
  const keys = readKeys(opts.keys);
  const base = facilitatorUrl(opts.facilitator, keys.network);
  const token = opts.tokenFile === undefined ? undefined : readToken(opts.tokenFile);
  const target = checkOut(opts.out, opts.force);

  const staged = openStaging(target);
  let issued;
  try {
    issued = await register(base, { payTo: keys.payTo, uivk: keys.uivk, network: `zcash:${keys.network}` }, token);
  } catch (e) {
    discard(staged);
    throw e;
  }
  publish(staged, target, issued.apiKey, opts.force);

  console.log(`providerId ${issued.providerId}`);
  console.log(`payTo ${keys.payTo}`);
  console.log(`key file ${shown(target)}`);
  console.error(issued.rotated ? "The payTo was already registered: its key was rotated, and the old key no longer works." : "Registered.");
}

main(process.argv.slice(2)).catch((e) => {
  console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = e instanceof Fail ? e.exitCode : 1;
});
