import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // WHY: Argon2id is deliberately expensive and lockout tests perform six or more operations.
    testTimeout: 20_000,
  },
});
