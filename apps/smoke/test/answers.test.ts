import { describe, expect, it } from "vitest";
import { parseChunk, parseEmbeddings, parseHold, parseMarkdown, parseUpload } from "../src/answers.js";
import { Failure } from "../src/http.js";

const refused = (call: () => unknown): string => {
  try {
    call();
  } catch (e) {
    if (e instanceof Failure) return e.message;
    throw e;
  }
  throw new Error("the answer was accepted");
};

describe("parseChunk", () => {
  const chunk = { stream: "abc_123-X", index: 0, text: "Hello there", done: false };

  it("reads the first chunk, and a last one with its finish reason", () => {
    expect(parseChunk(chunk, 0, undefined)).toEqual({ stream: "abc_123-X", index: 0, text: "Hello there", done: false });
    expect(parseChunk({ ...chunk, index: 2, done: true, finishReason: "stop", text: "" }, 2, "abc_123-X")).toEqual({
      stream: "abc_123-X",
      index: 2,
      text: "",
      done: true,
      finishReason: "stop",
    });
  });

  it.each([
    ["is not an object", "hello", /not a JSON object/],
    ["is an array", [chunk], /not a JSON object/],
    ["has no stream", { ...chunk, stream: undefined }, /stream/],
    ["has an empty stream", { ...chunk, stream: "" }, /stream/],
    ["has a stream that is a number", { ...chunk, stream: 7 }, /stream/],
    ["has an index that is another chunk", { ...chunk, index: 1 }, /index 1.*expected 0/],
    ["has an index that is a string", { ...chunk, index: "0" }, /index/],
    ["has text that is not a string", { ...chunk, text: 5 }, /text/],
    ["has no text before the last chunk", { ...chunk, text: "" }, /no text/],
    ["has a done that is not a boolean", { ...chunk, done: "no" }, /done/],
    ["has a finish reason that is not a string", { ...chunk, done: true, finishReason: 3 }, /finishReason/],
    ["ends the stream before any text", { ...chunk, text: "", done: true, finishReason: "stop" }, /no text at all/],
  ])("refuses an answer that %s", (_name, answer, message) => {
    expect(refused(() => parseChunk(answer, 0, undefined))).toMatch(message);
  });

  it("refuses a continued chunk that belongs to another stream", () => {
    expect(refused(() => parseChunk({ ...chunk, index: 1 }, 1, "other"))).toMatch(/stream.*other/);
  });
});

describe("parseMarkdown", () => {
  const page = { url: "https://example.com", finalUrl: "https://example.com/", title: "Example Domain", byline: null, markdown: "# Example", length: 9, truncated: false };

  it("reads the title and the length, and a page with no title", () => {
    expect(parseMarkdown(page)).toEqual({ title: "Example Domain", length: 9, truncated: false });
    expect(parseMarkdown({ ...page, title: null, truncated: true })).toEqual({ title: null, length: 9, truncated: true });
  });

  it.each([
    ["is not an object", null, /not a JSON object/],
    ["has no markdown", { ...page, markdown: undefined }, /markdown/],
    ["has empty markdown", { ...page, markdown: "  \n" }, /empty/],
    ["has a length that is not a count", { ...page, length: -1 }, /length/],
    ["has a length that is a string", { ...page, length: "9" }, /length/],
    ["has a title that is a number", { ...page, title: 3 }, /title/],
  ])("refuses an answer that %s", (_name, answer, message) => {
    expect(refused(() => parseMarkdown(answer))).toMatch(message);
  });
});

