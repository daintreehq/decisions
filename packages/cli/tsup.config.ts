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
  // Workspace packages ship as TypeScript source, so they must be bundled in.
  noExternal: [/^@daintree\//],
});
