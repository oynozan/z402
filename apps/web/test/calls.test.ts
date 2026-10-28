import { describe, expect, test } from "vitest";
import {
  curlCommand,
  exampleBlocks,
  exampleJson,
  exampleUrl,
  inlineJson,
  paidFetchCall,
  printable,
  shellQuote,
} from "../src/lib/calls";
import type { RouteInput } from "../src/lib/discovery-types";

const input = (over: Partial<RouteInput>): RouteInput => ({
  queryParams: null,
  pathParams: null,
  bodyType: null,
  body: null,
  ...over,
});

const LLM = {
  method: "POST",
  url: "http://localhost:4031/v1/generate",
  input: input({ bodyType: "json", body: { prompt: "Write a haiku about privacy." } }),
};
const MARKDOWN = { method: "GET", url: "http://localhost:4032/v1/markdown", input: input({ queryParams: { url: "https://example.com" } }) };
const HOLD = {
  method: "POST",
  url: "http://localhost:4034/v1/drops/:id/hold",
  input: input({ bodyType: "json", body: {}, pathParams: { id: "example" } }),
};
const DROPS = {
  method: "POST",
  url: "http://localhost:4034/v1/drops",
  input: input({ bodyType: "text", body: "-----BEGIN AGE ENCRYPTED FILE-----\nYWdl\n-----END AGE ENCRYPTED FILE-----\n" }),
};

describe("exampleUrl", () => {
  test("fills in the example query and path parameters", () => {
    expect(exampleUrl(MARKDOWN)).toBe("http://localhost:4032/v1/markdown?url=https%3A%2F%2Fexample.com");
    expect(exampleUrl(HOLD)).toBe("http://localhost:4034/v1/drops/example/hold");
    expect(exampleUrl({ ...HOLD, url: "http://a.test/v1/[id]", input: input({ pathParams: { id: "a b" } }) })).toBe(
      "http://a.test/v1/a%20b",
    );
  });

  test("leaves a parameter without an example, and a URL it cannot parse", () => {
    expect(exampleUrl({ ...HOLD, input: null })).toBe("http://localhost:4034/v1/drops/:id/hold");
    expect(exampleUrl({ method: "GET", url: "not a url", input: null })).toBe("not a url");
  });
});

describe("curlCommand", () => {
  test("a request with nothing but the URL stays on one line", () => {
    expect(curlCommand(MARKDOWN)).toBe("curl -i 'http://localhost:4032/v1/markdown?url=https%3A%2F%2Fexample.com'");
    expect(curlCommand({ method: "DELETE", url: "http://a.test/x", input: null })).toBe("curl -i -X DELETE 'http://a.test/x'");
  });

  test("a JSON body goes with its content type", () => {
    expect(curlCommand(LLM)).toBe(
      [
        "curl -i -X POST \\",
        "  'http://localhost:4031/v1/generate' \\",
        "  -H 'content-type: application/json' \\",
        `  -d '{"prompt":"Write a haiku about privacy."}'`,
      ].join("\n"),
    );
  });

  test("a text body is sent as it is", () => {
    expect(curlCommand(DROPS)).toBe(
      [
        "curl -i -X POST \\",
        "  'http://localhost:4034/v1/drops' \\",
        "  -H 'content-type: text/plain' \\",
        "  --data-binary '-----BEGIN AGE ENCRYPTED FILE-----",
        "YWdl",
        "-----END AGE ENCRYPTED FILE-----",
        "'",
      ].join("\n"),
    );
  });

  test("quotes what discovery sends so the shell runs nothing of it", () => {
    const hostile = { ...LLM, input: input({ bodyType: "json", body: { prompt: "it's $(rm -rf ~) `x`\u001b[31m" } }) };
    const command = curlCommand(hostile);
    expect(command).toContain(`-d '{"prompt":"it'\\''s $(rm -rf ~) \`x\`\\u001b[31m"}'`);
    expect(command).not.toContain("\u001b");
  });

  test("form fields become -F parts", () => {
    const form = { method: "POST", url: "http://a.test/up", input: input({ bodyType: "form-data", body: { name: "a", size: 2 } }) };
    expect(curlCommand(form)).toBe("curl -i -X POST \\\n  'http://a.test/up' \\\n  -F 'name=a' \\\n  -F 'size=2'");
  });

  test("the display form ends a text body on its last line, and changes nothing else", () => {
    expect(curlCommand(DROPS, { display: true }).split("\n").slice(-2)).toEqual(["YWdl", "-----END AGE ENCRYPTED FILE-----'"]);
    expect(curlCommand(LLM, { display: true })).toBe(curlCommand(LLM));
    expect(curlCommand(HOLD, { display: true })).toBe(curlCommand(HOLD));
  });
});

