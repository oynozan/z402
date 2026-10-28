// Holds the API back until the facilitator answers, since a restart starts every container at once and the API exits
// when its first call to /supported fails. Run by compose.yaml before the API, with the bearer token file as argument.
import { readFileSync } from "node:fs";

const url = process.env.Z402_FACILITATOR_URL ?? "http://127.0.0.1:4022";
const [tokenFile] = process.argv.slice(2);
// The facilitator's start period in compose.yaml, which covers its own wait for Zaino
const TIMEOUT_MS = 900_000;

/** The bearer header, so the facilitator does not log the probe as a refused request, never printed */
function auth() {
  if (tokenFile === undefined) return {};
  try {
    const token = readFileSync(tokenFile, "utf8").trim();
    return token === "" ? {} : { authorization: `Bearer ${token}` };
  } catch {
    return {};
  }
}

const deadline = Date.now() + TIMEOUT_MS;
let lastError = "";
for (;;) {
  try {
    const res = await fetch(`${url}/supported`, {
      headers: auth(),
      redirect: "manual",
      signal: AbortSignal.timeout(5000),
    });
    await res.body?.cancel();
    // Any status will do, as the facilitator listens only once it is ready
    break;
  } catch (e) {
    lastError = e?.cause?.code ?? e?.code ?? e?.message ?? String(e);
  }
  if (Date.now() >= deadline) {
    console.error(`wait-facilitator: ${url} did not answer within ${TIMEOUT_MS / 1000} s (${lastError})`);
    process.exit(1);
  }
  await new Promise((resolve) => setTimeout(resolve, 2000));
}
