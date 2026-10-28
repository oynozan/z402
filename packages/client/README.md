# @z402/client

Documentation: https://z402.net/docs/reference/client (all z402 docs: https://z402.net/docs)

The paying side of z402. `PrepaidVoucherScheme` plugs into the stock x402 client: for each provider it makes a shielded Zcash deposit, signs a voucher for every call, and reads each call's outcome to decide what to do next. `ZalletRpcWallet` sends the deposits through Zallet's JSON-RPC, and `LightwalletdTxStatus` watches them confirm.

```bash
pnpm add @z402/client
pnpm add --save-exact @x402/core@2.28.0 @x402/fetch@2.28.0
```

The `@x402` packages are pinned to exactly 2.28.0, which the scheme is built and tested against. `@x402/core` is a peer dependency (the declarations use its types), and `@z402/client` does not depend on `@x402/fetch`: install it for `x402Client` and `wrapFetchWithPayment`.

```ts
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { PrepaidVoucherScheme } from "@z402/client";

const scheme = new PrepaidVoucherScheme({ wallet, chain }); // a ZcashWallet and a TxStatusSource
const client = new x402Client().register("zcash:regtest", scheme); // the one line that adds Zcash
const paidFetch = wrapFetchWithPayment(fetch, client);

const res = await paidFetch("http://127.0.0.1:4021/chunk"); // pays when the API asks
```

`wallet` is a `ZalletRpcWallet` or any object that implements `ZcashWallet`. The bundled `ZalletRpcWallet` is built and tested for regtest; for any other network, bring your own wallet adapter. `chain` is any `TxStatusSource`; `LightwalletdTxStatus` wraps any object with `getTip()` and `getTransaction(txid)`.

Source and issues: https://github.com/oynozan/z402

MIT licensed.
