import { parseArgs } from "node:util";
import { isZcashNetwork, NETWORK_REGTEST, ZCASH_NETWORKS, type ZcashNetwork } from "@z402/protocol";

/** In the order the flow checks them */
export const SERVICE_NAMES = ["llm", "markdown", "embeddings", "dropbox"] as const;
export type ServiceName = (typeof SERVICE_NAMES)[number];

export interface Flags {
  /** The base URL of each service to check, without a trailing slash. A service that is not given is skipped. */
  services: Partial<Record<ServiceName, string>>;
  /** The page the markdown service is asked to fetch */
  page: string;
  network: ZcashNetwork;
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

export const DEFAULTS = Object.freeze({
  page: "https://example.com",
  network: NETWORK_REGTEST,
  zalletUrl: "http://127.0.0.1:50232",
  zalletUser: "zebra",
  zalletPassword: "zebra",
  lightwalletd: "http://127.0.0.1:28137",
});

export const USAGE = `usage: pnpm --filter @z402/smoke start [flags]

Pays one call on each service that has a URL, checks every answer, and prints one line per step:
<service> <step> <status> <ms> ms <detail>. It makes one deposit per merchant: services that share one share it.

  --llm <url>              LLM inference service, e.g. http://127.0.0.1:4031      (skipped when left out)
  --markdown <url>         URL to markdown service, e.g. http://127.0.0.1:4032    (skipped when left out)
  --embeddings <url>       text embeddings service, e.g. http://127.0.0.1:4033    (skipped when left out)
  --dropbox <url>          encrypted drop box service, e.g. http://127.0.0.1:4034 (skipped when left out)
  --page <url>             the page the markdown service fetches                  (${DEFAULTS.page})
  --network <id>           zcash:regtest | zcash:testnet | zcash:mainnet          (${DEFAULTS.network})
  --zallet-url <url>       Zallet JSON-RPC endpoint                               (${DEFAULTS.zalletUrl})
  --zallet-user <user>                                                            (${DEFAULTS.zalletUser})
  --zallet-password <pw>                                                          (${DEFAULTS.zalletPassword})
  --lightwalletd <url>     lightwalletd or Zaino gRPC, for deposit status         (${DEFAULTS.lightwalletd})
  --help                   print this text

At least one service is needed. Exit status: 0 when every step passed, 1 when a step failed or the wallet
could not be used, 2 for a flag error.`;

export const wantsHelp = (argv: readonly string[]): boolean => argv.includes("--help") || argv.includes("-h");

function parseHttp(flag: string, raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new FlagError(`${flag}: not a URL, got ${JSON.stringify(raw)}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new FlagError(`${flag}: expected an http(s) URL, got ${JSON.stringify(raw)}`);
  }
  return url;
}

/** A service origin, perhaps with a path prefix, that a route path can be appended to */
function serviceUrl(flag: string, raw: string): string {
  const url = parseHttp(flag, raw);
  if (url.username !== "" || url.password !== "") throw new FlagError(`${flag}: expected a URL without credentials`);
  if (/[?#]/.test(raw)) throw new FlagError(`${flag}: expected a URL without a query or a fragment`);
  return url.href.replace(/\/+$/, "");
}

function zalletUrl(raw: string): string {
  const url = parseHttp("--zallet-url", raw);
  if (url.username !== "" || url.password !== "") {
    throw new FlagError("--zallet-url: expected a URL without credentials, which go in --zallet-user and --zallet-password");
  }
  return raw;
}

export function parseFlags(argv: readonly string[]): Flags {
  // pnpm forwards the -- of `pnpm start -- --llm ...`
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  let values;
  try {
    ({ values } = parseArgs({
      args: [...args],
      options: {
        llm: { type: "string" },
        markdown: { type: "string" },
        embeddings: { type: "string" },
        dropbox: { type: "string" },
        page: { type: "string" },
        network: { type: "string" },
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

  const services: Flags["services"] = {};
  for (const name of SERVICE_NAMES) {
    const raw = values[name];
    if (raw !== undefined) services[name] = serviceUrl(`--${name}`, raw);
  }
  if (Object.keys(services).length === 0) {
    throw new FlagError("give at least one service to check: --llm, --markdown, --embeddings or --dropbox");
  }

  const network = values.network ?? DEFAULTS.network;
  if (!isZcashNetwork(network)) {
    throw new FlagError(`--network: expected one of ${ZCASH_NETWORKS.join(", ")}, got ${JSON.stringify(network)}`);
  }
  const page = values.page ?? DEFAULTS.page;
  parseHttp("--page", page);
  const lightwalletd = values.lightwalletd ?? DEFAULTS.lightwalletd;
  parseHttp("--lightwalletd", lightwalletd);

  return {
    services,
    page,
    network,
    zalletUrl: zalletUrl(values["zallet-url"] ?? DEFAULTS.zalletUrl),
    zalletUser: values["zallet-user"] ?? DEFAULTS.zalletUser,
    zalletPassword: values["zallet-password"] ?? DEFAULTS.zalletPassword,
    lightwalletd,
  };
}
