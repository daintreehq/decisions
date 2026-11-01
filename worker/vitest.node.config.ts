import { defineConfig } from 'vitest/config';
import { sourceConditions } from '../vitest.shared';

// Pure-logic tests that need Node's crypto (independent Web Push cross-checks) rather than workerd.
export default defineConfig({
  ...sourceConditions,
  test: { include: ['tests-node/**/*.test.ts'], environment: 'node' },
});
