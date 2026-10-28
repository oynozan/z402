import { textOf } from "./format";

/** The repository the site links to unless NEXT_PUBLIC_REPO_URL names another */
export const DEFAULT_REPO_URL = "https://github.com/oynozan/z402";

/** The repository's URL, or null when NEXT_PUBLIC_REPO_URL is set to something that is not an http(s) URL */
export function repoUrl(): string | null {
  const url = textOf(process.env.NEXT_PUBLIC_REPO_URL) ?? DEFAULT_REPO_URL;
  return /^https?:\/\//.test(url) ? url.replace(/\/+$/, "") : null;
}
