import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { loadDropboxConfig } from "../src/config.js";

describe("loadDropboxConfig", () => {
  test("has the defaults, with the directory resolved against the working directory", () => {
    expect(loadDropboxConfig({})).toEqual({
      dir: resolve(".data/dropbox"),
      maxBytes: 1_048_576,
      maxTotalBytes: 268_435_456,
      blocksPerCall: 10,
      maxHoldBlocks: 1000,
      lwdUrl: "http://127.0.0.1:28137",
      tipPollMs: 10_000,
    });
  });

  test("takes every setting from the environment, and an empty one counts as unset", () => {
    expect(
      loadDropboxConfig({
        DROPBOX_DIR: "/var/lib/dropbox",
        DROPBOX_MAX_BYTES: "2048",
        DROPBOX_MAX_TOTAL_BYTES: "4096",
        DROPBOX_BLOCKS_PER_CALL: "5",
        DROPBOX_MAX_HOLD_BLOCKS: "50",
        DROPBOX_LWD_URL: "https://lwd.example:443/",
        DROPBOX_TIP_POLL_MS: "2500",
      }),
    ).toEqual({
      dir: "/var/lib/dropbox",
      maxBytes: 2048,
      maxTotalBytes: 4096,
      blocksPerCall: 5,
      maxHoldBlocks: 50,
      lwdUrl: "https://lwd.example:443",
      tipPollMs: 2500,
    });
    expect(loadDropboxConfig({ DROPBOX_DIR: "", DROPBOX_MAX_BYTES: "" }).maxBytes).toBe(1_048_576);
    expect(loadDropboxConfig({ DROPBOX_DIR: "drops" }).dir).toBe(resolve("drops"));
  });

  test("names the variable at fault", () => {
    const bad = (name: string, value: string): unknown => () => loadDropboxConfig({ [name]: value });
    expect(bad("DROPBOX_DIR", "  ")).toThrow(/^DROPBOX_DIR:/);
    for (const name of [
      "DROPBOX_MAX_BYTES",
      "DROPBOX_MAX_TOTAL_BYTES",
      "DROPBOX_BLOCKS_PER_CALL",
      "DROPBOX_MAX_HOLD_BLOCKS",
      "DROPBOX_TIP_POLL_MS",
    ]) {
      expect(bad(name, "ten"), name).toThrow(new RegExp(`^${name}:`));
      expect(bad(name, "-1"), name).toThrow(new RegExp(`^${name}:`));
      expect(bad(name, "0"), name).toThrow(new RegExp(`^${name}:`));
    }
    expect(bad("DROPBOX_LWD_URL", "localhost:28137")).toThrow(/^DROPBOX_LWD_URL:/);
    expect(bad("DROPBOX_LWD_URL", "ftp://lwd")).toThrow(/^DROPBOX_LWD_URL:/);
  });

  test("refuses limits that contradict each other", () => {
    expect(() => loadDropboxConfig({ DROPBOX_MAX_BYTES: "2000", DROPBOX_MAX_TOTAL_BYTES: "1999" })).toThrow(
      /^DROPBOX_MAX_TOTAL_BYTES:/,
    );
    expect(() => loadDropboxConfig({ DROPBOX_BLOCKS_PER_CALL: "20", DROPBOX_MAX_HOLD_BLOCKS: "19" })).toThrow(
      /^DROPBOX_MAX_HOLD_BLOCKS:/,
    );
    expect(() => loadDropboxConfig({ DROPBOX_MAX_BYTES: "2000", DROPBOX_MAX_TOTAL_BYTES: "2000" })).not.toThrow();
  });

  test("keeps the poll interval inside the time the tip is trusted", () => {
    expect(() => loadDropboxConfig({ DROPBOX_TIP_POLL_MS: "30000" })).not.toThrow();
    expect(() => loadDropboxConfig({ DROPBOX_TIP_POLL_MS: "30001" })).toThrow(/^DROPBOX_TIP_POLL_MS:/);
    expect(() => loadDropboxConfig({ DROPBOX_TIP_POLL_MS: "99" })).toThrow(/^DROPBOX_TIP_POLL_MS:/);
  });
});
