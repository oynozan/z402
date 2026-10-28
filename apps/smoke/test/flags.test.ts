import { describe, expect, it } from "vitest";
import { FlagError, parseFlags, USAGE, wantsHelp, type Flags } from "../src/flags.js";

const DEFAULTS = {
  page: "https://example.com",
  network: "zcash:regtest",
  zalletUrl: "http://127.0.0.1:50232",
  zalletUser: "zebra",
  zalletPassword: "zebra",
  lightwalletd: "http://127.0.0.1:28137",
} as const;

const ALL = ["--llm", "http://llm:4031", "--markdown", "http://markdown:4032", "--embeddings", "http://embeddings:4033", "--dropbox", "http://dropbox:4034"];

function refused(argv: string[]): FlagError {
  try {
    parseFlags(argv);
  } catch (e) {
    if (e instanceof FlagError) return e;
    throw e;
  }
  throw new Error(`parseFlags accepted ${JSON.stringify(argv)}`);
}

describe("parseFlags", () => {
  it("defaults to the local Z3 regtest stack, and a service with no flag is not checked", () => {
    expect(parseFlags(["--llm", "http://127.0.0.1:4031"])).toEqual<Flags>({
      ...DEFAULTS,
      services: { llm: "http://127.0.0.1:4031" },
    });
  });

  it("reads the four services and every other flag", () => {
    const flags = parseFlags([
      ...ALL,
      "--page", "https://example.org/a?b=1",
      "--network", "zcash:testnet",
      "--zallet-url", "http://zallet:28232",
      "--zallet-user", "alice",
      "--zallet-password", "s3cret",
      "--lightwalletd", "https://testnet.zec.rocks:443",
    ]);
    expect(flags).toEqual<Flags>({
      services: {
        llm: "http://llm:4031",
        markdown: "http://markdown:4032",
        embeddings: "http://embeddings:4033",
        dropbox: "http://dropbox:4034",
      },
      page: "https://example.org/a?b=1",
      network: "zcash:testnet",
      zalletUrl: "http://zallet:28232",
      zalletUser: "alice",
      zalletPassword: "s3cret",
      lightwalletd: "https://testnet.zec.rocks:443",
    });
  });

  it("accepts --flag=value", () => {
    expect(parseFlags(["--embeddings=http://e:4033", "--network=zcash:mainnet"])).toMatchObject({
      services: { embeddings: "http://e:4033" },
      network: "zcash:mainnet",
    });
  });

  it("ignores the lone -- that `pnpm start -- --llm ...` passes through", () => {
    expect(parseFlags(["--", "--llm", "http://l:4031"]).services).toEqual({ llm: "http://l:4031" });
  });

  it("lets a flag given again win, as compose adds the flags after the service name to its own", () => {
    const flags = parseFlags([...ALL, "--zallet-url", "http://zallet:28232", "--page", "https://a.example", "--llm", "http://other:1", "--page", "https://b.example"]);
    expect(flags.page).toBe("https://b.example");
    expect(flags.services.llm).toBe("http://other:1");
    expect(flags.services.markdown).toBe("http://markdown:4032");
  });

  it("drops trailing slashes and keeps a path prefix, so a route can be appended to the base", () => {
    expect(parseFlags(["--llm", "http://l:4031/"]).services.llm).toBe("http://l:4031");
    expect(parseFlags(["--llm", "https://example.com/llm//"]).services.llm).toBe("https://example.com/llm");
  });

  it("refuses a run that would check nothing, so that a missing flag cannot pass for success", () => {
    expect(refused([]).message).toMatch(/--llm.*--markdown.*--embeddings.*--dropbox/);
    expect(refused(["--page", "https://example.com"]).message).toMatch(/at least one/);
  });

  it.each([
    [["--llm", "not a url"], /--llm/],
    [["--llm", "ftp://l:4031"], /--llm.*http/],
    [["--llm", "http://user:pw@l:4031"], /--llm.*credentials/],
    [["--llm", "http://l:4031/?x=1"], /--llm.*query/],
    [["--llm", "http://l:4031/#top"], /--llm.*fragment/],
    [["--llm", "http://l:4031?"], /--llm.*query/],
    [["--llm", ""], /--llm/],
    [["--llm", "http://l", "--page", "mailto:x@example.com"], /--page.*http/],
    [["--llm", "http://l", "--page", "example.com"], /--page/],
    [["--llm", "http://l", "--network", "eip155:1"], /--network.*zcash:regtest/],
    [["--llm", "http://l", "--zallet-url", "http://u:p@zallet:1"], /--zallet-url.*--zallet-user/],
    [["--llm", "http://l", "--zallet-url", "zallet:28232"], /--zallet-url/],
    [["--llm", "http://l", "--lightwalletd", "grpc://zaino:8137"], /--lightwalletd.*http/],
    [["--llm"], /--llm/],
    [["--llm", "http://l", "--unknown"], /--unknown/],
    [["--llm", "http://l", "extra"], /extra/],
    [["--llm", "http://l", "--api", "http://x"], /--api/],
  ])("refuses %j", (argv, message) => {
    expect(refused(argv).message).toMatch(message);
  });

  it("never echoes the node:util hint about quoting", () => {
    expect(refused(["--llm", "http://l", "--nope"]).message).not.toMatch(/To specify/);
  });
});

describe("wantsHelp and USAGE", () => {
  it("sees --help and -h anywhere", () => {
    expect(wantsHelp(["--help"])).toBe(true);
    expect(wantsHelp(["--llm", "http://l", "-h"])).toBe(true);
    expect(wantsHelp(["--llm", "http://l"])).toBe(false);
  });

  it("documents every flag with its default", () => {
    for (const flag of ["--llm", "--markdown", "--embeddings", "--dropbox", "--page", "--network", "--zallet-url", "--zallet-user", "--zallet-password", "--lightwalletd", "--help"]) {
      expect(USAGE).toContain(flag);
    }
    for (const value of Object.values(DEFAULTS)) expect(USAGE).toContain(value);
    expect(USAGE).toMatch(/exit/i);
  });
});
