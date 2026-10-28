// The markdown-register job of compose.yaml: registers provider 2 with the facilitator (POST /providers) and writes
// what its resource server reads to a directory of their own: the public payTo, and the API key, mode 0600.
//   node docker/register-provider.mjs --keys <zdecrypt keygen file> --out <directory> [--rotate]
// The environment names the facilitator (Z402_FACILITATOR_URL), its registration token if it has one
// (Z402_REGISTRATION_TOKEN), and how long to wait for it (Z402_FACILITATOR_WAIT_MS, 900 s).
// A stored key that GET /providers/me still matches to this payTo is kept, since registering again rotates the key and
// cuts off the server running with the old one; --rotate asks for a new key all the same. It retries a facilitator
// that does not answer or answers 5xx, and fails on any refusal. It never prints the API key, the registration token,
// or anything from the keys file.
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

const url = (process.env.Z402_FACILITATOR_URL || "http://127.0.0.1:4022").replace(/\/+$/, "");
// The facilitator's start period in compose.yaml, since docker compose restart starts this job beside it
const TIMEOUT_MS = 900_000;
const RETRY_MS = 2000;
/** An RFC 6750 b64token, the only token an Authorization header can carry, so no other text is ever sent as one */
const B64TOKEN = /^[A-Za-z0-9\-._~+/]+=*$/;
const NETWORKS = ["regtest", "testnet", "mainnet"];
const USAGE = "usage: node docker/register-provider.mjs --keys <zdecrypt keygen file> --out <directory> [--rotate]";

function fail(message) {
  console.error(`register-provider: ${message}`);
  process.exit(1);
}

function isToken(value) {
  return typeof value === "string" && value.length <= 512 && B64TOKEN.test(value);
}

let flags;
try {
  ({ values: flags } = parseArgs({
    options: { keys: { type: "string" }, out: { type: "string" }, rotate: { type: "boolean", default: false } },
  }));
} catch {
  fail(USAGE);
}
if (flags.keys === undefined || flags.out === undefined) fail(USAGE);
const PAY_TO = join(flags.out, "pay-to");
const API_KEY = join(flags.out, "api-key");

const waitText = process.env.Z402_FACILITATOR_WAIT_MS || String(TIMEOUT_MS);
if (!/^(0|[1-9][0-9]{0,8})$/.test(waitText)) {
  fail("Z402_FACILITATOR_WAIT_MS: expected a whole number of milliseconds");
}
const waitMs = Number(waitText);
const deadline = Date.now() + waitMs;

const registrationToken = process.env.Z402_REGISTRATION_TOKEN || undefined;
if (registrationToken !== undefined && !isToken(registrationToken)) {
  fail("Z402_REGISTRATION_TOKEN: expected a b64token (letters, digits and -._~+/, then any =)");
}

let keys;
try {
  keys = JSON.parse(readFileSync(flags.keys, "utf8"));
} catch (e) {
  // JSON.parse quotes the start of its input in its error, which here could be the seed
  fail(`cannot read the keys in ${flags.keys} (${e?.code ?? "not JSON"})`);
}
const payTo = keys?.orchardOnlyAddress;
const uivk = keys?.uivk;
if (!NETWORKS.includes(keys?.network) || typeof payTo !== "string" || typeof uivk !== "string") {
  fail(`${flags.keys} does not hold the keys that zdecrypt keygen prints`);
}
const network = `zcash:${keys.network}`;

/** The file's trimmed text, or undefined when there is none */
function stored(path) {
  try {
    return readFileSync(path, "utf8").trim();
  } catch (e) {
    if (e.code === "ENOENT") return undefined;
    fail(`cannot read ${path} (${e.code ?? "error"})`);
  }
}

/** Writes `text` to `path` by a rename, so a reader sees the old file or the new one and never part of one */
function replace(path, text) {
  const temporary = `${path}.tmp`;
  try {
    rmSync(temporary, { force: true });
    const fd = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, path);
  } catch (e) {
    fail(`cannot write ${path} (${e.code ?? "error"})`);
  }
}

/** The payTo for the server, written only when it changed, so a run that keeps the key changes nothing */
function writePayTo() {
  if (stored(PAY_TO) !== payTo) replace(PAY_TO, `${payTo}\n`);
}

