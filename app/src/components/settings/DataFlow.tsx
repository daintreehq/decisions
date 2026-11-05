import type { ReactNode } from 'react';
import { BellIcon, LaptopIcon, LockIcon, MicIcon, PhoneIcon } from '../Icons.js';

/** Each party, what it can see in a few words (the verdict), then the detail behind it. */
const FLOW: { icon: ReactNode; who: string; verdict: string; sees: ReactNode }[] = [
  {
    icon: <PhoneIcon size={20} />,
    who: 'Your devices and your computer',
    verdict: 'Everything',
    sees: 'Questions, context, screenshots and answers. Only they hold the keys.',
  },
  {
    icon: <LockIcon size={20} />,
    who: 'Your relay, in your Cloudflare account',
    verdict: 'Can’t read your questions or answers',
    sees: (
      <>
        They reach it <strong>end-to-end encrypted</strong>, images too. It does see routing
        details: when things happen, their size, expiry times and your device names. Dictation is
        the one exception, below.
      </>
    ),
  },
  {
    icon: <BellIcon size={20} />,
    who: 'Push services (Apple, Google, Mozilla)',
    verdict: 'Only that a notification went out',
    sees: 'Never the question, project or any agent text.',
  },
  {
    icon: <MicIcon size={20} />,
    who: 'Dictation providers',
    verdict: 'Your audio, its transcript and the question, if you turn dictation on',
    sees: (
      <>
        Your audio goes through your relay to the speech provider. If wording is tidied, the
        transcript and the question also go to the tidying provider. This is <strong>not</strong>{' '}
        end-to-end encrypted.
      </>
    ),
  },
  {
    icon: <LaptopIcon size={20} />,
    who: 'Daintree, the project',
    verdict: 'Nothing',
    sees: 'There is no Daintree server in this system.',
  },
];

/** Who sees what, in plain words. The one place "end-to-end encrypted" is claimed. */
export function DataFlow() {
  return (
    <ul className="s-flow">
      {FLOW.map((f) => (
        <li key={f.who} className="s-row">
          <span className="s-row-icon">{f.icon}</span>
          <span className="s-row-text">
            <span className="s-row-label">{f.who}</span>
            <span className="s-flow-verdict">{f.verdict}</span>
            <span className="s-row-desc">{f.sees}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/** What the design can't protect against. Plain rows: the actor list above is the only one with glyphs. */
export function PrivacyLimits() {
  return (
    <ul className="s-flow">
      <li className="s-row">
        <span className="s-row-text">
          <span className="s-row-label">The app comes from your relay</span>
          <span className="s-row-desc">
            If the code your relay serves were replaced, a web app couldn’t protect you. Keep your
            Cloudflare account secure.
          </span>
        </span>
      </li>
      <li className="s-row">
        <span className="s-row-text">
          <span className="s-row-label">Revoking can’t reach back</span>
          <span className="s-row-desc">
            A revoked device gets nothing new, but it keeps what it already saved.
          </span>
        </span>
      </li>
      <li className="s-row">
        <span className="s-row-text">
          <span className="s-row-label">Lose every key, lose the history</span>
          <span className="s-row-desc">
            If every device holding your keys is lost and you have no recovery kit, the encrypted
            history can’t be recovered by anyone.
          </span>
        </span>
      </li>
    </ul>
  );
}
