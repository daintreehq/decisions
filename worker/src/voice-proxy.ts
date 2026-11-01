import { LIMITS } from '@daintree/decisions-protocol';
import type { DecisionRoom } from './decision-room.js';
import type { Env } from './env.js';

/**
 * Transient dictation proxy. The browser never holds a provider key: it opens this socket with a
 * one-use ticket and the Worker relays PCM16 audio to the provider and normalised transcript events back.
 * Nothing is stored or logged. This path is NOT end-to-end encrypted (see docs/voice-privacy.md).
 */

type Stub = DurableObjectStub<DecisionRoom>;
const MAX_AUDIO_BYTES = (LIMITS.voiceMaxSessionMs / 1000) * 16000 * 2 + 64_000;
/** 16 kHz mono PCM16 = 32 bytes per millisecond. */
const BYTES_PER_MS = 32;
const MAX_PREBUFFERED_FRAMES = 64;

interface TicketPayload {
  session_id: string;
  provider: 'xai' | 'openai';
  keyterms: string[];
  language: string | null;
}

interface Bridge {
  control(type: 'finalize' | 'audio.done'): void;
  audio(buf: ArrayBuffer): void;
  upstream(data: string): void;
}

export async function handleVoiceSocket(request: Request, env: Env, stub: Stub): Promise<Response> {
  if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
    return new Response('expected websocket', { status: 426 });
  }
  const ticket = new URL(request.url).searchParams.get('ticket') ?? '';
  const t = await stub.consumeVoiceTicket(ticket);
  if (!t) return new Response('invalid ticket', { status: 401 });
  const p: TicketPayload = t.payload;

  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
  server.accept();

  const started = Date.now();
  let audioBytes = 0;
  let ended = false;
  let upstream: WebSocket | null = null;
  let bridge: Bridge | null = null;
  const prebuffer: (string | ArrayBuffer)[] = [];

  // Usage is the larger of connection time and accepted audio, so bursting audio faster than real time
  // cannot dodge the monthly budget.
  const end = (code: number, reason: string) => {
    if (ended) return;
    ended = true;
    clearTimeout(timer);
    for (const s of [server, upstream]) {
      try {
        s?.close(code, reason);
      } catch {
        /* already closed */
      }
    }
    void stub.voiceEnded(
      p.session_id,
      Math.max(Date.now() - started, Math.floor(audioBytes / BYTES_PER_MS)),
    );
  };

  // The deadline and the client lifecycle are armed before the provider connection is attempted.
  const timer = setTimeout(() => end(1000, 'session limit reached'), LIMITS.voiceMaxSessionMs);
  server.addEventListener('close', () => end(1000, 'closed'));
  server.addEventListener('error', () => end(1011, 'error'));

  const handle = (data: string | ArrayBuffer) => {
    if (!bridge) return;
    if (typeof data === 'string') {
      if (data.length > 256) return;
      try {
        const m = JSON.parse(data) as { type?: string };
        if (m.type === 'finalize' || m.type === 'audio.done') bridge.control(m.type);
      } catch {
        /* ignore malformed control frames */
      }
      return;
    }
    audioBytes += data.byteLength;
    if (data.byteLength > 64 * 1024 || audioBytes > MAX_AUDIO_BYTES)
      return end(1009, 'audio limit exceeded');
    bridge.audio(data);
  };

  server.addEventListener('message', (ev) => {
    if (ended) return;
    if (!bridge) {
      // The provider is still connecting; hold a few frames rather than dropping the first words.
      if (prebuffer.length < MAX_PREBUFFERED_FRAMES)
        prebuffer.push(ev.data as string | ArrayBuffer);
      return;
    }
    handle(ev.data as string | ArrayBuffer);
  });

  void (async () => {
    try {
      const up = p.provider === 'xai' ? await connectXai(env, p) : await connectOpenAI(env);
      if (!up) return end(1011, 'provider unavailable');
      if (ended) {
        // The client left (or the deadline fired) while we were connecting: do not leave a session open upstream.
        try {
          up.close(1000, 'client gone');
        } catch {
          /* ignore */
        }
        return;
      }
      upstream = up;
      bridge = p.provider === 'xai' ? xaiBridge(server, up) : openaiBridge(server, up, p);
      const b = bridge;
      up.addEventListener('message', (ev) => {
        if (typeof ev.data === 'string') b.upstream(ev.data);
      });
      up.addEventListener('close', () => end(1000, 'closed'));
      up.addEventListener('error', () => end(1011, 'provider error'));
      for (const frame of prebuffer.splice(0)) handle(frame);
    } catch {
      end(1011, 'provider unavailable');
    }
  })();

  return new Response(null, { status: 101, webSocket: client });
}

function send(ws: WebSocket, o: unknown): void {
  try {
    ws.send(JSON.stringify(o));
  } catch {
    /* closed */
  }
}

/* ---------------- xAI: pass-through with scrubbed errors ---------------- */

async function connectXai(env: Env, p: TicketPayload): Promise<WebSocket | null> {
  if (!env.XAI_API_KEY) return null;
  const u = new URL('https://api.x.ai/v1/stt');
  u.searchParams.set('sample_rate', '16000');
  u.searchParams.set('encoding', 'pcm');
  u.searchParams.set('interim_results', 'true');
  if (p.language) {
    u.searchParams.set('language', p.language);
    u.searchParams.set('format', 'true');
  }
  for (const k of p.keyterms.slice(0, 100)) u.searchParams.append('keyterm', k.slice(0, 50));
  const res = await fetch(u.toString(), {
    headers: { Upgrade: 'websocket', Authorization: `Bearer ${env.XAI_API_KEY}` },
  });
  const ws = res.webSocket;
  if (!ws) return null;
  ws.accept();
  return ws;
}

