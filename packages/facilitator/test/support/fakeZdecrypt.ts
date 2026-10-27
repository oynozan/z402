import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface Call {
  argv: string[];
  envKeys: string[];
  pid: number;
}

export interface Fake {
  bin: string;
  calls(): Call[];
}

interface Script {
  bin: string;
  log: string;
}

// macOS adds __CF_USER_TEXT_ENCODING to every process on its own, so it says nothing about what the parent passed
const LOG_CALL = `
const envKeys = Object.keys(process.env).filter((k) => k !== "__CF_USER_TEXT_ENCODING").sort();
const call = { argv: process.argv.slice(2), envKeys, pid: process.pid };
require("node:fs").appendFileSync(LOG, JSON.stringify(call) + "\\n");
`;

/** Executable stand-ins for the zdecrypt binary, kept in a private temp directory */
export class FakeBinaries {
  readonly #dir = mkdtempSync(join(tmpdir(), "z402-zdecrypt-"));
  readonly #cannedStdout = join(this.#dir, "canned.stdout");
  readonly #cannedExit = join(this.#dir, "canned.exit");
  readonly #shared = new Map<string, Script>();
  #count = 0;

  /** A node script that logs its call, then runs `body` as CommonJS */
  script(body: string): Fake {
    return fake(this.#write(body));
  }

  /** Runs the real binary on the same argv, stdin and environment, so results stay real */
  recording(realBin: string): Fake {
    return this.#share(`recording ${realBin}`, () =>
      this.#write(
        `const { spawnSync } = require("node:child_process");
const r = spawnSync(${JSON.stringify(realBin)}, process.argv.slice(2), { stdio: "inherit" });
process.exitCode = r.status ?? 1;`,
      ),
    );
  }

  /** Drains stdin, prints `stdout` and exits with `exitCode` */
  canned(stdout: string, exitCode = 0): Fake {
    writeFileSync(this.#cannedStdout, stdout);
    writeFileSync(this.#cannedExit, String(exitCode));
    return this.#share("canned", () =>
      this.#write(
        `const fs = require("node:fs");
const stdout = fs.readFileSync(${JSON.stringify(this.#cannedStdout)}, "utf8");
const exitCode = Number(fs.readFileSync(${JSON.stringify(this.#cannedExit)}, "utf8"));
process.stdin.resume();
process.stdin.on("end", () => {
  process.stdout.write(stdout);
  process.exitCode = exitCode;
});`,
      ),
    );
  }

  dispose(): void {
    rmSync(this.#dir, { recursive: true, force: true });
  }

  #write(body: string): Script {
    const n = this.#count++;
    const bin = join(this.#dir, `bin${n}`);
    const log = join(this.#dir, `calls${n}.jsonl`);
    writeFileSync(bin, `#!${process.execPath}\nconst LOG = ${JSON.stringify(log)};${LOG_CALL}${body}\n`);
    chmodSync(bin, 0o755);
    return { bin, log };
  }

  // A new file starts slowly on macOS, so sequential tests reuse one and clear its log
  #share(key: string, make: () => Script): Fake {
    const script = this.#shared.get(key) ?? make();
    this.#shared.set(key, script);
    writeFileSync(script.log, "");
    return fake(script);
  }
}

function fake({ bin, log }: Script): Fake {
  return { bin, calls: () => readCalls(log) };
}

function readCalls(log: string): Call[] {
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Call);
}
