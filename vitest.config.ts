import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 20000,
    env: { TZ: "America/Los_Angeles", HANDOFF_HOME: ".handoff-test" },
  },
});