/** The facilitator's status and JSON body (undefined when it sent none), retried while it is down or answers 5xx */
async function ask(method, path, bearer, payload) {
  for (let attempt = 1; ; attempt++) {
    let problem;
    try {
      const res = await fetch(`${url}${path}`, {
        method,
        headers: {
          ...(bearer !== undefined && { authorization: `Bearer ${bearer}` }),
          ...(payload !== undefined && { "content-type": "application/json" }),
        },
        body: payload === undefined ? undefined : JSON.stringify(payload),
        redirect: "manual",
        signal: AbortSignal.timeout(60_000),
      });
      const text = await res.text();
      if (res.status < 500) {
        let body;
        try {
          body = JSON.parse(text);
        } catch {
          body = undefined;
        }
        return { status: res.status, body };
      }
      problem = `answered ${res.status}`;
    } catch (e) {
      // The code or the name only, as a message may quote a header
      problem = e?.cause?.code ?? e?.name ?? "error";
    }
    if (Date.now() + RETRY_MS > deadline) {
      fail(`${method} ${url}${path}: ${problem}, given up after ${waitMs / 1000} s`);
    }
    // Once, so that a wait of minutes shows in docker compose logs
    if (attempt === 1) {
      console.log(`register-provider: ${method} ${url}${path}: ${problem}; retrying for up to ${waitMs / 1000} s`);
    }
    await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
  }
}

/** The status and the error code of a refusal, which the facilitator takes from a closed list */
function head(status, body) {
  const code = typeof body?.error === "string" && /^[a-z_]{1,64}$/.test(body.error) ? ` ${body.error}` : "";
  return `${status}${code}`;
}

/** A refusal with the facilitator's own message, which is left out when it quotes a secret */
function refusal(status, body, secrets) {
  const whole = typeof body?.message === "string" ? body.message : "";
  // Looked for in the whole message, since the cut below can end inside a secret and keep its start
  const quotes = secrets.some((secret) => typeof secret === "string" && secret !== "" && whole.includes(secret));
  const message = whole.replace(/[^\x20-\x7e]/g, " ").slice(0, 300);
  return message === "" || quotes ? head(status, body) : `${head(status, body)}: ${message}`;
}

/** What each refusal of POST /providers means for this job (design §4.1) */
const REFUSED = {
  401:
    registrationToken === undefined
      ? "the facilitator registers providers only with its registration token: set Z402_REGISTRATION_TOKEN to it"
      : "the facilitator refused the registration token in Z402_REGISTRATION_TOKEN",
  "403 not_owner": "the UIVK in the keys file does not own its payTo",
  "403 provider_limit": "the facilitator has no provider slot left (Z402_MAX_PROVIDERS)",
  "403 registration_disabled": "the facilitator takes no registrations, as it has no providers directory",
  "409 operator": "the payTo is the facilitator operator's own, and a provider needs keys of its own",
};

function providerId(body) {
  return typeof body?.providerId === "string" && /^[0-9a-f]{16}$/.test(body.providerId) ? body.providerId : "?";
}

/** Whether the stored key still works for this payTo, false when the facilitator says it does not */
async function kept(previous) {
  if (!isToken(previous)) {
    console.log(`register-provider: ${API_KEY} holds no API key; registering again`);
    return false;
  }
  const { status, body } = await ask("GET", "/providers/me", previous);
  if (status === 200 && body?.payTo === payTo && body?.network === network) {
    writePayTo();
    console.log(`register-provider: provider ${providerId(body)} keeps its API key`);
    return true;
  }
  if (status === 401) {
    console.log("register-provider: the facilitator no longer takes the stored API key; registering again");
    return false;
  }
  if (status === 200 && typeof body?.payTo === "string" && typeof body?.network === "string") {
    console.log("register-provider: the stored API key is for another payTo or network; registering again");
    return false;
  }
  const answer = status === 200 ? "200 without a provider" : refusal(status, body, [uivk, payTo, previous]);
  fail(`GET /providers/me answered ${answer}`);
}

async function register(previous) {
  const { status, body } = await ask("POST", "/providers", registrationToken, { payTo, uivk });
  if (status !== 201 && status !== 200) {
    const meaning = REFUSED[head(status, body)] ?? REFUSED[status];
    const answer = meaning === undefined
      ? refusal(status, body, [uivk, payTo, previous, registrationToken])
      : `${head(status, body)}: ${meaning}`;
    fail(`POST /providers answered ${answer}`);
  }
  const apiKey = body?.apiKey;
  if (!isToken(apiKey) || body.payTo !== payTo) {
    fail(`POST /providers answered ${status} without an API key for this payTo`);
  }
  writePayTo();
  replace(API_KEY, `${apiKey}\n`);
  const id = providerId(body);
  const done = status === 201 ? `registered provider ${id}` : `provider ${id} has a new API key`;
  console.log(`register-provider: ${done}`);
  // The facilitator refuses the old key from now on, and a server reads its key only when it starts
  if (previous !== undefined || status === 200) {
    console.log(`register-provider: the old API key no longer works; restart the server that reads ${API_KEY}`);
  }
}

const previous = stored(API_KEY);
if (previous === undefined || flags.rotate || !(await kept(previous))) await register(previous);
