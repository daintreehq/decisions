import { useCallback, useEffect, useRef, useState } from 'react';
import { app } from '../../app/controller.js';
import { useApp } from '../../app/hooks.js';
import type { QuestionView } from '../../domain/model.js';
import { VoiceDisclosure } from '../../components/VoiceDisclosure.js';
import {
  applyToRegion,
  buildKeyterms,
  resolveSpan,
  runCorrection,
  type DictationRegion,
  type KeptRawReason,
  type Span,
  type SpanChoice,
} from './correction.js';
import { VoiceClient } from './client.js';
import { MicUnavailableError, startMic } from './capture.js';
import { DictationSession, type SessionPhase } from './session.js';

type Phase = 'idle' | 'connecting' | 'listening' | 'finishing' | 'cleaning';

const KEPT: Record<KeptRawReason, string> = {
  timeout: 'Clean-up took too long, so your words are kept exactly as dictated.',
  'provider-error': 'Clean-up was unavailable, so your words are kept exactly as dictated.',
  malformed: 'Clean-up returned something unexpected, so your words are kept exactly as dictated.',
  'editor-changed': 'You edited the text, so clean-up was not applied.',
  drift: 'Clean-up changed the meaning, so your words are kept exactly as dictated.',
  unavailable: 'Clean-up was unavailable, so your words are kept exactly as dictated.',
};

