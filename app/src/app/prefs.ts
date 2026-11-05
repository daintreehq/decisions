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
}

export interface LocalPrefs {
  theme: Theme;
  voice: VoicePrefs;
  dismissedInstall: boolean;
}

export const DEFAULT_PREFS: LocalPrefs = {
  theme: 'system',
  voice: { consent: false, transcription: 'xai', correction: 'anthropic' },
  dismissedInstall: false,
};

/** Match browser/system chrome to the actual panel surface while a modal covers the canvas. */
export function syncThemeColor(theme: Theme, panel = false): void {
  const metas = document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]');
  const color = panel
    ? getComputedStyle(document.documentElement).getPropertyValue('--surface-chrome').trim()
    : '';
  metas.forEach((meta) => {
    meta.content =
      color ||
      (theme === 'system'
        ? meta.media.includes('light')
          ? CHROME.bondi
          : CHROME.daintree
        : CHROME[THEME_IDS[theme]]);
  });
}

export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', THEME_IDS[theme]);
  syncThemeColor(theme);
}
