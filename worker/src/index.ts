import { ApiError, DESKTOP_ROLES, LIMITS, VoiceCorrectBody } from '@daintree/decisions-protocol';
import type { DecisionRoom } from './decision-room.js';
import { WORKER_VERSION, type Env } from './env.js';
import { securityHeaders } from './security/headers.js';
import { correct } from './voice-correct.js';
import { handleVoiceSocket } from './voice-proxy.js';
import { parseJson, type ApiRequest } from './util.js';

export { DecisionRoom } from './decision-room.js';

type Stub = DurableObjectStub<DecisionRoom>;

const SOCKET_PATH = '/api/v1/socket';
const VOICE_WS_PATH = '/api/v1/voice/ws';
const VOICE_CORRECT_PATH = '/api/v1/voice/correct';
const ATTACHMENT_CONTENT = /^\/api\/v1\/attachments\/([A-Za-z0-9_-]{8,64})\/content$/;

function room(env: Env): Stub {
  return env.DECISION_ROOM.get(env.DECISION_ROOM.idFromName('primary'));
}

function withHeaders(res: Response, headers: Record<string, string>): Response {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(headers)) out.headers.set(k, v);
  return out;
}

function apiResponse(
  status: number,
  body: BodyInit | null,
  url: URL,
  extra: Record<string, string> = {},
): Response {
  return new Response(body, {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...securityHeaders(url, 'api'),
      ...extra,
    },
  });
}

function errorJson(url: URL, err: ApiError, requestId: string): Response {
  return apiResponse(err.status, JSON.stringify(err.toBody(requestId)), url);
}

/** Reads at most `max` bytes of a request body as UTF-8 text, rejecting oversize input without buffering it all. */
async function readBody(request: Request, max: number): Promise<string> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > max) throw new ApiError('payload_too_large', 'body too large');
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      throw new ApiError('payload_too_large', 'body too large');
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    all.set(c, o);
    o += c.byteLength;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(all);
  } catch {
    throw new ApiError('validation_error', 'body is not valid UTF-8');
  }
}

function baseRequest(request: Request, url: URL, requestId: string): ApiRequest {
  const h: Record<string, string> = {};
  const secret = request.headers.get('x-pairing-secret');
  if (secret) h['x-pairing-secret'] = secret;
  return {
    method: request.method,
    path: url.pathname,
    query: url.search.startsWith('?') ? url.search.slice(1) : '',
    authorization: request.headers.get('authorization'),
    body: '',
    ip: request.headers.get('cf-connecting-ip') ?? 'unknown',
    requestId,
    origin: url.origin,
    headers: h,
  };
}

async function handleApi(request: Request, env: Env, url: URL): Promise<Response> {
  const requestId = crypto.randomUUID();
  const stub = room(env);
  try {
    if (url.pathname === SOCKET_PATH) {
      if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
        return errorJson(
          url,
          new ApiError('validation_error', 'expected a WebSocket upgrade'),
          requestId,
        );
      }
      return stub.fetch(request);
    }
    if (url.pathname === VOICE_WS_PATH) return handleVoiceSocket(request, env, stub);

    const att = ATTACHMENT_CONTENT.exec(url.pathname);
    if (att && (request.method === 'PUT' || request.method === 'GET')) {
      return await handleAttachment(request, env, stub, url, att[1]!, requestId);
    }

    if (url.pathname === VOICE_CORRECT_PATH && request.method === 'POST') {
      return await handleCorrect(request, env, stub, url, requestId);
    }

    const req = baseRequest(request, url, requestId);
    req.body = ['POST', 'PUT', 'DELETE'].includes(request.method)
      ? await readBody(request, LIMITS.jsonBodyBytes)
      : '';
    const res = await stub.handle(req);
    return apiResponse(res.status, res.body, url, res.headers ?? {});
  } catch (e) {
    if (e instanceof ApiError) return errorJson(url, e, requestId);
    return errorJson(url, new ApiError('internal_error', 'internal error'), requestId);
  }
}

