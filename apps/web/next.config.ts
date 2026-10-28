import { resolve } from "node:path";
import createMDX from "@next/mdx";
import type { NextConfig } from "next";
import { docsMdxOptions } from "./src/lib/docs/mdx/options";

const repoRoot = resolve(import.meta.dirname, "../..");

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: repoRoot,
  poweredByHeader: false,
  reactStrictMode: true,
  // The tests import vitest from the workspace root, which an install filtered to this app does not have
  typescript: { tsconfigPath: "tsconfig.build.json" },
};

/** The docs are MDX under src/content/docs, compiled with the plugins that src/lib/docs/mdx/options.ts names */
const withMDX = createMDX({ options: docsMdxOptions(resolve(import.meta.dirname, "src/lib/docs/mdx")) });

export default withMDX(nextConfig);
