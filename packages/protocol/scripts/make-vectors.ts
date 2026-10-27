// Generates test/vectors.json with @noble/curves, independent of src/voucher.ts.
// Run: pnpm --filter @z402/protocol exec tsx scripts/make-vectors.ts > test/vectors.json
import { ed25519 } from "@noble/curves/ed25519.js";
import { bytesToHex } from "@noble/curves/utils.js";

const SEED = Uint8Array.from({ length: 32 }, (_, i) => i);
const SCHEME = "prepaid-voucher";
const NETWORK = "zcash:testnet";
const PAY_TO =
  "utest1q97m3j4x8x3mfw52ye4r8nx9ye7nuyt54ra0qnf79h2j0v76dqvl2arf9955zk620sjhe3954kc6x364r8rgn4xa6l7nwyr9nyqua6f9";
const EXPECTED_SESSION_KEY = "03a107bff3ce10be1d70dd18e74bc09967e4d6309ba50d5f1ddc8664125531b8";

const sessionKey = bytesToHex(ed25519.getPublicKey(SEED));
if (sessionKey !== EXPECTED_SESSION_KEY) {
  throw new Error(`sessionKey ${sessionKey} does not match design-critique 2.1 (${EXPECTED_SESSION_KEY})`);
}

const cases = ["1000", "53000"].map((cumulativeZat) => {
  const message = new TextEncoder().encode(
    ["z402-voucher-v1", SCHEME, NETWORK, PAY_TO, sessionKey, cumulativeZat].join("\n"),
  );
  return {
    cumulativeZat,
    messageHex: bytesToHex(message),
    sig: bytesToHex(ed25519.sign(message, SEED)),
  };
});

const vectors = { seed: bytesToHex(SEED), sessionKey, payTo: PAY_TO, scheme: SCHEME, network: NETWORK, cases };
process.stdout.write(`${JSON.stringify(vectors, null, 2)}\n`);
