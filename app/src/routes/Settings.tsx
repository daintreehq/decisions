import { useEffect, useState } from 'react';
import { app, type ServerSettings } from '../app/controller.js';
import { useApp } from '../app/hooks.js';
import { Link } from '../app/router.js';
import { ConfirmDialog } from '../components/Dialog.js';
import { VoiceDisclosure } from '../components/VoiceDisclosure.js';
import {
  currentSubscription,
  disablePush,
  enablePush,
  isIos,
  isStandalone,
  pushSupport,
  sendTestPush,
} from '../features/push.js';
import { timeZones } from '../lib/time.js';

type Server = ServerSettings;

const DEFAULT_SERVER: Server = {
  quiet_hours: {
    enabled: false,
    start: '22:00',
    end: '07:00',
    time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  },
  reminders: { enabled: true, first_ms: 4 * 3_600_000, interval_ms: 24 * 3_600_000, max: 3 },
  proxy_review_reminder: true,
};

function PushSection() {
  const [support] = useState(pushSupport());
  const [subscribed, setSubscribed] = useState<boolean | null>(null);
  const [status, setStatus] = useState<{ text: string; error: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const perm = typeof Notification !== 'undefined' ? Notification.permission : 'denied';

  useEffect(() => {
    if (support.ok)
      void currentSubscription()
        .then((s) => setSubscribed(!!s))
        .catch(() => setSubscribed(false));
  }, [support.ok]);

  const run = async (fn: () => Promise<string | void>) => {
    setBusy(true);
    setStatus(null);
    try {
      const msg = await fn();
      if (msg) setStatus({ text: msg, error: false });
    } catch (e) {
      setStatus({
        text: e instanceof Error ? e.message : 'Something went wrong. Try again.',
        error: true,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card" aria-labelledby="push-h">
      <h2 id="push-h">Notifications</h2>
      <p className="muted">
        Notifications only say that a question needs you. They never contain the question, project
        name or any code.
      </p>
      {!support.ok && support.reason === 'ios-not-installed' && (
        <p className="note warn">
          On iPhone and iPad, notifications only work after you add Decisions to your Home Screen.{' '}
          <Link to="/install">Show me how</Link>
        </p>
      )}
      {!support.ok && support.reason === 'unsupported' && (
        <p className="note warn">This browser cannot receive push notifications.</p>
      )}
      {support.ok && (
        <>
          <p>
            Status:{' '}
            <strong>
              {perm === 'denied'
                ? 'Blocked in system settings'
                : subscribed
                  ? 'On'
                  : perm === 'granted'
                    ? 'Allowed, not turned on'
                    : 'Off'}
            </strong>
          </p>
          <div className="row">
            {!subscribed && perm !== 'denied' && (
              <button
                type="button"
                className="btn primary"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await enablePush(app.getRelay()!);
                    setSubscribed(true);
                    return 'Notifications are on. Send a test to be sure.';
                  })
                }
              >
                Turn on notifications
              </button>
            )}
            {subscribed && (
              <>
                <button
                  type="button"
                  className="btn"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const r = await sendTestPush(app.getRelay()!);
                      return r.delivered > 0
                        ? 'Test sent. It should arrive in a few seconds.'
                        : r.attempted === 0
                          ? 'Notifications are not set up on this phone yet. Turn them off and on again.'
                          : 'The test could not be delivered. Turn notifications off and on again.';
                    })
                  }
                >
                  Send a test
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await disablePush();
                      setSubscribed(false);
                      return 'Notifications are off on this phone.';
                    })
                  }
                >
                  Turn off
                </button>
              </>
            )}
          </div>
          {perm === 'denied' && (
            <p className="note warn">
              Allow notifications for Decisions in your phone’s settings, then come back.
            </p>
          )}
          {status && (
            <p
              className={status.error ? 'note error' : 'note'}
              role={status.error ? 'alert' : 'status'}
            >
              {status.text}
            </p>
          )}
        </>
      )}
      {isIos() && isStandalone() && (
        <p className="muted">Installed on your Home Screen, so notifications can reach you.</p>
      )}
    </section>
  );
}

/**
 * A whole-number field you can clear and retype freely: the value is checked and kept within range when you
 * leave the field, not on every keystroke.
 */
function NumberField({
  label,
  value,
  min,
  max,
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onCommit: (n: number) => void;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = () => {
    const n = Number.parseInt(text, 10);
    const v = Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : value;
    setText(String(v));
    if (v !== value) onCommit(v);
  };
  return (
    <label>
      {label}
      <input
        type="text"
        inputMode="numeric"
        pattern="[0-9]*"
        value={text}
        onChange={(e) => {
          const t = e.target.value.replace(/[^0-9]/g, '').slice(0, 3);
          setText(t);
          // A valid number counts straight away (so Save lights up); anything else waits for blur.
          const n = Number.parseInt(t, 10);
          if (Number.isFinite(n) && n >= min && n <= max && n !== value) onCommit(n);
        }}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && commit()}
      />
    </label>
  );
}

