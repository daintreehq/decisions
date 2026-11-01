import { ApiError, type ErrorCode } from '@daintreehq/decisions-protocol';
import type { z } from 'zod';

export const nowMs = (): number => Date.now();
export const iso = (ms: number): string => new Date(ms).toISOString();
export const isoOrNull = (ms: number | null | undefined): string | null =>
  ms == null ? null : iso(ms);

export interface ApiRequest {
  method: string;
  path: string;
  /** raw query string without the leading "?" */
  query: string;
  authorization: string | null;
  body: string;
  ip: string;
  requestId: string;
  /** The request's own origin (https://host), recorded at claim time for the VAPID subject. */
  origin?: string;
  /** For streamed bodies the caller pre-computes/declares the body digest the signature must cover. */
  declaredBodySha256?: string;
  headers?: Record<string, string>;
}

export interface VoiceTicketPayload {
  session_id: string;
  provider: 'xai' | 'openai';
  keyterms: string[];
  language: string | null;
}

export interface ApiResponse {
  status: number;
  body: string;
  headers?: Record<string, string>;
}

export const json = (
  status: number,
  value: unknown,
  headers?: Record<string, string>,
): ApiResponse => ({
  status,
  body: JSON.stringify(value),
  ...(headers ? { headers } : {}),
});

export function errorResponse(e: ApiError, requestId: string): ApiResponse {
  return {
    status: e.status,
    body: JSON.stringify(e.toBody(requestId)),
    ...(e.retryAfterMs !== undefined
      ? { headers: { 'Retry-After': String(Math.ceil(e.retryAfterMs / 1000)) } }
      : {}),
  };
}

export function parseJson<T extends z.ZodType>(schema: T, text: string): z.infer<T> {
  let raw: unknown;
  try {
    raw = JSON.parse(text || 'null');
  } catch {
    throw new ApiError('validation_error', 'body is not valid JSON');
  }
  const r = schema.safeParse(raw);
  if (!r.success) {
    const first = r.error.issues[0];
    throw new ApiError(
      'validation_error',
      `${first?.path.join('.') || 'body'}: ${first?.message ?? 'invalid'}`,
    );
  }
  return r.data;
}

export function fail(code: ErrorCode, message: string, details?: Record<string, unknown>): never {
  throw new ApiError(
    'validation_error' === code ? code : code,
    message,
    details ? { details } : {},
  );
}

/** Encode a Uint8Array as lowercase hex (R2 sha256 option expects hex or ArrayBuffer). */
export const randomHex = (bytes: number): string => {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
};
