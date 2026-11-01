import { describe, expect, it, vi } from 'vitest';
import { VoiceClient, type VoiceState } from '../src/features/voice/client.js';
import type { WebSocketLike } from '../src/data/sync.js';

class FakeWS implements WebSocketLike {
  readyState = 1;
  sent: (string | ArrayBuffer)[] = [];
  closed = false;
  onopen: WebSocketLike['onopen'] = null;
  onmessage: WebSocketLike['onmessage'] = null;
  onclose: WebSocketLike['onclose'] = null;
  onerror: WebSocketLike['onerror'] = null;
  constructor(readonly url: string) {}
  send(d: string | ArrayBuffer) {
    this.sent.push(d);
  }
  close() {
    this.closed = true;
  }
  say(m: unknown) {
    this.onmessage?.({ data: JSON.stringify(m) });
  }
  texts() {
    return this.sent.filter((x): x is string => typeof x === 'string').map((x) => JSON.parse(x));
  }
}

function make(over: { doneTimeoutMs?: number } = {}) {
  const sockets: FakeWS[] = [];
  const states: VoiceState[] = [];
  const texts: { final: string; interim: string }[] = [];
  const errors: string[] = [];
  const posted: { path: string; body: Record<string, unknown> }[] = [];
  const c = new VoiceClient({
    origin: 'https://relay.example',
    provider: 'xai',
    keyterms: ['sidebar'],
    language: 'en',
    postJson: (async (path: string, body: Record<string, unknown>) => {
      posted.push({ path, body });
      return {
        ticket: 'VOICETICKET',
        ws_path: '/api/v1/voice/ws',
        provider: 'xai',
        sample_rate: 16000,
        max_session_ms: 300000,
        expires_at: new Date().toISOString(),
      };
    }) as never,
    wsFactory: (url) => {
      const s = new FakeWS(url);
      sockets.push(s);
      return s;
    },
    onState: (s) => states.push(s),
    onText: (t) => texts.push(t),
    onError: (m) => errors.push(m),
    ...over,
  });
  return { c, sockets, states, texts, errors, posted };
}

const frame = () => new ArrayBuffer(3200);

describe('voice protocol client', () => {
  it('requests a consented session with keyterms, then waits for transcript.created', async () => {
    const t = make();
    await t.c.start();
    expect(t.posted[0]).toMatchObject({
      path: '/voice/session',
      body: {
        provider: 'xai',
        consent: true,
        keyterms: ['sidebar'],
        language: 'en',
        protocol_version: 1,
      },
    });
    expect(t.sockets[0]!.url).toBe('wss://relay.example/api/v1/voice/ws?ticket=VOICETICKET');
    expect(t.c.state).toBe('connecting');
    t.sockets[0]!.say({ type: 'transcript.created' });
    expect(t.c.state).toBe('ready');
  });

  it('drops audio offered before the provider is ready and streams after', async () => {
    const t = make();
    await t.c.start();
    const ws = t.sockets[0]!;
    t.c.sendAudio(frame());
    expect(t.c.droppedFrames).toBe(1);
    expect(ws.sent).toHaveLength(0);
    ws.say({ type: 'transcript.created' });
    t.c.sendAudio(frame());
    t.c.sendAudio(frame());
    expect(ws.sent).toHaveLength(2);
    expect(t.c.state).toBe('streaming');
  });

  it('accumulates final chunks, shows interim text, and ignores a repeated final', async () => {
    const t = make();
    await t.c.start();
    const ws = t.sockets[0]!;
    ws.say({ type: 'transcript.created' });
    ws.say({ type: 'transcript.partial', text: 'keep the', is_final: false });
    expect(t.texts.at(-1)).toEqual({ final: '', interim: 'keep the' });
    ws.say({ type: 'transcript.partial', text: 'keep the side bar', is_final: true });
    ws.say({ type: 'transcript.partial', text: 'keep the side bar', is_final: true });
    ws.say({ type: 'transcript.partial', text: 'but make it', is_final: false });
    expect(t.texts.at(-1)).toEqual({ final: 'keep the side bar', interim: 'but make it' });
    expect(t.c.rawText()).toBe('keep the side bar but make it');
  });

  it('stop sends audio.done and resolves with the provider’s final text', async () => {
    const t = make();
    await t.c.start();
    const ws = t.sockets[0]!;
    ws.say({ type: 'transcript.created' });
    t.c.sendAudio(frame());
    ws.say({ type: 'transcript.partial', text: 'keep it', is_final: true });
    const p = t.c.stop();
    expect(t.c.state).toBe('finalizing');
    expect(ws.texts()).toContainEqual({ type: 'audio.done' });
    ws.say({ type: 'transcript.done', text: 'Keep it compact.' });
    await expect(p).resolves.toBe('Keep it compact.');
    expect(t.c.state).toBe('done');
    expect(ws.closed).toBe(true);
  });

  it('stop falls back to what it collected if the provider never says done', async () => {
    const t = make({ doneTimeoutMs: 20 });
    await t.c.start();
    const ws = t.sockets[0]!;
    ws.say({ type: 'transcript.created' });
    t.c.sendAudio(frame());
    ws.say({ type: 'transcript.partial', text: 'partial words', is_final: false });
    await expect(t.c.stop()).resolves.toBe('partial words');
  });

  it('a provider error keeps whatever was transcribed and never throws away the user’s words', async () => {
    const t = make();
    await t.c.start();
    const ws = t.sockets[0]!;
    ws.say({ type: 'transcript.created' });
    t.c.sendAudio(frame());
    ws.say({ type: 'transcript.partial', text: 'half a thought', is_final: true });
    ws.say({ type: 'error', message: 'provider_error' });
    expect(t.c.state).toBe('error');
    expect(t.errors).toEqual(['provider_error']);
    await expect(t.c.stop()).resolves.toBe('half a thought');
  });

  it('an unexpected disconnect while streaming is an error, not a silent stop', async () => {
    const t = make();
    await t.c.start();
    const ws = t.sockets[0]!;
    ws.say({ type: 'transcript.created' });
    t.c.sendAudio(frame());
    ws.onclose?.({});
    expect(t.c.state).toBe('error');
    expect(t.errors[0]).toMatch(/stopped unexpectedly/);
  });

  it('push-to-talk release sends finalize without ending the session', async () => {
    const t = make();
    await t.c.start();
    const ws = t.sockets[0]!;
    ws.say({ type: 'transcript.created' });
    t.c.finalize();
    expect(ws.texts()).toContainEqual({ type: 'finalize' });
    expect(t.c.state).toBe('ready');
  });

  it('ignores garbage frames and cancel closes the socket', async () => {
    const t = make();
    await t.c.start();
    const ws = t.sockets[0]!;
    ws.onmessage?.({ data: 'not json' });
    ws.onmessage?.({ data: new ArrayBuffer(4) });
    ws.say({ type: 'something.else' });
    t.c.cancel();
    expect(ws.closed).toBe(true);
    expect(t.c.state).toBe('idle');
    vi.useRealTimers();
  });
});
