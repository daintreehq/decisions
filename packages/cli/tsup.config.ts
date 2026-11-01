import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { bin: 'src/bin.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  clean: true,
  removeNodeProtocol: false,
  sourcemap: false,
  banner: { js: '#!/usr/bin/env node' },
  // The @daintreehq/decisions-* libraries stay external: they are real dependencies, installed next
  // to the CLI and resolved to their built `dist` at run time. In the workspace, `pnpm build:all`
  // builds them before the CLI.
});
