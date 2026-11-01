import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { build as esbuild } from 'esbuild';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string;
};

/**
 * Builds src/sw.ts into dist/sw.js (stable path, required for scope "/") after the main bundle,
 * injecting the list of hashed app-shell files to precache. Nothing from /api is ever listed.
 */
function serviceWorker(): Plugin {
  const precache = new Set<string>(['/', '/manifest.webmanifest', '/icons/icon-192.png']);
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
      const buildId = Date.now().toString(36);
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
