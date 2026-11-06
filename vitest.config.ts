import { defineConfig } from "vitest/config";

// Separate from vite.config.ts, whose root is ./web.
export default defineConfig({
  test: {
    root: ".",
    include: ["test/**/*.test.ts"],
  },
});
