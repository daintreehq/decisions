import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';
import { SOURCE_CONDITION } from '../vitest.shared';

// Workspace packages from source, then the workerd conditions the Cloudflare plugin would use. The
// tests run in the ssr environment, which does not inherit the top-level list once one is given.
const conditions = [
  SOURCE_CONDITION,
  'workerd',
  'worker',
  'module',
  'browser',
  'development|production',
];

export default defineConfig({
  resolve: { conditions: [...conditions] },
  ssr: { resolve: { conditions: [...conditions] } },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: '../wrangler.jsonc' },
      miniflare: {
        bindings: {
          CLAIM_SECRET: 'test-claim-secret-0123456789abcdef',
          XAI_API_KEY: '',
          ANTHROPIC_API_KEY: '',
          OPENAI_API_KEY: '',
        },
      },
    }),
  ],
  test: { include: ['tests/**/*.test.ts'], setupFiles: ['tests/setup.ts'], testTimeout: 30_000 },
});
