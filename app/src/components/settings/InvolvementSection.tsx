import { useEffect, useId, useRef, useState } from 'react';
import { LIMITS, type InvolvementMode } from '@daintreehq/decisions-protocol';
import { app } from '../../app/controller.js';
import { useApp } from '../../app/hooks.js';
import type { InvolvementSnapshot } from '../../data/involvement.js';
import {
  INVOLVEMENT_MODES,
  MODE_DESCRIPTION,
  MODE_LABEL,
  defaultOverrideEnd,
  draftError,
  draftOf,
  draftsEqual,
  endLabel,
  fromLocalInput,
  inForce,
  setByLine,
  toLocalInput,
  type InvolvementDraft,
} from '../../domain/involvement.js';
import { Dialog } from '../Dialog.js';
import { ErrorIcon, SuccessIcon } from '../Icons.js';
import { Callout, Row, SettingsGroup, Switch } from './ui.js';
import { useLeaveGuard } from './useLeaveGuard.js';

/** The preference as the controller holds it, kept current while the section is open. */
function useInvolvement(): InvolvementSnapshot {
  const [s, setS] = useState(() => app.involvementState());
  useEffect(() => {
    setS(app.involvementState());
    return app.onInvolvement(() => setS(app.involvementState()));
  }, []);
  return s;
}

/**
 * Re-renders the screen when the next of `ends` passes, so it never shows a temporary mode that is over. Ends already
 * past are skipped, so a later one is still waited for. Returns a tick that changes at each boundary.
 */
function useBoundaryTick(ends: readonly (string | null | undefined)[]): number {
  const [tick, setTick] = useState(0);
  const now = Date.now();
  const next = ends
    .map((u) => (u ? Date.parse(u) : NaN))
    .filter((t) => t > now)
    .sort((a, b) => a - b)[0];
  useEffect(() => {
    if (next === undefined) return;
    // setTimeout holds at most ~24.8 days; a later end is re-armed when this one fires.
    const t = setTimeout(
      () => setTick((n) => n + 1),
      Math.min(next - Date.now() + 50, 2_000_000_000),
    );
    return () => clearTimeout(t);
  }, [next, tick]);
  return tick;
}

function ModeChoice({
  name,
  value,
  onChange,
  labelledBy,
}: {
  name: string;
  value: InvolvementMode;
  onChange: (m: InvolvementMode) => void;
  labelledBy: string;
}) {
  return (
    <div className="s-radios" role="radiogroup" aria-labelledby={labelledBy}>
      {INVOLVEMENT_MODES.map((m) => (
        <label key={m} className={`s-radio${value === m ? ' on' : ''}`}>
          <input
            type="radio"
            name={name}
            value={m}
            checked={value === m}
            onChange={() => onChange(m)}
          />
          <span>
            <span className="s-radio-label">{MODE_LABEL[m]}</span>
            <span className="s-row-desc">{MODE_DESCRIPTION[m]}</span>
          </span>
        </label>
      ))}
    </div>
  );
}

/**
 * How involved the person wants to be right now: a normal mode and, for a while, a different one. Saved on the relay,
 * signed by this device, and read by agents through the desktop. The person can also set it on the computer, and the
 * section says where what is in force was set. Like quiet hours it waits for Save and never loses an edit silently;
 * unlike them, a save made on top of another device's change (the computer's included) is refused, and the person is
 * told.
 */
