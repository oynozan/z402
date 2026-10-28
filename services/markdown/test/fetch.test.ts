import type { LookupAddress } from "node:dns";
import { brotliCompressSync, deflateRawSync, deflateSync, gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { decodeBody } from "../src/convert.js";
import { PageError } from "../src/errors.js";
import { safeFetch, type FetchOptions } from "../src/fetch.js";
import type { Resolver } from "../src/guard.js";
import { allowLoopback, html, redirect, startPages, type PageServer } from "./pages.js";

const KiB = 1024;
const PAGE = "<html><head><title>Page</title></head><body><p>Hello</p></body></html>";
let pages: PageServer;

/** Answers for the names the tests use; anything else fails like a missing name */
const answers: Record<string, string[]> = {
  "pinned.test": ["127.0.0.1"],
  "internal.test": ["10.0.0.7"],
  "mixed.test": ["127.0.0.1", "192.168.1.1"],
};
const asked: string[] = [];
const fakeDns: Resolver = async (hostname) => {
  asked.push(hostname);
  const found = answers[hostname];
  if (found === undefined) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: "ENOTFOUND" });
  return found.map((address): LookupAddress => ({ address, family: 4 }));
};

function options(o: Partial<FetchOptions> = {}): FetchOptions {
  return {
    allowedPorts: new Set([pages.port]),
    maxBytes: 64 * KiB,
    timeoutMs: 2_000,
    maxRedirects: 2,
    userAgent: "z402-markdown-test/1",
    policy: allowLoopback,
    resolver: fakeDns,
    ...o,
  };
}

async function refusal(work: Promise<unknown>): Promise<PageError> {
  try {
    await work;
  } catch (e) {
    if (e instanceof PageError) return e;
    throw e;
  }
  throw new Error("expected a PageError");
}

beforeAll(async () => {
  const gzipBomb = gzipSync(Buffer.alloc(8 * 1024 * KiB));
  const brotliBomb = brotliCompressSync(Buffer.alloc(8 * 1024 * KiB));
  pages = await startPages({
    "/page": html(PAGE),
    "/headers": (req, res) => {
      res.writeHead(200, { "content-type": "text/plain" }).end(JSON.stringify(req.headers));
    },
    "/hop0": redirect("/page", 301),
    "/hop1": redirect("hop0", 308),
    "/hop2": redirect("/hop1", 303),
    "/hop3": redirect("/hop2", 307),
    "/loop": redirect("/loop"),
    "/to-metadata": (_req, res) => {
      // On an allowed port, so that only the address can refuse it
      res.writeHead(302, { location: `http://169.254.169.254:${pages.port}/latest/meta-data/` }).end();
    },
    "/to-internal": (_req, res) => {
      res.writeHead(302, { location: `http://internal.test:${pages.port}/page` }).end();
    },
    "/to-mixed": (_req, res) => {
      res.writeHead(302, { location: `http://mixed.test:${pages.port}/page` }).end();
    },
    "/to-pinned": (_req, res) => {
      res.writeHead(302, { location: `http://pinned.test:${pages.port}/page` }).end();
    },
    "/to-ftp": redirect("ftp://127.0.0.1/file"),
    "/to-credentials": (_req, res) => {
      res.writeHead(302, { location: `http://user:pw@127.0.0.1:${pages.port}/page` }).end();
    },
    "/to-closed-port": redirect("http://127.0.0.1:22/"),
    "/no-location": (_req, res) => {
      res.writeHead(302).end();
    },
    "/gzip": (_req, res) => {
      res.writeHead(200, { "content-type": "text/html", "content-encoding": "gzip" }).end(gzipSync(PAGE));
    },
    "/deflate": (_req, res) => {
      res.writeHead(200, { "content-type": "text/html", "content-encoding": "deflate" }).end(deflateSync(PAGE));
    },
    "/deflate-raw": (_req, res) => {
      res.writeHead(200, { "content-type": "text/html", "content-encoding": "deflate" }).end(deflateRawSync(PAGE));
    },
    "/br": (_req, res) => {
      res.writeHead(200, { "content-type": "text/html", "content-encoding": "br" }).end(brotliCompressSync(PAGE));
    },
    "/gzip-bomb": (_req, res) => {
      res.writeHead(200, { "content-type": "text/html", "content-encoding": "gzip" }).end(gzipBomb);
    },
    "/br-bomb": (_req, res) => {
      res.writeHead(200, { "content-type": "text/html", "content-encoding": "br" }).end(brotliBomb);
    },
    "/stacked": (_req, res) => {
      res.writeHead(200, { "content-type": "text/html", "content-encoding": "gzip, br" }).end("x");
    },
    "/zstd": (_req, res) => {
      res.writeHead(200, { "content-type": "text/html", "content-encoding": "zstd" }).end("x");
    },
    "/corrupt-gzip": (_req, res) => {
      res.writeHead(200, { "content-type": "text/html", "content-encoding": "gzip" }).end("not gzip at all");
    },
    "/big": (_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("a".repeat(100 * KiB));
    },
    "/big-declared": (_req, res) => {
      res.writeHead(200, { "content-type": "text/html", "content-length": String(100 * KiB) });
      // Never sends the body: the declared length alone is refused
      res.flushHeaders();
    },
    "/hang": () => undefined,
    "/trickle": (_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.write("<p>");
    },
    "/json": html('{"a":1}', "application/json"),
    "/no-type": (_req, res) => {
      res.writeHead(200).end(PAGE);
    },
    "/xhtml": html(PAGE, "application/xhtml+xml"),
    "/text": html("plain words", "text/plain"),
    "/latin1": (_req, res) => {
      res.writeHead(200, { "content-type": 'text/html; Charset="ISO-8859-1"' });
      res.end(Buffer.from("<p>caf\xe9</p>", "latin1"));
    },
    "/gone": (_req, res) => {
      res.writeHead(410, { "content-type": "text/html" }).end("<p>gone</p>");
    },
    "/error": (_req, res) => {
      res.writeHead(500, { "content-type": "text/html" }).end("<p>oops</p>");
    },
    "/reset": (req) => {
      req.socket.destroy();
    },
  });
});

