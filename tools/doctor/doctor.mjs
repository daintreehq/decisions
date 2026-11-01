#!/usr/bin/env node
// Unauthenticated health checks for a Decisions relay: reachability, protocol range, claim state and headers.
//   node tools/doctor/doctor.mjs --url https://your-relay.workers.dev
// For authenticated checks (socket ticket, attachments round trip, push config) use `decisions doctor`.
const args = process.argv.slice(2);
const i = args.indexOf('--url');
const base = (i >= 0 ? args[i + 1] : (process.env.DECISIONS_URL ?? '')).replace(/\/$/, '');
if (!/^https?:\/\//.test(base)) {
  console.error('usage: doctor.mjs --url https://your-relay.example');
  process.exit(2);
}

const results = [];
const check = async (label, fn) => {
  try {
    const detail = await fn();
    results.push({ label, ok: true, detail: detail ?? '' });
  } catch (e) {
    results.push({ label, ok: false, detail: e instanceof Error ? e.message : String(e) });
  }
};
const must = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

await check('health endpoint', async () => {
  const r = await fetch(`${base}/health`);
  must(r.ok, `HTTP ${r.status}`);
  return `version ${(await r.json()).version}`;
});

let info;
await check('protocol info', async () => {
  const r = await fetch(`${base}/api/v1/info`);
  must(r.ok, `HTTP ${r.status}`);
  info = await r.json();
  must(info.name === 'daintree-decisions', 'not a Decisions relay');
  must(
    info.protocol_min <= 1 && info.protocol_max >= 1,
    `relay speaks protocol ${info.protocol_min}-${info.protocol_max}, this client needs 1`,
  );
  return `protocol ${info.protocol_min}-${info.protocol_max}, worker ${info.worker_version}`;
});

await check('claim state', async () => {
  must(info, 'no info');
  if (info.claimed) return 'claimed';
  must(
    info.claim_configured,
    'CLAIM_SECRET is not set on the Worker; run `wrangler secret put CLAIM_SECRET`',
  );
  return 'ready to be claimed';
});

await check('API security headers, no CORS', async () => {
  const r = await fetch(`${base}/api/v1/info`);
  must(r.headers.get('x-content-type-options') === 'nosniff', 'missing nosniff');
  must(r.headers.get('cache-control') === 'no-store', 'API responses must be no-store');
  must(!r.headers.get('access-control-allow-origin'), 'CORS must not be enabled');
});

await check('web app and CSP', async () => {
  const r = await fetch(`${base}/`);
  must(r.ok, `HTTP ${r.status}`);
  const csp = r.headers.get('content-security-policy') ?? '';
  must(
    csp.includes("script-src 'self'") && csp.includes("frame-ancestors 'none'"),
    'CSP missing or too loose',
  );
  must(!/unsafe-eval|unsafe-inline'?[^-]*script/.test(csp), 'CSP allows unsafe script');
});

await check('installable manifest and service worker', async () => {
  const m = await fetch(`${base}/manifest.webmanifest`);
  must(m.ok, `manifest HTTP ${m.status}`);
  const mj = await m.json();
  must(mj.display === 'standalone', 'manifest display must be standalone');
  const s = await fetch(`${base}/sw.js`);
  must(s.ok && /javascript/.test(s.headers.get('content-type') ?? ''), 'service worker missing');
});

await check('unauthenticated API access is refused', async () => {
  const r = await fetch(`${base}/api/v1/devices`);
  must(r.status === 401, `expected 401, got ${r.status}`);
});

await check('HTTPS', async () => {
  must(
    base.startsWith('https://') || /localhost|127\.0\.0\.1/.test(base),
    'production relays must use HTTPS (required for push and service workers)',
  );
});

let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.label}${r.detail ? ` - ${r.detail}` : ''}`);
}
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
