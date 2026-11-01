import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

/**
 * `decisions deploy` refuses any relay bundle whose manifest differs from the one built alongside
 * this CLI, so the digest of @daintreehq/decisions-relay's manifest is embedded here. `pnpm -r build`
 * builds the relay first (it is a dependency).
 */
function relayManifestSha256(): string {
  const path = new URL('../relay/dist/manifest.json', import.meta.url);
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch {
    throw new Error(
      'packages/relay/dist/manifest.json is missing: build @daintreehq/decisions-relay before the CLI (pnpm build:all)',
    );
  }
  return createHash('sha256').update(bytes).digest('hex');
}

export default defineConfig({
  entry: { bin: 'src/bin.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  clean: true,
  removeNodeProtocol: false,
  sourcemap: false,
  banner: { js: '#!/usr/bin/env node' },
  define: { __RELAY_MANIFEST_SHA256__: JSON.stringify(relayManifestSha256()) },
  // The @daintreehq/decisions-* libraries stay external: they are real dependencies, installed next
  // to the CLI and resolved to their built `dist` at run time. In the workspace, `pnpm build:all`
  // builds them before the CLI.
});
