/**
 * An in-process stack for service tests (design §3.5): a FakeChain, the real facilitator on an in-memory ledger, the
 * service under test and a stock x402 fetch that pays through PrepaidVoucherScheme with a MockWallet. A call made with
 * `paidFetch` is a real paid call: deposit, voucher, verify, handler, settle.
 *
 * A service in the stack declares its routes only when the stack puts a stub catalog in front of the facilitator
 * (`catalog`), which records each declaration, and `declarationRefusal` checks one against the rules of the
 * facilitator's catalog (multi-provider design §4.4).
 */
import { decodePaymentRequiredHeader } from "@x402/core/http";
import type { PaymentRequired } from "@x402/core/types";
import { isValidIconUrl } from "@x402/extensions/bazaar";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { PrepaidVoucherScheme } from "@z402/client";
import { startFacilitator, type FacilitatorHandle } from "@z402/facilitator";
import {
  ASSET,
  DEMO_TERMS,
  encodeTerms,
  NETWORK_REGTEST,
  parseTerms,
  SCHEME,
  ZAT_RE,
  type Terms,
} from "@z402/protocol";
import { FakeChain, MockWallet } from "@z402/testkit";
import express, { type Express } from "express";
import type { ServiceEnv } from "./env.js";
import { serve, type Listening } from "./run.js";
import { PROBE_HEADER } from "./service.js";

export const TEST_NETWORK = NETWORK_REGTEST;
export const TEST_PAY_TO = `uregtest1${"q".repeat(60)}`;
export const TEST_TOKEN = "t-service-kit-4f1c";
export const TEST_PUBLIC_URL = "http://service.test";

export interface PayingClient {
  /** Pays through the stock x402 fetch wrapper and the prepaid-voucher client scheme */
  paidFetch: typeof fetch;
  scheme: PrepaidVoucherScheme;
}

/** One POST /discovery/resources the stub catalog took */
export interface Declaration {
  authorization: string | undefined;
  /** The body, parsed, or undefined when it is not JSON */
  body: unknown;
  bytes: number;
  /** When it arrived, as Date.now() */
  at: number;
}

/** Stands in for the facilitator's Bazaar and passes every other request on to the facilitator */
export interface CatalogStub {
  readonly declarations: Declaration[];
  /** The most declarations it was answering at one time */
  readonly mostAtOnce: number;
  /** How long it holds each answer */
  delayMs: number;
  /** How it answers from now on: 200 with the items (the default), another status with `body`, or "drop" */
  answer(how: number | "drop", body?: unknown): void;
}

export interface TestStack extends PayingClient {
  chain: FakeChain;
  facilitator: FacilitatorHandle;
  /** The service's own base URL */
  url: string;
  env: ServiceEnv;
  /** The stub Bazaar the service declares to, when the stack was started with `catalog` */
  catalog?: CatalogStub;
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
  /** Puts a stub Bazaar in front of the facilitator and lets the service declare to it, which it otherwise does not */
  catalog?: boolean;
}

