import { describe, expect, it } from "vitest";
import { FlagError, parseFlags, USAGE, type Flags } from "../src/flags.js";

const DEFAULTS: Flags = {
  targets: ["http://127.0.0.1:4021/chunk"],
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
      targets: ["https://api.example.com/chunk"],
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

  it("drops trailing slashes from --api before appending /chunk", () => {
    expect(parseFlags(["--api", "http://127.0.0.1:4021/"]).targets).toEqual(["http://127.0.0.1:4021/chunk"]);
  });

  describe("--url", () => {
    it("replaces the default target with the URL as given", () => {
      expect(parseFlags(["--url", "http://127.0.0.1:4023/chunk"]).targets).toEqual(["http://127.0.0.1:4023/chunk"]);
    });

    it("repeats for several targets, kept in order", () => {
      const flags = parseFlags(["--url", "http://127.0.0.1:4021/chunk", "--url", "http://127.0.0.1:4023/chunk?size=2"]);
      expect(flags.targets).toEqual(["http://127.0.0.1:4021/chunk", "http://127.0.0.1:4023/chunk?size=2"]);
    });

    it("takes the place of --api, so a --url after the compose entrypoint's --api wins", () => {
      expect(parseFlags(["--api", "http://a.test", "--url", "http://b.test/x"]).targets).toEqual(["http://b.test/x"]);
      expect(parseFlags(["--api", "http://a.test", "--url", "http://a.test/chunk"]).targets).toEqual(["http://a.test/chunk"]);
    });

    it("leaves --cheat alone with one --url, whatever --api says", () => {
      expect(parseFlags(["--cheat", "--api", "http://a.test", "--url", "http://b.test/x"])).toMatchObject({ cheat: true, targets: ["http://b.test/x"] });
    });

    it.each([
      [["--url", "not a url"], /--url/],
      [["--url", "ftp://127.0.0.1/x"], /--url/],
      [["--url", "http://user:pw@127.0.0.1/x"], /--url: .*credentials/],
      [["--url", "http://a.test/x", "--url", "http://a.test:80/x"], /--url: .*twice/],
      [["--api", "http://user:pw@127.0.0.1"], /--api: .*credentials/],
      [["--cheat", "--url", "http://a.test/x", "--url", "http://b.test/x"], /--cheat: .*one target, got 2/],
    ])("rejects %j with a FlagError", (argv, message) => {
      expect(() => parseFlags(argv)).toThrow(FlagError);
      expect(() => parseFlags(argv)).toThrow(message);
    });
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
    const fields = Object.keys(DEFAULTS).filter((k) => k !== "targets");
    for (const flag of [...fields.map((k) => k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)), "api", "url"]) {
      expect(USAGE, flag).toContain(`--${flag}`);
    }
  });
});
