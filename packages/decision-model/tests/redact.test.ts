import { describe, expect, it } from 'vitest';
import { containsSecrets, redactSecrets, stripControlChars } from '../src/redact.js';

describe('redactSecrets', () => {
  const secrets = [
    'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123',
    'sk-proj-abcdefghijklmnopqrstuvwxyz012345',
    'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    'github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuv',
    'AKIAIOSFODNN7EXAMPLE',
    'xai-abcdefghijklmnopqrstuvwxyz0123',
    'xoxb-1234567890-abcdefghij',
    'AIzaSyA1234567890abcdefghijklmnopqrstuv',
    'sk_live_abcdefghijklmnop1234',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk',
    'Bearer abcdefghijklmnopqrstuvwxyz012345',
  ];
  it.each(secrets)('redacts %s', (s) => {
    const out = redactSecrets(`prefix ${s} suffix`);
    expect(out).not.toContain(s);
    expect(out).toContain('[REDACTED]');
    expect(containsSecrets(s)).toBe(true);
  });
  it('redacts private key blocks, including unterminated ones', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEabc\n-----END RSA PRIVATE KEY-----';
    expect(redactSecrets(`a ${pem} b`)).toBe('a [REDACTED] b');
    expect(redactSecrets('x -----BEGIN PRIVATE KEY-----\nMIIE')).toBe('x [REDACTED]');
  });
  it('redacts .env style lines but keeps harmless ones', () => {
    const out = redactSecrets(
      'DATABASE_PASSWORD=hunter2\nexport API_KEY=abc123\nNODE_ENV=production\nSTRIPE_SECRET: zzz',
    );
    expect(out).toBe(
      'DATABASE_PASSWORD=[REDACTED]\nexport API_KEY=[REDACTED]\nNODE_ENV=production\nSTRIPE_SECRET: [REDACTED]',
    );
  });
  it('redacts inline passwords and URL credentials', () => {
    expect(redactSecrets('login with password: "s3cr3t!" please')).toContain('[REDACTED]');
    expect(redactSecrets('postgres://admin:pw123@db.internal/app')).toBe(
      'postgres://[REDACTED]@db.internal/app',
    );
  });
  it('leaves ordinary prose untouched and is idempotent', () => {
    const t = 'Should the settings panel use a compact layout? See issue #42.';
    expect(redactSecrets(t)).toBe(t);
    const once = redactSecrets('TOKEN=abc');
    expect(redactSecrets(once)).toBe(once);
  });
  it('strips control characters', () => {
    expect(stripControlChars('a\u0000b\u001b[31mc d\ne')).toBe('ab[31mcd\ne');
  });
});
