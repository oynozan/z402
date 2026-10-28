# @z402/protocol

The wire contract of z402's `prepaid-voucher` scheme for [x402](https://github.com/x402-foundation/x402) on Zcash: identifiers, payment terms, Ed25519 voucher signing and checking, deposit memos, the trust ramp, session snapshots and reason codes. Pure TypeScript with no network access; Ed25519 uses `node:crypto`. The z402 client, server scheme and facilitator all build on it.

```bash
pnpm add @z402/protocol
```

```ts
import { generateSeed, NETWORK_REGTEST, publicKeyFromSeed, SCHEME, signVoucher, verifyVoucher } from "@z402/protocol";

export function signAndCheck(payTo: string): boolean {
  const seed = generateSeed(); // one per session, never leaves the client
  const sessionKey = publicKeyFromSeed(seed);

  // "my running total with this payTo is now 1,500 zat"
  const fields = { scheme: SCHEME, network: NETWORK_REGTEST, payTo, sessionKey, cumulativeZat: "1500" };
  const sig = signVoucher(seed, fields);

  return verifyVoucher({ sessionKey, cumulativeZat: "1500", sig }, { scheme: SCHEME, network: NETWORK_REGTEST, payTo });
}
```

- Documentation: https://z402.net/docs (reference: https://z402.net/docs/reference/protocol)
- Source and issues: https://github.com/oynozan/z402

MIT licensed.
