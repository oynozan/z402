import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // The docs' components import through the app's "@/" alias
  resolve: { alias: { "@": resolve(import.meta.dirname, "src") } },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