const quiet = (): void => undefined;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The catalog routes a facilitator does not have yet, in front of one that has the rest */
async function startCatalog(facilitatorUrl: string): Promise<CatalogStub & { url: string; close(): Promise<void> }> {
  let how: number | "drop" = 200;
  let refusal: unknown;
  let atOnce = 0;
  const stub = {
    declarations: [] as Declaration[],
    mostAtOnce: 0,
    delayMs: 0,
    answer(next: number | "drop", body?: unknown): void {
      how = next;
      refusal = body;
    },
  };
  const app = express();
  app.post("/discovery/resources", express.raw({ type: () => true, limit: "1mb" }), async (req, res) => {
    atOnce += 1;
    stub.mostAtOnce = Math.max(stub.mostAtOnce, atOnce);
    try {
      const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      let body: unknown;
      try {
        body = JSON.parse(bytes.toString("utf8"));
      } catch {
        body = undefined;
      }
      stub.declarations.push({ authorization: req.get("authorization"), body, bytes: bytes.length, at: Date.now() });
      if (stub.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, stub.delayMs));
      if (how === "drop") req.socket.destroy();
      else if (how === 200) res.json({ x402Version: 2, items: isRecord(body) ? body["items"] : [] });
      else res.status(how).json(refusal ?? { error: "refused_by_the_stub" });
    } finally {
      atOnce -= 1;
    }
  });
  app.use(express.raw({ type: () => true, limit: "1mb" }), async (req, res) => {
    const headers: Record<string, string> = {};
    for (const name of ["authorization", "content-type"]) {
      const value = req.get(name);
      if (value !== undefined) headers[name] = value;
    }
    const answer = await fetch(`${facilitatorUrl}${req.originalUrl}`, {
      method: req.method,
      headers,
      ...(Buffer.isBuffer(req.body) && { body: new Uint8Array(req.body) }),
    });
    const type = answer.headers.get("content-type");
    if (type !== null) res.set("content-type", type);
    res.status(answer.status).send(Buffer.from(await answer.arrayBuffer()));
  });
  const listening = await serve(app, { host: "127.0.0.1", port: 0 });
  return Object.assign(stub, {
    url: listening.url,
    close: async () => {
      listening.server.closeAllConnections();
      await listening.close();
    },
  });
}

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
  let catalog: Awaited<ReturnType<typeof startCatalog>> | undefined;
  try {
    if (o.catalog === true) catalog = await startCatalog(facilitator.url);
    const env: ServiceEnv = {
      network: TEST_NETWORK,
      facilitatorUrl: catalog?.url ?? facilitator.url,
      facilitatorToken: TEST_TOKEN,
      payTo: TEST_PAY_TO,
      priceZat,
      publicUrl: TEST_PUBLIC_URL,
      host: "127.0.0.1",
      port: 0,
      // Only the stub catalog takes declarations, and a test that has none sends none
      ...(catalog === undefined && { declareIntervalMs: 0 }),
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
    const stub = catalog;
    let closing: Promise<void> | undefined;
    return {
      chain,
      facilitator,
      url: running.url,
      env,
      ...(stub !== undefined && { catalog: stub }),
      paidFetch,
      scheme,
      client,
      close: () =>
        (closing ??= (async () => {
          await Promise.all(schemes.map((s) => s.close().catch(() => undefined)));
          running.server.closeAllConnections();
          await running.close().catch(() => undefined);
          await extraClose?.().catch(() => undefined);
          await stub?.close().catch(() => undefined);
          await facilitator.close().catch(() => undefined);
        })()),
    };
  } catch (e) {
    if (listening !== undefined) {
      listening.server.closeAllConnections();
      await listening.close().catch(() => undefined);
    }
    await extraClose?.().catch(() => undefined);
    await catalog?.close().catch(() => undefined);
    await facilitator.close().catch(() => undefined);
    throw e;
  }
}

/** The 402 an unpaid request gets, sent as a discovery probe so that no check of the route refuses it first */
export async function paymentRequiredOf(url: string, method: string): Promise<PaymentRequired> {
  const res = await fetch(url, { method, headers: { [PROBE_HEADER]: "1" } });
  await res.arrayBuffer();
  const header = res.headers.get("payment-required");
  if (res.status !== 402 || header === null) throw new Error(`${method} ${url} answered ${res.status}, not a 402`);
  return decodePaymentRequiredHeader(header);
}

/** What a declared item's accepts must name: the facilitator's network and terms, and the provider's payTo */
export interface Rail {
  network: string;
  payTo: string;
  /** The extra of the facilitator's /supported kind, which holds the terms and termsVersion */
  extra: Record<string, unknown>;
}

/** The rail as the stack's facilitator advertises it in /supported, for the stack's own payTo */
export async function railOf(stack: TestStack): Promise<Rail> {
  const res = await fetch(`${stack.facilitator.url}/supported`, { headers: { authorization: `Bearer ${TEST_TOKEN}` } });
  const { kinds } = (await res.json()) as { kinds: { network: string; extra?: Record<string, unknown> }[] };
  const kind = kinds.find((k) => k.network === TEST_NETWORK);
  return { network: TEST_NETWORK, payTo: stack.env.payTo, extra: kind?.extra ?? {} };
}

/*
 * The facilitator's rules for a declaration, written from the multi-provider design §4.4 ("Item validation") and not
 * from the kit, so that they check what the kit sends
 */

const MAX_BODY_BYTES = 64 * 1024;
const ITEM_FIELDS: ReadonlySet<string> = new Set([
  "resource",
  "type",
  "x402Version",
  "accepts",
  "description",
  "mimeType",
  "serviceName",
  "tags",
  "iconUrl",
  "extensions",
]);
const METHODS: ReadonlySet<string> = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]);
const NAME_RE = /^[\x20-\x7e]{1,32}$/;