function RemindersSection() {
  const [saved, setSaved] = useState<Server | null>(null);
  const [s, setDraft] = useState<Server | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [zones] = useState(timeZones);
  const load = () => {
    setLoadError(false);
    app
      .getServerSettings()
      .then((r) => {
        const v = { ...DEFAULT_SERVER, ...r };
        setSaved(v);
        setDraft(v);
      })
      // Never show invented values as if they were saved ones: say it failed and offer a retry.
      .catch(() => setLoadError(true));
  };
  useEffect(load, []);
  if (loadError) {
    return (
      <section className="card" aria-labelledby="rem-h">
        <h2 id="rem-h">Quiet hours and reminders</h2>
        <p className="note warn" role="alert">
          Could not load these settings from your relay.
        </p>
        <button type="button" className="btn small" onClick={load}>
          Try again
        </button>
      </section>
    );
  }
  if (!s) return <section className="card skeleton-row" aria-label="Loading reminder settings" />;
  const setS = (next: Server) => {
    setDraft(next);
    setMsg(null);
    setSaveError(null);
  };
  const dirty = JSON.stringify(s) !== JSON.stringify(saved);
  // Unsaved edits always outrank an earlier "Saved." so the status never claims more than is true.
  const qh = s.quiet_hours ?? DEFAULT_SERVER.quiet_hours!;
  const rm = s.reminders ?? DEFAULT_SERVER.reminders!;
  const save = async () => {
    setMsg(null);
    setSaveError(null);
    setSaving(true);
    try {
      await app.putServerSettings(s);
      setSaved(s);
      setMsg('Saved.');
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : 'Could not save. Try again.');
    } finally {
      setSaving(false);
    }
  };
  return (
    <section className="card" aria-labelledby="rem-h">
      <h2 id="rem-h">Quiet hours and reminders</h2>
      <p className="muted">
        These only change when you are notified. Questions and answers always sync.
      </p>
      <fieldset disabled={saving}>
        <label className="check">
          <input
            type="checkbox"
            checked={qh.enabled}
            onChange={(e) => setS({ ...s, quiet_hours: { ...qh, enabled: e.target.checked } })}
          />
          Quiet hours
        </label>
        {qh.enabled && (
          <div className="grid2">
            <label>
              From
              <input
                type="time"
                value={qh.start}
                onChange={(e) => setS({ ...s, quiet_hours: { ...qh, start: e.target.value } })}
              />
            </label>
            <label>
              Until
              <input
                type="time"
                value={qh.end}
                onChange={(e) => setS({ ...s, quiet_hours: { ...qh, end: e.target.value } })}
              />
            </label>
            <label className="span2">
              Time zone
              <select
                value={qh.time_zone}
                onChange={(e) => setS({ ...s, quiet_hours: { ...qh, time_zone: e.target.value } })}
              >
                {(zones.includes(qh.time_zone) ? zones : [qh.time_zone, ...zones]).map((z) => (
                  <option key={z}>{z}</option>
                ))}
              </select>
            </label>
          </div>
        )}
        <label className="check">
          <input
            type="checkbox"
            checked={rm.enabled}
            onChange={(e) => setS({ ...s, reminders: { ...rm, enabled: e.target.checked } })}
          />
          Remind me about unanswered questions
        </label>
        {rm.enabled && (
          <div className="grid2">
            <NumberField
              label="First reminder (hours)"
              min={1}
              max={168}
              value={Math.round(rm.first_ms / 3_600_000)}
              onCommit={(n) => setS({ ...s, reminders: { ...rm, first_ms: n * 3_600_000 } })}
            />
            <NumberField
              label="Then every (hours)"
              min={1}
              max={168}
              value={Math.round(rm.interval_ms / 3_600_000)}
              onCommit={(n) => setS({ ...s, reminders: { ...rm, interval_ms: n * 3_600_000 } })}
            />
            <NumberField
              label="Maximum reminders"
              min={0}
              max={10}
              value={rm.max}
              onCommit={(n) => setS({ ...s, reminders: { ...rm, max: n } })}
            />
          </div>
        )}
        <label className="check">
          <input
            type="checkbox"
            checked={s.proxy_review_reminder ?? true}
            onChange={(e) => setS({ ...s, proxy_review_reminder: e.target.checked })}
          />
          Remind me to review answers from the decision model
        </label>
      </fieldset>
      <div className="row">
        <button
          type="button"
          className={dirty ? 'btn primary' : 'btn'}
          disabled={!dirty || saving}
          onClick={() => void save()}
        >
          {saving ? 'Saving…' : 'Save changes'}
        </button>
        <span role="status" className="muted">
          {saving ? '' : dirty && !saveError ? 'Unsaved changes' : (msg ?? '')}
        </span>
      </div>
      {saveError && (
        <p className="note error" role="alert">
          Your changes were not saved: {saveError}
        </p>
      )}
    </section>
  );
}

