import type { ReactNode } from 'react';
import { BellIcon, LaptopIcon, LockIcon, MicIcon, PhoneIcon, ShieldIcon } from '../Icons.js';

const FLOW: { icon: ReactNode; who: string; sees: ReactNode }[] = [
  {
    icon: <PhoneIcon size={20} />,
    who: 'Your devices and your computer',
    sees: 'Everything: questions, context, screenshots and answers. Only they hold the keys.',
  },
  {
    icon: <LockIcon size={20} />,
    who: 'Your relay, in your Cloudflare account',
    sees: (
      <>
        Questions, answers and images <strong>end-to-end encrypted</strong>, so it can’t read them.
        It does see routing details: when things happen, their size, expiry times and your device
        names.
      </>
    ),
  },
  {
    icon: <BellIcon size={20} />,
    who: 'Push services (Apple, Google, Mozilla)',
    sees: 'That a notification went to this device. Never the question, project or any agent text.',
  },
  {
    icon: <MicIcon size={20} />,
    who: 'Dictation providers, only if you turn dictation on',
    sees: (
      <>
        The audio you dictate, its transcript, and the question (for tidying wording), through your
        relay. This is <strong>not</strong> end-to-end encrypted.
      </>
    ),
  },
  {
    icon: <LaptopIcon size={20} />,
    who: 'Daintree, the project',
    sees: 'Nothing. There is no Daintree server in this system.',
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
            <span className="s-row-desc">{f.sees}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

export function PrivacyLimits() {
  return (
    <ul className="s-flow">
      <li className="s-row">
        <span className="s-row-icon">
          <ShieldIcon size={20} />
        </span>
        <span className="s-row-text">
          <span className="s-row-label">The app comes from your relay</span>
          <span className="s-row-desc">
            If the code your relay serves were replaced, a web app couldn’t protect you. Keep your
            Cloudflare account secure.
          </span>
        </span>
      </li>
      <li className="s-row">
        <span className="s-row-icon">
          <PhoneIcon size={20} />
        </span>
        <span className="s-row-text">
          <span className="s-row-label">Revoking can’t reach back</span>
          <span className="s-row-desc">
            A revoked device gets nothing new, but it keeps what it already saved.
          </span>
        </span>
      </li>
      <li className="s-row">
        <span className="s-row-icon">
          <LockIcon size={20} />
        </span>
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
