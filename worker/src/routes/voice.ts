import { ApiError, LIMITS, VoiceSessionBody } from '@daintree/decisions-protocol';
import { newId } from '@daintree/decisions-crypto';
import type { Handler } from '../room/types.js';
import { iso, json, nowMs } from '../util.js';

export const voiceSession: Handler = async (room, c) => {
  const auth = c.auth!;
  const b = c.body(VoiceSessionBody);
  const key = b.provider === 'xai' ? room.env.XAI_API_KEY : room.env.OPENAI_API_KEY;
  if (!key)
    throw new ApiError('not_configured', `${b.provider} dictation is not configured on this relay`);
  room.hit(`voicesess:${auth.deviceId}`, 12, 60_000);
  const t = nowMs();
  const month = new Date(t).toISOString().slice(0, 7);
  const used =
    room.q1<{ ms: number }>(`SELECT ms FROM voice_usage WHERE month = ?`, month)?.ms ?? 0;
  const capMs = Number(room.env.VOICE_MONTHLY_MINUTES ?? '600') * 60_000;
  if (used >= capMs)
    throw new ApiError('rate_limited', 'monthly dictation budget reached', {
      retryAfterMs: 3600_000,
    });
  const active = room.q1<{ n: number }>(
    `SELECT COUNT(*) AS n FROM voice_sessions WHERE device_id = ? AND activated_at IS NOT NULL AND ended_at IS NULL AND activated_at > ?`,
    auth.deviceId,
    t - LIMITS.voiceMaxSessionMs - 10_000,
  )!.n;
  if (active > 0)
    throw new ApiError('rate_limited', 'a dictation session is already active', {
      retryAfterMs: 5000,
    });
  const sessionId = newId(t);
  room.run(
    `INSERT INTO voice_sessions (session_id, device_id, started_at) VALUES (?, ?, ?)`,
    sessionId,
    auth.deviceId,
    t,
  );
  const ticket = await room.mintTicket(
    'voice',
    auth.deviceId,
    {
      session_id: sessionId,
      provider: b.provider,
      keyterms: b.keyterms,
      language: b.language ?? null,
    },
    LIMITS.voiceTicketTtlMs,
  );
  return json(200, {
    ticket,
    ws_path: '/api/v1/voice/ws',
    provider: b.provider,
    sample_rate: 16000,
    max_session_ms: LIMITS.voiceMaxSessionMs,
    expires_at: iso(t + LIMITS.voiceTicketTtlMs),
  });
};
