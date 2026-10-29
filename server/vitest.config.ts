import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    setupFiles: ["test/setup.ts"],
    // Integration tests share one database, so run files one at a time.
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
})
