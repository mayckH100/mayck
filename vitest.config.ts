import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    environment: 'node',
    globalSetup: ['tests/globalSetup.ts'],
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 60000,
    env: {
      NODE_ENV: 'test',
      SQLITE_URL: 'file:./test.db',
      MASTER_KEY: 'q3k7lZfC0Z8mJ8m4cX1o7V3w5n2p9s6t1u4y7b0e3h8=',
      API_RATE_LIMIT: '100000',
      LOGIN_RATE_LIMIT: '1000',
      ALLOW_PRIVATE_HTTP: 'false',
      ENABLE_SCHEDULER: 'false',
      ENABLE_MCKMENSAGEM_CRON: 'false',
      GRAPH_API_BASE: 'https://graph.facebook.com',
    },
    reporters: ['verbose'],
  },
});