function xaiBridge(client: WebSocket, up: WebSocket): Bridge {
  return {
    control: (type) => send(up, { type }),
    audio: (buf) => up.send(buf),
    upstream: (data) => {
      let m: { type?: string; text?: string; is_final?: boolean; speech_final?: boolean };
      try {
        m = JSON.parse(data);
      } catch {
        return;
      }
      if (m.type === 'transcript.created') send(client, { type: 'transcript.created' });
      else if (m.type === 'transcript.partial') {
        send(client, {
          type: 'transcript.partial',
          text: String(m.text ?? ''),
          is_final: Boolean(m.is_final),
          speech_final: Boolean(m.speech_final),
        });
      } else if (m.type === 'transcript.done') {
        send(client, { type: 'transcript.done', text: String(m.text ?? '') });
      } else if (m.type === 'error') send(client, { type: 'error', message: 'provider_error' });
    },
  };
}

/* ---------------- OpenAI realtime transcription (preview) ---------------- */

async function connectOpenAI(env: Env): Promise<WebSocket | null> {
  if (!env.OPENAI_API_KEY) return null;
  const res = await fetch('https://api.openai.com/v1/realtime?intent=transcription', {
    headers: { Upgrade: 'websocket', Authorization: `Bearer ${env.OPENAI_API_KEY}` },
  });
  const ws = res.webSocket;
  if (!ws) return null;
  ws.accept();
  return ws;
}

/** PCM16 LE 16 kHz to 24 kHz by linear interpolation (3 output samples per 2 input samples). */
export function resample16kTo24k(input: Int16Array): Int16Array {
  const outLen = Math.floor((input.length * 3) / 2);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = (i * 2) / 3;
    const i0 = Math.floor(pos);
    const frac = pos - i0;
    const a = input[i0] ?? 0;
    const b = input[Math.min(i0 + 1, input.length - 1)] ?? a;
    out[i] = Math.round(a + (b - a) * frac);
  }
  return out;
}

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/**
 * Normalises OpenAI's per-item events to the xAI-shaped stream the client expects: `partial` chunks carry only the
 * text of the turn in progress, each finished turn is emitted once and strictly in audio order (OpenAI does not
 * guarantee completion order), and `done` carries the whole ordered transcript.
 */
export function openaiBridge(
  client: WebSocket,
  up: WebSocket,
  p: Pick<TicketPayload, 'keyterms' | 'language'>,
): Bridge {
  const order: string[] = [];
  const live = new Map<string, string>();
  const finals = new Map<string, string>();
  let released = 0;
  let full = '';
  let pendingSamples = 0;
  let awaitingCommit = 0;
  let finishing = false;
  let doneSent = false;

  const transcription: Record<string, unknown> = { model: 'gpt-live-transcribe' };
  if (p.keyterms.length) {
    transcription.keywords = p.keyterms
      .map((k) => k.replace(/[<>\r\n]/g, ' ').trim())
      .filter(Boolean)
      .slice(0, 50);
  }
  if (p.language) transcription.languages = [p.language];
  send(up, {
    type: 'session.update',
    session: {
      type: 'transcription',
      audio: {
        input: { format: { type: 'audio/pcm', rate: 24000 }, transcription, turn_detection: null },
      },
    },
  });
  send(client, { type: 'transcript.created' });

  const commit = () => {
    if (pendingSamples === 0) return;
    pendingSamples = 0;
    awaitingCommit++;
    send(up, { type: 'input_audio_buffer.commit' });
  };
  const releaseFinished = () => {
    while (released < order.length && finals.has(order[released]!)) {
      const text = finals.get(order[released]!)!.trim();
      released++;
      if (text) {
        full += (full ? ' ' : '') + text;
        send(client, { type: 'transcript.partial', text, is_final: true, speech_final: true });
      }
    }
  };
  const maybeDone = () => {
    if (doneSent || !finishing) return;
    if (awaitingCommit === 0 && pendingSamples === 0 && released === order.length) {
      doneSent = true;
      send(client, { type: 'transcript.done', text: full });
    }
  };

  return {
    control: (type) => {
      if (type === 'audio.done') finishing = true;
      commit();
      maybeDone();
    },
    audio: (buf) => {
      const pcm = new Int16Array(buf.slice(0, buf.byteLength - (buf.byteLength % 2)));
      pendingSamples += pcm.length;
      const up24 = resample16kTo24k(pcm);
      send(up, { type: 'input_audio_buffer.append', audio: toBase64(new Uint8Array(up24.buffer)) });
    },
    upstream: (data) => {
      let m: { type?: string; item_id?: string; delta?: string; transcript?: string };
      try {
        m = JSON.parse(data);
      } catch {
        return;
      }
      const id = m.item_id;
      switch (m.type) {
        case 'input_audio_buffer.committed':
          if (id) {
            order.push(id);
            awaitingCommit = Math.max(0, awaitingCommit - 1);
            releaseFinished();
            maybeDone();
          }
          break;
        case 'conversation.item.input_audio_transcription.delta':
          if (id) {
            const text = (live.get(id) ?? '') + (m.delta ?? '');
            live.set(id, text);
            send(client, {
              type: 'transcript.partial',
              text: text.trim(),
              is_final: false,
              speech_final: false,
            });
          }
          break;
        case 'conversation.item.input_audio_transcription.completed':
          if (id) {
            finals.set(id, m.transcript ?? '');
            live.delete(id);
            releaseFinished();
            maybeDone();
          }
          break;
        case 'conversation.item.input_audio_transcription.failed':
          if (id) {
            finals.set(id, '');
            live.delete(id);
            releaseFinished();
            maybeDone();
          }
          break;
        case 'error':
          send(client, { type: 'error', message: 'provider_error' });
          break;
      }
    },
  };
}
