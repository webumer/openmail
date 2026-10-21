import { defineConfig } from "vitest/config";

const integration = process.env.OPENMAIL_INTEGRATION === "1";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    exclude: integration ? ["node_modules/**", "dist/**"] : ["tests/integration/**", "node_modules/**", "dist/**"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
