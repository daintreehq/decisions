/** Stored as before; `light` is Daintree's Bondi theme and `dark` is the Daintree theme. */
export type Theme = 'system' | 'light' | 'dark';

export const THEME_IDS = { light: 'bondi', dark: 'daintree' } as const;
/** Each theme's chrome colour (its sidebar surface), for the browser and installed-app title bar. */
const CHROME = { bondi: '#f2e9da', daintree: '#151211' } as const;

export interface VoicePrefs {
  /** Explicit, revocable opt-in. Off by default; nothing is sent to a voice provider without it. */
  consent: boolean;
  transcription: 'xai' | 'openai';
  correction: 'anthropic' | 'openai' | 'off';
  mode: 'tap' | 'hold';
}

export interface LocalPrefs {
  theme: Theme;
  voice: VoicePrefs;
  dismissedInstall: boolean;
}

export const DEFAULT_PREFS: LocalPrefs = {
  theme: 'system',
  voice: { consent: false, transcription: 'xai', correction: 'anthropic', mode: 'tap' },
  dismissedInstall: false,
};

export function applyTheme(theme: Theme): void {
  const r = document.documentElement;
  const metas = document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]');
  if (theme === 'system') {
    r.removeAttribute('data-theme');
    metas.forEach((m) => {
      const light = m.media.includes('light');
      m.content = light ? CHROME.bondi : CHROME.daintree;
    });
    return;
  }
  const id = THEME_IDS[theme];
  r.setAttribute('data-theme', id);
  metas.forEach((m) => (m.content = CHROME[id]));
}
