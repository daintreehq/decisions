import { createRequire } from 'node:module';

/**
 * The CLI's own version, read from its package.json (one directory up from both `src/` and the
 * bundled `dist/bin.js`), so it can never drift from what npm installed.
 */
export const VERSION: string = (
  createRequire(import.meta.url)('../package.json') as { version: string }
).version;
