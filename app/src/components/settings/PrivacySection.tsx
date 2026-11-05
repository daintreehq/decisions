import { useEffect, useState } from 'react';
import { app } from '../../app/controller.js';
import { useApp } from '../../app/hooks.js';
import { navigate } from '../../app/router.js';
import { absoluteLabel } from '../../lib/time.js';
import { Dialog } from '../Dialog.js';
import { DataFlow, PrivacyLimits } from './DataFlow.js';
import { unpairErasures, type LocalData } from './model.js';
import { forgetServerSettings } from './QuietHoursSection.js';
import { Callout, Row, SettingsGroup } from './ui.js';

function relayHost(origin: string | undefined): string {
  if (!origin) return '';
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

export function UnpairDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [data, setData] = useState<LocalData | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    let live = true;
    setData(null);
    void app.localDataSummary().then((d) => live && setData(d));
    return () => {
      live = false;
    };
  }, [open]);

  const items = data ? unpairErasures(data) : null;
  return (
    <Dialog
      open={open}
      title="Unpair this device?"
      // Once erasing has started there is nothing to cancel.
      onClose={() => {
        if (!busy) onClose();
      }}
      actions={
        <>
          <button type="button" className="btn" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn danger"
            disabled={!data || busy}
            onClick={() => {
              setBusy(true);
              forgetServerSettings();
              void app
                .wipe()
                .then(() => {
                  setBusy(false);
                  onClose();
                  navigate('/', true);
                })
                // If erasing fails the dialog stays usable, so the person isn't stuck behind it.
                .catch(() => setBusy(false));
            }}
          >
            {busy ? 'Erasing…' : 'Unpair and erase'}
          </button>
        </>
      }
    >
      <p>This erases from this device:</p>
      {items ? (
        <ul className="s-erase-list">
          {items.map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ul>
      ) : (
        <p className="s-row-desc">Counting what’s saved here…</p>
      )}
      {data && data.unsent === 0 && data.drafts === 0 && (
        <p className="s-row-desc s-erase-note">
          Nothing is waiting to be sent, and there are no drafts.
        </p>
      )}
      {data && data.unsent > 0 && (
        <Callout tone="warn">
          {data.unsent === 1 ? 'An answer hasn’t' : `${data.unsent} answers haven’t`} reached your
          relay yet. Unpairing deletes {data.unsent === 1 ? 'it' : 'them'}.
        </Callout>
      )}
      <p className="s-row-desc">
        Unpairing isn’t revoking. Your computer still lists this device until you revoke it in
        Daintree. Your relay keeps its encrypted copy, and you can pair again any time.
      </p>
    </Dialog>
  );
}

export function PrivacySection() {
  const { config, devices } = useApp();
  const [unpair, setUnpair] = useState(false);
  const me = devices?.devices.find((d) => d.device_id === config?.deviceId);
  return (
    <>
      <p className="s-lead">
        Who can see your questions and answers, what recovery depends on, and how to unpair this
        device.
      </p>
      <SettingsGroup>
        <Row
          label="Paired to your relay"
          description={<span className="mono">{relayHost(config?.relayOrigin)}</span>}
        />
        <Row
          label="This device"
          description={
            <>
              {config?.label}
              {me ? ` · paired ${absoluteLabel(me.created_at)}` : ''}
            </>
          }
        />
      </SettingsGroup>

      <SettingsGroup label="Who sees what">
        <DataFlow />
      </SettingsGroup>

      <SettingsGroup label="Recovery">
        <Row
          label="If you lose this device"
          description="Revoke it from Daintree on your computer, then pair a new one. Your history stays on your computer and, encrypted, on your relay."
        />
        <Row
          label="Recovery kit"
          description="Your computer’s keys are backed up in its recovery kit. This device’s own keys can’t be exported, by design."
        />
      </SettingsGroup>

      <SettingsGroup label="Limits worth knowing">
        <PrivacyLimits />
      </SettingsGroup>

      <section className="s-group-wrap s-danger" aria-labelledby="unpair-h">
        <h2 className="s-group-label" id="unpair-h">
          Unpair
        </h2>
        <div className="s-group">
          <Row
            label="Unpair this device"
            description="Erases Decisions’ keys and saved data from this device. Nothing else on it is touched."
            control={
              <button
                type="button"
                className="btn small danger-outline"
                onClick={() => setUnpair(true)}
              >
                Unpair…
              </button>
            }
          />
        </div>
      </section>
      <UnpairDialog open={unpair} onClose={() => setUnpair(false)} />
    </>
  );
}
