/**
 * Run by fetch.test.ts in a child process whose environment names a proxy, since Node reads NODE_USE_ENV_PROXY only
 * at start. Fetches the page server's /page by a pinned name, by its address and over https, and prints the outcomes.
 */
import { safeFetch } from "../src/fetch.js";

const port = Number(process.env["PAGE_PORT"]);
const outcomes: string[] = [];
const urls = [`http://pinned.test:${port}/page`, `http://127.0.0.1:${port}/page`, `https://pinned.test:${port}/page`];
for (const url of urls) {
  try {
    const page = await safeFetch(url, {
      allowedPorts: new Set([port]),
      maxBytes: 65_536,
      timeoutMs: 3_000,
      maxRedirects: 0,
      userAgent: "z402-markdown-test/1",
      policy: (address) => address === "127.0.0.1",
      resolver: async () => [{ address: "127.0.0.1", family: 4 }],
    });
    outcomes.push(page.body.toString("utf8"));
  } catch (e) {
    outcomes.push(`failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
process.stdout.write(JSON.stringify(outcomes));