function VoiceSection() {
  const { prefs, info } = useApp();
  const v = prefs.voice;
  const [disclose, setDisclose] = useState(false);
  const set = (p: Partial<typeof v>) => app.setPrefs({ voice: { ...v, ...p } });
  const anyVoice = !!info && (info.voice.xai || info.voice.openai);
  return (
    <section className="card" aria-labelledby="voice-h">
      <h2 id="voice-h">Dictation</h2>
      {!anyVoice ? (
        <p className="muted">
          Dictation is not set up on your relay. It needs an xAI or OpenAI key added to your relay
          (an Anthropic key is optional, for tidying up what you said). Typing always works.
        </p>
      ) : (
        <>
          <p className="note warn">
            Dictation sends your voice and transcript through your relay to an AI provider. It is{' '}
            <strong>not</strong> end-to-end encrypted.{' '}
            <button type="button" className="link-btn" onClick={() => setDisclose(true)}>
              Read exactly what happens
            </button>
          </p>
          <label className="check">
            <input
              type="checkbox"
              checked={v.consent}
              onChange={(e) =>
                e.target.checked ? setDisclose(true) : void set({ consent: false })
              }
            />
            Allow dictation
          </label>
          {v.consent && (
            <div className="grid2">
              <label>
                Speech to text
                <select
                  value={v.transcription}
                  onChange={(e) =>
                    void set({ transcription: e.target.value as typeof v.transcription })
                  }
                >
                  <option value="xai" disabled={!info?.voice.xai}>
                    xAI Grok{info?.voice.xai ? '' : ' (not configured)'}
                  </option>
                  <option value="openai" disabled={!info?.voice.openai}>
                    OpenAI (preview){info?.voice.openai ? '' : ' (not configured)'}
                  </option>
                </select>
              </label>
              <label>
                Clean-up
                <select
                  value={v.correction}
                  onChange={(e) => void set({ correction: e.target.value as typeof v.correction })}
                >
                  <option value="anthropic" disabled={!info?.voice.anthropic}>
                    Claude Haiku{info?.voice.anthropic ? '' : ' (not configured)'}
                  </option>
                  <option value="openai" disabled={!info?.voice.openai}>
                    OpenAI{info?.voice.openai ? '' : ' (not configured)'}
                  </option>
                  <option value="off">Off (keep exactly what was heard)</option>
                </select>
              </label>
              <label className="span2">
                Microphone button
                <select
                  value={v.mode}
                  onChange={(e) => void set({ mode: e.target.value as typeof v.mode })}
                >
                  <option value="tap">Tap to start, tap to stop</option>
                  <option value="hold">Hold to talk</option>
                </select>
              </label>
            </div>
          )}
        </>
      )}
      <VoiceDisclosure
        open={disclose}
        provider={v.transcription === 'xai' ? 'xAI (Grok)' : 'OpenAI'}
        correction={
          v.correction === 'anthropic'
            ? 'Anthropic (Claude)'
            : v.correction === 'openai'
              ? 'OpenAI'
              : null
        }
        onClose={() => setDisclose(false)}
        onAccept={
          v.consent
            ? undefined
            : () => {
                setDisclose(false);
                void set({ consent: true });
              }
        }
      />
    </section>
  );
}

export function SettingsPage() {
  const snap = useApp();
  const [wipe, setWipe] = useState(false);
  return (
    <div className="page">
      <h1>Settings</h1>
      <section className="card">
        <h2>Appearance</h2>
        <label>
          Theme
          <select
            value={snap.prefs.theme}
            onChange={(e) =>
              void app.setPrefs({ theme: e.target.value as 'system' | 'light' | 'dark' })
            }
          >
            <option value="system">Match my phone</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </label>
      </section>
      <PushSection />
      <RemindersSection />
      <VoiceSection />
      <section className="card" aria-labelledby="privacy-h">
        <h2 id="privacy-h">Privacy and data</h2>
        <ul className="nav-list">
          <li>
            <Link to="/privacy">Who sees what</Link>
          </li>
          <li>
            <Link to="/devices">Devices</Link>
          </li>
          <li>
            <Link to="/install">Install help</Link>
          </li>
        </ul>
        <p className="muted">
          Paired as <strong>{snap.config?.label}</strong> to{' '}
          <span className="mono">{snap.config?.relayOrigin}</span>
        </p>
        <button type="button" className="btn danger-outline" onClick={() => setWipe(true)}>
          Unpair this phone…
        </button>
      </section>
      <p className="muted center">Decisions {__APP_VERSION__} · protocol 1</p>
      <ConfirmDialog
        open={wipe}
        danger
        title="Unpair and erase Decisions on this phone?"
        confirmLabel="Unpair and erase"
        onCancel={() => setWipe(false)}
        onConfirm={() => {
          setWipe(false);
          void app.wipe();
        }}
      >
        <p>
          This deletes the Decisions keys, saved questions and any unsent answers from this phone.
          Nothing else on the phone is touched, and your relay keeps its encrypted copy. Your
          computer still lists this phone until you revoke it there. You can pair this phone again
          from Daintree whenever you want.
        </p>
      </ConfirmDialog>
    </div>
  );
}
