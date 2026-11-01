/**
 * Workspace packages export their TypeScript source under the "@daintreehq/source" condition and
 * their built `dist` to everyone else. Vite and Vitest configs in this repository spread
 * `sourceConditions` so tests, dev servers and app builds run straight from source, with no prior
 * library build. TypeScript gets the same condition from `customConditions` in tsconfig.base.json,
 * and Wrangler from `alias` in wrangler.jsonc.
 */
export const SOURCE_CONDITION = '@daintreehq/source';

// Setting `conditions` replaces Vite's defaults (`defaultClientConditions` and
// `defaultServerConditions` from 'vite'), so they are repeated after the source condition.
const client = [SOURCE_CONDITION, 'module', 'browser', 'development|production'];
const server = [SOURCE_CONDITION, 'module', 'node', 'development|production'];

export const sourceConditions = {
  resolve: { conditions: client },
  ssr: { resolve: { conditions: server } },
};
