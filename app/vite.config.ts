import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { build as esbuild } from 'esbuild';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';
import { sourceConditions } from '../vitest.shared';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string;
};

/**
 * Builds src/sw.ts into dist/sw.js (stable path, required for scope "/") after the main bundle,
 * injecting the list of hashed app-shell files to precache. Nothing from /api is ever listed.
 */
function serviceWorker(): Plugin {
  const precache = new Set<string>([
    '/',
    '/manifest.webmanifest',
    '/icons/icon-192.png',
    '/icons/badge-96.png',
  ]);
  let outDir = 'dist';
  return {
    name: 'decisions-service-worker',
    apply: 'build',
    configResolved(c) {
      outDir = resolve(c.root, c.build.outDir);
    },
    generateBundle(_o, bundle) {
      for (const f of Object.values(bundle)) {
        if (/\.(js|css)$/.test(f.fileName)) precache.add('/' + f.fileName);
      }
    },
    async closeBundle() {
      // Derived from the built files, not the clock, so the same source always builds the same
      // bytes: the relay package pins the app by SHA-256 (packages/relay/scripts/build.mjs).
      const hash = createHash('sha256');
      const files = readdirSync(outDir, { recursive: true, withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => resolve(e.parentPath, e.name))
        .filter((f) => f !== resolve(outDir, 'sw.js'))
        .sort();
      for (const f of files)
        hash.update(relative(outDir, f).split(sep).join('/')).update('\0').update(readFileSync(f));
      const buildId = hash.digest('hex').slice(0, 12);
      await esbuild({
        entryPoints: [resolve(import.meta.dirname, 'src/sw.ts')],
        outfile: resolve(outDir, 'sw.js'),
        bundle: true,
        format: 'iife',
        target: 'es2022',
        minify: true,
        define: {
          __PRECACHE__: JSON.stringify([...precache].sort()),
          __BUILD_ID__: JSON.stringify(`${pkg.version}-${buildId}`),
        },
      });
    },
  };
}

export default defineConfig({
  ...sourceConditions,
  plugins: [react(), serviceWorker()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2022',
    assetsInlineLimit: 0,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:8787', ws: true, changeOrigin: false },
      '/health': 'http://127.0.0.1:8787',
    },
  },
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    setupFiles: ['tests/setup.ts'],
  },
});
