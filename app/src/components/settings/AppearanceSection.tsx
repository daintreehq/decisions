import { useEffect, useState } from 'react';
import { app } from '../../app/controller.js';
import { useApp } from '../../app/hooks.js';
import type { Theme } from '../../app/prefs.js';
import { CheckIcon } from '../Icons.js';
import { Row, SettingsGroup } from './ui.js';

const THEMES: { value: Theme; name: string; detail: string }[] = [
  { value: 'system', name: 'Match device', detail: '' },
  { value: 'light', name: 'Bondi', detail: 'Light' },
  { value: 'dark', name: 'Daintree', detail: 'Dark' },
];

export const THEME_LABEL: Record<Theme, string> = {
  system: 'Match device',
  light: 'Bondi',
  dark: 'Daintree',
};

function useMedia(query: string): boolean {
  const [on, setOn] = useState(() => globalThis.matchMedia?.(query).matches ?? false);
  useEffect(() => {
    const m = globalThis.matchMedia?.(query);
    if (!m) return;
    const f = () => setOn(m.matches);
    f();
    m.addEventListener('change', f);
    return () => m.removeEventListener('change', f);
  }, [query]);
  return on;
}

/** The theme's own hero art, as Daintree's theme picker shows it. Match device is the two, split. */
function Preview({ value }: { value: Theme }) {
  if (value === 'system') {
    return (
      <span className="theme-art split" aria-hidden="true">
        <img src="/themes/bondi.webp" alt="" decoding="async" />
        <img src="/themes/daintree.webp" alt="" decoding="async" />
      </span>
    );
  }
  return (
    <span className="theme-art" aria-hidden="true">
      <img
        src={value === 'light' ? '/themes/bondi.webp' : '/themes/daintree.webp'}
        alt=""
        decoding="async"
      />
    </span>
  );
}

export function AppearanceSection() {
  const { prefs } = useApp();
  const reduced = useMedia('(prefers-reduced-motion: reduce)');
  const dark = useMedia('(prefers-color-scheme: dark)');
  return (
    <>
      <p className="s-lead">Changes apply straight away, on this device only.</p>
      <section className="s-group-wrap" aria-labelledby="theme-h">
        <h2 className="s-group-label" id="theme-h">
          Theme
        </h2>
        <div className="theme-grid" role="radiogroup" aria-labelledby="theme-h">
          {THEMES.map((t) => {
            const on = prefs.theme === t.value;
            return (
              <label key={t.value} className={`theme-card${on ? ' on' : ''}`}>
                <input
                  type="radio"
                  name="theme"
                  className="sr-only"
                  value={t.value}
                  checked={on}
                  onChange={() => void app.setPrefs({ theme: t.value })}
                />
                <span className="theme-art-wrap">
                  <Preview value={t.value} />
                  {on && (
                    <span className="theme-check" aria-hidden="true">
                      <CheckIcon size={13} />
                    </span>
                  )}
                </span>
                <span className="theme-name">{t.name}</span>
                <span className="theme-detail">
                  {t.value === 'system' ? `Now ${dark ? 'Daintree' : 'Bondi'}` : t.detail}
                </span>
              </label>
            );
          })}
        </div>
      </section>
      <SettingsGroup label="Motion">
        <Row
          label="Reduced motion"
          description="Follows your device’s accessibility setting. Slides and pulses are removed when it is on."
          control={<span className="s-value">{reduced ? 'On' : 'Off'}</span>}
        />
      </SettingsGroup>
    </>
  );
}
