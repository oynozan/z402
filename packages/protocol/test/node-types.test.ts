import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";

// Typechecking this file fails (TS2591) unless the base tsconfig includes the node types.
describe("node builtin types", () => {
  it("typecheck resolves node:crypto", () => {
    expect(randomBytes(1).length).toBe(1);
  });
});
