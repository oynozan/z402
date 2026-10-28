import { afterEach, describe, expect, test, vi } from "vitest";
import { DEFAULT_REPO_URL, repoUrl } from "../src/lib/repo";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("repoUrl", () => {
  test("is the z402 repository when NEXT_PUBLIC_REPO_URL is unset, empty or blank", () => {
    expect(DEFAULT_REPO_URL).toBe("https://github.com/oynozan/z402");
    for (const value of [undefined, "", "   "]) {
      vi.stubEnv("NEXT_PUBLIC_REPO_URL", value);
      expect(repoUrl()).toBe("https://github.com/oynozan/z402");
    }
  });

  test("is the value that is set, trimmed and without trailing slashes", () => {
    vi.stubEnv("NEXT_PUBLIC_REPO_URL", " https://github.com/example/fork// ");
    expect(repoUrl()).toBe("https://github.com/example/fork");
    vi.stubEnv("NEXT_PUBLIC_REPO_URL", "http://git.example.test/z402");
    expect(repoUrl()).toBe("http://git.example.test/z402");
  });

  test("is null for a value that is not an http(s) URL, which turns the repository links off", () => {
    for (const value of ["none", "github.com/oynozan/z402", "git@github.com:oynozan/z402.git", "ftp://example.test/z402"]) {
      vi.stubEnv("NEXT_PUBLIC_REPO_URL", value);
      expect(repoUrl()).toBeNull();
    }
  });
});
