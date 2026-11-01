import { describe, expect, it } from 'vitest';
import { ROUTE_MANIFEST } from '@daintree/decisions-protocol';
import { ROUTES } from '../src/routes/index.js';

const ID = '([A-Za-z0-9_-]{8,64})';
/** Routes the outer Worker serves itself (streaming or WebSocket), not through the Durable Object route table. */
const WORKER_LEVEL = new Set([
  'GET /socket',
  'GET /voice/ws',
  'POST /voice/correct',
  'PUT /attachments/{id}/content',
  'GET /attachments/{id}/content',
]);

describe('route manifest matches the implementation', () => {
  const implemented = new Map(ROUTES.map((r) => [`${r.method} ${r.pattern.source}`, r]));

  it('every documented JSON route exists with the documented auth and roles', () => {
    for (const m of ROUTE_MANIFEST) {
      const id = `${m.method} ${m.path}`;
      if (WORKER_LEVEL.has(id)) continue;
      const source = '^' + ('/api/v1' + m.path).replace(/\{id\}/g, ID).replace(/\//g, '\\/') + '$';
      const hit = implemented.get(`${m.method} ${source}`);
      expect(hit, `${id} is documented but not implemented`).toBeTruthy();
      expect(hit!.auth, id).toBe(m.auth);
      if (m.auth === 'signed') {
        const want =
          m.roles === 'any'
            ? ['desktop-host', 'owner-desktop', 'phone', 'tablet']
            : [...(m.roles as string[])].sort();
        expect([...(hit!.roles ?? [])].sort(), `${id} roles`).toEqual(want);
      }
    }
  });

  it('every implemented route is documented', () => {
    const documented = new Set(
      ROUTE_MANIFEST.map(
        (m) => `${m.method} ^${('/api/v1' + m.path).replace(/\{id\}/g, ID).replace(/\//g, '\\/')}$`,
      ),
    );
    for (const key of implemented.keys())
      expect(documented.has(key), `${key} is implemented but undocumented`).toBe(true);
  });
});
