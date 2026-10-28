/** Helpers for the tests that run src/main.ts as a process, with exactly the environment given and nothing of the developer's own */
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";

const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));
/** Preloaded with --expose-gc, it collects garbage every few milliseconds */
export const GC_PRELOAD = fileURLToPath(new URL("./gc-preload.mjs", import.meta.url));
/** The longest a run may take to end by itself before it is killed and the test fails */
const ENDS_BY_ITSELF_MS = 40_000;

export interface Exit {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface Started {
  child: ChildProcess;
  stdout(): string;
  stderr(): string;
  /** Resolves when the process ends on its own, and rejects if it is still there after 40 s */
  exit: Promise<Exit>;
}

const children: ChildProcess[] = [];
const servers: Server[] = [];

/** Kills what was started and closes what was opened, for afterEach */
export async function cleanup(): Promise<void> {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** Starts src/main.ts, with `node` for the flags of node itself */
export function start(args: string[], node: string[] = []): Started {
  const child = spawn(process.execPath, [...node, "--import", "tsx", "src/main.ts", ...args], {
    cwd: PACKAGE_DIR,
    env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "", TMPDIR: process.env["TMPDIR"] ?? "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
  child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
  const exit = new Promise<Exit>((resolve, reject) => {
    const hung = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`the process did not end by itself, stdout: ${stdout}, stderr: ${stderr}`));
    }, ENDS_BY_ITSELF_MS);
    child.once("exit", (code) => {
      clearTimeout(hung);
      resolve({ code, stdout, stderr });
    });
  });
  return { child, stdout: () => stdout, stderr: () => stderr, exit };
}

export const run = (args: string[]): Promise<Exit> => start(args).exit;

/** A server on a free port, closed by `cleanup` */
export async function listen(handler: Parameters<typeof createServer>[1]): Promise<string> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** An address where nothing listens, which refuses the connection (port 1 is on the fetch blocklist and fails differently) */
export async function refusedUrl(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}
