import { describe, expect, it } from "vitest";
import { FlagError, parseFlags, USAGE, type Flags } from "../src/flags.js";

const DEFAULTS: Flags = {
  api: "http://127.0.0.1:4021",
  calls: 150,
  intervalMs: 1000,
  cheat: false,
  network: "zcash:regtest",
  wallet: "zallet",
  zalletUrl: "http://127.0.0.1:50232",
  zalletUser: "zebra",
  zalletPassword: "zebra",
  lightwalletd: "http://127.0.0.1:28137",
};

describe("parseFlags", () => {
  it("defaults to the local Z3 regtest stack", () => {
    expect(parseFlags([])).toEqual(DEFAULTS);
  });

  it("--cheat turns the cheat flag on and changes nothing else", () => {
    expect(parseFlags(["--cheat"])).toEqual({ ...DEFAULTS, cheat: true });
  });

  it("reads every value flag", () => {
    const flags = parseFlags([
      "--api", "https://api.example.com",
      "--calls", "7",
      "--interval-ms", "250",
      "--network", "zcash:testnet",
      "--wallet", "zingo",
      "--zallet-url", "http://zallet:1234",
      "--zallet-user", "alice",
      "--zallet-password", "s3cret",
      "--lightwalletd", "https://testnet.zec.rocks:443",
    ]);
    expect(flags).toEqual({
      api: "https://api.example.com",
      calls: 7,
      intervalMs: 250,
      cheat: false,
      network: "zcash:testnet",
      wallet: "zingo",
      zalletUrl: "http://zallet:1234",
      zalletUser: "alice",
      zalletPassword: "s3cret",
      lightwalletd: "https://testnet.zec.rocks:443",
    });
  });

  it("accepts --flag=value and a zero interval", () => {
    expect(parseFlags(["--calls=3", "--interval-ms=0"])).toEqual({ ...DEFAULTS, calls: 3, intervalMs: 0 });
  });

  it("ignores the lone -- that `pnpm demo -- --cheat` passes through", () => {
    expect(parseFlags(["--", "--cheat"])).toEqual({ ...DEFAULTS, cheat: true });
  });

  it("drops trailing slashes from --api, so the loop can append /chunk", () => {
    expect(parseFlags(["--api", "http://127.0.0.1:4021/"]).api).toBe("http://127.0.0.1:4021");
  });

  it.each([
    [["--calls", "0"], /--calls/],
    [["--calls", "-3"], /--calls/],
    [["--calls", "1.5"], /--calls/],
    [["--calls", "abc"], /--calls/],
    [["--interval-ms", "-1"], /--interval-ms/],
    [["--interval-ms", "fast"], /--interval-ms/],
    [["--network", "eip155:1"], /--network.*zcash:regtest/],
    [["--network", "zcash:"], /--network/],
    [["--wallet", "ledger"], /--wallet.*zallet.*zingo/],
    [["--api", "not a url"], /--api/],
    [["--api", "ftp://127.0.0.1"], /--api/],
    [["--calls"], /--calls/],
    [["--unknown"], /--unknown/],
    [["chunk"], /chunk/],
    [["--zingo-bin", "/usr/bin/zingo-cli"], /--zingo-bin/],
    [["--wallet-dir", "/tmp/w"], /--wallet-dir/],
  ])("rejects %j with a FlagError", (argv, message) => {
    expect(() => parseFlags(argv)).toThrow(FlagError);
    expect(() => parseFlags(argv)).toThrow(message);
  });

  it("documents every flag in the usage text", () => {
    for (const flag of Object.keys(DEFAULTS).map((k) => k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`))) {
      expect(USAGE, flag).toContain(`--${flag}`);
    }
  });
});
