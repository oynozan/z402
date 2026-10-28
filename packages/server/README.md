# @z402/server

The provider side of z402 for x402 resource servers: `PrepaidVoucherServerScheme`, the `prepaid-voucher` scheme you register with the stock `x402ResourceServer`, and `checkProvider`, the start-up check that an API key and a pay-to address belong together.

```bash
pnpm add @z402/server @z402/protocol
pnpm add --save-exact @x402/core@2.28.0
```

The example imports `@x402/core`, which z402 pins to exactly 2.28.0, and `NETWORK_REGTEST` from `@z402/protocol`.

```ts
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import { NETWORK_REGTEST } from "@z402/protocol";
import { PrepaidVoucherServerScheme } from "@z402/server";

const payTo = "uregtest1...";
const server = new x402ResourceServer(new HTTPFacilitatorClient({ url: "https://facilitator.example" })).register(
  NETWORK_REGTEST,
  new PrepaidVoucherServerScheme({ payTo, network: NETWORK_REGTEST }),
);
```

- Documentation: https://z402.net/docs (reference: https://z402.net/docs/reference/server)
- Source and issues: https://github.com/oynozan/z402

MIT licensed.
