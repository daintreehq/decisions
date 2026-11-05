import { useId, useState } from 'react';
import { app } from '../../app/controller.js';
import { useApp } from '../../app/hooks.js';
import type { VoicePrefs } from '../../app/prefs.js';
import { VoiceDisclosure } from '../VoiceDisclosure.js';
import { MicTest } from './MicTest.js';
import { useMicPermission, type MicPermission } from '../../features/voice/permission.js';
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
  granted: ['Allowed now', 'Your browser controls how long this permission lasts'],
  prompt: [
    'Asks when needed',
    'Your browser asks when you test or first dictate. To be asked less, allow the microphone for this site in your browser’s settings.',
  ],
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

/** The index summary: "On · Tidying", where tidying only counts if the relay has a key for it. */
export function dictationSummary(
  v: VoicePrefs,
  info: { voice: { xai: boolean; openai: boolean; anthropic?: boolean } } | null,
): string {
  if (!info) return '';
  if (!info.voice.xai && !info.voice.openai) return 'Not set up';
  if (!v.consent) return 'Off';
  const cleanup = v.correction !== 'off' && !!info.voice[v.correction];
  return cleanup ? 'On · Tidying' : 'On';
}

function Seg<T extends string>({
  value,
  options,
  labels,
  onChange,
  labelledBy,
  describedBy,
}: {
  value: T;
  options: readonly T[];
  labels: Record<T, string>;
  onChange: (v: T) => void;
  labelledBy: string;
  describedBy?: string;
}) {
  return (
    <div
      className="seg s-seg"
      role="radiogroup"
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
    >
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
      <p className="s-lead">
        Dictation turns speech into answer text and never sends an answer. Changes apply straight
        away, on this device only.
      </p>
      {!info && !online && (
        <Callout tone="info">Dictation settings need a connection to your relay.</Callout>
      )}
      {info && !configured && (
        <Callout tone="info" title="Dictation isn’t set up on your relay">
          On your computer, run <span className="mono">decisions deploy</span> again and add an xAI
          or OpenAI key when it asks (an Anthropic key is optional, for tidying wording). Typing
          always works.
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
                stacked={opts!.speech.length > 1}
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
                descriptionId={`${id}-td`}
                stacked={opts!.cleanup.length > 1}
                description={
                  opts!.cleanup.length === 1
                    ? 'Your relay has no key for it, so you get exactly what was heard'
                    : cleanup === 'off'
                      ? 'You get exactly what was heard'
                      : `After you stop, ${CLEANUP[cleanup]} fixes punctuation and misheard words. “Use original wording” undoes it.`
                }
                control={
                  opts!.cleanup.length === 1 ? (
                    <span className="s-value">Off</span>
                  ) : (
                    <Seg
                      value={cleanup}
                      options={opts!.cleanup}
                      labels={CLEANUP}
                      labelledBy={`${id}-t`}
                      describedBy={`${id}-td`}
                      onChange={(c) => set({ correction: c })}
                    />
                  )
                }
              />
            </>
          )}
        </SettingsGroup>
      )}
      <SettingsGroup
        label="Microphone"
        footer="Home Screen apps on iPhone and iPad may ask again after reopening: the browser keeps that permission, not Decisions."
      >
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
