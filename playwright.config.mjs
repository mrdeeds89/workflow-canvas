import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './test/browser', outputDir: 'test-results/theme',
  workers: 1, retries: 0, timeout: 45000,
  use: { actionTimeout: 10000, baseURL: 'http://127.0.0.1:18787', viewport: { width: 1600, height: 1000 }, trace: 'retain-on-failure' },
  webServer: { command: 'node scripts/browser-server.mjs', url: 'http://127.0.0.1:18787/api/health', reuseExistingServer: false },
});
