/**
 * An in-process stack for service tests (design §3.5): a FakeChain, the real facilitator on an in-memory ledger, the
 * service under test and a stock x402 fetch that pays through PrepaidVoucherScheme with a MockWallet. A call made with
 * `paidFetch` is a real paid call: deposit, voucher, verify, handler, settle.
 */
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { PrepaidVoucherScheme } from "@z402/client";
import { startFacilitator, type FacilitatorHandle } from "@z402/facilitator";
import { DEMO_TERMS, NETWORK_REGTEST } from "@z402/protocol";
import { FakeChain, MockWallet } from "@z402/testkit";
import type { Express } from "express";
import type { ServiceEnv } from "./env.js";
import { serve, type Listening } from "./run.js";

export const TEST_NETWORK = NETWORK_REGTEST;
export const TEST_PAY_TO = `uregtest1${"q".repeat(60)}`;
export const TEST_TOKEN = "t-service-kit-4f1c";
export const TEST_PUBLIC_URL = "http://service.test";

export interface PayingClient {
  /** Pays through the stock x402 fetch wrapper and the prepaid-voucher client scheme */
  paidFetch: typeof fetch;
  scheme: PrepaidVoucherScheme;
}

export interface TestStack extends PayingClient {
  chain: FakeChain;
  facilitator: FacilitatorHandle;
  /** The service's own base URL */
  url: string;
  env: ServiceEnv;
  /** Another paying client with its own session, since one client's paid calls take turns on its session lock */
  client(): PayingClient;
  close(): Promise<void>;
}

export type Built = Express | { app: Express; close?(): Promise<void> };

export interface TestStackOptions {
  build: (env: ServiceEnv) => Promise<Built>;
  priceZat?: bigint;
  /** Overrides of the service env the build receives */
  env?: Partial<ServiceEnv>;
}

const quiet = (): void => undefined;

/** Starts the facilitator, the service and the paying client, and closes what started if a later step fails */
export async function startTestStack(o: TestStackOptions): Promise<TestStack> {
  const priceZat = o.priceZat ?? 500n;
  const chain = new FakeChain({ expiryDelta: 40 });
  const facilitator = await startFacilitator({
    network: TEST_NETWORK,
    chain: chain.viewFor(TEST_PAY_TO),
    payTo: TEST_PAY_TO,
    priceZat,
    terms: DEMO_TERMS,
    authToken: TEST_TOKEN,
    pollIntervalMs: 50,
    port: 0,
    log: quiet,
  });

  let listening: Listening | undefined;
  let extraClose: (() => Promise<void>) | undefined;
  try {
    const env: ServiceEnv = {
      network: TEST_NETWORK,
      facilitatorUrl: facilitator.url,
      facilitatorToken: TEST_TOKEN,
      payTo: TEST_PAY_TO,
      priceZat,
      publicUrl: TEST_PUBLIC_URL,
      host: "127.0.0.1",
      port: 0,
      ...o.env,
    };
    const built = await o.build(env);
    const app = "app" in built && typeof built.app === "function" ? built.app : (built as Express);
    extraClose = "app" in built && typeof built.app === "function" ? built.close : undefined;
    listening = await serve(app, { host: env.host, port: 0 });

    const schemes: PrepaidVoucherScheme[] = [];
    const client = (): PayingClient => {
      const scheme = new PrepaidVoucherScheme({
        wallet: new MockWallet(chain),
        chain: chain.statusSource(),
        pollIntervalMs: 20,
        facilitatorLagMs: 100,
      });
      schemes.push(scheme);
      return { scheme, paidFetch: wrapFetchWithPayment(fetch, new x402Client().register(TEST_NETWORK, scheme)) };
    };
    const { scheme, paidFetch } = client();
    const running = listening;
    let closing: Promise<void> | undefined;
    return {
      chain,
      facilitator,
      url: running.url,
      env,
      paidFetch,
      scheme,
      client,
      close: () =>
        (closing ??= (async () => {
          await Promise.all(schemes.map((s) => s.close().catch(() => undefined)));
          running.server.closeAllConnections();
          await running.close().catch(() => undefined);
          await extraClose?.().catch(() => undefined);
          await facilitator.close().catch(() => undefined);
        })()),
    };
  } catch (e) {
    if (listening !== undefined) {
      listening.server.closeAllConnections();
      await listening.close().catch(() => undefined);
    }
    await extraClose?.().catch(() => undefined);
    await facilitator.close().catch(() => undefined);
    throw e;
  }
}
