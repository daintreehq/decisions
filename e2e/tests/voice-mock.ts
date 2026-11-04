import type { BrowserContext, Page } from 'playwright-core';

/**
 * A stand-in for the relay's dictation provider, for driving the PWA's voice input in Chromium without a speech
 * service. The app itself is untouched: the relay's info reports xAI as set up, `/voice/session` returns a ticket, and
 * the voice WebSocket speaks the relay's normalised dictation protocol (docs/protocol.md section 13) from a script.
 * Chromium's fake capture device supplies the microphone, so the real capture path (levels, frames) still runs.
 */
export interface VoiceScript {
  /** How long the provider takes to say it is ready (`transcript.created`), in ms. */
  readyAfterMs?: number;
  /** Words to emit after ready, in order: `final` chunks lock into the draft, others are interim. */
  words: { afterMs: number; text: string; final: boolean }[];
}

/** Launch flags for a Chromium whose microphone is the fake device (a steady tone). */
export const FAKE_MIC_ARGS = [
  '--use-fake-ui-for-media-stream',
  '--use-fake-device-for-media-stream',
];

export async function mockVoice(
  context: BrowserContext,
  page: Page,
  script: () => VoiceScript,
): Promise<void> {
  await context.grantPermissions(['microphone']);
  await page.route('**/api/v1/info', async (route) => {
    const res = await route.fetch();
    const body = (await res.json()) as { voice?: Record<string, boolean> };
    body.voice = { ...(body.voice ?? {}), xai: true };
    await route.fulfill({ response: res, json: body });
  });
  await page.route('**/voice/session', (route) =>
    route.fulfill({
      json: {
        ticket: 'ZTJlLXZvaWNlLXRpY2tldA',
        ws_path: '/api/v1/voice/stream',
        provider: 'xai',
        sample_rate: 16000,
        max_session_ms: 300_000,
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      },
    }),
  );
  await page.routeWebSocket(/\/voice\/stream/, (ws) => {
    const s = script();
    const timers: ReturnType<typeof setTimeout>[] = [];
    const said: string[] = [];
    let pending = '';
    const send = (m: Record<string, unknown>) => {
      try {
        ws.send(JSON.stringify(m));
      } catch {
        /* closed */
      }
    };
    timers.push(
      setTimeout(() => {
        send({ type: 'transcript.created' });
        for (const w of s.words)
          timers.push(
            setTimeout(() => {
              if (w.final) said.push(w.text);
              pending = w.final ? '' : w.text;
              send({ type: 'transcript.partial', text: w.text, is_final: w.final });
            }, w.afterMs),
          );
      }, s.readyAfterMs ?? 150),
    );
    ws.onMessage((m) => {
      if (typeof m !== 'string') return; // audio frames
      let msg: { type?: string };
      try {
        msg = JSON.parse(m);
      } catch {
        return;
      }
      if (msg.type === 'audio.done') {
        timers.forEach(clearTimeout);
        // The provider locks whatever it was still recognising when the audio ends.
        if (pending) {
          said.push(pending);
          send({ type: 'transcript.partial', text: pending, is_final: true });
          pending = '';
        }
        send({ type: 'transcript.done', text: said.join(' ') });
      }
    });
    ws.onClose(() => timers.forEach(clearTimeout));
  });
}
