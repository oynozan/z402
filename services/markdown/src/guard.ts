/**
 * The SSRF guard (design §4.2). A page URL must be http(s), carry no credentials and use an allowed port, and every
 * address its host resolves to must be public unicast. The fetcher then connects only to the addresses returned here,
 * so a DNS answer that changes between this check and the connection cannot reach anything else.
 */
import { promises as dns, type LookupAddress } from "node:dns";
import { isIP } from "node:net";
import ipaddr from "ipaddr.js";
import { PageError } from "./errors.js";

/** Every address a host name has */
export type Resolver = (hostname: string) => Promise<LookupAddress[]>;
/** Whether a connection to this address is allowed */
export type AddressPolicy = (address: string) => boolean;

export const systemResolver: Resolver = (hostname) => dns.lookup(hostname, { all: true, verbatim: true });

export const MAX_URL_LENGTH = 4096;

/**
 * Refused on top of ipaddr.js's own table (anything it does not call "unicast"), so that a change in that table cannot
 * open one of these. 240.0.0.0/4 covers 255.255.255.255.
 */
const BLOCKED_V4 = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.0.2.0/24",
  "192.88.99.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "224.0.0.0/4",
  "240.0.0.0/4",
].map((cidr) => ipaddr.IPv4.parseCIDR(cidr));

/**
 * An IPv6 address must be global unicast (2000::/3). That alone leaves out ::, ::1, the IPv4-compatible ::/96, NAT64
 * 64:ff9b::/96, 100::/64, fc00::/7, fe80::/10 and ff00::/8; the list below names the translation and special ranges
 * inside 2000::/3 as well, and repeats NAT64 so that it stays refused whatever happens to the rule above.
 */
const GLOBAL_UNICAST_V6 = ipaddr.IPv6.parseCIDR("2000::/3");
const BLOCKED_V6 = [
  "64:ff9b::/96",
  "64:ff9b:1::/48",
  "2001::/23",
  "2001:db8::/32",
  "2002::/16",
  "3fff::/20",
  "5f00::/16",
].map((cidr) => ipaddr.IPv6.parseCIDR(cidr));

function parseAddress(address: string): ipaddr.IPv4 | ipaddr.IPv6 | undefined {
  const family = isIP(address);
  if (family === 0) return undefined;
  try {
    // ipaddr.js reads the IPv4-compatible "::a.b.c.d" (which resolvers print) as if it were ::ffff:a.b.c.d, so an
    // IPv6 address goes through the WHATWG serializer first, which writes it in hex. A zone id (fe80::1%eth0) throws.
    const canonical = family === 6 ? new URL(`http://[${address}]/`).hostname.slice(1, -1) : address;
    // An IPv4-mapped IPv6 address (::ffff:a.b.c.d) comes back as the IPv4 address it maps
    return ipaddr.process(canonical);
  } catch {
    return undefined;
  }
}

/** The strict policy every deployment uses: public unicast only */
export function isPublicAddress(address: string): boolean {
  const ip = parseAddress(address);
  if (ip === undefined || ip.range() !== "unicast") return false;
  if (ip instanceof ipaddr.IPv4) return !BLOCKED_V4.some((range) => ip.match(range));
  return ip.match(GLOBAL_UNICAST_V6) && !BLOCKED_V6.some((range) => ip.match(range));
}

/** The port a connection to `url` uses, explicit or the scheme's default */
export function portOf(url: URL): number {
  if (url.port !== "") return Number(url.port);
  return url.protocol === "https:" ? 443 : 80;
}

/** The host of `url`, without the brackets of an IPv6 literal */
export function hostOf(url: URL): string {
  const host = url.hostname;
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

function shapeProblem(url: URL, allowedPorts: ReadonlySet<number>): string | undefined {
  if (url.protocol !== "http:" && url.protocol !== "https:") return `${url.protocol} is not http: or https:`;
  if (url.username !== "" || url.password !== "") return "the URL carries credentials";
  const port = portOf(url);
  if (!allowedPorts.has(port)) return `port ${port} is not allowed`;
  return undefined;
}

/**
 * The URL a caller asked for, refused as invalid_url when it is not an absolute http(s) URL without credentials on an
 * allowed port. The WHATWG parser has already turned every IPv4 spelling (0x7f.1, 2130706433, 0177.0.0.1, 127.1) into
 * dotted decimal by then, so the address check sees the real address.
 */
export function parsePageUrl(raw: string, allowedPorts: ReadonlySet<number>): URL {
  if (raw.length === 0 || raw.length > MAX_URL_LENGTH || !URL.canParse(raw)) {
    throw new PageError("invalid_url", "expected an absolute http(s) URL");
  }
  const url = new URL(raw);
  const problem = shapeProblem(url, allowedPorts);
  if (problem !== undefined) throw new PageError("invalid_url", problem);
  return url;
}

/** A redirect target gets the same checks, refused as blocked_address since the upstream chose it */
export function checkRedirect(url: URL, allowedPorts: ReadonlySet<number>): URL {
  const problem = shapeProblem(url, allowedPorts);
  if (problem !== undefined) throw new PageError("blocked_address", `redirect refused: ${problem}`);
  return url;
}

/**
 * The addresses to connect to for `url`, every one allowed by `policy`. An IP literal is judged at once, without DNS.
 * A name is refused when any one of its addresses is blocked, so a name that also points inside cannot be used at all.
 */
export async function allowedAddresses(url: URL, policy: AddressPolicy, resolver: Resolver): Promise<LookupAddress[]> {
  const host = hostOf(url);
  const literal = isIP(host);
  if (literal !== 0) {
    if (!policy(host)) throw new PageError("blocked_address", `${host} is not a public address`);
    return [{ address: host, family: literal }];
  }
  let found: LookupAddress[];
  try {
    found = await resolver(host);
  } catch (e) {
    throw new PageError("fetch_failed", `cannot resolve ${host}`, { cause: e });
  }
  if (found.length === 0) throw new PageError("fetch_failed", `${host} has no address`);
  return found.map(({ address }) => {
    const family = isIP(address);
    if (family === 0 || !policy(address)) {
      throw new PageError("blocked_address", `${host} resolves to a blocked address`);
    }
    return { address, family };
  });
}
