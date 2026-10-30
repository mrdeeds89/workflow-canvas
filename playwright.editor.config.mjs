import { defineConfig } from "@playwright/test";

/**
 * Editor audit suite. The server is started by scripts/editor-browser.sh so a
 * restart can reuse the same database. Do not point this at the preview
 * service or its volume.
 */
const baseURL = process.env.WC_BASE_URL ?? "http://127.0.0.1:18788";

export default defineConfig({
  testDir: "./test/editor-browser",
  outputDir: "test-results/editor",
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL,
    viewport: { width: 1440, height: 1100 },
    actionTimeout: 10_000,
    trace: "retain-on-failure",
  },
});
