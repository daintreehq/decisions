/**
 * Security headers for every response. The PWA is same-origin only: no third-party scripts, styles,
 * fonts or connections. `connect-src` names the origin's own wss: endpoint explicitly for Safari.
 */
export function securityHeaders(url: URL, kind: 'html' | 'asset' | 'api'): Record<string, string> {
  const wss = `wss://${url.host}`;
  const h: Record<string, string> = {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy':
      'microphone=(self), camera=(self), geolocation=(), payment=(), usb=(), interest-cohort=()',
    'Strict-Transport-Security': 'max-age=31536000',
  };
  if (kind === 'api') {
    h['Cache-Control'] = 'no-store';
    h['Content-Security-Policy'] = "default-src 'none'; frame-ancestors 'none'";
  } else {
    h['Content-Security-Policy'] = [
      "default-src 'none'",
      "script-src 'self'",
      "style-src 'self'",
      "style-src-attr 'unsafe-inline'",
      "img-src 'self' blob: data:",
      `connect-src 'self' ${wss}`,
      "manifest-src 'self'",
      "worker-src 'self'",
      "media-src 'self' blob:",
      "font-src 'self'",
      "base-uri 'none'",
      "form-action 'none'",
      "object-src 'none'",
      "frame-ancestors 'none'",
    ].join('; ');
  }
  return h;
}
