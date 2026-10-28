import { parseArgs } from "node:util";
import { isZcashNetwork, NETWORK_REGTEST, ZCASH_NETWORKS, type ZcashNetwork } from "@z402/protocol";
import { Z3_DEFAULTS } from "./z3.js";

export type WalletKind = "zallet" | "zingo";

export interface Flags {
  /** The merchant's base URL, without a trailing slash */
  api: string;
  calls: number;
  intervalMs: number;
  /** One deposit, then none, so the merchant refuses at its credit limit */
  cheat: boolean;
  network: ZcashNetwork;
  wallet: WalletKind;
  zalletUrl: string;
  zalletUser: string;
  zalletPassword: string;
  lightwalletd: string;
}

export class FlagError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FlagError";
  }
}

export const USAGE = `usage: pnpm --filter @z402/agent demo [flags]

  --api <url>              merchant base URL, GET <url>/chunk is the paid call   (http://127.0.0.1:4021)
  --calls <n>              number of paid calls                                  (150)
  --interval-ms <ms>       pause between calls                                   (1000)
  --cheat                  deposit once, then let the merchant refuse at its credit limit
  --network <id>           zcash:regtest | zcash:testnet | zcash:mainnet         (zcash:regtest)
  --wallet <kind>          zallet (zingo arrives in Phase 2)                     (zallet)
  --zallet-url <url>       Zallet JSON-RPC endpoint                              (http://127.0.0.1:50232)
  --zallet-user <user>                                                           (zebra)
  --zallet-password <pw>                                                         (zebra)
  --lightwalletd <url>     lightwalletd or Zaino gRPC, for deposit status        (http://127.0.0.1:28137)
  --help                   print this text`;

export const FLAG_DEFAULTS: Flags = Object.freeze({
  api: "http://127.0.0.1:4021",
  calls: 150,
  intervalMs: 1000,
  cheat: false,
  network: NETWORK_REGTEST,
  wallet: "zallet",
  zalletUrl: Z3_DEFAULTS.zalletUrl,
  zalletUser: Z3_DEFAULTS.zalletUser,
  zalletPassword: Z3_DEFAULTS.zalletPassword,
  lightwalletd: Z3_DEFAULTS.lightwalletdUrl,
});

function integer(flag: string, raw: string, min: 0 | 1): number {
  const ok = min === 1 ? /^[1-9][0-9]{0,9}$/ : /^(0|[1-9][0-9]{0,9})$/;
  if (!ok.test(raw)) throw new FlagError(`${flag}: expected ${min === 1 ? "a positive" : "a non-negative"} integer, got ${JSON.stringify(raw)}`);
  return Number(raw);
}

function httpUrl(flag: string, raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new FlagError(`${flag}: not a URL, got ${JSON.stringify(raw)}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new FlagError(`${flag}: expected an http(s) URL, got ${JSON.stringify(raw)}`);
  }
  return raw;
}

export function parseFlags(argv: readonly string[]): Flags {
  // pnpm forwards the -- of pnpm demo -- --cheat
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  let values;
  try {
    ({ values } = parseArgs({
      args: [...args],
      options: {
        api: { type: "string" },
        calls: { type: "string" },
        "interval-ms": { type: "string" },
        cheat: { type: "boolean" },
        network: { type: "string" },
        wallet: { type: "string" },
        "zallet-url": { type: "string" },
        "zallet-user": { type: "string" },
        "zallet-password": { type: "string" },
        lightwalletd: { type: "string" },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw new FlagError(message.replace(/\. To specify.*$/s, ""));
  }

  const d = FLAG_DEFAULTS;
  const network = values.network ?? d.network;
  if (!isZcashNetwork(network)) {
    throw new FlagError(`--network: expected one of ${ZCASH_NETWORKS.join(", ")}, got ${JSON.stringify(network)}`);
  }
  const wallet = values.wallet ?? d.wallet;
  if (wallet !== "zallet" && wallet !== "zingo") {
    throw new FlagError(`--wallet: expected zallet or zingo, got ${JSON.stringify(wallet)}`);
  }

  return {
    api: httpUrl("--api", values.api ?? d.api).replace(/\/+$/, ""),
    calls: values.calls === undefined ? d.calls : integer("--calls", values.calls, 1),
    intervalMs: values["interval-ms"] === undefined ? d.intervalMs : integer("--interval-ms", values["interval-ms"], 0),
    cheat: values.cheat ?? d.cheat,
    network,
    wallet,
    zalletUrl: values["zallet-url"] ?? d.zalletUrl,
    zalletUser: values["zallet-user"] ?? d.zalletUser,
    zalletPassword: values["zallet-password"] ?? d.zalletPassword,
    lightwalletd: values.lightwalletd ?? d.lightwalletd,
  };
}

export interface DiscoverFlags {
  /** A Bazaar endpoint without a trailing slash, the discovery service or the website that proxies it */
  discovery: string;
  /** Free text to rank the list against, which never leaves the process */
  intent: string | undefined;
  /** Print the list as the service sent it */
  json: boolean;
}

export const DISCOVER_USAGE = `usage: pnpm --filter @z402/agent discover [flags]

  --discovery <url>        discovery service, or the website that proxies it     (http://127.0.0.1:4030)
  --intent <text>          rank the list by word overlap with this text, matched here and never sent
  --json                   print the list as JSON, as the service sent it
  --help                   print this text`;

const DISCOVER_DEFAULTS: DiscoverFlags = Object.freeze({
  discovery: "http://127.0.0.1:4030",
  intent: undefined,
  json: false,
});

export function parseDiscoverFlags(argv: readonly string[]): DiscoverFlags {
  // pnpm forwards the -- of pnpm discover -- --json
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  let values;
  try {
    ({ values } = parseArgs({
      args: [...args],
      options: {
        discovery: { type: "string" },
        intent: { type: "string" },
        json: { type: "boolean" },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw new FlagError(message.replace(/\. To specify.*$/s, ""));
  }

  const d = DISCOVER_DEFAULTS;
  const { intent } = values;
  if (intent !== undefined && intent.trim() === "") throw new FlagError("--intent: expected some text");
  if (intent !== undefined && values.json === true) {
    throw new FlagError("--intent: cannot be combined with --json, which prints the list as the service sent it");
  }
  const discovery = httpUrl("--discovery", values.discovery ?? d.discovery);
  const { username, password, search, hash } = new URL(discovery);
  if (username !== "" || password !== "" || search !== "" || hash !== "") {
    throw new FlagError("--discovery: expected a URL without credentials, a query or a fragment");
  }
  return {
    discovery: discovery.replace(/\/+$/, ""),
    intent,
    json: values.json ?? d.json,
  };
}
