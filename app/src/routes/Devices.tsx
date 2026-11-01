import { useEffect, useState } from 'react';
import { fingerprint } from '@daintree/decisions-crypto';
import { app } from '../app/controller.js';
import { useApp } from '../app/hooks.js';
import { ageLabel } from '../lib/time.js';
import { Link } from '../app/router.js';

const ROLE: Record<string, string> = {
  'owner-desktop': 'Your Daintree computer',
  'desktop-host': 'Daintree host',
  phone: 'Phone',
  tablet: 'Tablet',
};

export function DevicesPage() {
  const snap = useApp();
  const [fp, setFp] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const load = () => {
    setErr(null);
    setLoading(true);
    app
      .refreshDevices()
      .catch((e) => setErr(e instanceof Error ? e.message : 'Could not load the list of devices.'))
      .finally(() => setLoading(false));
  };
  useEffect(() => {
    if (snap.config) void fingerprint(snap.config.ownerCert.signing_pub).then(setFp);
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snap.config]);

  const groups = fp.split(/\s+/).filter(Boolean);
  return (
    <div className="page">
      <h1>Devices</h1>
      <p className="note">
        These devices can read your decisions. To remove one, open Daintree on your computer and
        choose <strong>Settings → Decisions → Devices → Revoke</strong>. Revoking cannot erase what
        a device already downloaded.
      </p>
      {err && (
        <div className="card warn" role="alert">
          <strong>Could not refresh the list</strong>
          <p>
            {snap.devices
              ? 'The list below is from your last successful check and may be out of date.'
              : 'Check your connection, then try again.'}
          </p>
          <button type="button" className="btn small" disabled={loading} onClick={load}>
            Try again
          </button>
        </div>
      )}
      <ul className="list" aria-busy={!snap.devices && loading}>
        {snap.devices?.devices.map((d) => {
          const mine = d.device_id === snap.config?.deviceId;
          const isPhone = d.role !== 'owner-desktop' && d.role !== 'desktop-host';
          return (
            <li key={d.device_id} className="card">
              <p className="row-top">
                <strong>{d.label}</strong>
                <span className="row-badges">
                  {mine && <span className="badge">This phone</span>}
                  {d.revoked_at ? (
                    <span className="badge danger">Revoked</span>
                  ) : (
                    <span className="badge">Active</span>
                  )}
                </span>
              </p>
              <p className="muted">
                {ROLE[d.role] ?? d.role}
                {d.last_seen_at ? ` · last seen ${ageLabel(d.last_seen_at)}` : ''}
                {isPhone ? (d.push_enabled ? ' · notifications on' : ' · notifications off') : ''}
              </p>
              {mine && isPhone && !d.push_enabled && (
                <Link to="/settings" className="text-link">
                  Turn on notifications
                </Link>
              )}
            </li>
          );
        })}
        {!snap.devices && !err && <li className="card skeleton-row" />}
      </ul>
      <section className="card">
        <h2>Your computer’s identity</h2>
        <p className="muted">
          This phone only trusts questions signed by devices your computer approved. Check that
          these groups match the ones Daintree shows.
        </p>
        <p className="sr-only">Owner key fingerprint:</p>
        <p className="fingerprint">
          {groups.map((g, i) => (
            <span key={i}>{g}</span>
          ))}
        </p>
      </section>
    </div>
  );
}
