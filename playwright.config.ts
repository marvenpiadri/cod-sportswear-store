import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:4200',
    viewport: { width: 1440, height: 900 },
    trace: 'on-first-retry',
  },
  webServer: {
    command: 'npm start -- --host 0.0.0.0 --port 4200',
    url: 'http://localhost:4200',
    reuseExistingServer: !process.env.CI,
    timeout: 60000,
  },
});
