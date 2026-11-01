import { defineConfig } from 'vitest/config';

// Pure-logic tests that need Node's crypto (independent Web Push cross-checks) rather than workerd.
export default defineConfig({
  test: { include: ['tests-node/**/*.test.ts'], environment: 'node' },
});
