import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError } from "@z402/service-kit";
import { describe, expect, test } from "vitest";
import { DEFAULT_BASE_URL, DEFAULT_MODEL, loadEmbeddingsConfig } from "../src/index.js";

describe("loadEmbeddingsConfig", () => {
  test("defaults", () => {
    expect(loadEmbeddingsConfig({})).toEqual({
      baseUrl: "http://127.0.0.1:11434/v1",
      apiKey: undefined,
      model: "nomic-embed-text",
      maxChars: 4000,
      maxInputChars: 60000,
      maxInputs: 64,
    });
    expect(DEFAULT_BASE_URL).toBe("http://127.0.0.1:11434/v1");
    expect(DEFAULT_MODEL).toBe("nomic-embed-text");
  });

  test("an empty variable counts as unset", () => {
    const config = loadEmbeddingsConfig({
      EMBEDDINGS_BASE_URL: "",
      EMBEDDINGS_API_KEY: "",
      EMBEDDINGS_MODEL: "",
      EMBEDDINGS_MAX_CHARS: "",
      EMBEDDINGS_MAX_INPUTS: "",
    });
    expect(config).toMatchObject({ baseUrl: DEFAULT_BASE_URL, apiKey: undefined, model: DEFAULT_MODEL });
    expect(config).toMatchObject({ maxChars: 4000, maxInputs: 64 });
  });

  test("reads every setting and drops the trailing slash of the base URL", () => {
    const config = loadEmbeddingsConfig({
      EMBEDDINGS_BASE_URL: "https://api.example.com/v1//",
      EMBEDDINGS_API_KEY: "sk-test-123",
      EMBEDDINGS_MODEL: "text-embedding-3-small",
      EMBEDDINGS_MAX_CHARS: "8000",
      EMBEDDINGS_MAX_INPUT_CHARS: "2000",
      EMBEDDINGS_MAX_INPUTS: "16",
    });
    expect(config).toEqual({
      baseUrl: "https://api.example.com/v1",
      apiKey: "sk-test-123",
      model: "text-embedding-3-small",
      maxChars: 8000,
      maxInputChars: 2000,
      maxInputs: 16,
    });
  });

  test("reads the key from a file, and a plain variable wins", () => {
    const dir = mkdtempSync(join(tmpdir(), "embeddings-config-"));
    try {
      const file = join(dir, "key");
      writeFileSync(file, "sk-from-file\n");
      expect(loadEmbeddingsConfig({ EMBEDDINGS_API_KEY_FILE: file }).apiKey).toBe("sk-from-file");
      const both = { EMBEDDINGS_API_KEY: "sk-plain", EMBEDDINGS_API_KEY_FILE: file };
      expect(loadEmbeddingsConfig(both).apiKey).toBe("sk-plain");
      expect(() => loadEmbeddingsConfig({ EMBEDDINGS_API_KEY_FILE: join(dir, "missing") })).toThrow(
        /^EMBEDDINGS_API_KEY_FILE/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a key with a trailing line break from an env file is trimmed", () => {
    expect(loadEmbeddingsConfig({ EMBEDDINGS_API_KEY: "sk-test\r\n" }).apiKey).toBe("sk-test");
  });

  test.each([
    [{ EMBEDDINGS_BASE_URL: "ftp://example.com" }, /^EMBEDDINGS_BASE_URL/],
    [{ EMBEDDINGS_BASE_URL: "not a url" }, /^EMBEDDINGS_BASE_URL/],
    [{ EMBEDDINGS_BASE_URL: "http://user:hunter2@example.com/v1" }, /^EMBEDDINGS_BASE_URL/],
    [{ EMBEDDINGS_API_KEY: "has a space" }, /^EMBEDDINGS_API_KEY/],
    [{ EMBEDDINGS_MODEL: "   " }, /^EMBEDDINGS_MODEL/],
    [{ EMBEDDINGS_MAX_CHARS: "0" }, /^EMBEDDINGS_MAX_CHARS/],
    [{ EMBEDDINGS_MAX_CHARS: "lots" }, /^EMBEDDINGS_MAX_CHARS/],
    [{ EMBEDDINGS_MAX_CHARS: "1000000" }, /^EMBEDDINGS_MAX_CHARS/],
    [{ EMBEDDINGS_MAX_INPUTS: "0" }, /^EMBEDDINGS_MAX_INPUTS/],
    [{ EMBEDDINGS_MAX_INPUTS: "1.5" }, /^EMBEDDINGS_MAX_INPUTS/],
  ])("%j names the variable at fault", (env, message) => {
    expect(() => loadEmbeddingsConfig(env)).toThrow(ConfigError);
    expect(() => loadEmbeddingsConfig(env)).toThrow(message);
  });

  test("an error never quotes a secret", () => {
    for (const env of [
      { EMBEDDINGS_BASE_URL: "http://user:hunter2@example.com/v1" },
      { EMBEDDINGS_API_KEY: "hunter2 with a space" },
    ]) {
      let message = "";
      try {
        loadEmbeddingsConfig(env);
      } catch (e) {
        message = e instanceof Error ? e.message : "";
      }
      expect(message).not.toBe("");
      expect(message).not.toContain("hunter2");
    }
  });
});