export function InvolvementSection() {
  const { online } = useApp();
  const state = useInvolvement();
  const id = useId();
  const [draft, setDraft] = useState<InvolvementDraft | null>(null);
  /** The revision the edits started from: a save replaces exactly it, so another device's later save is a conflict. */
  const [base, setBase] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  /** The revision a save was refused over, while the person decides what to do about it; null when none was. */
  const [conflict, setConflict] = useState<number | null>(null);
  const [justSaved, setJustSaved] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);

  const load = () => {
    setLoadFailed(false);
    app.loadInvolvement().catch(() => setLoadFailed(true));
  };
  useEffect(load, []);

  const loaded = state.status === 'ready' || state.status === 'invalid';
  const record = state.status === 'ready' ? state.record : null;
  // Re-render when the saved temporary mode ends, and when the one being edited does, so neither outlives its time.
  useBoundaryTick([record?.override?.until, draft?.override?.until]);
  // Everything is worked out against the time now, so a screen left open never judges by when it opened.
  const now = Date.now();
  const effective = inForce(record, now);
  const baseline = draftOf(record, now);
  const baselineKey = JSON.stringify(baseline);

  // The form starts from what is saved, and follows it while there is nothing unsaved (another device's save, or
  // a temporary mode ending while the screen is open). Following moves the revision the edits start from too.
  const lastBaseline = useRef<InvolvementDraft | null>(null);
  useEffect(() => {
    if (!loaded) return;
    const prev = lastBaseline.current;
    lastBaseline.current = baseline;
    if (draft === null || draftsEqual(draft, baseline) || (prev && draftsEqual(draft, prev))) {
      setDraft(baseline);
      setBase(state.revision);
    }
    // Keyed on the baseline itself: a temporary mode that ended changes it, however the render was caused.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, baselineKey, state.revision]);

  const dirty = !!draft && !draftsEqual(draft, baseline);
  /** Nothing usable is saved (none set, or one this device couldn't verify): what the form shows can be saved as is. */
  const unsaved = loaded && record === null;
  const canSave = dirty || unsaved;
  const invalid = draft ? draftError(draft, now) : null;
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    setSettled(false);
    if (!justSaved) return;
    const t = setTimeout(() => setSettled(true), 4000);
    return () => clearTimeout(t);
  }, [justSaved]);
  const docked = canSave || saving || (justSaved && !settled) || !!saveError;
  const guard = useLeaveGuard(dirty);

  const edit = (next: InvolvementDraft) => {
    // Edits that start from what is saved start from its revision, whatever an earlier edit started from.
    if (draft && draftsEqual(draft, baseline)) setBase(state.revision);
    setDraft(next);
    setJustSaved(false);
    setSaveError(null);
  };

  const save = async (): Promise<boolean> => {
    if (!draft || invalid || saving) return false;
    setSaving(true);
    setSaveError(null);
    try {
      const r = await app.saveInvolvement(draft, base);
      if (r.kind === 'conflict') {
        // The edits stay: the person sees what is set now and decides whether to save theirs over it, which a
        // second Save does, now over what they have seen.
        setConflict(base);
        setBase(app.involvementState().revision);
        return false;
      }
      setConflict(null);
      setJustSaved(true);
      return true;
    } catch {
      setSaveError(
        !navigator.onLine
          ? 'You’re offline. Your changes are still here; save when you reconnect.'
          : 'Your relay didn’t accept the change. It’s still here, so try again in a moment.',
      );
      return false;
    } finally {
      setSaving(false);
    }
  };
  const discard = () => {
    setDraft(baseline);
    setBase(state.revision);
    setSaveError(null);
    setConflict(null);
  };

  const lead = (
    <p className="s-lead">
      Tells your agents how you want to take part right now. It doesn’t change what they’re allowed
      to do: questions that need you still come straight to you.
    </p>
  );

  if (loadFailed && !loaded) {
    return (
      <>
        {lead}
        <Callout
          tone="error"
          role="alert"
          title="Couldn’t load your involvement from your relay"
          action={
            <button type="button" className="btn small" onClick={load}>
              Try again
            </button>
          }
        >
          {online ? 'Check your connection, then try again.' : 'It needs a connection.'}
        </Callout>
      </>
    );
  }
  if (!loaded || !draft) {
    return (
      <>
        {lead}
        <div className="skeleton s-skeleton" aria-label="Loading involvement" role="status" />
      </>
    );
  }

  const usesRecommend = draft.normalMode === 'recommend' || draft.override?.mode === 'recommend';
  const other = (m: InvolvementMode): InvolvementMode =>
    m === 'recommend' ? 'involve-early' : 'recommend';

  return (
    <>
      {lead}
      {state.status === 'invalid' && (
        <Callout tone="warn" role="alert" title="The preference on your relay couldn’t be verified">
          It isn’t shown here. Saving here replaces it with one this device signs.
        </Callout>
      )}
      {conflict !== null && dirty && (
        <Callout
          tone="warn"
          role="alert"
          title={
            // Named only from a record read since the refused save started, never from the one it replaced.
            state.revision > conflict && state.setBy?.on === 'computer'
              ? `Changed on ${state.setBy.computer ?? 'your computer'} while you were editing`
              : 'Another device changed this while you were editing'
          }
        >
          {effective ? `It’s now set to ${MODE_LABEL[effective.mode]}. ` : 'It’s now cleared. '}
          Your changes weren’t saved. Save again to replace it with yours, or Discard to keep it.
        </Callout>
      )}

      <SettingsGroup label="Right now">
        <Row
          label={effective ? MODE_LABEL[effective.mode] : 'Not set'}
          description={
            effective
              ? `${
                  effective.until
                    ? `Until ${endLabel(effective.until, now)}, then back to ${MODE_LABEL[effective.normal_mode]}.`
                    : 'Your normal mode.'
                }${state.setBy ? ` ${setByLine(state.setBy)}` : ''}`
              : 'Agents follow their own instructions until you choose.'
          }
        />
      </SettingsGroup>

      <form
        className="s-form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <fieldset disabled={saving}>
          <SettingsGroup label="Normally">
            <div className="s-row stacked">
              <span className="sr-only" id={`${id}-normal`}>
                Normal mode
              </span>
              <ModeChoice
                name={`${id}-normal-mode`}
                value={draft.normalMode}
                labelledBy={`${id}-normal`}
                onChange={(normalMode) => edit({ ...draft, normalMode })}
              />
            </div>
          </SettingsGroup>

          <SettingsGroup label="For a while">
            <Row
              label="Use a different mode until a time you choose"
              labelId={`${id}-tmp-l`}
              description="Then it goes back to your normal mode on its own."
              descriptionId={`${id}-tmp-d`}
              control={
                <Switch
                  checked={draft.override !== null}
                  labelledBy={`${id}-tmp-l`}
                  describedBy={`${id}-tmp-d`}
                  onChange={(on) =>
                    edit({
                      ...draft,
                      override: on
                        ? { mode: other(draft.normalMode), until: defaultOverrideEnd(Date.now()) }
                        : null,
                    })
                  }
                />
              }
            />
            {draft.override && (
              <div className="s-dependents">
                <div className="s-row stacked">
                  <span className="sr-only" id={`${id}-tmp-mode`}>
                    Temporary mode
                  </span>
                  <ModeChoice
                    name={`${id}-tmp-mode-r`}
                    value={draft.override.mode}
                    labelledBy={`${id}-tmp-mode`}
                    onChange={(mode) => edit({ ...draft, override: { ...draft.override!, mode } })}
                  />
                </div>
                <Row
                  label="Until"
                  htmlFor={`${id}-until`}
                  control={
                    <input
                      id={`${id}-until`}
                      type="datetime-local"
                      className="s-time"
                      value={toLocalInput(draft.override.until)}
                      aria-invalid={!!invalid}
                      aria-describedby={invalid ? `${id}-err` : undefined}
                      onChange={(e) => {
                        const until = fromLocalInput(e.target.value);
                        edit({ ...draft, override: { ...draft.override!, until: until ?? '' } });
                      }}
                    />
                  }
                />
              </div>
            )}
          </SettingsGroup>

          {usesRecommend && (
            <SettingsGroup label="Recommendations">
              <Row
                label="Agents to consult"
                htmlFor={`${id}-count`}
                description="How many other agents the asking agent consults before it brings you a recommendation."
                control={
                  <select
                    id={`${id}-count`}
                    className="s-select"
                    value={draft.consultCount}
                    onChange={(e) => edit({ ...draft, consultCount: Number(e.target.value) })}
                  >
                    {Array.from({ length: LIMITS.involvementConsultMax }, (_, i) => i + 1).map(
                      (n) => (
                        <option key={n} value={n}>
                          {n}
                        </option>
                      ),
                    )}
                  </select>
                }
              />
            </SettingsGroup>
          )}

          {invalid && (
            <div className="s-field-error" id={`${id}-err`}>
              <Callout tone="error" role="alert">
                {invalid}
              </Callout>
            </div>
          )}
        </fieldset>

        <div className={`s-save-dock${docked ? ' docked' : ''}`}>
          {saveError && (
            <Callout tone="error" role="alert" title="Couldn’t save to your relay">
              {saveError}
            </Callout>
          )}
          <div
            className={`s-savebar${canSave && !saving && !invalid && !saveError ? ' dirty' : ''}${canSave && (invalid || saveError) ? ' failed' : ''}${justSaved && !dirty ? ' saved' : ''}`}
            role="group"
            aria-label="Save changes"
          >
            <span className="s-savebar-status" role="status">
              {justSaved && !dirty && !saving && <SuccessIcon size={16} />}
              {canSave && !saving && invalid && <ErrorIcon size={16} />}
              {saving
                ? 'Saving to your relay…'
                : canSave
                  ? invalid
                    ? 'Fix the end time to save'
                    : saveError || conflict
                      ? 'Not saved yet'
                      : dirty
                        ? 'Unsaved changes'
                        : 'Not saved on your relay yet'
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
              <button
                type="submit"
                className="btn small primary"
                disabled={!canSave || !!invalid}
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
          Your involvement changes haven’t been saved to your relay.
          {invalid ? ' The end time needs fixing before they can be saved.' : ''}
        </p>
      </Dialog>
    </>
  );
}
