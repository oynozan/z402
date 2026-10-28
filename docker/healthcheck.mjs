// Container healthcheck for the Node images: node docker/healthcheck.mjs <url> [status] [bearer token file]
// Exits 0 when the URL answers the expected status (200 by default). On failure it prints why, which
// docker inspect keeps, and never the token.
import { readFileSync } from "node:fs";

const [url, expected = "200", tokenFile] = process.argv.slice(2);

try {
  const headers = tokenFile ? { authorization: `Bearer ${readFileSync(tokenFile, "utf8").trim()}` } : {};
  const res = await fetch(url, { headers, redirect: "manual", signal: AbortSignal.timeout(4000) });
  await res.body?.cancel();
  if (String(res.status) === expected) process.exit(0);
  console.log(`${url} answered ${res.status}, expected ${expected}`);
} catch (e) {
  console.log(`${url}: ${e?.cause?.code ?? e?.code ?? e?.message ?? e}`);
}
process.exit(1);
