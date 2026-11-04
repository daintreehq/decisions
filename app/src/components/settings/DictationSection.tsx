import { useId, useState } from 'react';
import { app } from '../../app/controller.js';
import { useApp } from '../../app/hooks.js';
import type { VoicePrefs } from '../../app/prefs.js';
import { VoiceDisclosure } from '../VoiceDisclosure.js';
import { MicTest, useMicPermission, type MicPermission } from './MicTest.js';
import { Callout, Row, SettingsGroup, Switch } from './ui.js';

const SPEECH: Record<VoicePrefs['transcription'], string> = {
  xai: 'xAI Grok',
  openai: 'OpenAI',
};
const CLEANUP: Record<VoicePrefs['correction'], string> = {
  anthropic: 'Claude',
  openai: 'OpenAI',
  off: 'Off',
};
const DISCLOSE_SPEECH: Record<VoicePrefs['transcription'], string> = {
  xai: 'xAI (Grok)',
  openai: 'OpenAI',
};

const MIC_STATUS: Record<MicPermission, [string, string | undefined]> = {
  granted: ['Allowed', undefined],
  prompt: ['Not asked yet', 'Your browser asks the first time you dictate or test'],
  denied: ['Blocked', 'Allow the microphone for this site in your browser’s settings'],
  unavailable: ['Not available', 'This browser can’t use a microphone'],
  unknown: ['Not known', 'Your browser says when you first dictate or test'],
};

/** Speech and cleanup providers this relay actually has keys for. Never offer one that would fail. */
export function voiceOptions(info: {
  voice: { xai: boolean; openai: boolean; anthropic: boolean };
}) {
  const speech = (['xai', 'openai'] as const).filter((p) => info.voice[p]);
  const cleanup = [
    ...(['anthropic', 'openai'] as const).filter((p) => info.voice[p]),
    'off' as const,
  ];
  return { speech, cleanup };
}

/** The index summary: "On · Cleanup on". */
export function dictationSummary(
  v: VoicePrefs,
  info: { voice: { xai: boolean; openai: boolean } } | null,
): string {
  if (!info) return '';
  if (!info.voice.xai && !info.voice.openai) return 'Not set up';
  if (!v.consent) return 'Off';
  return `On · Cleanup ${v.correction === 'off' ? 'off' : 'on'}`;
}

function Seg<T extends string>({
  value,
  options,
  labels,
  onChange,
  labelledBy,
}: {
  value: T;
  options: readonly T[];
  labels: Record<T, string>;
  onChange: (v: T) => void;
  labelledBy: string;
}) {
  return (
    <div className="seg s-seg" role="radiogroup" aria-labelledby={labelledBy}>
      {options.map((o) => (
        <button
          key={o}
          type="button"
          role="radio"
          aria-checked={value === o}
          tabIndex={value === o ? 0 : -1}
          onClick={() => onChange(o)}
          onKeyDown={(e) => {
            const i = options.indexOf(value);
            const step =
              e.key === 'ArrowRight' || e.key === 'ArrowDown'
                ? 1
                : e.key === 'ArrowLeft' || e.key === 'ArrowUp'
                  ? -1
                  : 0;
            if (!step) return;
            e.preventDefault();
            const next = options[(i + step + options.length) % options.length]!;
            onChange(next);
            (
              e.currentTarget.parentElement?.children[options.indexOf(next)] as HTMLElement
            )?.focus();
          }}
        >
          {labels[o]}
        </button>
      ))}
    </div>
  );
}

export function DictationSection() {
  const { prefs, info, online } = useApp();
  const v = prefs.voice;
  const [disclose, setDisclose] = useState(false);
  const mic = useMicPermission();
  const id = useId();
  const set = (p: Partial<VoicePrefs>) => void app.setPrefs({ voice: { ...v, ...p } });
  const opts = info ? voiceOptions(info) : null;
  const configured = !!opts && opts.speech.length > 0;
  // A stored choice the relay no longer offers reads as the one that will actually be used.
  const speech = opts?.speech.includes(v.transcription) ? v.transcription : opts?.speech[0];
  const cleanup = opts?.cleanup.includes(v.correction) ? v.correction : 'off';

  return (
    <>
      <p className="s-lead">Dictation turns speech into answer text. It never sends an answer.</p>
      {!info && !online && (
        <Callout tone="info">Dictation settings need a connection to your relay.</Callout>
      )}
      {info && !configured && (
        <Callout tone="info" title="Dictation isn’t set up for this relay">
          It needs an xAI or OpenAI key on your relay (an Anthropic key is optional, for tidying
          wording). Typing always works.
        </Callout>
      )}
      {configured && (
        <SettingsGroup>
          <Row
            label="Dictation"
            labelId={`${id}-c`}
            description={
              <>
                Audio goes through your relay to {SPEECH[speech!]}. It is not end-to-end encrypted.{' '}
                <button type="button" className="link-btn inline" onClick={() => setDisclose(true)}>
                  What happens to it
                </button>
              </>
            }
            descriptionId={`${id}-cd`}
            control={
              <Switch
                checked={v.consent}
                labelledBy={`${id}-c`}
                describedBy={`${id}-cd`}
                // Turning it on only opens the disclosure; consent is recorded by its button. Nothing records here.
                onChange={(on) => (on ? setDisclose(true) : set({ consent: false }))}
              />
            }
          />
          {v.consent && (
            <>
              <Row
                label="Speech to text"
                labelId={`${id}-s`}
                description={
                  opts!.speech.length > 1 ? undefined : 'The only provider set up on your relay'
                }
                control={
                  opts!.speech.length > 1 ? (
                    <Seg
                      value={speech!}
                      options={opts!.speech}
                      labels={SPEECH}
                      labelledBy={`${id}-s`}
                      onChange={(t) => set({ transcription: t })}
                    />
                  ) : (
                    <span className="s-value">{SPEECH[speech!]}</span>
                  )
                }
              />
              <Row
                label="Tidy wording"
                labelId={`${id}-t`}
                description={
                  cleanup === 'off'
                    ? 'Off: you get exactly what was heard'
                    : `After you stop, ${CLEANUP[cleanup]} fixes punctuation and misheard words. “Use original wording” undoes it.`
                }
                control={
                  <Seg
                    value={cleanup}
                    options={opts!.cleanup}
                    labels={CLEANUP}
                    labelledBy={`${id}-t`}
                    onChange={(c) => set({ correction: c })}
                  />
                }
              />
            </>
          )}
        </SettingsGroup>
      )}
      <SettingsGroup label="Microphone">
        <Row
          label="Access"
          description={MIC_STATUS[mic][1]}
          control={<span className="s-value">{MIC_STATUS[mic][0]}</span>}
        />
        <div className="s-row stacked">
          <MicTest />
        </div>
      </SettingsGroup>
      <VoiceDisclosure
        open={disclose}
        provider={DISCLOSE_SPEECH[speech ?? 'xai']}
        correction={
          cleanup === 'anthropic' ? 'Anthropic (Claude)' : cleanup === 'openai' ? 'OpenAI' : null
        }
        onClose={() => setDisclose(false)}
        onAccept={
          v.consent
            ? undefined
            : () => {
                setDisclose(false);
                set({ consent: true });
              }
        }
      />
    </>
  );
}
