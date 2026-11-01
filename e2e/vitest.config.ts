import { defineConfig } from 'vitest/config';
import { sourceConditions } from '../vitest.shared';

export default defineConfig({
  ...sourceConditions,
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
