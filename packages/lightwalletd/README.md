# @z402-net/lightwalletd

Documentation: https://z402.net/docs/guides/pay-from-an-agent (all z402 docs: https://z402.net/docs)

A gRPC client for lightwalletd-compatible nodes (lightwalletd, Zaino, Zebra's built-in gRPC). `createLightwalletdClient` reads the chain tip (`getTip`), a raw transaction with its location (`getTransaction`) and the node's info (`getLightdInfo`). The Zcash developers' MIT-licensed `.proto` files ship in `proto/` with their own LICENSE.

```bash
pnpm add @z402-net/lightwalletd
```

`@z402-net/client` does not depend on this package: its `LightwalletdTxStatus` accepts any object with `getTip()` and `getTransaction(txid)`, such as this client. A paying agent uses it as the deposit-status source:

```ts
import { LightwalletdTxStatus } from "@z402-net/client";
import { createLightwalletdClient } from "@z402-net/lightwalletd";

const lightwalletd = createLightwalletdClient({ url: "http://127.0.0.1:28137" }); // https:// uses TLS
const chain = new LightwalletdTxStatus(lightwalletd); // pass it to PrepaidVoucherScheme as `chain`
```

Call `lightwalletd.close()` when you are done. The node learns your IP address and the txids you ask about, so use one you trust.

Source and issues: https://github.com/oynozan/z402

MIT licensed.
