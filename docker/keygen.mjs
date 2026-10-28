// Second half of the keygen job of compose.yaml, run after `zdecrypt keygen` and with the same umask 077. It checks
// both merchant keys files without ever printing them, the operator's and provider 2's, then writes what the other
// containers may see of the operator's to the runtime volume: the public payTo, and once, the facilitator's bearer
// token. The operator's keys volume is mounted only into the keygen job and the facilitator, and provider 2's only into
// the keygen job and markdown-register, which gets provider 2 its own API key from the facilitator.
import { randomBytes } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";

const KEYS = "/keys/merchant-regtest.json";
const PROVIDER_KEYS = "/markdown-keys/merchant-regtest.json";
const PAY_TO = "/run/z402/pay-to";
const TOKEN = "/run/z402/facilitator-token";

function fail(message) {
  console.error(`keygen: ${message}`);
  process.exit(1);
}

function replace(path, text) {
  writeFileSync(`${path}.tmp`, text);
  renameSync(`${path}.tmp`, path);
}

function readOrEmpty(path) {
  try {
    return readFileSync(path, "utf8").trim();
  } catch (e) {
    if (e.code === "ENOENT") return "";
    throw e;
  }
}

/** The payTo of the keys file at `path`. A file that holds no keys is removed, so the next run generates them again */
function payToOf(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    fail(`cannot read ${path} (${e.code ?? "error"})`);
  }
  // What a zdecrypt that died before printing leaves behind, which holds no seed
  if (text.trim() === "") {
    rmSync(path, { force: true });
    fail(`zdecrypt keygen printed nothing into ${path}; the next run generates the keys again`);
  }

  let keys;
  try {
    keys = JSON.parse(text);
  } catch {
    // JSON.parse quotes the start of its input in its error, which here could be the seed
    fail(`${path} is not valid JSON; docker compose down -v starts over with new keys`);
  }

  // On failure zdecrypt prints {"error": ...} on stdout, which the redirect stored in place of the keys
  if (typeof keys?.error === "string" && keys.seedHex === undefined) {
    rmSync(path, { force: true });
    fail(`zdecrypt keygen failed for ${path}: ${keys.error.slice(0, 200)}`);
  }

  const payTo = keys?.orchardOnlyAddress;
  const sound =
    keys?.network === "regtest" &&
    typeof keys.uivk === "string" &&
    typeof payTo === "string" &&
    payTo.startsWith("uregtest1");
  if (!sound) fail(`${path} does not hold the regtest keys that zdecrypt keygen prints`);
  return payTo;
}

const payTo = payToOf(KEYS);
// Provider 2's payTo reaches markdown through markdown-register, together with its API key
payToOf(PROVIDER_KEYS);

replace(PAY_TO, `${payTo}\n`);
if (readOrEmpty(TOKEN) === "") {
  replace(TOKEN, `${randomBytes(32).toString("hex")}\n`);
  console.log("keygen: created the facilitator token");
}
console.log(`keygen: payTo ${payTo}`);
