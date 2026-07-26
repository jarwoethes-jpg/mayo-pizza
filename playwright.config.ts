import { fileURLToPath, URL } from "node:url";
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: fileURLToPath(new URL("./e2e", import.meta.url)),
  testMatch: "**/*.spec.ts",
  fullyParallel: true,
  reporter: "line",
  use: {
    baseURL: "http://127.0.0.1:5173",
    trace: "on-first-retry",
  },
  // The app reads window.__MAYO_SIGNALING_URL__ at runtime, so e2e does not
  // need a rebuild to point the browser at the separately started WS server.
  // MAYO_FORCE_RELAY=1 is copied to the same runtime global by connect.spec.ts.
  webServer: [
    {
      command:
        "pnpm --filter shared build && pnpm --filter server build && pnpm --filter server start",
      url: "http://127.0.0.1:3100/healthz",
      timeout: 120_000,
      reuseExistingServer: !process.env.CI,
      env: {
        PORT: "3100",
        TURN_STATIC_SECRET: "playwright-turn-secret",
        HOST: "127.0.0.1",
        // Loopback TURN for the forced-relay gate; coturn must be running
        // locally with the same static secret (see e2e README/CI setup).
        STUN_HOST: "127.0.0.1",
        TURN_HOST: "127.0.0.1",
      },
    },
    {
      command:
        "pnpm --filter web build && pnpm --filter web preview --host 127.0.0.1 --port 5173 --strictPort",
      url: "http://127.0.0.1:5173",
      timeout: 120_000,
      reuseExistingServer: !process.env.CI,
    },
  ],
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "firefox",
      use: {
        ...devices["Desktop Firefox"],
        launchOptions: {
          // Local gate runs TURN on 127.0.0.1; Firefox drops loopback
          // ICE traffic unless this pref is set.
          firefoxUserPrefs: { "media.peerconnection.ice.loopback": true },
        },
      },
    },
  ],
});