describe("exampleBlocks", () => {
  test("shows the body, query and path examples the detail renders", () => {
    expect(exampleBlocks(LLM.input)).toEqual([{ label: "Body", code: '{ "prompt": "Write a haiku about privacy." }' }]);
    expect(exampleBlocks(MARKDOWN.input)).toEqual([{ label: "Query", code: '{ "url": "https://example.com" }' }]);
    expect(exampleBlocks(DROPS.input)).toEqual([
      { label: "Body", code: "-----BEGIN AGE ENCRYPTED FILE-----\nYWdl\n-----END AGE ENCRYPTED FILE-----" },
    ]);
  });

  test("leaves out an empty JSON body but keeps the path it fills in", () => {
    expect(exampleBlocks(HOLD.input)).toEqual([{ label: "Path", code: '{ "id": "example" }' }]);
    expect(exampleBlocks(input({ bodyType: "json", body: [] }))).toEqual([{ label: "Body", code: "[]" }]);
    expect(exampleBlocks(null)).toEqual([]);
  });

  test("drops terminal controls from what it shows", () => {
    expect(exampleBlocks(input({ bodyType: "text", body: "a\u001b[31mb\n" }))).toEqual([{ label: "Body", code: "a[31mb" }]);
  });
});

describe("paidFetchCall", () => {
  test("a GET needs no options", () => {
    expect(paidFetchCall(MARKDOWN)).toBe(
      'await paidFetch("http://localhost:4032/v1/markdown?url=https%3A%2F%2Fexample.com");',
    );
  });

  test("a JSON body is stringified with its content type", () => {
    expect(paidFetchCall(LLM)).toBe(
      [
        'await paidFetch("http://localhost:4031/v1/generate", {',
        '  method: "POST",',
        '  headers: { "content-type": "application/json" },',
        '  body: JSON.stringify({ "prompt": "Write a haiku about privacy." }),',
        "});",
      ].join("\n"),
    );
    expect(paidFetchCall(HOLD)).toContain('"http://localhost:4034/v1/drops/example/hold"');
    expect(paidFetchCall(HOLD)).toContain("body: JSON.stringify({}),");
  });

  test("a text body is one string literal", () => {
    expect(paidFetchCall(DROPS)).toContain(
      'body: "-----BEGIN AGE ENCRYPTED FILE-----\\nYWdl\\n-----END AGE ENCRYPTED FILE-----\\n",',
    );
  });

  test("form fields go through FormData", () => {
    const form = { method: "POST", url: "http://a.test/up", input: input({ bodyType: "form-data", body: { name: "a" } }) };
    expect(paidFetchCall(form)).toBe(
      'const form = new FormData();\nform.append("name", "a");\nawait paidFetch("http://a.test/up", {\n  method: "POST",\n  body: form,\n});',
    );
  });
});

describe("helpers", () => {
  test("shellQuote survives single quotes", () => {
    expect(shellQuote("a'b")).toBe(`'a'\\''b'`);
  });

  test("printable drops terminal controls and bidi marks but keeps lines and tabs", () => {
    expect(printable("a\u0007b‮c\nd\te")).toBe("abc\nd\te");
  });

  test("inlineJson and exampleJson", () => {
    expect(inlineJson({ input: ["The quick brown fox"], n: 1, ok: true, none: null })).toBe(
      '{ "input": ["The quick brown fox"], "n": 1, "ok": true, "none": null }',
    );
    expect(inlineJson({})).toBe("{}");
    expect(exampleJson({ prompt: "short" })).toBe('{ "prompt": "short" }');
    expect(exampleJson({ prompt: "x".repeat(60) })).toBe(`{\n  "prompt": "${"x".repeat(60)}"\n}`);
  });
});
