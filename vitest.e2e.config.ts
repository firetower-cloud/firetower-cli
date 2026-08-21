import { defineConfig } from "vitest/config";

// The end-to-end tests drive a real Docker daemon: they install into a
// throwaway directory, wait for the stack to come up, and tear it down again.
// Minutes, not seconds — which is why they are a separate command.
export default defineConfig({
  test: {
    include: ["test/**/*.e2e.test.ts"],
    testTimeout: 15 * 60 * 1000,
    hookTimeout: 5 * 60 * 1000,
    fileParallelism: false,
  },
});
