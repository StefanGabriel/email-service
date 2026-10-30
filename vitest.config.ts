import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['test/global-setup.ts'],
    env: {
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgresql://postbox:postbox@localhost:5432/postbox_test',
      POSTBOX_SECRET_KEY: Buffer.alloc(32, 7).toString('base64'),
    },
    fileParallelism: false,
  },
});
