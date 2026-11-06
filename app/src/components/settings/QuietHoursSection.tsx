import { useEffect, useId, useRef, useState } from 'react';
import { app, type ServerSettings } from '../../app/controller.js';
import { useApp } from '../../app/hooks.js';
import { timeZones } from '../../lib/time.js';
import { Dialog } from '../Dialog.js';
import { ErrorIcon, SuccessIcon } from '../Icons.js';
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
  disabled,
}: {
  id: string;
  value: number;
  onChange: (ms: number) => void;
  disabled?: boolean;
}) {
  return (
    <select
      id={id}
      className="s-select"
      disabled={disabled}
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
  // A fresh save stays docked for a few seconds, then the bar settles at the form's foot still saying so.
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    setSettled(false);
    if (!justSaved) return;
    const t = setTimeout(() => setSettled(true), 4000);
    return () => clearTimeout(t);
  }, [justSaved]);
  const docked = dirty || saving || (justSaved && !settled) || !!saveError;
  // The docked bar's real height, so a control Tab moves to is always scrolled clear of it.
  const dock = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = dock.current;
    const root = document.documentElement;
    if (!el || !docked || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      root.style.setProperty('--s-dock-h', `${el.getBoundingClientRect().height}px`);
      // The bar lifting (or growing an error) never leaves the control being edited underneath it.
      const f = document.activeElement;
      if (f instanceof HTMLElement && f !== document.body && !el.contains(f))
        f.scrollIntoView({ block: 'nearest' });
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      root.style.removeProperty('--s-dock-h');
    };
  }, [docked]);
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
    if (!draft || invalid || saving) return false;
    setSaving(true);
    setSaveError(null);
    try {
      await app.putServerSettings(draft);
      setSaved(draft);
      remember(draft);
      setJustSaved(true);
      return true;
    } catch {
      setSaveError(
        !navigator.onLine
          ? 'You’re offline. Your changes are still here; save when you reconnect.'
          : 'Your relay didn’t accept the changes. They’re still here, so try again in a moment.',
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
      Saved on your relay and shared by every paired device, so changes wait for Save. These
      settings only decide when you’re notified.
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
    // The relay's zone and this device's first, then every zone the browser knows (UTC is often not among them).
    ...new Set([qh.time_zone, deviceZone(), ...zones]),
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
                  <div className="s-row stacked s-field-error" id={`${id}-err`}>
                    <Callout tone="error" role="alert">
                      {invalid}
                    </Callout>
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
              // Turning reminders on from a relay that held "none" starts from the usual three.
              onChange={(enabled) =>
                setRm(enabled && rm.max === 0 ? { enabled, max: 3 } : { enabled })
              }
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
                      // With one reminder there is no "then".
                      disabled={rm.max <= 1}
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
                      {/* Turning reminders off is the checkbox above; 0 is offered only if the relay already holds it. */}
                      {Array.from({ length: 11 }, (_, n) => n)
                        .filter((n) => n > 0 || rm.max === 0)
                        .map((n) => (
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

        {/* The bar stays docked at the foot of the screen while there is anything to say about saving, so the
            outcome of Save is always where the person pressed it. */}
        <div className={`s-save-dock${docked ? ' docked' : ''}`} ref={dock}>
          {saveError && (
            <Callout tone="error" role="alert" title="Couldn’t save to your relay">
              {saveError}
            </Callout>
          )}
          <div
            className={`s-savebar${dirty && !saving && !invalid && !saveError ? ' dirty' : ''}${dirty && (invalid || saveError) ? ' failed' : ''}${justSaved && !dirty ? ' saved' : ''}`}
            role="group"
            aria-label="Save changes"
          >
            <span className="s-savebar-status" role="status">
              {justSaved && !dirty && !saving && <SuccessIcon size={16} />}
              {/* A failed save already shows its glyph on the callout above. */}
              {dirty && !saving && invalid && <ErrorIcon size={16} />}
              {saving
                ? 'Saving to your relay…'
                : dirty
                  ? invalid
                    ? 'Fix the times to save'
                    : saveError
                      ? 'Not saved yet'
                      : 'Unsaved changes'
                  : justSaved
                    ? 'Saved on your relay'
                    : ''}
            </span>
            <div className="s-savebar-actions">
              {dirty && (
                <button type="button" className="btn small" disabled={saving} onClick={discard}>
                  Discard
                </button>
              )}
              {/* Not disabled while saving, so focus stays on it; the save itself ignores a second press. */}
              <button
                type="submit"
                className="btn small primary"
                disabled={!dirty || !!invalid}
                aria-disabled={saving || undefined}
              >
                {saveError && !saving ? 'Try again' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      </form>

      <Dialog
        open={guard.pending !== null}
        title="Save your changes?"
        // While a save is in flight its outcome decides: stay on failure, leave on success.
        onClose={() => {
          if (!saving) guard.stay();
        }}
        actions={
          <div className="s-dialog-actions">
            <button type="button" className="btn" disabled={saving} onClick={guard.stay}>
              Keep editing
            </button>
            <button
              type="button"
              className="btn"
              disabled={saving}
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
