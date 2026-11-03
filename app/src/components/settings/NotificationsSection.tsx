import { useCallback, useEffect, useState } from 'react';
import { app } from '../../app/controller.js';
import { Link } from '../../app/router.js';
import {
  currentSubscription,
  disablePush,
  enablePush,
  pushIsOn,
  pushSupport,
  sendTestPush,
} from '../../features/push.js';
import { notificationState, type NotificationState } from './model.js';
import { Callout, Row, SettingsGroup } from './ui.js';

const permissionNow = (): NotificationPermission =>
  typeof Notification !== 'undefined' ? Notification.permission : 'denied';

/** This device's notification state, re-checked on demand. Shared by the index summary and the section. */
export function useNotificationStatus(deep = true) {
  const [support] = useState(pushSupport);
  const [subscribed, setSubscribed] = useState<boolean | null>(null);
  const [checkFailed, setCheckFailed] = useState(false);
  const [permission, setPermission] = useState(permissionNow);
  const check = useCallback(() => {
    if (!support.ok) return;
    setCheckFailed(false);
    setSubscribed(null);
    setPermission(permissionNow());
    // The index only needs the browser's own answer; the section also asks the relay.
    (deep ? pushIsOn(app.getRelay()) : currentSubscription().then((s) => !!s))
      .then(setSubscribed)
      .catch(() => setCheckFailed(true));
  }, [support.ok, deep]);
  useEffect(check, [check]);
  const state = notificationState({ support, permission, subscribed, checkFailed });
  return { state, check, setSubscribed, setPermission };
}

const STATUS: Record<NotificationState, { value: string; text: string }> = {
  checking: { value: 'Checking…', text: '' },
  on: {
    value: 'On',
    text: 'This device is told when a question needs you.',
  },
  'not-requested': {
    value: 'Off',
    text: 'Turn them on to hear when a question needs you. Your browser will ask first.',
  },
  'granted-no-subscription': {
    value: 'Not set up',
    text: 'Your browser allows notifications, but this device isn’t registered with your relay yet.',
  },
  blocked: {
    value: 'Blocked',
    text: 'Notifications are blocked for Decisions.',
  },
  'install-needed': {
    value: 'Needs Home Screen',
    text: 'On iPhone and iPad, notifications only work once Decisions is on your Home Screen (iOS 16.4 or newer).',
  },
  unsupported: {
    value: 'Not available',
    text: 'This browser can’t receive notifications. Questions still sync whenever Decisions is open.',
  },
  'check-failed': {
    value: 'Couldn’t check',
    text: 'Decisions couldn’t read this device’s notification setting.',
  },
};

export function NotificationsSection() {
  const { state, check, setSubscribed, setPermission } = useNotificationStatus();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ text: string; tone: 'success' | 'error' | 'info' } | null>(
    null,
  );

  const run = async (fn: () => Promise<{ text: string; tone: 'success' | 'error' | 'info' }>) => {
    setBusy(true);
    setResult(null);
    try {
      setResult(await fn());
    } catch (e) {
      setResult({
        text: e instanceof Error ? e.message : 'Something went wrong. Try again.',
        tone: 'error',
      });
    } finally {
      setPermission(permissionNow());
      setBusy(false);
    }
  };

  const turnOn = () =>
    void run(async () => {
      await enablePush(app.getRelay()!);
      setSubscribed(true);
      return { text: 'Notifications are on. Send a test to check.', tone: 'success' };
    });
  const test = () =>
    void run(async () => {
      const r = await sendTestPush(app.getRelay()!);
      if (r.delivered > 0) return { text: 'Test notification sent', tone: 'success' };
      if (r.attempted === 0)
        return {
          text: 'This device isn’t registered with your relay. Turn notifications off and on again.',
          tone: 'error',
        };
      return {
        text: 'The push service refused the test. Turn notifications off and on again.',
        tone: 'error',
      };
    });
  const turnOff = () =>
    void run(async () => {
      await disablePush();
      setSubscribed(false);
      return { text: 'Notifications are off on this device.', tone: 'info' };
    });

  const s = STATUS[state];
  return (
    <>
      <p className="s-lead">
        A notification only says that a question needs you. It never contains the question, project
        or any code.
      </p>
      <SettingsGroup>
        <Row
          label="This device"
          description={s.text || undefined}
          control={<span className="s-value">{s.value}</span>}
          actions={
            state === 'blocked' || state === 'check-failed' ? (
              <button type="button" className="btn small" onClick={check}>
                {state === 'blocked' ? 'Check again' : 'Try again'}
              </button>
            ) : state === 'install-needed' ? (
              <Link to="/install" className="btn small">
                Add to Home Screen
              </Link>
            ) : state === 'not-requested' || state === 'granted-no-subscription' ? (
              <button type="button" className="btn small primary" disabled={busy} onClick={turnOn}>
                {state === 'granted-no-subscription' ? 'Set up notifications' : 'Turn on'}
              </button>
            ) : state === 'on' ? (
              <>
                <button type="button" className="btn small" disabled={busy} onClick={test}>
                  Send a test
                </button>
                <button type="button" className="btn small" disabled={busy} onClick={turnOff}>
                  Turn off
                </button>
              </>
            ) : undefined
          }
        />
        {state === 'blocked' && (
          <div className="s-row stacked">
            <Callout tone="warn" title="Allow notifications in your settings">
              Open your browser’s or phone’s settings, allow notifications for Decisions, then come
              back and check again.
            </Callout>
          </div>
        )}
        {result && (
          <div className="s-row stacked">
            <Callout tone={result.tone} role={result.tone === 'error' ? 'alert' : 'status'}>
              {result.text}
            </Callout>
          </div>
        )}
      </SettingsGroup>
      <p className="s-foot">
        When notifications arrive is set in{' '}
        <Link to="/settings/quiet-hours">Quiet hours &amp; reminders</Link>.
      </p>
    </>
  );
}
