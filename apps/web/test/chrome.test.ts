import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, test, vi } from "vitest";
import { Footer, Header } from "../src/components/chrome";

afterEach(() => {
  vi.unstubAllEnvs();
});

const Z402_REPO = "https://github.com/oynozan/z402";

/** The label of each anchor with this class, in document order */
function labels(markup: string, className: string): string[] {
  return [...markup.matchAll(new RegExp(`<a class="${className}"[^>]*>([^<]+)</a>`, "g"))].map((m) => m[1]!);
}

describe("Header", () => {
  test("links the z402 repository as GitHub when none is set, in the cell How it works leaves", () => {
    for (const value of [undefined, ""]) {
      vi.stubEnv("NEXT_PUBLIC_REPO_URL", value);
      const out = renderToStaticMarkup(createElement(Header));
      expect(labels(out, "nav-link")).toEqual(["Services", "Docs", "GitHub"]);
      expect(labels(out, "nav-cta")).toEqual(["Get started"]);
      expect(out).toContain(`<a class="nav-link" href="${Z402_REPO}" target="_blank" rel="noreferrer">GitHub</a>`);
      expect(out).toContain("--links:3");
      // The menu on a narrow screen lists all four
      expect(labels(out, "nav-drop-link")).toEqual(["How it works", "Services", "Docs", "GitHub"]);
    }
  });

  test("links the repository that is set", () => {
    vi.stubEnv("NEXT_PUBLIC_REPO_URL", "https://github.com/example/fork/");
    const out = renderToStaticMarkup(createElement(Header));
    expect(out).toContain('<a class="nav-link" href="https://github.com/example/fork" target="_blank" rel="noreferrer">GitHub</a>');
    expect(out).not.toContain(Z402_REPO);
  });

  test("keeps How it works and drops GitHub when the value is not an http(s) URL", () => {
    vi.stubEnv("NEXT_PUBLIC_REPO_URL", "none");
    const out = renderToStaticMarkup(createElement(Header));
    expect(labels(out, "nav-link")).toEqual(["How it works", "Services", "Docs"]);
    expect(labels(out, "nav-drop-link")).toEqual(["How it works", "Services", "Docs"]);
    expect(out).not.toContain("GitHub");
  });
});

describe("Footer", () => {
  test("lists the z402 repository as GitHub when none is set", () => {
    vi.stubEnv("NEXT_PUBLIC_REPO_URL", undefined);
    const out = renderToStaticMarkup(createElement(Footer));
    expect(labels(out, "foot-link")).toEqual(["How it works", "Services", "Docs", "Get started", "Quickstart", "Bazaar list", "GitHub"]);
    expect(out).toContain(`<a class="foot-link" href="${Z402_REPO}" target="_blank" rel="noreferrer">GitHub</a>`);
  });

  test("lists no repository when the value is not an http(s) URL", () => {
    vi.stubEnv("NEXT_PUBLIC_REPO_URL", "none");
    const out = renderToStaticMarkup(createElement(Footer));
    expect(labels(out, "foot-link")).toEqual(["How it works", "Services", "Docs", "Get started", "Quickstart", "Bazaar list"]);
  });
});
