import type { LookupAddress } from "node:dns";
import { describe, expect, test } from "vitest";
import { PageError } from "../src/errors.js";
import {
  allowedAddresses,
  isPublicAddress,
  MAX_URL_LENGTH,
  parsePageUrl,
  systemResolver,
  type Resolver,
} from "../src/guard.js";
import { allowLoopback } from "./pages.js";

const PORTS: ReadonlySet<number> = new Set([80, 443, 8080, 8443]);

/** A resolver with fixed answers that records every name it is asked */
function fakeDns(answers: Record<string, string[]>): Resolver & { asked: string[] } {
  const asked: string[] = [];
  const resolve = async (hostname: string): Promise<LookupAddress[]> => {
    asked.push(hostname);
    const addresses = answers[hostname];
    if (addresses === undefined) {
      throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: "ENOTFOUND" });
    }
    return addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  };
  return Object.assign(resolve, { asked });
}

async function refusal(work: Promise<unknown> | (() => unknown)): Promise<PageError> {
  try {
    await (typeof work === "function" ? work() : work);
  } catch (e) {
    if (e instanceof PageError) return e;
    throw e;
  }
  throw new Error("expected a PageError");
}

describe("isPublicAddress", () => {
  const blocked = {
    "this network 0.0.0.0/8": ["0.0.0.0", "0.1.2.3", "0.255.255.255"],
    "private 10/8": ["10.0.0.1", "10.255.255.255"],
    "CGNAT 100.64/10": ["100.64.0.1", "100.127.255.255"],
    "loopback 127/8": ["127.0.0.1", "127.1.2.3", "127.255.255.254"],
    "link-local 169.254/16 (cloud metadata)": ["169.254.169.254", "169.254.0.1", "169.254.170.2"],
    "private 172.16/12": ["172.16.0.1", "172.20.10.5", "172.31.255.255"],
    "IETF 192.0.0/24": ["192.0.0.1", "192.0.0.170"],
    "TEST-NET-1 192.0.2/24": ["192.0.2.1"],
    "6to4 relay 192.88.99/24": ["192.88.99.1"],
    "private 192.168/16": ["192.168.0.1", "192.168.255.255"],
    "benchmarking 198.18/15": ["198.18.0.1", "198.19.255.255"],
    "TEST-NET-2 198.51.100/24": ["198.51.100.1"],
    "TEST-NET-3 203.0.113/24": ["203.0.113.1"],
    "multicast 224/4": ["224.0.0.1", "239.255.255.250"],
    "reserved 240/4": ["240.0.0.1", "254.255.255.255"],
    "broadcast": ["255.255.255.255"],
    "unspecified ::": ["::", "0:0:0:0:0:0:0:0"],
    "loopback ::1": ["::1", "0:0:0:0:0:0:0:1"],
    "unique local fc00::/7": ["fc00::1", "fd12:3456:789a::1", "fdff:ffff::1"],
    "link-local fe80::/10": ["fe80::1", "febf:ffff::1", "fe80::1%lo0"],
    "multicast ff00::/8": ["ff02::1", "ff05::1:3", "ff0e::1"],
    "site-local fec0::/10": ["fec0::1"],
    "discard 100::/64": ["100::1"],
    "IPv4-mapped, judged as IPv4": [
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "::ffff:169.254.169.254",
      "::ffff:10.0.0.1",
      "::ffff:0.0.0.0",
    ],
    "IPv4-compatible ::/96": ["::127.0.0.1", "::7f00:1", "::a9fe:a9fe", "::8.8.8.8"],
    "IPv4-translated ::ffff:0:0:0/96": ["::ffff:0:7f00:1"],
    "NAT64 64:ff9b::/96, even of a public IPv4": ["64:ff9b::7f00:1", "64:ff9b::a9fe:a9fe", "64:ff9b::808:808"],
    "local NAT64 64:ff9b:1::/48": ["64:ff9b:1::a00:1"],
    "6to4 2002::/16": ["2002:7f00:1::1", "2002:a9fe:a9fe::1", "2002:808:808::1"],
    "Teredo 2001::/32 and the rest of 2001::/23": [
      "2001::1",
      "2001:0:4136:e378:8000:63bf:3fff:fdd2",
      "2001:2::1",
      "2001:10::1",
    ],
    "documentation 2001:db8::/32 and 3fff::/20": ["2001:db8::1", "3fff::1"],
    "segment routing 5f00::/16": ["5f00::1"],
    "not an address": ["", "localhost", "example.com", "1.2.3", "0x7f.1", "127.1", "2130706433", "01.02.03.04"],
    "a bracketed literal": ["[::1]"],
  };
  for (const [range, addresses] of Object.entries(blocked)) {
    test(`refuses ${range}`, () => {
      for (const address of addresses) expect(isPublicAddress(address), address).toBe(false);
    });
  }

  test("allows public unicast, including next to the blocked ranges", () => {
    const allowed = [
      "8.8.8.8",
      "1.1.1.1",
      "93.184.215.14",
      "100.63.255.255",
      "100.128.0.1",
      "172.15.255.255",
      "172.32.0.1",
      "192.167.255.255",
      "192.169.0.1",
      "198.17.255.255",
      "198.20.0.1",
      "223.255.255.255",
      "::ffff:8.8.8.8",
      "2606:4700:4700::1111",
      "2a00:1450:4001:80b::200e",
      "2001:4860:4860::8888",
    ];
    for (const address of allowed) expect(isPublicAddress(address), address).toBe(true);
  });
});

