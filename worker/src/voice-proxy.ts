import { LIMITS } from '@daintreehq/decisions-protocol';
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
  // Audio frames must arrive as ArrayBuffers: from compatibility date 2026 workerd hands binary messages over as
  // Blobs by default, and a Blob forwarded upstream goes out as the text "[object Blob]".
  server.binaryType = 'arraybuffer';

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
      let up: WebSocket | null;
      let first: string | null = null;
      if (p.provider === 'xai') {
        const x = await connectXai(env, p, () => ended);
        up = x?.ws ?? null;
        first = x?.first ?? null;
      } else up = await connectOpenAI(env);
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
      if (first) b.upstream(first);
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

// Daintree desktop's Grok tuning (electron/services/voice/grokTranscriptionTuning.ts and
// GrokTranscriptionProvider.ts): its model, a 300 ms endpoint, `format` only for a language xAI formats, and the
// keyterm limits with a full, trimmed, none ladder when xAI refuses a session over its terms.
const GROK_MODEL = 'grok-voice-transcribe-2.0';
const GROK_ENDPOINTING_MS = 300;
const GROK_FORMAT_LANGUAGES = new Set([
  'ar',
  'de',
  'en',
  'es',
  'fr',
  'ja',
  'pt',
  'ru',
  'sv',
  'vi',
  'zh',
]);
const MAX_GROK_KEYTERMS = 100;
const MAX_GROK_KEYTERM_LENGTH = 50;
// The keyterms' share of the query string, as encoded, keeping the URL under the common 8 KiB request-line limit.
const MAX_GROK_KEYTERM_QUERY_LENGTH = 6_000;
const TRIMMED_RETRY_KEYTERMS = 20;
const XAI_READY_TIMEOUT_MS = 10_000;

type KeytermAttempt = 'full' | 'trimmed' | 'none';

/** The keyterms that fit xAI's limits, in priority order. A term too long is skipped, not the end of the list. */
export function sanitizeGrokKeyterms(keyterms: readonly string[]): string[] {
  const out: string[] = [];
  let encoded = 0;
  for (const raw of keyterms) {
    const term = raw.trim();
    if (!term || term.length > MAX_GROK_KEYTERM_LENGTH) continue;
    if (out.length >= MAX_GROK_KEYTERMS) break;
    const len = new URLSearchParams([['keyterm', term]]).toString().length + 1;
    if (encoded + len > MAX_GROK_KEYTERM_QUERY_LENGTH) continue;
    out.push(term);
    encoded += len;
  }
  return out;
}

export function xaiUrl(p: Pick<TicketPayload, 'language'>, keyterms: readonly string[]): string {
  const params = new URLSearchParams({
    model: GROK_MODEL,
    encoding: 'pcm',
    sample_rate: '16000',
    interim_results: 'true',
    endpointing: String(GROK_ENDPOINTING_MS),
  });
  // Left out, xAI detects the language itself.
  if (p.language) {
    params.set('language', p.language);
    if (GROK_FORMAT_LANGUAGES.has(p.language)) params.set('format', 'true');
  }
  for (const k of keyterms) params.append('keyterm', k);
  return `https://api.x.ai/v1/stt?${params.toString()}`;
}

/** The next rung of the keyterm ladder after a refusal, or null when the refusal can't be about the terms. */
export function nextKeytermAttempt(
  attempt: KeytermAttempt,
  sent: number,
  available: number,
): KeytermAttempt | null {
  if (attempt === 'none' || sent === 0) return null;
  return attempt === 'full' && available > TRIMMED_RETRY_KEYTERMS ? 'trimmed' : 'none';
}

type XaiOpen = { kind: 'ready'; ws: WebSocket; first: string } | { kind: 'refused' | 'failed' };

