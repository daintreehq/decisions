import { describe, expect, it } from 'vitest';
import { isCacheable, notificationUrl, safeTargetUrl, shapePush } from '../src/sw-core.js';

const QID = '0190c65d6f3274de80ce930f43021bf0';

describe('push payload shaping', () => {
  it('always shows the generic title and the fixed body for the type', () => {
    expect(shapePush({ type: 'decision-new', question_id: QID })).toMatchObject({
      title: 'Daintree Decisions',
      options: { body: 'A question needs your input', tag: QID, data: { url: `/q/${QID}` } },
    });
    expect(shapePush({ type: 'decision-reminder', question_id: QID }).options.body).toBe(
      'A question is still waiting',
    );
    expect(shapePush({ type: 'decision-proxy', question_id: QID }).options.body).toBe(
      'A proxy answer needs your review',
    );
    expect(shapePush({ type: 'test' }).options.body).toBe('Notifications are working');
  });

  it('never lets payload text reach the notification', () => {
    const evil = shapePush({
      type: 'decision-new',
      question_id: QID,
      title: 'secret project',
      body: 'DROP TABLE users',
      text: 'api key sk-123',
      url: 'https://evil.example',
    });
    const all = JSON.stringify(evil);
    expect(all).not.toContain('secret project');
    expect(all).not.toContain('DROP TABLE');
    expect(all).not.toContain('sk-123');
    expect(all).not.toContain('evil.example');
  });

  it('falls back safely for junk, unknown types and malformed ids', () => {
    for (const bad of [
      null,
      undefined,
      42,
      'string',
      [],
      {},
      { type: '__proto__' },
      { type: 'constructor' },
    ]) {
      const n = shapePush(bad);
      expect(n.options.body).toBe('A question needs your input');
      expect(n.options.data.url).toBe('/');
      expect(n.options.tag).toBe('decisions');
    }
    expect(shapePush({ type: 'decision-new', question_id: '../../admin' }).options.data.url).toBe(
      '/',
    );
    expect(shapePush({ type: 'decision-new', question_id: 'x'.repeat(65) }).options.data.url).toBe(
      '/',
    );
  });
});

describe('notification click targets', () => {
  it('only ever opens the inbox or a question page', () => {
    expect(notificationUrl(QID)).toBe(`/q/${QID}`);
    expect(notificationUrl(null)).toBe('/');
    expect(safeTargetUrl({ url: `/q/${QID}` })).toBe(`/q/${QID}`);
    for (const bad of [
      'https://evil.example',
      '//evil.example',
      '/settings',
      '/q/',
      '/q/../x',
      'javascript:alert(1)',
      5,
      undefined,
    ]) {
      expect(safeTargetUrl({ url: bad })).toBe('/');
    }
    expect(safeTargetUrl(null)).toBe('/');
  });
});

describe('cache policy', () => {
  const pre = new Set(['/', '/assets/app-abc.js', '/manifest.webmanifest']);
  const u = (p: string, o = 'https://r.example') => new URL(p, o);
  it('caches only the precached shell, same-origin GETs', () => {
    expect(isCacheable(u('/assets/app-abc.js'), 'GET', 'https://r.example', pre)).toBe('asset');
    expect(isCacheable(u('/assets/other.js'), 'GET', 'https://r.example', pre)).toBeNull();
    expect(isCacheable(u('/assets/app-abc.js'), 'POST', 'https://r.example', pre)).toBeNull();
    expect(
      isCacheable(u('/assets/app-abc.js', 'https://evil.example'), 'GET', 'https://r.example', pre),
    ).toBeNull();
  });
  it('never touches the API, attachments or health', () => {
    const everything = new Set(['/api/v1/attachments/x/content', '/api/v1/events', '/health']);
    for (const p of everything)
      expect(isCacheable(u(p), 'GET', 'https://r.example', everything)).toBeNull();
  });
});
