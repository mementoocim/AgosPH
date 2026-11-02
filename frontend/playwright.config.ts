import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';
export default defineConfig({
  testDir: './e2e',
  timeout: 60000,
  expect: { timeout: 15000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: '../playwright-report' }]],
  outputDir: '../test-results',
  use: {
    baseURL: 'http://127.0.0.1:5174',
    viewport: { width: 1440, height: 1000 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge',
    launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] },
  },
  webServer: [
    {
      command:
        '..\\.venv\\Scripts\\python.exe -m uvicorn backend.main:app --app-dir .. --host 127.0.0.1 --port 8011',
      url: 'http://127.0.0.1:8011/api/health',
      env: { AGOS_DATA_DIR: path.resolve('../data/e2e') },
      reuseExistingServer: false,
      timeout: 60000,
    },
    {
      command: 'npm run dev -- --port 5174',
      url: 'http://127.0.0.1:5174',
      env: { AGOS_BACKEND_URL: 'http://127.0.0.1:8011' },
      reuseExistingServer: false,
      timeout: 60000,
    },
  ],
});
