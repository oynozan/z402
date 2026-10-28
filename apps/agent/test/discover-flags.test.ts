import { describe, expect, it } from "vitest";
import { DISCOVER_USAGE, FlagError, parseDiscoverFlags, parseFlags, type DiscoverFlags } from "../src/flags.js";

const DEFAULTS: DiscoverFlags = {
  discovery: "http://127.0.0.1:4030",
  intent: undefined,
  json: false,
};

describe("parseDiscoverFlags", () => {
  it("defaults to the local discovery service and the plain list", () => {
    expect(parseDiscoverFlags([])).toEqual(DEFAULTS);
  });

  it("reads every flag", () => {
    expect(parseDiscoverFlags(["--discovery", "https://z402.example", "--intent", "turn a page into markdown"])).toEqual({
      discovery: "https://z402.example",
      intent: "turn a page into markdown",
      json: false,
    });
    expect(parseDiscoverFlags(["--json"])).toEqual({ ...DEFAULTS, json: true });
  });

  it("accepts --flag=value, which is how an intent may start with a dash", () => {
    expect(parseDiscoverFlags(["--discovery=http://discovery:4030", "--intent=-1 block of storage"])).toEqual({
      ...DEFAULTS,
      discovery: "http://discovery:4030",
      intent: "-1 block of storage",
    });
  });

  it("ignores the lone -- that `pnpm discover -- --json` passes through", () => {
    expect(parseDiscoverFlags(["--", "--json"])).toEqual({ ...DEFAULTS, json: true });
  });

  it("drops trailing slashes from --discovery, so the client can append /discovery/resources", () => {
    expect(parseDiscoverFlags(["--discovery", "http://127.0.0.1:4030/"]).discovery).toBe("http://127.0.0.1:4030");
    expect(parseDiscoverFlags(["--discovery", "https://z402.example//"]).discovery).toBe("https://z402.example");
  });

  it("keeps a path prefix, where a website serves the discovery paths below it", () => {
    expect(parseDiscoverFlags(["--discovery", "https://z402.example/api/"]).discovery).toBe("https://z402.example/api");
  });

  it("does not repeat a password in its error", () => {
    expect(() => parseDiscoverFlags(["--discovery", "http://z402:hunter2@127.0.0.1:4030"])).toThrow(FlagError);
    expect(() => parseDiscoverFlags(["--discovery", "http://z402:hunter2@127.0.0.1:4030"])).not.toThrow(/hunter2/);
  });

  it("keeps an intent as typed", () => {
    expect(parseDiscoverFlags(["--intent", "  Store an encrypted file  "]).intent).toBe("  Store an encrypted file  ");
  });

  it.each([
    [["--discovery", "not a url"], /--discovery/],
    [["--discovery", "ftp://127.0.0.1:4030"], /--discovery.*http/],
    [["--discovery"], /--discovery/],
    [["--discovery", "http://z402:hunter2@127.0.0.1:4030"], /--discovery.*credentials/],
    [["--discovery", "http://127.0.0.1:4030/?token=abc"], /--discovery.*query/],
    [["--discovery", "http://127.0.0.1:4030/#top"], /--discovery.*fragment/],
    [["--discovery", "http://127.0.0.1:4030/?"], /--discovery.*query/],
    [["--discovery", "http://127.0.0.1:4030/#"], /--discovery.*fragment/],
    [["--intent"], /--intent/],
    [["--intent", ""], /--intent.*some text/],
    [["--intent", "   "], /--intent.*some text/],
    [["--intent", "store a file", "--json"], /--intent.*--json/],
    [["--json=yes"], /--json/],
    [["--api", "http://127.0.0.1:4021"], /--api/],
    [["--cheat"], /--cheat/],
    [["discover"], /discover/],
    [["markdown"], /markdown/],
  ])("rejects %j with a FlagError", (argv, message) => {
    expect(() => parseDiscoverFlags(argv)).toThrow(FlagError);
    expect(() => parseDiscoverFlags(argv)).toThrow(message);
  });

  it("documents every flag in the usage text", () => {
    for (const flag of [...Object.keys(DEFAULTS), "help"]) {
      expect(DISCOVER_USAGE, flag).toContain(`--${flag}`);
    }
    expect(DISCOVER_USAGE).toContain("http://127.0.0.1:4030");
  });

  it("leaves the demo's own parser alone, which still takes no subcommand", () => {
    expect(() => parseFlags(["discover"])).toThrow(FlagError);
    expect(() => parseFlags(["--discovery", "http://127.0.0.1:4030"])).toThrow(/--discovery/);
  });
});
