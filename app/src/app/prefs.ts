export type Theme = 'system' | 'light' | 'dark';

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
  if (theme === 'system') r.removeAttribute('data-theme');
  else r.setAttribute('data-theme', theme);
}
