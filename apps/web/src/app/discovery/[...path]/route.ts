import type { NextRequest } from "next/server";
import { DISCOVERY_TIMEOUT_MS, discoveryBase, upstreamUrl } from "@/lib/proxy";

const HEADERS = {
  "access-control-allow-origin": "*",
  "cache-control": "no-store",
} as const;

function json(status: number, body: unknown): Response {
  return Response.json(body, { status, headers: HEADERS });
}

/** Makes the site origin a Bazaar endpoint that the stock withBazaar client can list and search */
export async function GET(request: NextRequest, { params }: { params: Promise<{ path: string[] }> }): Promise<Response> {
  const { path } = await params;
  const target = upstreamUrl(discoveryBase(process.env.DISCOVERY_URL), path, request.nextUrl.search);
  if (target === null) return json(404, { error: "not_found" });

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      cache: "no-store",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    });
  } catch (e) {
    const timedOut = e instanceof DOMException && e.name === "TimeoutError";
    return json(timedOut ? 504 : 502, { error: timedOut ? "discovery_timeout" : "discovery_unreachable" });
  }

  let body: string;
  try {
    body = await upstream.text();
    JSON.parse(body);
  } catch {
    return json(502, { error: "discovery_bad_response" });
  }
  return new Response(body, {
    status: upstream.status,
    headers: { ...HEADERS, "content-type": "application/json; charset=utf-8" },
  });
}

/** The stock Bazaar client sends Content-Type on its GET, so a browser asks first */
export function OPTIONS(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      ...HEADERS,
      "access-control-allow-methods": "GET, OPTIONS",
      "access-control-allow-headers": "Content-Type, Authorization",
      "access-control-max-age": "86400",
    },
  });
}
