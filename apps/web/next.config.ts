import { resolve } from "node:path";
import type { NextConfig } from "next";

const repoRoot = resolve(import.meta.dirname, "../..");

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: repoRoot,
  poweredByHeader: false,
  reactStrictMode: true,
  // The tests import vitest from the workspace root, which an install filtered to this app does not have
  typescript: { tsconfigPath: "tsconfig.build.json" },
};

export default nextConfig;