async function handleAttachment(
  request: Request,
  env: Env,
  stub: Stub,
  url: URL,
  attachmentId: string,
  requestId: string,
): Promise<Response> {
  const base = baseRequest(request, url, requestId);
  if (request.method === 'PUT') {
    const len = Number(request.headers.get('content-length') ?? '');
    const sha = (request.headers.get('x-content-sha256') ?? '').toLowerCase();
    if (!Number.isSafeInteger(len) || len < 1 || len > LIMITS.attachmentBytes + 64) {
      return errorJson(
        url,
        new ApiError('payload_too_large', 'attachment size not acceptable'),
        requestId,
      );
    }
    if (!/^[0-9a-f]{64}$/.test(sha)) {
      return errorJson(
        url,
        new ApiError('validation_error', 'x-content-sha256 required'),
        requestId,
      );
    }
    const auth = await stub.authorizeStream({ ...base, declaredBodySha256: sha }, DESKTOP_ROLES);
    if (!auth.ok) return apiResponse(auth.status, auth.body, url);
    const slot = await stub.attachmentForUpload(attachmentId, auth.value, len, sha);
    if (!slot.ok) return apiResponse(slot.status, slot.body, url);
    try {
      // R2 verifies the SHA-256 while streaming; a mismatching upload fails and nothing is stored.
      await env.ATTACHMENTS.put(slot.value.object_key, request.body, {
        sha256: sha,
        httpMetadata: { contentType: 'application/octet-stream' },
      });
    } catch {
      // Only this request holds the upload claim, so cleaning up the shared key cannot hurt a winner.
      await env.ATTACHMENTS.delete(slot.value.object_key).catch(() => undefined);
      await stub.abortUpload(attachmentId);
      return errorJson(
        url,
        new ApiError('validation_error', 'upload failed or digest did not match'),
        requestId,
      );
    }
    if (!(await stub.markUploaded(attachmentId))) {
      // The reservation disappeared while streaming (data reset or garbage collection): leave no orphan.
      await env.ATTACHMENTS.delete(slot.value.object_key).catch(() => undefined);
      return errorJson(url, new ApiError('invalid_state', 'upload is no longer valid'), requestId);
    }
    return apiResponse(
      200,
      JSON.stringify({ attachment_id: attachmentId, state: 'uploaded' }),
      url,
    );
  }
  const auth = await stub.authorizeStream(base);
  if (!auth.ok) return apiResponse(auth.status, auth.body, url);
  const slot = await stub.attachmentForDownload(attachmentId);
  if (!slot.ok) return apiResponse(slot.status, slot.body, url);
  const obj = await env.ATTACHMENTS.get(slot.value.object_key);
  if (!obj) return errorJson(url, new ApiError('not_found', 'attachment expired'), requestId);
  return new Response(obj.body, {
    status: 200,
    headers: {
      'content-type': 'application/octet-stream',
      'content-length': String(obj.size),
      ...securityHeaders(url, 'api'),
    },
  });
}

async function handleCorrect(
  request: Request,
  env: Env,
  stub: Stub,
  url: URL,
  requestId: string,
): Promise<Response> {
  const text = await readBody(request, 64 * 1024);
  const req = { ...baseRequest(request, url, requestId), body: text };
  const auth = await stub.authorizeStream(req, ['phone', 'tablet']);
  if (!auth.ok) return apiResponse(auth.status, auth.body, url);
  const lim = await stub.limit(`correct:${auth.value.deviceId}`, 20, 60_000);
  if (!lim.ok) return apiResponse(lim.status, lim.body, url);
  const body = parseJson(VoiceCorrectBody, text);
  const out = await correct(env, body);
  if (!out.ok) {
    return errorJson(
      url,
      new ApiError('temporarily_unavailable', 'correction unavailable; keep the raw text'),
      requestId,
    );
  }
  return apiResponse(200, JSON.stringify({ result: out.result, model: out.model }), url);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/health') {
      return apiResponse(200, JSON.stringify({ ok: true, version: WORKER_VERSION }), url);
    }
    if (url.pathname.startsWith('/api/')) return handleApi(request, env, url);
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
    }
    const res = await env.ASSETS.fetch(request);
    const ct = res.headers.get('content-type') ?? '';
    const isHtml = ct.includes('text/html');
    const headers = securityHeaders(url, isHtml ? 'html' : 'asset');
    if (isHtml || url.pathname === '/sw.js') headers['Cache-Control'] = 'no-cache';
    if (/^\/assets\/.+-[A-Za-z0-9_-]{6,}\./.test(url.pathname)) {
      headers['Cache-Control'] = 'public, max-age=31536000, immutable';
    }
    return withHeaders(res, headers);
  },
} satisfies ExportedHandler<Env>;
