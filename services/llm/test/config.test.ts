import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError } from "@z402/service-kit";
import { describe, expect, test } from "vitest";
import { loadLlmConfig } from "../src/config.js";

describe("loadLlmConfig", () => {
  test("defaults", () => {
    expect(loadLlmConfig({})).toEqual({
      baseUrl: "http://127.0.0.1:11434/v1",
      apiKey: undefined,
      model: "qwen2.5:0.5b",
      chunkTokens: 32,
      maxTokens: 1024,
      maxPromptChars: 8000,
      maxStreams: 64,
      streamIdleMs: 600_000,
      chunkTimeoutMs: 60_000,
    });
  });

  test("reads every variable, and an empty one counts as unset", () => {
    expect(
      loadLlmConfig({
        LLM_BASE_URL: "https://openrouter.ai/api/v1/",
        LLM_API_KEY: "sk-or-1",
        LLM_MODEL: "meta-llama/llama-3.1-8b-instruct",
        LLM_CHUNK_TOKENS: "16",
        LLM_MAX_TOKENS: "2048",
        LLM_MAX_PROMPT_CHARS: "4000",
        LLM_MAX_STREAMS: "8",
        LLM_STREAM_IDLE_MS: "",
        LLM_CHUNK_TIMEOUT_MS: "30000",
      }),
    ).toEqual({
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "sk-or-1",
      model: "meta-llama/llama-3.1-8b-instruct",
      chunkTokens: 16,
      maxTokens: 2048,
      maxPromptChars: 4000,
      maxStreams: 8,
      streamIdleMs: 600_000,
      chunkTimeoutMs: 30_000,
    });
  });

  test("names the variable at fault and never quotes the key", () => {
    const cases: [Record<string, string>, RegExp][] = [
      [{ LLM_BASE_URL: "ftp://x" }, /^LLM_BASE_URL/],
      [{ LLM_CHUNK_TOKENS: "0" }, /^LLM_CHUNK_TOKENS/],
      [{ LLM_CHUNK_TOKENS: "513" }, /^LLM_CHUNK_TOKENS/],
      [{ LLM_MAX_TOKENS: "40000" }, /^LLM_MAX_TOKENS/],
      [{ LLM_MAX_PROMPT_CHARS: "1e3" }, /^LLM_MAX_PROMPT_CHARS/],
      [{ LLM_MAX_STREAMS: "0" }, /^LLM_MAX_STREAMS/],
      [{ LLM_STREAM_IDLE_MS: "10" }, /^LLM_STREAM_IDLE_MS/],
      [{ LLM_CHUNK_TIMEOUT_MS: "90000" }, /^LLM_CHUNK_TIMEOUT_MS/],
      [{ LLM_MODEL: " qwen2.5" }, /^LLM_MODEL/],
      [{ LLM_API_KEY: "sk-has space" }, /^LLM_API_KEY: /],
    ];
    for (const [env, pattern] of cases) {
      expect(() => loadLlmConfig(env)).toThrow(ConfigError);
      expect(() => loadLlmConfig(env)).toThrow(pattern);
    }
    expect(() => loadLlmConfig({ LLM_API_KEY: "sk-has space" })).not.toThrow(/sk-has/);
  });

  test("reads the key from a file", () => {
    const dir = mkdtempSync(join(tmpdir(), "llm-config-"));
    writeFileSync(join(dir, "key"), "sk-from-file\n");
    expect(loadLlmConfig({ LLM_API_KEY_FILE: join(dir, "key") }).apiKey).toBe("sk-from-file");
    expect(loadLlmConfig({ LLM_API_KEY: "sk-direct", LLM_API_KEY_FILE: join(dir, "key") }).apiKey).toBe("sk-direct");
    expect(() => loadLlmConfig({ LLM_API_KEY_FILE: join(dir, "missing") })).toThrow(/^LLM_API_KEY_FILE/);
  });
});
