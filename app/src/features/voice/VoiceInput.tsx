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
import { MicUnavailableError, startMic, type Capture } from './capture.js';

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
  const [disclose, setDisclose] = useState(false);
  const valueRef = useRef(value);
  valueRef.current = value;
  const spansText = useRef<string | null>(null);
  const clientRef = useRef<VoiceClient | null>(null);
  const micRef = useRef<Capture | null>(null);

  // Span offsets are only meaningful for the exact text they were computed against.
  const spansValid = spans.length > 0 && spansText.current === value;

  const teardown = useCallback(() => {
    micRef.current?.stop();
    micRef.current = null;
    clientRef.current?.cancel();
    clientRef.current = null;
  }, []);
  useEffect(() => teardown, [teardown]);

  const end = useCallback(
    async (note?: string) => {
      const client = clientRef.current;
      if (!client) return;
      micRef.current?.stop();
      micRef.current = null;
      setPhase('finishing');
      const raw = (await client.stop()).trim();
      clientRef.current = null;
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
      if (!correctionAvailable || !app.getRelay() || v.correction === 'off') {
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
        post: async (path, body) => relay.raw('POST', path, body),
      });
      setPhase('idle');
      if (outcome.kind === 'kept-raw') {
        setMessage(KEPT[outcome.reason]);
        return;
      }
      const applied = applyToRegion(valueRef.current, region, outcome.result.corrected_text);
      if (!applied) {
        setMessage(KEPT['editor-changed']);
        return;
      }
      const shifted = outcome.spans.map((s) => ({
        ...s,
        start: s.start + region.start,
        end: s.end + region.start,
      }));
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

  // Never keep recording while the app is hidden.
  useEffect(() => {
    const h = () => {
      if (document.visibilityState === 'hidden' && clientRef.current)
        void end('Recording stopped because the app was hidden.');
    };
    document.addEventListener('visibilitychange', h);
    return () => document.removeEventListener('visibilitychange', h);
  }, [end]);

  const begin = async () => {
    if (!v.consent) {
      setDisclose(true);
      return;
    }
    const relay = app.getRelay();
    if (!relay || !snap.config) return;
    setMessage(null);
    setSpans([]);
    setPhase('connecting');
    const labels = view.content?.options.map((o) => o.label) ?? [];
    let readyResolve: () => void = () => undefined;
    const ready = new Promise<void>((res) => (readyResolve = res));
    const client = new VoiceClient({
      origin: snap.config.relayOrigin,
      provider: v.transcription,
      keyterms: buildKeyterms(view.content?.question ?? '', labels),
      postJson: (path, body) => relay.json('POST', path, { body }),
      onState: (s) => s === 'ready' && readyResolve(),
      onText: setLive,
      onError: (m) => setMessage(m),
    });
    clientRef.current = client;
    try {
      await client.start();
      await Promise.race([
        ready,
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 10_000)),
      ]);
      micRef.current = await startMic((pcm) => client.sendAudio(pcm), setLevel);
      setPhase('listening');
    } catch (e) {
      teardown();
      setPhase('idle');
      setMessage(
        e instanceof MicUnavailableError
          ? e.message
          : 'Dictation could not start. You can type your answer instead.',
      );
    }
  };

  const toggle = () =>
    phase === 'listening' ? void end() : phase === 'idle' ? void begin() : undefined;

  if (!available || disabled) {
    return (
      <p className="note" data-testid="type-instead">
        {v.consent ? 'Dictation is not set up on your relay. ' : ''}Type your answer below.
      </p>
    );
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
          disabled={phase === 'connecting' || phase === 'finishing' || phase === 'cleaning'}
          {...(hold
            ? {
                onPointerDown: (e) => {
                  if (e.button === 0 && phase === 'idle') void begin();
                },
                onPointerUp: () => phase === 'listening' && void end(),
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
          {phase === 'connecting' && 'Connecting…'}
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
              : 'no one (clean-up is off)'
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
