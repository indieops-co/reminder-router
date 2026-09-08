import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 20000,
    // Sandboxed: a scratch HANDOFF_HOME, and a port nothing listens on, so no test can ever
    // reach a real daemon (the MCP tools route actions through the daemon whenever one answers).
    env: { TZ: "America/Los_Angeles", HANDOFF_HOME: ".handoff-test", HANDOFF_PORT: "1" },
  },
});