const sameTerms = (a: Terms, b: Terms): boolean => JSON.stringify(encodeTerms(a)) === JSON.stringify(encodeTerms(b));

function acceptRefusal(a: unknown, rail: Rail): string | undefined {
  if (!isRecord(a)) return "not an object";
  if (a["scheme"] !== SCHEME) return "scheme";
  if (a["network"] !== rail.network) return "network";
  if (a["asset"] !== ASSET) return "asset";
  if (a["payTo"] !== rail.payTo) return "payTo";
  const terms = parseTerms(rail.extra);
  const amount = a["amount"];
  if (typeof amount !== "string" || !ZAT_RE.test(amount) || BigInt(amount) < 1n || BigInt(amount) > terms.windowZat) {
    return "amount: not a canonical zat amount from 1 to windowZat";
  }
  const extra = a["extra"];
  let theirs: Terms;
  try {
    theirs = parseTerms(extra);
  } catch {
    return "extra: no terms";
  }
  if (!sameTerms(theirs, terms)) return "extra: other terms than the facilitator's";
  if (!isRecord(extra) || extra["termsVersion"] !== rail.extra["termsVersion"]) return "extra.termsVersion";
  return undefined;
}

function itemRefusal(item: unknown, rail: Rail): string | undefined {
  if (!isRecord(item)) return "not an object";
  const stranger = Object.keys(item).find((k) => !ITEM_FIELDS.has(k));
  if (stranger !== undefined) return `${stranger}: not a field of a declared resource`;
  const { resource, accepts, description, mimeType, serviceName, tags, iconUrl, extensions } = item;
  if (typeof resource !== "string" || resource.length > 2048 || !URL.canParse(resource)) {
    return "resource: not an absolute URL of at most 2048 characters";
  }
  const url = new URL(resource);
  if (url.protocol !== "http:" && url.protocol !== "https:") return "resource: not http or https";
  if (url.username !== "" || url.password !== "") return "resource: has userinfo";
  if (item["type"] !== "http") return "type";
  if (item["x402Version"] !== 2) return "x402Version";
  if (!Array.isArray(accepts) || accepts.length < 1 || accepts.length > 4) return "accepts: not 1 to 4 entries";
  for (const [i, accept] of accepts.entries()) {
    const why = acceptRefusal(accept, rail);
    if (why !== undefined) return `accepts[${i}].${why}`;
  }
  if (description !== undefined && (typeof description !== "string" || description.length > 512)) return "description";
  if (mimeType !== undefined && (typeof mimeType !== "string" || mimeType.length > 128)) return "mimeType";
  if (serviceName !== undefined && (typeof serviceName !== "string" || !NAME_RE.test(serviceName))) {
    return "serviceName";
  }
  if (tags !== undefined) {
    if (!Array.isArray(tags) || tags.length > 5) return "tags: more than 5";
    if (!tags.every((t) => typeof t === "string" && NAME_RE.test(t))) return "tags: not 1 to 32 printable ASCII each";
    if (new Set(tags.map((t: string) => t.toLowerCase())).size !== tags.length) return "tags: repeated";
  }
  if (iconUrl !== undefined && (typeof iconUrl !== "string" || !isValidIconUrl(iconUrl))) return "iconUrl";
  if (extensions !== undefined) {
    if (!isRecord(extensions)) return "extensions: not an object";
    if (Buffer.byteLength(JSON.stringify(extensions)) > 8192) return "extensions: over 8 KB as JSON";
    const bazaar = extensions["bazaar"];
    const info = isRecord(bazaar) ? bazaar["info"] : undefined;
    const input = isRecord(info) ? info["input"] : undefined;
    const method = isRecord(input) ? input["method"] : undefined;
    if (method !== undefined && (typeof method !== "string" || !METHODS.has(method))) {
      return "extensions.bazaar.info.input.method";
    }
  }
  return undefined;
}

/** Why the facilitator's catalog would refuse this declaration, or undefined when it would take every item */
export function declarationRefusal(d: Declaration, rail: Rail): string | undefined {
  if (d.bytes > MAX_BODY_BYTES) return `the body is ${d.bytes} bytes, over 64 KB`;
  const items = isRecord(d.body) ? d.body["items"] : undefined;
  if (!Array.isArray(items) || items.length < 1 || items.length > 32) return "items: not 1 to 32 items";
  for (const [i, item] of items.entries()) {
    const why = itemRefusal(item, rail);
    if (why !== undefined) return `items[${i}].${why}`;
  }
  return undefined;
}
