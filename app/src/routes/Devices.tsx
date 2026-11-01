import { useEffect, useState } from 'react';
import { fingerprint } from '@daintree/decisions-crypto';
import { app } from '../app/controller.js';
import { useApp } from '../app/hooks.js';
import { ageLabel } from '../lib/time.js';

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
  useEffect(() => {
    if (snap.config) void fingerprint(snap.config.ownerCert.signing_pub).then(setFp);
    app
      .refreshDevices()
      .catch((e) => setErr(e instanceof Error ? e.message : 'Could not load devices'));
  }, [snap.config]);

  return (
    <div className="page">
      <h1>Devices</h1>
      <p className="note">
        These are the devices that can read your decisions. To remove one, open Daintree on your
        computer and choose
        <strong> Settings → Decisions → Devices → Revoke</strong>. Revoking cannot erase what a
        device already downloaded.
      </p>
      {err && <p className="note warn">{err}</p>}
      <ul className="list">
        {snap.devices?.devices.map((d) => (
          <li key={d.device_id} className="card">
            <p className="row-top">
              <strong>
                {d.label}
                {d.device_id === snap.config?.deviceId ? ' (this phone)' : ''}
              </strong>
              {d.revoked_at ? (
                <span className="badge danger">Revoked</span>
              ) : (
                <span className="badge human">Active</span>
              )}
            </p>
            <p className="muted">
              {ROLE[d.role] ?? d.role}
              {d.last_seen_at ? ` · last seen ${ageLabel(d.last_seen_at)}` : ''}
              {d.role !== 'owner-desktop' && d.role !== 'desktop-host'
                ? d.push_enabled
                  ? ' · notifications on'
                  : ' · notifications off'
                : ''}
            </p>
          </li>
        ))}
        {!snap.devices && <li className="card skeleton-row" />}
      </ul>
      <section className="card">
        <h2>Your computer’s identity</h2>
        <p className="muted">
          This phone only trusts questions signed by devices your computer approved. Compare this
          fingerprint with the one shown in Daintree to be sure.
        </p>
        <p className="mono" aria-label="Owner key fingerprint">
          {fp}
        </p>
      </section>
    </div>
  );
}
