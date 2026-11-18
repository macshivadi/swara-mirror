import { defineConfig } from 'vitest/config';

export default defineConfig({
  base: '/swara-mirror/',
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
