import { useEffect, useId, useState } from 'react';
import { app, type ServerSettings } from '../../app/controller.js';
import { useApp } from '../../app/hooks.js';
import { timeZones } from '../../lib/time.js';
import { Dialog } from '../Dialog.js';
import {
  durationLabel,
  quietHoursError,
  reminderHourOptions,
  reminderSummary,
  settingsEqual,
  withDefaults,
  type QuietHours,
  type Reminders,
} from './model.js';
import { Callout, Row, SettingsGroup } from './ui.js';
import { useLeaveGuard } from './useLeaveGuard.js';

const HOUR = 3_600_000;
const deviceZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** The last settings read from the relay, so the index can summarise them without asking again. */
let lastLoaded: ServerSettings | null = null;
const loadedListeners = new Set<() => void>();
export function loadedServerSettings(): ServerSettings | null {
  return lastLoaded;
}
export function onServerSettings(l: () => void): () => void {
  loadedListeners.add(l);
  return () => loadedListeners.delete(l);
}
function remember(s: ServerSettings | null) {
  lastLoaded = s;
  loadedListeners.forEach((l) => l());
}
/** Called on unpair, so nothing from the old pairing is summarised afterwards. */
export function forgetServerSettings() {
  remember(null);
}

export async function fetchServerSettings(): Promise<ServerSettings> {
  const s = withDefaults(await app.getServerSettings(), deviceZone());
  remember(s);
  return s;
}

function zoneLabel(z: string): string {
  return z.replace(/_/g, ' ');
}

function Checkbox({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (on: boolean) => void;
}) {
  const id = useId();
  return (
    <label className="s-row s-check" htmlFor={id}>
      <input
        id={id}
        type="checkbox"
        checked={checked}
        aria-labelledby={`${id}-l`}
        aria-describedby={description ? `${id}-d` : undefined}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="s-row-text">
        <span className="s-row-label" id={`${id}-l`}>
          {label}
        </span>
        {description && (
          <span className="s-row-desc" id={`${id}-d`}>
            {description}
          </span>
        )}
      </span>
    </label>
  );
}

function HoursSelect({
  id,
  value,
  onChange,
}: {
  id: string;
  value: number;
  onChange: (ms: number) => void;
}) {
  return (
    <select
      id={id}
      className="s-select"
      value={value / HOUR}
      onChange={(e) => onChange(Number(e.target.value) * HOUR)}
    >
      {reminderHourOptions(value).map((h) => (
        <option key={h} value={h}>
          {durationLabel(h * HOUR)}
        </option>
      ))}
    </select>
  );
}

/**
 * Quiet hours and reminders live on the relay and apply to every paired device, so unlike local preferences they
 * use an explicit Save. Unsaved edits are never lost silently: leaving asks, a failed save keeps them.
 */
