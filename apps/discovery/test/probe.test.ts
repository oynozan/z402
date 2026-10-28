import type { ServerResponse } from "node:http";
import { afterEach, describe, expect, test } from "vitest";
import { describeError, probeHealth, probeRoute, routeUrl, type ProbeContext } from "../src/probe.js";
import {
  bazaar,
  closeAll,
  deadUrl,
  encode,
  hangingOrigin,
  origin,
  paymentRequired,
  pathOf,
  router,
  send402,
  send402Raw,
  sendHealth,
  sendJson,
} from "./support/origins.js";

afterEach(closeAll);

const ctx: ProbeContext = { timeoutMs: 2000 };
const RESOURCE = "https://svc.example/v1/thing";
/** Written as code points, so that no invisible character sits in this file */
const bidi = String.fromCodePoint(0x202e);
const zeroWidth = String.fromCodePoint(0x200b);

/** `levels` arrays inside one another */
function nested(levels: number): unknown {
  let value: unknown = [];
  for (let i = 1; i < levels; i++) value = [value];
  return value;
}

describe("probeHealth", () => {
  test("200 and 503 both mean the service is up", async () => {
    const routes = [
      { method: "post", path: "/v1/a", unit: "page" },
      { method: "GET", path: "/v1/b/:id", probePath: "/v1/b/x" },
    ];
    const ready = await origin((_req, res) => sendHealth(res, routes, { callsToday: 7, priceZat: "500", service: "Svc" }));
    const busy = await origin((_req, res) => sendHealth(res, routes, { ready: false }));

    expect(await probeHealth(ready.url, ctx)).toMatchObject({
      ok: true,
      health: {
        ready: true,
        service: "Svc",
        callsToday: 7,
        priceZat: "500",
        routes: [
          { method: "POST", path: "/v1/a", unit: "page" },
          { method: "GET", path: "/v1/b/:id", probePath: "/v1/b/x", unit: "call" },
        ],
      },
    });
    expect(await probeHealth(busy.url, ctx)).toMatchObject({ ok: true, health: { ready: false } });
    expect(ready.requests).toEqual(["GET /health"]);
  });

  test("any other status is down", async () => {
    for (const status of [204, 301, 404, 500, 502]) {
      const svc = await origin((_req, res) => {
        res.writeHead(status, { location: "/elsewhere" });
        res.end("{}");
      });
      expect(await probeHealth(svc.url, ctx), String(status)).toEqual({ ok: false, reason: `/health answered HTTP ${status}` });
      expect(svc.requests).toEqual(["GET /health"]);
    }
  });

  test("something that is not a kit health is down", async () => {
    const bodies = ["<html>hi</html>", "[]", "null", "42", JSON.stringify({ ok: true }), JSON.stringify({ routes: "no" })];
    for (const body of bodies) {
      const svc = await origin((_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(body);
      });
      expect((await probeHealth(svc.url, ctx)).ok, body).toBe(false);
    }
  });

  test("keeps only what is well formed", async () => {
    const svc = await origin((_req, res) =>
      sendJson(res, 200, {
        service: "café",
        ready: "yes",
        callsToday: -1,
        priceZat: "12x",
        routes: [
          { method: "TRACE", path: "/a", unit: "x" },
          { method: "GET", path: "a", unit: "x" },
          { method: "GET", path: "/b c", unit: "x" },
          { method: "GET", path: "/c#frag", unit: "x" },
          { method: "GET", path: "/d", probePath: "e", unit: "x" },
          { method: "GET", path: "/f\ng", unit: "x" },
          { method: "GET", path: `/${"x".repeat(2100)}`, unit: "x" },
          "nonsense",
          { method: "DELETE", path: "/ok", unit: " \u0007 " },
        ],
      }),
    );
    expect(await probeHealth(svc.url, ctx)).toMatchObject({
      ok: true,
      health: {
        ready: true,
        service: null,
        callsToday: null,
        priceZat: null,
        routes: [{ method: "DELETE", path: "/ok", unit: null }],
      },
    });
  });

  test("reads at most 32 routes", async () => {
    const routes = Array.from({ length: 80 }, (_, i) => ({ method: "GET", path: `/r${i}`, unit: "x" }));
    const svc = await origin((_req, res) => sendHealth(res, routes));
    const result = await probeHealth(svc.url, ctx);
    expect(result.ok && result.health.routes.length).toBe(32);
  });

  test("refuses a body over 64 KiB, declared or not, without waiting for the rest", async () => {
    const declared = await origin((_req, res) => {
      res.writeHead(200, { "content-type": "application/json", "content-length": "100000" });
      res.write("{");
    });
    const streamed = await origin((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write(`{"pad":"${"x".repeat(70_000)}`);
    });
    for (const svc of [declared, streamed]) {
      const started = performance.now();
      expect(await probeHealth(svc.url, { timeoutMs: 5000 })).toEqual({ ok: false, reason: "/health is larger than 64 KiB" });
      expect(performance.now() - started).toBeLessThan(2000);
    }
  });

  test("a body that stalls or trickles is cut off by the deadline", async () => {
    const stalled = await origin((_req, res) => {
      res.writeHead(200, { "content-type": "application/json", "content-length": "500" });
      res.write("{");
    });
    const trickle = await origin((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      const timer = setInterval(() => res.write(" "), 10);
      res.on("close", () => clearInterval(timer));
    });
    for (const svc of [stalled, trickle]) {
      const started = performance.now();
      expect(await probeHealth(svc.url, { timeoutMs: 200 })).toEqual({ ok: false, reason: "timed out" });
      expect(performance.now() - started).toBeLessThan(1500);
    }
  });

  test("a service that never answers times out", async () => {
    const svc = await hangingOrigin();
    const started = performance.now();
    expect(await probeHealth(svc.url, { timeoutMs: 150 })).toEqual({ ok: false, reason: "timed out" });
    expect(performance.now() - started).toBeLessThan(1500);
  });

  test("a refused connection says so, and so does a port that fetch refuses to use", async () => {
    expect(await probeHealth(await deadUrl(), ctx)).toEqual({ ok: false, reason: "ECONNREFUSED" });
    expect(await probeHealth("http://127.0.0.1:6000", ctx)).toEqual({ ok: false, reason: "bad port" });
  });

  test("an abort from outside stops the request at once", async () => {
    const svc = await hangingOrigin();
    const controller = new AbortController();
    const started = performance.now();
    const pending = probeHealth(svc.url, { timeoutMs: 10_000, signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    expect(await pending).toEqual({ ok: false, reason: "aborted" });
    expect(performance.now() - started).toBeLessThan(1500);
    expect(await probeHealth(svc.url, { timeoutMs: 10_000, signal: controller.signal })).toEqual({
      ok: false,
      reason: "aborted",
    });
  });
});

describe("probeRoute", () => {
  test("sends an unpaid probe with no body and returns the decoded 402", async () => {
    const seen: Array<Record<string, string | string[] | undefined>> = [];
    const svc = await origin((req, res) => {
      seen.push({ ...req.headers });
      send402(res, paymentRequired(RESOURCE, { extensions: { bazaar: bazaar("POST"), z402: { unit: "page", note: "n" } } }));
    });
    expect(await probeRoute("POST", `${svc.url}/v1/thing`, ctx)).toMatchObject({
      ok: true,
      route: {
        url: RESOURCE,
        description: `The route at ${RESOURCE}`,
        mimeType: "application/json",
        serviceName: "Fake",
        accepts: [{ scheme: "prepaid-voucher", amount: "500" }],
        extensions: { z402: { unit: "page", note: "n" } },
      },
    });
    expect(svc.requests).toEqual(["POST /v1/thing"]);
    expect(seen[0]).toMatchObject({ accept: "application/json", "x-z402-probe": "1", "user-agent": "z402-discovery" });
    expect(seen[0]?.["payment-signature"]).toBeUndefined();
    expect(seen[0]?.["content-length"] ?? "0").toBe("0");
  });

  test("uses the method of the route", async () => {
    for (const method of ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"] as const) {
      const svc = await origin((_req, res) => send402(res, paymentRequired(RESOURCE)));
      expect((await probeRoute(method, `${svc.url}/x`, ctx)).ok, method).toBe(true);
      expect(svc.requests).toEqual([`${method} /x`]);
    }
  });

  test("anything but a 402 with a header fails", async () => {
    const answers: Array<[string, (res: ServerResponse) => void]> = [
      ["HTTP 200, expected 402", (res) => sendJson(res, 200, {})],
      ["HTTP 503, expected 402", (res) => sendJson(res, 503, { error: "not_ready" })],
      [
        "HTTP 302, expected 402",
        (res) => {
          res.writeHead(302, { location: "/elsewhere" });
          res.end();
        },
      ],
      ["402 without a PAYMENT-REQUIRED header", (res) => sendJson(res, 402, paymentRequired(RESOURCE))],
    ];
    for (const [reason, answer] of answers) {
      const svc = await origin((_req, res) => answer(res));
      expect(await probeRoute("GET", `${svc.url}/x`, ctx)).toEqual({ ok: false, reason });
      expect(svc.requests).toEqual(["GET /x"]);
    }
  });

  test("skips every malformed 402", async () => {
    const valid = paymentRequired(RESOURCE);
    const goodOffer = { scheme: "s", network: "n:1", asset: "A", amount: "1", payTo: "p" };
    const { payTo: _payTo, ...noPayTo } = goodOffer;
    const variants: Array<[string, string, RegExp]> = [
      ["not base64", "%%% not base64 %%%", /base64 JSON/],
      ["base64 of text", Buffer.from("hello world").toString("base64"), /base64 JSON/],
      ["an array", encode([valid]), /x402Version 2/],
      ["null", encode(null), /x402Version 2/],
      ["version 1", encode({ ...valid, x402Version: 1 }), /x402Version 2/],
      ["version as text", encode({ ...valid, x402Version: "2" }), /x402Version 2/],
      ["no accepts", encode({ ...valid, accepts: [] }), /no usable accepts/],
      ["accepts not a list", encode({ ...valid, accepts: goodOffer }), /no usable accepts/],
      ["accepts of junk", encode({ ...valid, accepts: [42, null, "x", {}] }), /no usable accepts/],
      ["accepts without payTo", encode({ ...valid, accepts: [noPayTo] }), /no usable accepts/],
      ["no resource", encode({ ...valid, resource: undefined }), /resource\.url/],
      ["resource without url", encode({ ...valid, resource: { description: "d" } }), /resource\.url/],
      ["resource url of another scheme", encode({ ...valid, resource: { url: "ftp://svc.example/x" } }), /resource\.url/],
      ["resource url with credentials", encode({ ...valid, resource: { url: "https://u:p@svc.example/x" } }), /resource\.url/],
      ["resource url that is not a url", encode({ ...valid, resource: { url: "/v1/thing" } }), /resource\.url/],
      ["bazaar that is not an object", encode({ ...valid, extensions: { bazaar: "yes" } }), /bazaar extension is invalid/],
      ["bazaar that is null", encode({ ...valid, extensions: { bazaar: null } }), /bazaar extension is invalid/],
      ["bazaar without info", encode({ ...valid, extensions: { bazaar: { schema: {} } } }), /bazaar extension is invalid/],
      ["bazaar with a bad method", encode({ ...valid, extensions: { bazaar: bazaar("FETCH") } }), /bazaar extension is invalid/],
      ["a header over the limit of Node's client", "A".repeat(70_000), /larger than Node accepts \(16 KiB\)/],
      ["resource url with a newline", encode({ ...valid, resource: { url: "https://svc.example/a\nb" } }), /resource\.url/],
      ["resource url with an escape character", encode({ ...valid, resource: { url: "https://svc.example/\u001b[2J" } }), /resource\.url/],
      ["resource url with a space", encode({ ...valid, resource: { url: "https://svc.example/a b" } }), /resource\.url/],
      ["resource url with a leading space", encode({ ...valid, resource: { url: " https://svc.example/x" } }), /resource\.url/],
      ["resource url with a tab", encode({ ...valid, resource: { url: "https://svc.example/a\tb" } }), /resource\.url/],
      ["resource url with DEL", encode({ ...valid, resource: { url: "https://svc.example/a\u007fb" } }), /resource\.url/],
      ["resource url with a C1 control", encode({ ...valid, resource: { url: "https://svc.example/a\u009bb" } }), /resource\.url/],
      ["resource url with a bidi override", encode({ ...valid, resource: { url: `https://svc.example/${bidi}x` } }), /resource\.url/],
      ["resource url with a zero-width space", encode({ ...valid, resource: { url: `https://svc.example/a${zeroWidth}b` } }), /resource\.url/],
      ["resource url over 2048 characters", encode({ ...valid, resource: { url: `https://svc.example/${"a".repeat(2030)}` } }), /resource\.url/],
      ["nesting deeper than 64 levels", encode({ ...valid, extensions: { z402: nested(63) } }), /nested deeper than 64 levels/],
      ["nesting of 5,000 levels", encode({ ...valid, extensions: { z402: nested(5000) } }), /nested deeper than 64 levels/],
      ["nesting in an offer", encode({ ...valid, accepts: [{ ...goodOffer, extra: nested(70) }] }), /nested deeper than 64 levels/],
    ];
    for (const [name, header, reason] of variants) {
      const svc = await origin((_req, res) => send402Raw(res, header));
      const result = await probeRoute("GET", `${svc.url}/x`, ctx);
      expect(result.ok, name).toBe(false);
      expect(result.ok ? "" : result.reason, name).toMatch(reason);
    }
  });

  test("keeps the well formed accepts and cleans the service metadata", async () => {
    const required = paymentRequired(RESOURCE, {
      resource: {
        serviceName: "café ☕",
        tags: ["ok", "OK", "", 5, "x".repeat(40), "a", "b", "c", "d", "e"],
        iconUrl: "http://localhost/icon.png",
        description: "",
        mimeType: 12,
      },
    });
    const exact = { scheme: "exact", network: "eip155:8453", asset: "USDC", amount: "1", payTo: "0xabc" };
    (required.accepts as unknown[]).push("junk", exact);
    const svc = await origin((_req, res) => send402(res, required));
    const result = await probeRoute("GET", `${svc.url}/x`, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.route.accepts).toHaveLength(2);
    expect(result.route.tags).toEqual(["ok", "a", "b", "c", "d"]);
    for (const dropped of ["serviceName", "iconUrl", "description", "mimeType", "extensions"]) {
      expect(result.route, dropped).not.toHaveProperty(dropped);
    }
  });

  test("takes nesting up to 64 levels, counting the payment requirements themselves", async () => {
    // The requirements are level 1 and the extensions level 2, so 62 arrays fill the 64 levels that are allowed
    const required = paymentRequired(RESOURCE, { extensions: { z402: nested(62) } });
    const svc = await origin((_req, res) => send402(res, required));
    expect((await probeRoute("GET", `${svc.url}/x`, ctx)).ok).toBe(true);
  });

  test("takes a resource url of 2048 characters and one with letters that are not ASCII", async () => {
    const edge = `https://svc.example/${"a".repeat(2048 - "https://svc.example/".length)}`;
    for (const url of [edge, "https://svc.example/caf\u00e9"]) {
      const svc = await origin((_req, res) => send402(res, paymentRequired(url)));
      expect(await probeRoute("GET", `${svc.url}/x`, ctx), url.slice(0, 40)).toMatchObject({ ok: true, route: { url } });
    }
  });

  test("keeps the description and the media type to one clean line of sane size", async () => {
    const dirty = `  Embeds \u001b[31mtext\u001b[0m${bidi}\nin\r\nlines${zeroWidth}  `;
    interface Kept {
      description?: string;
      mimeType?: string;
    }
    const cases: Array<[string, unknown, unknown, Kept]> = [
      [
        "escapes, line breaks and format characters",
        dirty,
        "application/json",
        { description: "Embeds  [31mtext [0m  in  lines", mimeType: "application/json" },
      ],
      ["a long description", "d".repeat(900), "text/html; charset=utf-8", { description: `${"d".repeat(500)}...`, mimeType: "text/html; charset=utf-8" }],
      ["only control characters", "\u0007\u001b", "application/json", { mimeType: "application/json" }],
      ["a media type with a line break", "ok", "text/plain\nx-injected: 1", { description: "ok" }],
      ["a media type of 129 characters", "ok", `text/${"x".repeat(124)}`, { description: "ok" }],
      ["a media type with a leading space", "ok", " text/plain", { description: "ok" }],
    ];
    for (const [name, description, mimeType, kept] of cases) {
      const svc = await origin((_req, res) => send402(res, paymentRequired(RESOURCE, { resource: { description, mimeType } })));
      const result = await probeRoute("GET", `${svc.url}/x`, ctx);
      expect(result.ok, name).toBe(true);
      if (!result.ok) continue;
      const { description: d, mimeType: m } = result.route;
      expect({ ...(d !== undefined && { description: d }), ...(m !== undefined && { mimeType: m }) }, name).toEqual(kept);
    }
  });

  test("keeps the joiners that emoji and some scripts need in a description", async () => {
    const family = String.fromCodePoint(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467);
    const persian = String.fromCodePoint(0x645, 0x6cc, 0x200c, 0x62e, 0x648, 0x627, 0x647, 0x645);
    const description = `family ${family} and ${persian}`;
    const svc = await origin((_req, res) => send402(res, paymentRequired(RESOURCE, { resource: { description } })));
    expect(await probeRoute("GET", `${svc.url}/x`, ctx)).toMatchObject({ ok: true, route: { description } });
  });

  test("keeps at most 32 offers, however many the 402 holds", async () => {
    const required = paymentRequired(RESOURCE);
    const offers = Array.from({ length: 60 }, (_, i) => ({ scheme: "s", network: "n:1", asset: "A", amount: "1", payTo: `p${i}` }));
    required.accepts = offers;
    const svc = await origin((_req, res) => send402(res, required));
    const result = await probeRoute("GET", `${svc.url}/x`, ctx);
    expect(result.ok && result.route.accepts.map((a) => a.payTo)).toEqual(offers.slice(0, 32).map((a) => a.payTo));
  });

  test("says what a response header block over Node's limit is", async () => {
    // A 402 whose header alone is over the 16 KiB that Node accepts for all the headers of a response
    const big = paymentRequired(RESOURCE, { extensions: { z402: { note: "n".repeat(20_000) } } });
    const heavy = await origin((_req, res) => send402(res, big));
    const reason = "response headers are larger than Node accepts (16 KiB)";
    expect(await probeRoute("GET", `${heavy.url}/x`, ctx)).toEqual({ ok: false, reason });

    const header = await origin((_req, res) => {
      res.writeHead(200, { "content-type": "application/json", "x-padding": "p".repeat(20_000) });
      res.end("{}");
    });
    expect(await probeHealth(header.url, ctx)).toEqual({ ok: false, reason });
  });

  test("keeps a public icon url and an extension that has no bazaar", async () => {
    const required = paymentRequired(RESOURCE, {
      resource: { iconUrl: "https://svc.example/icon.png" },
      extensions: { z402: { unit: "page" } },
    });
    const svc = await origin((_req, res) => send402(res, required));
    expect(await probeRoute("GET", `${svc.url}/x`, ctx)).toMatchObject({
      ok: true,
      route: { iconUrl: "https://svc.example/icon.png", extensions: { z402: { unit: "page" } } },
    });
  });

  test("does not follow a redirect", async () => {
    const svc = await origin(
      router({
        "GET /x": (_req, res) => {
          res.writeHead(307, { location: "/y" });
          res.end();
        },
        "GET /y": (_req, res) => send402(res, paymentRequired(RESOURCE)),
      }),
    );
    expect(await probeRoute("GET", `${svc.url}/x`, ctx)).toEqual({ ok: false, reason: "HTTP 307, expected 402" });
    expect(svc.requests).toEqual(["GET /x"]);
  });

  test("a service that never answers times out", async () => {
    const svc = await hangingOrigin();
    const started = performance.now();
    expect(await probeRoute("GET", `${svc.url}/x`, { timeoutMs: 150 })).toEqual({ ok: false, reason: "timed out" });
    expect(performance.now() - started).toBeLessThan(1500);
  });

  test("a 402 counts without waiting for its body", async () => {
    const svc = await origin((_req, res) => {
      res.writeHead(402, { "payment-required": encode(paymentRequired(RESOURCE)), "content-length": "100" });
      res.flushHeaders();
    });
    const started = performance.now();
    expect((await probeRoute("GET", `${svc.url}/x`, { timeoutMs: 5000 })).ok).toBe(true);
    expect(performance.now() - started).toBeLessThan(1500);
  });
});

describe("routeUrl", () => {
  const base = "http://llm:4031";

  test("joins the probe path, or the path, to the base", () => {
    expect(routeUrl(base, { method: "GET", path: "/v1/a", unit: null })).toBe("http://llm:4031/v1/a");
    expect(routeUrl(base, { method: "GET", path: "/v1/a/:id", probePath: "/v1/a/x?y=1", unit: null })).toBe(
      "http://llm:4031/v1/a/x?y=1",
    );
    expect(routeUrl("http://h/api", { method: "GET", path: "/v1/a", unit: null })).toBe("http://h/api/v1/a");
  });

  test("never leaves the path prefix of the service, where other services may share its origin", () => {
    const prefixed = "http://gw:8080/llm";
    const out = [
      "/../admin/wipe",
      "/a/../../admin",
      "/./../x",
      "/../llm2/x",
      "/%2e%2e/admin",
      "/.%2E/admin",
      "/..%2fadmin",
      "/a%2F..%2f..%2fadmin",
      "/..%5cadmin",
      "/a/%2e%2E/%2e%2e/admin",
    ];
    for (const path of out) {
      expect(routeUrl(prefixed, { method: "DELETE", path, unit: null }), path).toBeUndefined();
      expect(routeUrl(prefixed, { method: "GET", path: "/v1/a", probePath: path, unit: null }), `probe ${path}`).toBeUndefined();
    }
    expect(routeUrl(prefixed, { method: "GET", path: "/v1/a/../b", unit: null })).toBe("http://gw:8080/llm/v1/b");
    expect(routeUrl(prefixed, { method: "GET", path: "/", unit: null })).toBe("http://gw:8080/llm/");
    expect(routeUrl(prefixed, { method: "GET", path: "/v1/a%20b", unit: null })).toBe("http://gw:8080/llm/v1/a%20b");
    expect(routeUrl("http://h", { method: "GET", path: "/a/../b", unit: null })).toBe("http://h/b");
  });

  test("never leaves the origin of the service", () => {
    for (const path of ["//evil.example/x", "/..//evil.example", "/%2f%2fevil.example", "/@evil.example"]) {
      const url = routeUrl(base, { method: "GET", path, unit: null });
      expect(url === undefined || new URL(url).origin === base, path).toBe(true);
    }
  });
});

describe("describeError", () => {
  test("names the cause of a failed fetch", async () => {
    const error = await fetch(`${await deadUrl()}/`).catch((e: unknown) => e);
    expect(describeError(error)).toBe("ECONNREFUSED");
    expect(describeError(new DOMException("x", "TimeoutError"))).toBe("timed out");
    expect(describeError(new DOMException("x", "AbortError"))).toBe("aborted");
  });

  test("returns one clean line for anything else", () => {
    expect(describeError(new Error("line one\nline two\u0007"))).toBe("line one line two");
    expect(describeError("plain\r\ntext")).toBe("plain  text");
    expect(describeError(new Error("x".repeat(500))).length).toBeLessThanOrEqual(203);
    expect(describeError(undefined)).toBe("undefined");
    expect(describeError(new Error(""))).toBe("Error");
  });
});

describe("a probe never throws", () => {
  test("whatever the service does", async () => {
    const svc = await origin((req, res) => {
      if (pathOf(req) === "/reset") {
        req.socket.destroy();
        return;
      }
      res.socket?.write("this is not http\r\n\r\n");
      res.socket?.destroy();
    });
    for (const path of ["/reset", "/garbage"]) {
      expect((await probeRoute("GET", `${svc.url}${path}`, ctx)).ok, path).toBe(false);
      expect((await probeHealth(`${svc.url}${path}`, ctx)).ok, path).toBe(false);
    }
  });
});
