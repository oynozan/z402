# @z402-net/service-kit

Documentation: https://z402.net/docs/reference/service-kit (all z402 docs: https://z402.net/docs)

Builds a paid HTTP service from a list of routes. It wires the stock x402 Express middleware to the z402 `prepaid-voucher` scheme, checks the provider's API key and the facilitator's terms at start-up, lists the routes in the facilitator's Bazaar, and serves `GET /health`.

```bash
pnpm add @z402-net/service-kit
```

```ts
import { createPaidService, loadServiceEnv, serve, type PaidRoute } from "@z402-net/service-kit";

const routes: PaidRoute[] = [
  { method: "GET", path: "/v1/hello", description: "Says hello.", unit: "hello", discovery: { output: { example: { hello: "world" } } } },
];

const env = loadServiceEnv(process.env, { port: 4040, priceZat: 100n });
const service = await createPaidService({ env, service: { serviceName: "Hello", tags: ["demo"], routes } });
service.app.get("/v1/hello", (_req, res) => res.json({ hello: "world" })); // runs only for a paid call
await serve(service.app, env);
```

TypeScript users also need `@types/express` for the `Express` type in the declarations. `@z402-net/service-kit/testing` (`startTestStack`) is available only inside the z402 repository, because it runs the repository's unpublished `@z402/facilitator` and `@z402/testkit`.

Source and issues: https://github.com/oynozan/z402

MIT licensed.
