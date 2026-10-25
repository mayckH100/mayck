import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60000,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: 'http://127.0.0.1:4319', screenshot: 'only-on-failure', trace: 'off' },
  outputDir: 'tests/e2e/.resultados',
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'rm -f prisma/sqlite/e2e.db && npx prisma db push --schema prisma/sqlite/schema.prisma --skip-generate && node dist/server/index.js',
    url: 'http://127.0.0.1:4319/api/health/db',
    timeout: 90000,
    reuseExistingServer: false,
    env: { NODE_ENV: 'development', PORT: '4319', SQLITE_URL: 'file:./e2e.db', ENABLE_SCHEDULER: 'false', COOKIE_SECURE: 'false' },
  },
});