describe("parsePageUrl", () => {
  test("accepts http(s) on an allowed port, explicit or default", () => {
    expect(parsePageUrl("https://example.com", PORTS).href).toBe("https://example.com/");
    expect(parsePageUrl("http://example.com:8080/a?b=c#d", PORTS).port).toBe("8080");
    expect(parsePageUrl("https://example.com:443/", PORTS).href).toBe("https://example.com/");
    expect(parsePageUrl("  https://example.com/x  ", PORTS).href).toBe("https://example.com/x");
    // The allowlist is of port numbers, whatever the scheme
    expect(parsePageUrl("http://example.com:8443/", PORTS).port).toBe("8443");
    expect(parsePageUrl("https://example.com:80/", PORTS).port).toBe("80");
  });

  test("refuses other schemes, credentials, ports and anything that is not an absolute URL", async () => {
    const refused = [
      "",
      "example.com",
      "/relative",
      "//example.com/x",
      "not a url",
      "ftp://example.com/",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "data:text/html,hi",
      "gopher://example.com:70/",
      "ws://example.com/",
      "http://user:pass@example.com/",
      "http://user@example.com/",
      "https://:secret@example.com/",
      "http://example.com:22/",
      "https://example.com:6379/",
      "http://127.0.0.1:2375/",
      "http://example.com:0/",
      `https://example.com/${"a".repeat(MAX_URL_LENGTH)}`,
    ];
    for (const raw of refused) {
      expect((await refusal(() => parsePageUrl(raw, PORTS))).code, raw).toBe("invalid_url");
    }
  });
});

describe("allowedAddresses", () => {
  const url = (raw: string): URL => parsePageUrl(raw, PORTS);

  test("an IP literal in a blocked range is refused at once, whatever spelling the URL used", async () => {
    const dns = fakeDns({});
    const literals = [
      "http://127.0.0.1/",
      "http://127.1/",
      "http://0x7f.0.0.1/",
      "http://0x7f000001/",
      "http://2130706433/",
      "http://017700000001/",
      "http://0177.0.0.1/",
      "http://127.0.0.1./",
      "http://0/",
      "http://169.254.169.254/latest/meta-data/",
      "http://2852039166/",
      "http://10.1.2.3:8080/",
      "http://[::1]/",
      "http://[::]/",
      "http://[::ffff:127.0.0.1]/",
      "http://[::ffff:169.254.169.254]/",
      "http://[::127.0.0.1]/",
      "http://[fd00::1]/",
      "http://[fe80::1]/",
      "http://[64:ff9b::a9fe:a9fe]/",
      "http://[2002:a9fe:a9fe::]/",
    ];
    for (const raw of literals) {
      expect((await refusal(allowedAddresses(url(raw), isPublicAddress, dns))).code, raw).toBe("blocked_address");
    }
    expect(dns.asked).toEqual([]);
  });

  test("a public IP literal is used as it is, without DNS", async () => {
    const dns = fakeDns({});
    expect(await allowedAddresses(url("http://93.184.215.14/"), isPublicAddress, dns)).toEqual([
      { address: "93.184.215.14", family: 4 },
    ]);
    expect(await allowedAddresses(url("http://[2606:4700:4700::1111]/"), isPublicAddress, dns)).toEqual([
      { address: "2606:4700:4700::1111", family: 6 },
    ]);
    expect(dns.asked).toEqual([]);
  });

  test("a name must resolve to public addresses only", async () => {
    const dns = fakeDns({
      "public.test": ["93.184.215.14", "2606:4700:4700::1111"],
      "mixed.test": ["93.184.215.14", "10.0.0.7"],
      "mixed6.test": ["2606:4700:4700::1111", "fd00::7"],
      "private.test": ["192.168.1.10"],
      "mapped.test": ["::ffff:10.0.0.1"],
      "nat64.test": ["64:ff9b::a00:1"],
      "metadata.test": ["169.254.169.254"],
      "empty.test": [],
    });
    expect(await allowedAddresses(url("https://public.test/"), isPublicAddress, dns)).toEqual([
      { address: "93.184.215.14", family: 4 },
      { address: "2606:4700:4700::1111", family: 6 },
    ]);
    for (const host of ["mixed", "mixed6", "private", "mapped", "nat64", "metadata"]) {
      const e = await refusal(allowedAddresses(url(`https://${host}.test/`), isPublicAddress, dns));
      expect(e.code, host).toBe("blocked_address");
    }
    for (const host of ["empty", "missing"]) {
      const e = await refusal(allowedAddresses(url(`https://${host}.test/`), isPublicAddress, dns));
      expect(e.code, host).toBe("fetch_failed");
    }
  });

  test("the system resolver sends localhost to loopback, which is refused", async () => {
    const e = await refusal(allowedAddresses(url("http://localhost/"), isPublicAddress, systemResolver));
    expect(e.code).toBe("blocked_address");
  });

  test("the policy is injectable, and relaxing it for 127.0.0.1 opens nothing else", async () => {
    const dns = fakeDns({ "local.test": ["127.0.0.1"], "other.test": ["127.0.0.2"] });
    expect(await allowedAddresses(url("http://127.0.0.1/"), allowLoopback, dns)).toEqual([
      { address: "127.0.0.1", family: 4 },
    ]);
    expect(await allowedAddresses(url("http://local.test/"), allowLoopback, dns)).toEqual([
      { address: "127.0.0.1", family: 4 },
    ]);
    expect((await refusal(allowedAddresses(url("http://other.test/"), allowLoopback, dns))).code).toBe(
      "blocked_address",
    );
    expect((await refusal(allowedAddresses(url("http://[::ffff:127.0.0.1]/"), allowLoopback, dns))).code).toBe(
      "blocked_address",
    );
  });
});