/** Opens one xAI session and waits for `transcript.created`, which is when it has accepted the parameters. */
async function openXai(env: Env, url: string): Promise<XaiOpen> {
  const res = await fetch(url, {
    // A provider key never follows a redirect anywhere.
    redirect: 'manual',
    headers: { Upgrade: 'websocket', Authorization: `Bearer ${env.XAI_API_KEY}` },
  });
  const ws = res.webSocket;
  // 400 is bad parameters, most plausibly the terms.
  if (!ws) return { kind: res.status === 400 ? 'refused' : 'failed' };
  ws.accept();
  return new Promise<XaiOpen>((resolve) => {
    const settle = (v: XaiOpen) => {
      clearTimeout(timer);
      ws.removeEventListener('message', onMessage);
      ws.removeEventListener('close', onGone);
      ws.removeEventListener('error', onGone);
      if (v.kind !== 'ready') {
        try {
          ws.close(1000, 'retry');
        } catch {
          /* already closed */
        }
      }
      resolve(v);
    };
    const onMessage = (ev: MessageEvent) => {
      if (typeof ev.data !== 'string') return;
      let m: { type?: string };
      try {
        m = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (m.type === 'transcript.created') settle({ kind: 'ready', ws, first: ev.data });
      else if (m.type === 'error') settle({ kind: 'refused' });
    };
    const onGone = () => settle({ kind: 'failed' });
    const timer = setTimeout(() => settle({ kind: 'failed' }), XAI_READY_TIMEOUT_MS);
    ws.addEventListener('message', onMessage);
    ws.addEventListener('close', onGone);
    ws.addEventListener('error', onGone);
  });
}

async function connectXai(
  env: Env,
  p: TicketPayload,
  gone: () => boolean,
): Promise<{ ws: WebSocket; first: string } | null> {
  if (!env.XAI_API_KEY) return null;
  const sanitized = sanitizeGrokKeyterms(p.keyterms);
  let attempt: KeytermAttempt = 'full';
  for (;;) {
    // A client that left during a refused attempt gets no further attempts made on its behalf.
    if (gone()) return null;
    const terms: string[] =
      attempt === 'none'
        ? []
        : attempt === 'trimmed'
          ? sanitized.slice(0, TRIMMED_RETRY_KEYTERMS)
          : sanitized;
    const r = await openXai(env, xaiUrl(p, terms));
    if (r.kind === 'ready') return { ws: r.ws, first: r.first };
    const next: KeytermAttempt | null =
      r.kind === 'refused' ? nextKeytermAttempt(attempt, terms.length, sanitized.length) : null;
    if (!next) return null;
    attempt = next;
  }
}

/*
 * Grok's stream, as Daintree's GrokTranscriptionProvider reads it: an `is_final` result without `speech_final` is a
 * locked chunk of the utterance in progress, and the `speech_final` result restates the whole utterance. Passed
 * through as they come, the phone would keep the chunks and the restatement, and the words twice. So chunks go to
 * the phone as preview text, and the utterance final lands once, with any chunk it left out kept ahead of it.
 */

// A result restates locked chunks when this share of their words opens it, in order, and at least this share of
// the first chunk's words (Daintree's RESTATED_WORD_SHARE and RESTATED_MIN_WORD_SHARE).
const RESTATED_WORD_SHARE = 0.75;
const RESTATED_MIN_WORD_SHARE = 0.5;
// Two results belong to the same stretch of audio when one starts this close to where the other ends.
const RESULT_TIMING_TOLERANCE_SECONDS = 0.1;
const WORD_BOUNDARY_EPSILON_SECONDS = 0.001;

function spokenWords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** How many words `a` and `b` share in order (their longest common subsequence). */
function sharedWordCount(a: readonly string[], b: readonly string[]): number {
  let previous = new Array<number>(b.length + 1).fill(0);
  for (const word of a) {
    const current = [0];
    for (let j = 0; j < b.length; j++) {
      current.push(word === b[j] ? previous[j]! + 1 : Math.max(previous[j + 1]!, current[j]!));
    }
    previous = current;
  }
  return previous[b.length]!;
}

function opensWith(words: readonly string[], said: readonly string[], share: number): boolean {
  const opening = words.slice(0, said.length + Math.ceil(said.length / 4) + 2);
  return sharedWordCount(said, opening) >= share * said.length;
}

interface Chunk {
  text: string;
  /** Where its audio ends, in seconds from the session start; null when untimed. */
  end: number | null;
}

/** The locked chunks an utterance final does not restate, which land ahead of it. */
export function chunksNotRestated(chunks: readonly Chunk[], final: string): Chunk[] {
  const words = spokenWords(final);
  for (let from = 0; from < chunks.length; from++) {
    const restated = chunks.slice(from).map((c) => spokenWords(c.text));
    if (
      opensWith(words, restated[0]!, RESTATED_MIN_WORD_SHARE) &&
      opensWith(words, restated.flat(), RESTATED_WORD_SHARE)
    ) {
      return chunks.slice(0, from);
    }
  }
  return [...chunks];
}

interface XaiResult {
  type?: string;
  text?: string;
  is_final?: boolean;
  speech_final?: boolean;
  start?: number;
  duration?: number;
}

const seconds = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;

/** Turns xAI events into the events the phone reads: one final per utterance, chunks as its preview. */
export function xaiTranscriptNormalizer(emit: (event: Record<string, unknown>) => void) {
  let locked: Chunk[] = [];
  const join = (parts: readonly string[]) => parts.filter(Boolean).join(' ').trim();
  const preview = (parts: readonly string[]) =>
    emit({ type: 'transcript.partial', text: join(parts), is_final: false, speech_final: false });
  const final = (text: string) => {
    if (text) emit({ type: 'transcript.partial', text, is_final: true, speech_final: true });
  };
  return (m: XaiResult) => {
    if (m.type === 'transcript.created') emit({ type: 'transcript.created' });
    else if (m.type === 'transcript.partial') {
      const text = String(m.text ?? '').trim();
      const start = seconds(m.start);
      const duration = seconds(m.duration);
      const end = start !== null && duration !== null ? start + duration : null;
      if (m.speech_final) {
        final(join([...chunksNotRestated(locked, text).map((c) => c.text), text]));
        locked = [];
      } else if (m.is_final) {
        if (text) {
          // A later chunk final over the same audio replaces the one before it.
          const before =
            end === null
              ? locked
              : locked.filter((c) => c.end === null || c.end + WORD_BOUNDARY_EPSILON_SECONDS < end);
          locked = [...before, { text, end }];
        }
        preview(locked.map((c) => c.text));
      } else {
        // An interim that restates the utterance so far starts before the chunks end, so none go ahead of it.
        const before =
          start === null
            ? locked
            : locked.filter(
                (c) => c.end === null || c.end <= start + RESULT_TIMING_TOLERANCE_SECONDS,
              );
        preview([...before.map((c) => c.text), text]);
      }
    } else if (m.type === 'transcript.done') {
      // An utterance the stream ended before completing keeps the words its chunks locked.
      final(join(locked.map((c) => c.text)));
      locked = [];
      emit({ type: 'transcript.done', text: String(m.text ?? '') });
    } else if (m.type === 'error') emit({ type: 'error', message: 'provider_error' });
  };
}

function xaiBridge(client: WebSocket, up: WebSocket): Bridge {
  const normalize = xaiTranscriptNormalizer((event) => send(client, event));
  return {
    control: (type) => send(up, { type }),
    audio: (buf) => up.send(buf),
    upstream: (data) => {
      let m: XaiResult;
      try {
        m = JSON.parse(data);
      } catch {
        return;
      }
      normalize(m);
    },
  };
}

/* ---------------- OpenAI realtime transcription (preview) ---------------- */

async function connectOpenAI(env: Env): Promise<WebSocket | null> {
  if (!env.OPENAI_API_KEY) return null;
  const res = await fetch('https://api.openai.com/v1/realtime?intent=transcription', {
    redirect: 'manual',
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
