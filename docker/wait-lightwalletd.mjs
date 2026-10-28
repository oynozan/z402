// Runs before the facilitator (compose.yaml) and waits until lightwalletd (Zaino) answers GetLightdInfo, since the
// facilitator's start-up check exits on the first failed call and Zaino's healthcheck only proves its port is open.
// Run with `node --import tsx`, which loads the TypeScript client. The facilitator itself checks the branch id.
import { createLightwalletdClient } from "../packages/lightwalletd/src/index.js";

const url = process.env.Z402_LWD_URL ?? "http://127.0.0.1:28137";
const TIMEOUT_MS = 600_000;

const lwd = createLightwalletdClient({ url });
const deadline = Date.now() + TIMEOUT_MS;
let lastError = "";
for (;;) {
  try {
    await lwd.getLightdInfo();
    break;
  } catch (e) {
    lastError = e instanceof Error ? e.message : String(e);
  }
  if (Date.now() >= deadline) {
    console.error(`wait-lightwalletd: ${url} did not answer GetLightdInfo within ${TIMEOUT_MS / 1000} s (${lastError})`);
    lwd.close();
    process.exit(1);
  }
  await new Promise((resolve) => setTimeout(resolve, 2000));
}
lwd.close();