export function VoiceInput({
  value,
  onChange,
  view,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  view: QuestionView;
  disabled?: boolean;
}) {
  const snap = useApp();
  const { prefs, info } = snap;
  const v = prefs.voice;
  const available =
    !!info &&
    ((v.transcription === 'xai' && info.voice.xai) ||
      (v.transcription === 'openai' && info.voice.openai));
  const correctionAvailable =
    v.correction !== 'off' &&
    !!info &&
    ((v.correction === 'anthropic' && info.voice.anthropic) ||
      (v.correction === 'openai' && info.voice.openai));

  const [phase, setPhase] = useState<Phase>('idle');
  const [live, setLive] = useState({ final: '', interim: '' });
  const [level, setLevel] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const [spans, setSpans] = useState<Span[]>([]);
  const [suggestion, setSuggestion] = useState<{
    corrected: string;
    region: DictationRegion;
    reason: string;
    spans: Span[];
  } | null>(null);
  const [disclose, setDisclose] = useState(false);
  const valueRef = useRef(value);
  valueRef.current = value;
  const spansText = useRef<string | null>(null);
  const sessionRef = useRef<DictationSession | null>(null);
  /** Whether the human is physically holding the button (hold-to-talk), tracked apart from the async startup. */
  const pressed = useRef(false);
  const disabledRef = useRef(!!disabled);
  disabledRef.current = !!disabled;

  // Span offsets are only meaningful for the exact text they were computed against.
  const spansValid = spans.length > 0 && spansText.current === value;

  useEffect(
    () => () => {
      sessionRef.current?.cancel();
      sessionRef.current = null;
    },
    [],
  );

  const end = useCallback(
    async (note?: string) => {
      const session = sessionRef.current;
      if (!session) return;
      setPhase('finishing');
      const raw = (await session.finish()).trim();
      if (sessionRef.current === session) sessionRef.current = null;
      setLive({ final: '', interim: '' });
      setLevel(0);
      if (!raw) {
        setPhase('idle');
        setMessage(note ?? 'Nothing was heard. You can try again or type your answer.');
        return;
      }
      const before = valueRef.current;
      const sep = before && !/\s$/.test(before) ? ' ' : '';
      const start = before.length + sep.length;
      const withRaw = before + sep + raw;
      const region: DictationRegion = { start, end: start + raw.length, raw };
      onChange(withRaw); // raw is in the editor (and autosaved as an encrypted draft) before any clean-up runs
      setMessage(note ?? null);
      if (
        !correctionAvailable ||
        !app.getRelay() ||
        v.correction === 'off' ||
        disabledRef.current
      ) {
        setPhase('idle');
        return;
      }
      setPhase('cleaning');
      const relay = app.getRelay()!;
      const labels = view.content?.options.map((o) => o.label) ?? [];
      const keyterms = buildKeyterms(view.content?.question ?? '', labels);
      const outcome = await runCorrection({
        provider: v.correction as 'anthropic' | 'openai',
        raw,
        question: view.content?.question ?? '',
        optionLabels: labels,
        keyterms,
        editorAtStart: withRaw,
        getEditorText: () => valueRef.current,
        post: (path, body, signal) => relay.raw('POST', path, body, signal),
      });
      setPhase('idle');
      if (outcome.kind === 'kept-raw') {
        setMessage(KEPT[outcome.reason]);
        return;
      }
      const shifted = outcome.spans.map((x) => ({
        ...x,
        start: x.start + region.start,
        end: x.end + region.start,
      }));
      if (!outcome.autoApply) {
        // Not a conservative edit: shown as a suggestion. The human's dictated words stay in the editor untouched.
        setSuggestion({
          corrected: outcome.result.corrected_text,
          region,
          reason: outcome.reviewReason ?? 'the wording changed',
          spans: shifted,
        });
        setMessage(
          'The clean-up changed more than punctuation, so it is only a suggestion. Your words are unchanged.',
        );
        return;
      }
      const applied = applyToRegion(valueRef.current, region, outcome.result.corrected_text);
      if (!applied) {
        setMessage(KEPT['editor-changed']);
        return;
      }
      spansText.current = applied.text;
      onChange(applied.text);
      setSpans(shifted);
      setMessage(
        shifted.length
          ? 'Cleaned up. Words the model was unsure about are marked below.'
          : 'Cleaned up. Check it before you submit.',
      );
    },
    [correctionAvailable, onChange, v.correction, view.content],
  );

  const acceptSuggestion = () => {
    if (!suggestion) return;
    const applied = applyToRegion(valueRef.current, suggestion.region, suggestion.corrected);
    setSuggestion(null);
    if (!applied) {
      setMessage(KEPT['editor-changed']);
      return;
    }
    spansText.current = applied.text;
    onChange(applied.text);
    setSpans(suggestion.spans);
    setMessage('Suggestion applied. Check it before you submit.');
  };

  // Never keep recording while the app is hidden.
  useEffect(() => {
    const h = () => {
      if (document.visibilityState === 'hidden' && sessionRef.current)
        void end('Recording stopped because the app was hidden.');
    };
    document.addEventListener('visibilitychange', h);
    return () => document.removeEventListener('visibilitychange', h);
  }, [end]);

  // The editor was locked (question changed, answer sent, ...): stop and finalize capture, keeping the words so far.
  useEffect(() => {
    if (disabled && sessionRef.current) {
      void end('Dictation stopped because the question changed. Your words so far were kept.');
    }
  }, [disabled, end]);

  const begin = async () => {
    if (sessionRef.current || disabledRef.current) return;
    if (!v.consent) {
      setDisclose(true);
      return;
    }
    const relay = app.getRelay();
    if (!relay || !snap.config) return;
    setMessage(null);
    setSpans([]);
    setSuggestion(null);
    const labels = view.content?.options.map((o) => o.label) ?? [];
    const keyterms = buildKeyterms(view.content?.question ?? '', labels);
    const config = snap.config;
    const session = new DictationSession(
      {
        makeClient: (onReady) =>
          new VoiceClient({
            origin: config.relayOrigin,
            provider: v.transcription,
            keyterms,
            postJson: (path, body) => relay.json('POST', path, { body }),
            onState: (st) => st === 'ready' && onReady(),
            onText: setLive,
            onError: (m) => setMessage(m),
          }),
        startMic,
        onLevel: setLevel,
      },
      (p: SessionPhase) =>
        setPhase(
          p === 'starting'
            ? 'connecting'
            : p === 'listening'
              ? 'listening'
              : p === 'finishing'
                ? 'finishing'
                : 'idle',
        ),
    );
    sessionRef.current = session;
    try {
      const r = await session.start();
      if (r === 'cancelled' && sessionRef.current === session) sessionRef.current = null;
    } catch (e) {
      if (sessionRef.current === session) sessionRef.current = null;
      setPhase('idle');
      setMessage(
        e instanceof MicUnavailableError
          ? e.message
          : 'Dictation could not start. You can type your answer instead.',
      );
    }
  };

  /** Hold-to-talk release or pointer cancel: abort a startup in progress, or finish a live recording. */
  const release = () => {
    if (!pressed.current) return;
    pressed.current = false;
    const session = sessionRef.current;
    if (!session) return;
    if (session.phase === 'starting') {
      session.cancel();
      sessionRef.current = null;
      setPhase('idle');
    } else if (session.phase === 'listening') {
      void end();
    }
  };

  const toggle = () => {
    const session = sessionRef.current;
    if (session?.phase === 'listening') void end();
    else if (session?.phase === 'starting') {
      session.cancel();
      sessionRef.current = null;
      setPhase('idle');
    } else if (!session) void begin();
  };

  // Without dictation there is nothing to say: the text box above is the way in. Only explain when the
  // owner turned dictation on and it cannot work here.
  if (!available || disabled) {
    return v.consent && !disabled ? (
      <p className="note hint" data-testid="type-instead">
        Dictation is not set up on your relay, so type instead.
      </p>
    ) : null;
  }

  const busy = phase !== 'idle';
  const hold = v.mode === 'hold';
  return (
    <div className="voice">
      <div className="voice-row">
        <button
          type="button"
          className={`btn mic ${phase === 'listening' ? 'recording' : ''}`}
          aria-pressed={phase === 'listening'}
          // Never disabled while connecting: a disabled button would swallow the release that cancels startup.
          disabled={phase === 'finishing' || phase === 'cleaning'}
          {...(hold
            ? {
                onPointerDown: (e) => {
                  if (e.button !== 0) return;
                  pressed.current = true;
                  e.currentTarget.setPointerCapture?.(e.pointerId);
                  void begin();
                },
                onPointerUp: release,
                onPointerCancel: release,
                onLostPointerCapture: release,
                onClick: (e) => e.detail === 0 && toggle(), // keyboard activation
              }
            : { onClick: toggle })}
        >
          <span
            aria-hidden="true"
            className="mic-dot"
            style={{ transform: `scale(${1 + Math.min(level * 6, 1)})` }}
          />
          {phase === 'idle' && (hold ? 'Hold to dictate' : 'Dictate')}
          {phase === 'connecting' && 'Connecting… (tap to cancel)'}
          {phase === 'listening' && (hold ? 'Release to finish' : 'Tap to finish')}
          {phase === 'finishing' && 'Finishing…'}
          {phase === 'cleaning' && 'Cleaning up…'}
        </button>
        <button type="button" className="link-btn" onClick={() => setDisclose(true)}>
          Where does my voice go?
        </button>
      </div>
      {busy && (live.final || live.interim) && (
        <p className="live" aria-live="off">
          {live.final} <span className="interim">{live.interim}</span>
        </p>
      )}
      {message && (
        <p className="note" role="status">
          {message}
        </p>
      )}
      {suggestion && (
        <div className="card suggestion" role="group" aria-label="Suggested clean-up">
          <p className="note">Suggested clean-up (needs your OK, {suggestion.reason}):</p>
          <p className="draft-text">{suggestion.corrected}</p>
          <div className="row">
            <button type="button" className="btn primary small" onClick={acceptSuggestion}>
              Use suggestion
            </button>
            <button type="button" className="btn small" onClick={() => setSuggestion(null)}>
              Keep what I said
            </button>
          </div>
        </div>
      )}
      {spansValid && (
        <ul className="spans" aria-label="Words to double-check">
          {spans.map((s, i) => (
            <li key={`${s.start}-${s.end}`}>
              <p>
                Not sure about <mark>{value.slice(s.start, s.end)}</mark>
                {s.reason ? ` (${s.reason})` : ''}
              </p>
              <div className="chips">
                {(['corrected', 'candidate', 'raw'] as SpanChoice[]).map((c) => {
                  const label =
                    c === 'corrected' ? 'Keep' : c === 'candidate' ? s.candidate : s.raw;
                  return (
                    <button
                      key={c}
                      type="button"
                      className="chip"
                      onClick={() => {
                        const r = resolveSpan(value, spans, i, c);
                        spansText.current = r.text;
                        setSpans(r.spans);
                        onChange(r.text);
                      }}
                    >
                      {c === 'raw'
                        ? `Heard: ${label}`
                        : c === 'candidate'
                          ? `Maybe: ${label}`
                          : label}
                    </button>
                  );
                })}
              </div>
            </li>
          ))}
        </ul>
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
                void app.setPrefs({ voice: { ...v, consent: true } });
              }
        }
      />
    </div>
  );
}
