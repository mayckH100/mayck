import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60000,
  workers: 1,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never', outputFolder: 'tests/e2e/.relatorio' }]] : [['list']],
  use: { baseURL: 'http://127.0.0.1:4319', screenshot: 'only-on-failure', trace: 'off' },
  outputDir: 'tests/e2e/.resultados',
  retries: process.env.CI ? 1 : 0,
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'rm -f prisma/sqlite/e2e.db && npx prisma db push --schema prisma/sqlite/schema.prisma --skip-generate && node dist/server/index.js',
    url: 'http://127.0.0.1:4319/api/health/db',
    timeout: 90000,
    reuseExistingServer: false,
    env: {
      NODE_ENV: 'development', PORT: '4319', SQLITE_URL: 'file:./e2e.db', ENABLE_SCHEDULER: 'false', ENABLE_MCKMENSAGEM_CRON: 'false', COOKIE_SECURE: 'false',
      // Ganchos só de teste (e-mail em memória + leitura do código do cadastro); desligados em produção.
      E2E_TEST_HOOKS: '1',
      SUPERADMIN_EMAILS: 'master-e2e@teste.dev', SUPERADMIN_MFA_REQUIRED: 'false',
      LOGIN_RATE_LIMIT: '1000', SIGNUP_RATE_LIMIT: '1000', API_RATE_LIMIT: '100000',
    },
  },
});