afterAll(async () => {
  await pages.close();
});

describe("safeFetch", () => {
  test("GETs a page with fixed headers and nothing of its own beyond them", async () => {
    const page = await safeFetch(`${pages.origin}/headers`, options());
    const headers = JSON.parse(page.body.toString("utf8")) as Record<string, string>;
    expect(headers).toMatchObject({
      "user-agent": "z402-markdown-test/1",
      accept: "text/html,application/xhtml+xml,text/plain;q=0.9",
      "accept-encoding": "gzip, deflate, br",
      host: `127.0.0.1:${pages.port}`,
    });
    expect(headers.cookie).toBeUndefined();
    expect(headers.authorization).toBeUndefined();
    expect(page).toMatchObject({ status: 200, contentType: "text/plain", charset: undefined });
  });

  test("returns the body, the media type and the charset", async () => {
    const page = await safeFetch(`${pages.origin}/page#frag`, options());
    expect(page).toMatchObject({
      finalUrl: `${pages.origin}/page`,
      status: 200,
      contentType: "text/html",
      charset: "utf-8",
    });
    expect(page.body.toString("utf8")).toBe(PAGE);
    const latin1 = await safeFetch(`${pages.origin}/latin1`, options());
    expect(latin1.charset).toBe("iso-8859-1");
    expect(latin1.body).toEqual(Buffer.from("<p>caf\xe9</p>", "latin1"));
    expect(decodeBody(latin1.body, latin1.charset, true)).toBe("<p>café</p>");
    expect((await safeFetch(`${pages.origin}/xhtml`, options())).contentType).toBe("application/xhtml+xml");
    expect((await safeFetch(`${pages.origin}/text`, options())).contentType).toBe("text/plain");
  });

  test("connects to the address the guard checked, not to what the system resolver would say", async () => {
    asked.length = 0;
    // pinned.test exists only in the fake DNS, so this can only work through the pinned lookup
    const page = await safeFetch(`http://pinned.test:${pages.port}/headers`, options());
    expect(JSON.parse(page.body.toString("utf8"))).toMatchObject({ host: `pinned.test:${pages.port}` });
    expect(asked).toEqual(["pinned.test"]);
  });

  test("follows relative and absolute redirects up to the limit, checking every hop", async () => {
    const twice = await safeFetch(`${pages.origin}/hop1`, options());
    expect(twice.finalUrl).toBe(`${pages.origin}/page`);
    asked.length = 0;
    const viaName = await safeFetch(`${pages.origin}/to-pinned`, options());
    expect(viaName.finalUrl).toBe(`http://pinned.test:${pages.port}/page`);
    expect(asked).toEqual(["pinned.test"]);

    // hopN takes N + 1 redirects to reach /page
    expect((await refusal(safeFetch(`${pages.origin}/hop2`, options()))).code).toBe("fetch_failed");
    expect((await refusal(safeFetch(`${pages.origin}/loop`, options()))).code).toBe("fetch_failed");
    const four = await safeFetch(`${pages.origin}/hop3`, options({ maxRedirects: 4 }));
    expect(four.finalUrl).toBe(`${pages.origin}/page`);
    expect((await refusal(safeFetch(`${pages.origin}/hop0`, options({ maxRedirects: 0 })))).code).toBe("fetch_failed");
  });

  test("a redirect to a blocked address or URL is refused at that hop", async () => {
    const before = pages.hits.length;
    for (const path of ["/to-metadata", "/to-internal", "/to-mixed", "/to-ftp", "/to-credentials", "/to-closed-port"]) {
      const e = await refusal(safeFetch(`${pages.origin}${path}`, options()));
      expect(e.code, path).toBe("blocked_address");
    }
    // Each refused hop ended the chain: the server saw the six first requests and nothing after them
    expect(pages.hits.length - before).toBe(6);
  });

  test("the strict default policy refuses the local server itself", async () => {
    const e = await refusal(safeFetch(`${pages.origin}/page`, options({ policy: undefined })));
    expect(e.code).toBe("blocked_address");
  });

  test("decodes gzip, deflate (zlib or raw) and br", async () => {
    for (const path of ["/gzip", "/deflate", "/deflate-raw", "/br"]) {
      const page = await safeFetch(`${pages.origin}${path}`, options());
      expect(page.body.toString("utf8"), path).toBe(PAGE);
    }
  });

  test("a decompression bomb stops at maxBytes", async () => {
    for (const path of ["/gzip-bomb", "/br-bomb"]) {
      const started = Date.now();
      const e = await refusal(safeFetch(`${pages.origin}${path}`, options()));
      expect(e.code, path).toBe("too_large");
      expect(Date.now() - started).toBeLessThan(1_500);
    }
  });

  test("a body over maxBytes is refused, declared or not", async () => {
    expect((await refusal(safeFetch(`${pages.origin}/big`, options()))).code).toBe("too_large");
    expect((await refusal(safeFetch(`${pages.origin}/big-declared`, options()))).code).toBe("too_large");
    expect((await safeFetch(`${pages.origin}/big`, options({ maxBytes: 100 * KiB }))).body.length).toBe(100 * KiB);
  });

  test("only pages: other content types are refused before the body is read", async () => {
    for (const path of ["/json", "/no-type"]) {
      const e = await refusal(safeFetch(`${pages.origin}${path}`, options()));
      expect(e.code, path).toBe("unsupported_content_type");
    }
  });

  test("an unknown, stacked or broken content coding fails", async () => {
    for (const path of ["/stacked", "/zstd", "/corrupt-gzip"]) {
      expect((await refusal(safeFetch(`${pages.origin}${path}`, options()))).code, path).toBe("fetch_failed");
    }
  });

  test("an upstream error status, a reset or a missing name fails with what is known", async () => {
    expect((await refusal(safeFetch(`${pages.origin}/gone`, options()))).body()).toEqual({
      error: "fetch_failed",
      upstreamStatus: 410,
    });
    expect((await refusal(safeFetch(`${pages.origin}/error`, options()))).upstreamStatus).toBe(500);
    expect((await refusal(safeFetch(`${pages.origin}/no-location`, options()))).upstreamStatus).toBe(302);
    expect((await refusal(safeFetch(`${pages.origin}/reset`, options()))).body()).toEqual({ error: "fetch_failed" });
    expect((await refusal(safeFetch(`http://missing.test:${pages.port}/`, options()))).code).toBe("fetch_failed");
  });

  test("one deadline covers the answer, the body and the DNS lookup", async () => {
    for (const path of ["/hang", "/trickle"]) {
      const started = Date.now();
      const e = await refusal(safeFetch(`${pages.origin}${path}`, options({ timeoutMs: 300 })));
      expect(e.code, path).toBe("fetch_timeout");
      expect(Date.now() - started).toBeLessThan(1_500);
    }
    const stuckDns: Resolver = () => new Promise(() => undefined);
    const slow = safeFetch(`http://slow.test:${pages.port}/`, options({ timeoutMs: 300, resolver: stuckDns }));
    const e = await refusal(slow);
    expect(e.code).toBe("fetch_timeout");
  });

  test("refuses a bad URL before any connection", async () => {
    const before = pages.hits.length;
    expect((await refusal(safeFetch(`ftp://127.0.0.1:${pages.port}/`, options()))).code).toBe("invalid_url");
    expect((await refusal(safeFetch(`http://127.0.0.1:1/`, options()))).code).toBe("invalid_url");
    expect((await refusal(safeFetch(`http://u:p@127.0.0.1:${pages.port}/page`, options()))).code).toBe("invalid_url");
    expect(pages.hits.length).toBe(before);
  });
});