export function QuietHoursSection() {
  const { online } = useApp();
  const [saved, setSaved] = useState<ServerSettings | null>(null);
  const [draft, setDraft] = useState<ServerSettings | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);
  const [zones] = useState(timeZones);
  const id = useId();

  const load = () => {
    setLoadError(false);
    fetchServerSettings()
      .then((s) => {
        setSaved(s);
        setDraft(s);
      })
      // Never show invented values as if they were saved ones: say it failed and offer a retry.
      .catch(() => setLoadError(true));
  };
  useEffect(load, []);

  const dirty = !!draft && !settingsEqual(draft, saved);
  const guard = useLeaveGuard(dirty);
  const qh = draft?.quiet_hours as QuietHours | undefined;
  const rm = draft?.reminders as Reminders | undefined;
  const invalid = qh ? quietHoursError(qh) : null;

  const edit = (next: ServerSettings) => {
    setDraft(next);
    setJustSaved(false);
    setSaveError(null);
  };
  const setQh = (p: Partial<QuietHours>) => edit({ ...draft!, quiet_hours: { ...qh!, ...p } });
  const setRm = (p: Partial<Reminders>) => edit({ ...draft!, reminders: { ...rm!, ...p } });

  const save = async (): Promise<boolean> => {
    if (!draft || invalid) return false;
    setSaving(true);
    setSaveError(null);
    try {
      await app.putServerSettings(draft);
      setSaved(draft);
      remember(draft);
      setJustSaved(true);
      return true;
    } catch (e) {
      setSaveError(
        !navigator.onLine
          ? 'You’re offline. Your changes are still here; save when you reconnect.'
          : `Your changes are still here. ${e instanceof Error ? e.message : 'Try again.'}`,
      );
      return false;
    } finally {
      setSaving(false);
    }
  };
  const discard = () => {
    setDraft(saved);
    setSaveError(null);
  };

  const lead = (
    <p className="s-lead">
      Applies to every device paired to this relay. These only change when you’re notified;
      questions and answers always sync.
    </p>
  );

  if (loadError) {
    return (
      <>
        {lead}
        <Callout
          tone="error"
          role="alert"
          title="Couldn’t load these settings from your relay"
          action={
            <button type="button" className="btn small" onClick={load}>
              Try again
            </button>
          }
        >
          {online ? 'Check your connection, then try again.' : 'They need a connection.'}
        </Callout>
      </>
    );
  }
  if (!draft || !qh || !rm) {
    return (
      <>
        {lead}
        <div className="skeleton s-skeleton" aria-label="Loading quiet hours" role="status" />
      </>
    );
  }

  const zoneList = [
    ...new Set([qh.time_zone, deviceZone(), ...(zones.includes(qh.time_zone) ? zones : [])]),
  ];

  return (
    <>
      {lead}
      <form
        className="s-form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <fieldset disabled={saving}>
          <SettingsGroup>
            <Checkbox
              label="Quiet hours"
              description="Notifications wait until quiet hours end. Questions still arrive and sync."
              checked={qh.enabled}
              onChange={(enabled) => setQh({ enabled })}
            />
            {qh.enabled && (
              <div className="s-dependents">
                <Row
                  label="From"
                  htmlFor={`${id}-from`}
                  control={
                    <input
                      id={`${id}-from`}
                      type="time"
                      className="s-time"
                      value={qh.start}
                      aria-invalid={!!invalid}
                      aria-describedby={invalid ? `${id}-err` : undefined}
                      onChange={(e) => setQh({ start: e.target.value })}
                    />
                  }
                />
                <Row
                  label="Until"
                  htmlFor={`${id}-to`}
                  control={
                    <input
                      id={`${id}-to`}
                      type="time"
                      className="s-time"
                      value={qh.end}
                      aria-invalid={!!invalid}
                      aria-describedby={invalid ? `${id}-err` : undefined}
                      onChange={(e) => setQh({ end: e.target.value })}
                    />
                  }
                />
                {invalid && (
                  <div className="s-row stacked">
                    <p className="s-field-error" id={`${id}-err`} role="alert">
                      {invalid}
                    </p>
                  </div>
                )}
                <Row
                  label="Time zone"
                  stacked
                  htmlFor={`${id}-tz`}
                  description={
                    qh.time_zone === deviceZone()
                      ? 'This device’s time zone'
                      : `This device is in ${zoneLabel(deviceZone())}`
                  }
                  control={
                    <select
                      id={`${id}-tz`}
                      className="s-select wide"
                      value={qh.time_zone}
                      onChange={(e) => setQh({ time_zone: e.target.value })}
                    >
                      {zoneList.map((z) => (
                        <option key={z} value={z}>
                          {zoneLabel(z)}
                        </option>
                      ))}
                    </select>
                  }
                />
              </div>
            )}
          </SettingsGroup>

          <SettingsGroup label="Reminders">
            <Checkbox
              label="Remind me about unanswered questions"
              description={reminderSummary(rm)}
              checked={rm.enabled}
              onChange={(enabled) => setRm({ enabled })}
            />
            {rm.enabled && (
              <div className="s-dependents">
                <Row
                  label="First reminder after"
                  htmlFor={`${id}-first`}
                  control={
                    <HoursSelect
                      id={`${id}-first`}
                      value={rm.first_ms}
                      onChange={(first_ms) => setRm({ first_ms })}
                    />
                  }
                />
                <Row
                  label="Then every"
                  htmlFor={`${id}-every`}
                  control={
                    <HoursSelect
                      id={`${id}-every`}
                      value={rm.interval_ms}
                      onChange={(interval_ms) => setRm({ interval_ms })}
                    />
                  }
                />
                <Row
                  label="At most"
                  htmlFor={`${id}-max`}
                  control={
                    <select
                      id={`${id}-max`}
                      className="s-select"
                      value={rm.max}
                      onChange={(e) => setRm({ max: Number(e.target.value) })}
                    >
                      {Array.from({ length: 11 }, (_, n) => (
                        <option key={n} value={n}>
                          {n === 0 ? 'No reminders' : `${n} reminder${n === 1 ? '' : 's'}`}
                        </option>
                      ))}
                    </select>
                  }
                />
              </div>
            )}
            <Checkbox
              label="Remind me to review model answers"
              description="When the decision model answers for you, you’re reminded to confirm or change it"
              checked={draft.proxy_review_reminder ?? true}
              onChange={(proxy_review_reminder) => edit({ ...draft, proxy_review_reminder })}
            />
          </SettingsGroup>
        </fieldset>

        {saveError && (
          <Callout
            tone="error"
            role="alert"
            title="Couldn’t save to your relay"
            action={
              <button type="submit" className="btn small">
                Retry
              </button>
            }
          >
            {saveError}
          </Callout>
        )}

        <div className={`s-savebar${dirty ? ' dirty' : ''}`} role="group" aria-label="Save changes">
          <span className="s-savebar-status" role="status">
            {saving
              ? 'Saving to your relay…'
              : dirty
                ? invalid
                  ? 'Fix the times to save'
                  : 'Unsaved changes'
                : justSaved
                  ? 'Saved on your relay'
                  : ''}
          </span>
          {dirty && (
            <button type="button" className="btn small" disabled={saving} onClick={discard}>
              Discard
            </button>
          )}
          <button
            type="submit"
            className="btn small primary"
            disabled={!dirty || saving || !!invalid}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>

      <Dialog
        open={guard.pending !== null}
        title="Save your changes?"
        onClose={guard.stay}
        actions={
          <div className="s-dialog-actions">
            <button type="button" className="btn" onClick={guard.stay}>
              Keep editing
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => {
                discard();
                guard.leave();
              }}
            >
              Discard
            </button>
            <button
              type="button"
              className="btn primary"
              disabled={!!invalid || saving}
              onClick={() => {
                void save().then((ok) => (ok ? guard.leave() : guard.stay()));
              }}
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        }
      >
        <p>
          Your quiet hours and reminder changes haven’t been saved to your relay.
          {invalid ? ' The times need fixing before they can be saved.' : ''}
        </p>
      </Dialog>
    </>
  );
}
