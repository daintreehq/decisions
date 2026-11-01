import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ROUTE_MANIFEST, buildOpenApi, buildSchemaBundle } from '../src/index.js';

/**
 * Published artifacts are generated from the code. Regenerate deliberately with WRITE_SCHEMAS=1 pnpm test;
 * otherwise the committed files must match, so the documented contract cannot drift from the implementation.
 */
const dir = (f: string) => fileURLToPath(new URL(`../${f}`, import.meta.url));
const stable = (v: unknown) => JSON.stringify(v, null, 2) + '\n';

describe('published API artifacts', () => {
  it('has a unique, well-formed route inventory', () => {
    const keys = ROUTE_MANIFEST.map((r) => `${r.method} ${r.path}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const r of ROUTE_MANIFEST) {
      expect(r.path.startsWith('/')).toBe(true);
      if (r.auth === 'signed') expect(r.roles, r.path).toBeTruthy();
    }
  });

  it('openapi.json matches the code', () => {
    const generated = stable(buildOpenApi());
    if (process.env.WRITE_SCHEMAS === '1' || !existsSync(dir('openapi.json')))
      writeFileSync(dir('openapi.json'), generated);
    expect(readFileSync(dir('openapi.json'), 'utf8')).toBe(generated);
    const doc = buildOpenApi() as { openapi: string; paths: Record<string, unknown> };
    expect(doc.openapi).toBe('3.1.0');
    expect(Object.keys(doc.paths)).toContain('/api/v1/questions/{id}/answer');
  });

  it('schemas.json matches the code', async () => {
    const generated = stable(await buildSchemaBundle());
    if (process.env.WRITE_SCHEMAS === '1' || !existsSync(dir('schemas.json')))
      writeFileSync(dir('schemas.json'), generated);
    expect(readFileSync(dir('schemas.json'), 'utf8')).toBe(generated);
  });
});
