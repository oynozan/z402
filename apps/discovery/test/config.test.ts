import { describe, expect, test } from "vitest";
import { ConfigError, loadConfig } from "../src/config.js";

const base = { DISCOVERY_SERVICES: "http://llm:4031" };

describe("loadConfig", () => {
  test("defaults", () => {
    expect(loadConfig(base)).toEqual({
      services: ["http://llm:4031"],
      targets: [],
      refreshMs: 30_000,
      timeoutMs: 5_000,
      host: "127.0.0.1",
      port: 4030,
    });
  });

  test("reads the services and targets, trimmed and in order", () => {
    const config = loadConfig({
      DISCOVERY_SERVICES: " http://llm:4031/ , https://md.example.com/prefix/ ,, http://[::1]:4033 ",
      DISCOVERY_TARGETS: "get http://api:4021/chunk, POST   http://api:4021/other?x=1",
      DISCOVERY_REFRESH_MS: "1000",
      DISCOVERY_TIMEOUT_MS: "250",
      HOST: "0.0.0.0",
      PORT: "0",
    });
    expect(config).toEqual({
      services: ["http://llm:4031", "https://md.example.com/prefix", "http://[::1]:4033"],
      targets: [
        { method: "GET", url: "http://api:4021/chunk" },
        { method: "POST", url: "http://api:4021/other?x=1" },
      ],
      refreshMs: 1000,
      timeoutMs: 250,
      host: "0.0.0.0",
      port: 0,
    });
  });

  test("targets alone are enough", () => {
    expect(loadConfig({ DISCOVERY_TARGETS: "GET http://api:4021/chunk" }).services).toEqual([]);
  });

  test("an empty variable counts as unset", () => {
    const config = loadConfig({
      ...base,
      DISCOVERY_TARGETS: "",
      DISCOVERY_REFRESH_MS: "",
      DISCOVERY_TIMEOUT_MS: "",
      HOST: "",
      PORT: "",
    });
    expect(config).toMatchObject({ targets: [], refreshMs: 30_000, timeoutMs: 5_000, host: "127.0.0.1", port: 4030 });
  });

  test("names the variable at fault", () => {
    const cases: Array<[Record<string, string>, RegExp]> = [
      [{}, /^DISCOVERY_SERVICES is required/],
      [{ DISCOVERY_SERVICES: " , " }, /^DISCOVERY_SERVICES is required/],
      [{ DISCOVERY_SERVICES: "llm:4031" }, /^DISCOVERY_SERVICES: entry 1 is not an http/],
      [{ DISCOVERY_SERVICES: "ftp://llm" }, /^DISCOVERY_SERVICES: entry 1 is not an http/],
      [{ DISCOVERY_SERVICES: "http://a,http://b/?x=1" }, /^DISCOVERY_SERVICES: entry 2 must not have a query/],
      [{ DISCOVERY_SERVICES: "http://a#frag" }, /^DISCOVERY_SERVICES: entry 1 must not have a fragment/],
      [{ DISCOVERY_SERVICES: "http://a:1,http://a:1/" }, /^DISCOVERY_SERVICES: entry 2 repeats entry 1/],
      [{ ...base, DISCOVERY_TARGETS: "http://api/chunk" }, /^DISCOVERY_TARGETS: entry 1 must look like/],
      [{ ...base, DISCOVERY_TARGETS: "TRACE http://api/chunk" }, /^DISCOVERY_TARGETS: entry 1 must look like/],
      [{ ...base, DISCOVERY_TARGETS: "GET api/chunk" }, /^DISCOVERY_TARGETS: entry 1 is not an http/],
      [
        { ...base, DISCOVERY_TARGETS: "GET http://a/b,get http://a/b" },
        /^DISCOVERY_TARGETS: entry 2 repeats entry 1/,
      ],
      [{ ...base, DISCOVERY_REFRESH_MS: "500" }, /^DISCOVERY_REFRESH_MS: expected a whole number from 1000/],
      [{ ...base, DISCOVERY_REFRESH_MS: "soon" }, /^DISCOVERY_REFRESH_MS/],
      [{ ...base, DISCOVERY_TIMEOUT_MS: "0" }, /^DISCOVERY_TIMEOUT_MS: expected a whole number from 1 to 60000/],
      [{ ...base, DISCOVERY_TIMEOUT_MS: "1.5" }, /^DISCOVERY_TIMEOUT_MS/],
      [{ ...base, HOST: "  " }, /^HOST: must not be blank/],
      [{ ...base, PORT: "70000" }, /^PORT: expected a whole number from 0 to 65535/],
      [{ ...base, PORT: "-1" }, /^PORT/],
    ];
    for (const [env, message] of cases) {
      expect(() => loadConfig(env), JSON.stringify(env)).toThrow(message);
      expect(() => loadConfig(env), JSON.stringify(env)).toThrow(ConfigError);
    }
  });

  test("never quotes an entry, which may carry credentials", () => {
    for (const env of [
      { DISCOVERY_SERVICES: "http://user:hunter2@llm:4031" },
      { DISCOVERY_SERVICES: "not a url with hunter2" },
      { ...base, DISCOVERY_TARGETS: "GET http://user:hunter2@api/chunk" },
      { ...base, DISCOVERY_TARGETS: "hunter2" },
    ]) {
      let message = "";
      try {
        loadConfig(env);
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).not.toBe("");
      expect(message).not.toContain("hunter2");
    }
  });
});
