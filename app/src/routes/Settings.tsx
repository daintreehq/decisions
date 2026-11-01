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
  const [status, setStatus] = useState<string | null>(null);
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
      if (msg) setStatus(msg);
    } catch (e) {
      setStatus(e instanceof Error ? e.message : 'Something went wrong');
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
                    ? 'Allowed, not subscribed'
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
                          ? 'No subscription is registered for this phone. Turn notifications off and on again.'
                          : 'The push service rejected the test. Turn notifications off and on again.';
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
            <p className="note" role="status">
              {status}
            </p>
          )}
        </>
      )}
      {isIos() && isStandalone() && <p className="muted">Installed on your Home Screen: good.</p>}
    </section>
  );
}

function RemindersSection() {
  const [s, setS] = useState<Server | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [zones] = useState(timeZones);
  useEffect(() => {
    app
      .getServerSettings()
      .then((r) => setS({ ...DEFAULT_SERVER, ...r }))
      .catch(() => setS(DEFAULT_SERVER));
  }, []);
  if (!s) return <section className="card skeleton-row" />;
  const qh = s.quiet_hours ?? DEFAULT_SERVER.quiet_hours!;
  const rm = s.reminders ?? DEFAULT_SERVER.reminders!;
  const save = async () => {
    setMsg(null);
    try {
      await app.putServerSettings(s);
      setMsg('Saved.');
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Could not save');
    }
  };
  return (
    <section className="card" aria-labelledby="rem-h">
      <h2 id="rem-h">Quiet hours and reminders</h2>
      <p className="muted">
        These only change when you are notified. Questions and answers always sync.
      </p>
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
          <label>
            First reminder after (hours)
            <input
              type="number"
              min={1}
              max={168}
              value={Math.round(rm.first_ms / 3_600_000)}
              onChange={(e) =>
                setS({
                  ...s,
                  reminders: { ...rm, first_ms: Math.max(1, Number(e.target.value)) * 3_600_000 },
                })
              }
            />
          </label>
          <label>
            Then every (hours)
            <input
              type="number"
              min={1}
              max={168}
              value={Math.round(rm.interval_ms / 3_600_000)}
              onChange={(e) =>
                setS({
                  ...s,
                  reminders: {
                    ...rm,
                    interval_ms: Math.max(1, Number(e.target.value)) * 3_600_000,
                  },
                })
              }
            />
          </label>
          <label>
            At most
            <input
              type="number"
              min={0}
              max={10}
              value={rm.max}
              onChange={(e) =>
                setS({
                  ...s,
                  reminders: { ...rm, max: Math.min(10, Math.max(0, Number(e.target.value))) },
                })
              }
            />
          </label>
        </div>
      )}
      <label className="check">
        <input
          type="checkbox"
          checked={s.proxy_review_reminder ?? true}
          onChange={(e) => setS({ ...s, proxy_review_reminder: e.target.checked })}
        />
        Remind me to review proxy answers
      </label>
      <div className="row">
        <button type="button" className="btn primary" onClick={() => void save()}>
          Save
        </button>
        {msg && <span role="status">{msg}</span>}
      </div>
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
          Dictation is not set up on your relay. You can add an xAI, Anthropic or OpenAI API key as
          a Worker secret to turn it on. Typing always works.
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
              : 'no one (clean-up is off)'
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
      <section className="card">
        <h2>Privacy and data</h2>
        <p>
          <Link to="/privacy">Who sees what</Link> · <Link to="/devices">Devices</Link> ·{' '}
          <Link to="/install">Install help</Link>
        </p>
        <p className="muted">
          Paired as <strong>{snap.config?.label}</strong> to{' '}
          <span className="mono">{snap.config?.relayOrigin}</span>
        </p>
        <button type="button" className="btn danger" onClick={() => setWipe(true)}>
          Unpair and erase this phone…
        </button>
      </section>
      <p className="muted center">Decisions {__APP_VERSION__} · protocol 1</p>
      <ConfirmDialog
        open={wipe}
        danger
        title="Erase everything on this phone?"
        confirmLabel="Unpair and erase"
        onCancel={() => setWipe(false)}
        onConfirm={() => {
          setWipe(false);
          void app.wipe();
        }}
      >
        <p>
          This deletes the keys, cached questions and any unsent answers on this phone. Your relay
          keeps its encrypted copy. To use this phone again you will pair it again from Daintree.
          Unsent answers will be lost.
        </p>
      </ConfirmDialog>
    </div>
  );
}