describe("parseEmbeddings", () => {
  const vector = (index: number, size = 3): unknown => ({ object: "embedding", index, embedding: Array.from({ length: size }, (_, i) => i / 10) });
  const answer = { object: "list", model: "m", dimensions: 3, data: [vector(0), vector(1)], usage: { prompt_tokens: 4, total_tokens: 4 } };

  it("reads the vectors, the dimensions, the model and the tokens", () => {
    expect(parseEmbeddings(answer, 2)).toEqual({ vectors: 2, dimensions: 3, model: "m", tokens: 4 });
    expect(parseEmbeddings({ ...answer, model: undefined, usage: undefined }, 2)).toEqual({ vectors: 2, dimensions: 3 });
  });

  it.each([
    ["is not an object", [], /not a JSON object/],
    ["has no dimensions", { ...answer, dimensions: undefined }, /dimensions/],
    ["has zero dimensions", { ...answer, dimensions: 0 }, /dimensions/],
    ["has no data", { ...answer, data: undefined }, /data/],
    ["has one vector for two inputs", { ...answer, data: [vector(0)] }, /1 vector.*2/],
    ["has a vector at the wrong index", { ...answer, data: [vector(0), vector(5)] }, /index 5/],
    ["has a vector of another size", { ...answer, data: [vector(0), vector(1, 2)] }, /2 numbers.*dimensions is 3/],
    ["has a vector that is not numbers", { ...answer, data: [vector(0), { index: 1, embedding: [0, "x", 0] }] }, /not a finite number/],
    ["has a vector that is NaN", { ...answer, data: [vector(0), { index: 1, embedding: [0, null, 0] }] }, /not a finite number/],
    ["has a vector that is missing", { ...answer, data: [vector(0), { index: 1 }] }, /embedding/],
  ])("refuses an answer that %s", (_name, body, message) => {
    expect(refused(() => parseEmbeddings(body, 2))).toMatch(message);
  });
});

describe("parseUpload", () => {
  const stored = { id: "q3Zs0mYbT7cWpAxK1nGhUw", deleteToken: "m4X1rVd9Tq0uYb7LkGfH2sNaPzE8cJwO5iRtBvQeXyA", size: 1109, tip: 1042, expiresAtHeight: 1052 };

  it("reads the id, the token and the heights", () => {
    expect(parseUpload(stored, 1109)).toEqual(stored);
  });

  it.each([
    ["an id that climbs out of the drops", { ...stored, id: "../health" }, /id/],
    ["an id with a query", { ...stored, id: "abc?x=1" }, /id/],
    ["an id with a slash", { ...stored, id: "a/b" }, /id/],
    ["an empty id", { ...stored, id: "" }, /id/],
    ["a very long id", { ...stored, id: "a".repeat(65) }, /id/],
    ["no delete token", { ...stored, deleteToken: undefined }, /deleteToken/],
    ["a delete token with a line break", { ...stored, deleteToken: "abc\r\nX-Evil: 1" }, /deleteToken/],
    ["another size", { ...stored, size: 1108 }, /size 1108.*1109/],
    ["a tip that is not a count", { ...stored, tip: -4 }, /tip/],
    ["an expiry that is not after the tip", { ...stored, expiresAtHeight: 1042 }, /expiresAtHeight/],
  ])("refuses %s", (_name, answer, message) => {
    expect(refused(() => parseUpload(answer, 1109))).toMatch(message);
  });
});

describe("parseHold", () => {
  const upload = { id: "q3Zs0mYbT7cWpAxK1nGhUw", deleteToken: "t", size: 1, tip: 1042, expiresAtHeight: 1052 };

  it("reads a hold that moved the expiry out", () => {
    expect(parseHold({ id: upload.id, tip: 1043, expiresAtHeight: 1062 }, upload)).toEqual({ id: upload.id, tip: 1043, expiresAtHeight: 1062 });
  });

  it.each([
    ["another drop", { id: "other", tip: 1043, expiresAtHeight: 1062 }, /id/],
    ["an expiry that did not move", { id: upload.id, tip: 1043, expiresAtHeight: 1052 }, /expiresAtHeight 1052.*1052/],
    ["no expiry", { id: upload.id, tip: 1043 }, /expiresAtHeight/],
  ])("refuses an answer with %s", (_name, answer, message) => {
    expect(refused(() => parseHold(answer, upload))).toMatch(message);
  });
});
