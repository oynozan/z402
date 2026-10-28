import { createServer, type Server } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { afterEach, describe, expect, test, vi } from "vitest";
import { startDiscovery, type DiscoveryHandle } from "../src/index.js";
import { closeAll, deadUrl, hangingOrigin, origin, paymentRequired, router, send402, sendHealth } from "./support/origins.js";

const handles: DiscoveryHandle[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((h) => h.close()));
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  await closeAll();
});

const quiet = (): void => undefined;

function service(onHealth: () => void = () => undefined) {
  return origin(
    router({
      "GET /health": (_req, res) => {
        onHealth();
        sendHealth(res, [{ method: "GET", path: "/a" }]);
      },
      "GET /a": (_req, res) => send402(res, paymentRequired("https://svc.example/a")),
    }),
  );
}

describe("startDiscovery", () => {
  test("holds its catalog by the time it is ready", async () => {
    const svc = await service();
    const found = await startDiscovery({ services: [svc.url], port: 0, log: quiet });
    handles.push(found);
    expect(found.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(found.catalog.size).toBe(1);
    const listed = (await (await fetch(`${found.url}/discovery/resources`)).json()) as { items: unknown[] };
    expect(listed.items).toHaveLength(1);
  });

  test("starts even when every service is down, hanging or garbage, and says so in its log", async () => {
    const lines: string[] = [];
    const hang = await hangingOrigin();
    const garbage = await origin((_req, res) => res.end("not json"));
    const services = [await deadUrl(), hang.url, garbage.url];
    const found = await startDiscovery({ services, port: 0, timeoutMs: 150, log: (line) => lines.push(line) });
    handles.push(found);

    const status = (await (await fetch(`${found.url}/discovery/status`)).json()) as Array<{ up: boolean }>;
    expect(status.map((s) => s.up)).toEqual([false, false, false]);
    expect(lines.sort()).toEqual(
      [
        `${services[0]} is down (ECONNREFUSED)`,
        `${services[1]} is down (timed out)`,
        `${services[2]} is down (/health is not JSON)`,
      ].sort(),
    );
    expect((await fetch(`${found.url}/health`)).status).toBe(200);
  });

  test("keeps refreshing until it is closed, and then stops probing", async () => {
    let health = 0;
    const svc = await service(() => health++);
    const found = await startDiscovery({ services: [svc.url], port: 0, refreshMs: 30, log: quiet });
    handles.push(found);
    await vi.waitFor(() => expect(health).toBeGreaterThanOrEqual(3), { timeout: 3000, interval: 10 });

    await found.close();
    const closed = health;
    await expect(fetch(`${found.url}/health`)).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(health).toBe(closed);
    expect(await found.close()).toBeUndefined();
  });

  test("closing does not wait for a client that is stuck mid-request", async () => {
    const svc = await service();
    const found = await startDiscovery({ services: [svc.url], port: 0, log: quiet });
    const { hostname, port } = new URL(found.url);
    const socket = connect(Number(port), hostname);
    socket.on("error", () => undefined);
    await new Promise((resolve) => socket.once("connect", resolve));
    socket.write("GET /health HTTP/1.1\r\nHost: x\r\n");

    const started = performance.now();
    await found.close();
    expect(performance.now() - started).toBeLessThan(4000);
    socket.destroy();
  });

  test("a port in use is reported by name and leaves nothing running", async () => {
    let health = 0;
    const svc = await service(() => health++);
    const occupant = createServer();
    servers.push(occupant);
    await new Promise<void>((resolve) => occupant.listen(0, "127.0.0.1", resolve));
    const port = (occupant.address() as AddressInfo).port;

    await expect(startDiscovery({ services: [svc.url], port, refreshMs: 30, log: quiet })).rejects.toThrow(
      new RegExp(`^PORT: cannot listen on 127\\.0\\.0\\.1:${port} \\(EADDRINUSE\\)$`),
    );
    const probed = health;
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(health).toBe(probed);
  });

  test("a host that cannot be bound is reported by name", async () => {
    const svc = await service();
    await expect(startDiscovery({ services: [svc.url], host: "203.0.113.1", port: 0, log: quiet })).rejects.toThrow(
      /^HOST: cannot listen on 203\.0\.113\.1:0/,
    );
  });

  test("lists a target without any service", async () => {
    const api = await origin(router({ "GET /chunk": (_req, res) => send402(res, paymentRequired("https://api.example/chunk")) }));
    const found = await startDiscovery({
      services: [],
      targets: [{ method: "GET", url: `${api.url}/chunk` }],
      port: 0,
      log: quiet,
    });
    handles.push(found);
    expect(found.catalog.list().items.map((i) => i.resource)).toEqual(["https://api.example/chunk"]);
    expect(api.requests).toEqual(["GET /chunk"]);
    expect(found.catalog.status()).toEqual([]);
  });
});
