import { useEffect, useState } from 'react';
import type { DeviceInfo } from '@daintreehq/decisions-protocol';
import { fingerprint } from '@daintreehq/decisions-crypto';
import { app } from '../../app/controller.js';
import { useApp, useNow } from '../../app/hooks.js';
import { absoluteLabel, ageLabel } from '../../lib/time.js';
import { CopyIcon, LaptopIcon, PhoneIcon, RefreshIcon } from '../Icons.js';
import { deviceGroup, type DeviceGroup } from './model.js';
import { Callout, Sheet } from './ui.js';

const ROLE: Record<string, string> = {
  'owner-desktop': 'Daintree computer · Owner',
  'desktop-host': 'Daintree host computer',
  phone: 'Phone',
  tablet: 'Tablet',
};

const GROUPS: { id: DeviceGroup; label: string }[] = [
  { id: 'this', label: 'This device' },
  { id: 'computers', label: 'Computers' },
  { id: 'others', label: 'Other paired devices' },
  { id: 'revoked', label: 'Revoked' },
];

const isComputer = (d: DeviceInfo) => d.role === 'owner-desktop' || d.role === 'desktop-host';

/** "Last seen 12 min ago", never "Online": the relay only knows when a device last checked in. */
function seenLabel(d: DeviceInfo, mine: boolean, now: number): string {
  if (d.revoked_at) return `Revoked ${absoluteLabel(d.revoked_at)}`;
  if (mine) return 'You’re using it now';
  if (!d.last_seen_at) return 'Not seen yet';
  const age = ageLabel(d.last_seen_at, now);
  // The number keeps its unit on one line ("1 min", never "1 / min").
  return age === 'just now'
    ? 'Last seen just now'
    : `Last seen ${age.replace(/(\d) /g, '$1\u00a0')}`;
}

function Fingerprint({ value }: { value: string }) {
  const groups = value.split(/\s+/).filter(Boolean);
  return (
    <p className="fingerprint" aria-label={`Fingerprint ${groups.join(', ')}`}>
      {groups.map((g, i) => (
        <span key={i} aria-hidden="true">
          {g}
        </span>
      ))}
    </p>
  );
}

function CopyButton({ text }: { text: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  return (
    <>
      <button
        type="button"
        className="btn small"
        onClick={() => {
          if (!navigator.clipboard) return setState('failed');
          void navigator.clipboard
            .writeText(text)
            .then(() => setState('copied'))
            .catch(() => setState('failed'));
        }}
      >
        <CopyIcon size={16} />
        {state === 'copied' ? 'Copied' : 'Copy fingerprint'}
      </button>
      <span className="s-row-desc" role="status">
        {state === 'failed' ? 'Couldn’t copy. Select the text to copy it.' : ''}
      </span>
    </>
  );
}

function DeviceDetails({
  device,
  mine,
  owner,
  onClose,
}: {
  device: DeviceInfo | null;
  mine: boolean;
  owner: boolean;
  onClose: () => void;
}) {
  const [fp, setFp] = useState('');
  const now = useNow();
  // Keep the last device while the sheet animates closed.
  const [shown, setShown] = useState<DeviceInfo | null>(device);
  useEffect(() => {
    if (device) setShown(device);
  }, [device]);
  useEffect(() => {
    setFp('');
    if (shown) void fingerprint(shown.cert.signing_pub).then(setFp);
  }, [shown]);
  const d = shown;
  return (
    <Sheet open={!!device} onClose={onClose} title={d?.label ?? 'Device'}>
      {d && (
        <>
          <dl className="s-facts">
            <div>
              <dt>Kind</dt>
              <dd>{ROLE[d.role] ?? d.role}</dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd>{d.revoked_at ? `Revoked ${absoluteLabel(d.revoked_at)}` : 'Paired'}</dd>
            </div>
            <div>
              <dt>Paired</dt>
              <dd>{absoluteLabel(d.created_at)}</dd>
            </div>
            <div>
              <dt>Last seen</dt>
              <dd>
                {mine
                  ? 'Now (this device)'
                  : d.last_seen_at
                    ? `${absoluteLabel(d.last_seen_at)} · ${ageLabel(d.last_seen_at, now)}`
                    : 'Not yet'}
              </dd>
            </div>
            {!isComputer(d) && (
              <div>
                <dt>Notifications</dt>
                <dd>{d.push_enabled ? 'On' : 'Off'}</dd>
              </div>
            )}
          </dl>
          <h3 className="s-sheet-sub">Fingerprint</h3>
          <p className="s-row-desc">
            {owner
              ? 'This device trusts only questions signed by this key. Check the groups match the ones Daintree shows in Settings › Decisions.'
              : 'The key this device signs its answers with, as your computer approved it.'}
          </p>
          {fp ? <Fingerprint value={fp} /> : <p className="fingerprint" aria-hidden="true" />}
          <div className="s-actions">{fp && <CopyButton text={fp} />}</div>
        </>
      )}
    </Sheet>
  );
}

export function DevicesSection() {
  const snap = useApp();
  const now = useNow(30_000);
  const [err, setErr] = useState(false);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const load = () => {
    setErr(false);
    setLoading(true);
    app
      .refreshDevices()
      .catch(() => setErr(true))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  const myId = snap.config?.deviceId;
  const list = snap.devices?.devices ?? [];
  const ownerId = snap.devices?.owner_device_id;
  const selected = list.find((d) => d.device_id === open) ?? null;

  return (
    <>
      <p className="s-lead">Devices that can read and answer your questions.</p>
      {err && (
        <Callout
          tone="warn"
          role="alert"
          title="Couldn’t refresh the list"
          action={
            <button type="button" className="btn small" disabled={loading} onClick={load}>
              <RefreshIcon size={16} />
              Try again
            </button>
          }
        >
          {snap.devices
            ? 'This is the list from your last successful check and may be out of date.'
            : 'Check your connection, then try again.'}
        </Callout>
      )}
      {!snap.devices && !err && (
        <div className="skeleton s-skeleton" role="status" aria-label="Loading devices" />
      )}
      {GROUPS.map((g) => {
        const items = list.filter((d) => deviceGroup(d, myId) === g.id);
        if (!items.length) return null;
        return (
          <section key={g.id} className="s-group-wrap" aria-labelledby={`dev-${g.id}`}>
            <h2 className="s-group-label" id={`dev-${g.id}`}>
              {g.label}
            </h2>
            <ul className="s-group s-device-list">
              {items.map((d) => {
                const mine = d.device_id === myId;
                const Icon = isComputer(d) ? LaptopIcon : PhoneIcon;
                return (
                  <li key={d.device_id}>
                    <button
                      type="button"
                      className={`s-device${d.revoked_at ? ' revoked' : ''}`}
                      aria-haspopup="dialog"
                      onClick={() => setOpen(d.device_id)}
                    >
                      <span className="s-row-icon">
                        <Icon size={20} />
                      </span>
                      <span className="s-row-text">
                        <span className="s-row-label">{d.label}</span>
                        <span className="s-row-desc">
                          {ROLE[d.role] ?? d.role} · {seenLabel(d, mine, now)}
                        </span>
                      </span>
                      <span className="s-chevron" aria-hidden="true" />
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
      <Callout tone="neutral" title="Removing a device">
        Revoke it from your computer: in Daintree, open Settings › Decisions › Devices and choose
        Revoke. It stops new questions reaching that device; it can’t erase what the device already
        saved.
      </Callout>
      <DeviceDetails
        device={selected}
        mine={selected?.device_id === myId}
        owner={selected?.device_id === ownerId}
        onClose={() => setOpen(null)}
      />
    </>
  );
}
