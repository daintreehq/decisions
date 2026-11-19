import type { ErrorCode } from '@daintreehq/decisions-protocol';

export class RelayError extends Error {
  readonly code: ErrorCode | 'network_error' | 'unknown_error';
  readonly status: number;
  readonly retryAfterMs: number | undefined;
  readonly details: Record<string, unknown> | undefined;
  /**
   * A network error from a request that provably never reached the relay: every attempt failed while connecting
   * (`isUnsentError`), before a byte of the request was written. False whenever any attempt may have been sent.
   */
  readonly notSent: boolean;

  constructor(
    code: RelayError['code'],
    message: string,
    status: number,
    extra: { retryAfterMs?: number; details?: Record<string, unknown>; notSent?: boolean } = {},
  ) {
    super(message);
    this.name = 'RelayError';
    this.code = code;
    this.status = status;
    this.retryAfterMs = extra.retryAfterMs;
    this.details = extra.details;
    this.notSent = extra.notSent === true;
  }

  static fromBody(status: number, text: string): RelayError {
    try {
      const b = JSON.parse(text) as {
        code?: ErrorCode;
        message?: string;
        retry_after_ms?: number;
        details?: Record<string, unknown>;
      };
      if (b && typeof b.code === 'string') {
        return new RelayError(b.code, b.message ?? b.code, status, {
          ...(b.retry_after_ms !== undefined ? { retryAfterMs: b.retry_after_ms } : {}),
          ...(b.details ? { details: b.details } : {}),
        });
      }
    } catch {
      /* not JSON */
    }
    return new RelayError('unknown_error', `relay returned HTTP ${status}`, status);
  }

  /** Only transient failures are retried; 4xx (including 409 conflicts) never are. */
  get retryable(): boolean {
    return this.code === 'network_error' || this.status === 429 || this.status >= 500;
  }
}

/**
 * The relay no longer accepts this device: `401 not_authenticated` with the message the relay gives a revoked (or
 * deleted) device, checked after the client has had its chance to correct a clock skew. Other `not_authenticated`
 * refusals (an unknown installation, a bad signature, a skew) can be a misrouted or misconfigured relay that recovers,
 * so they are not revocations.
 */
export function isDeviceRevoked(e: unknown): boolean {
  return (
    e instanceof RelayError &&
    e.code === 'not_authenticated' &&
    e.status === 401 &&
    e.message === 'unknown or revoked device'
  );
}

/**
 * Socket errors raised before a connection exists: name resolution, a refused or unreachable connection, or a connect
 * timeout. A request that failed with one of these was never written to the wire. Anything else (a reset, a closed
 * socket, an abort, a TLS failure) may come after the request left, so it proves nothing.
 */
const UNSENT_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ENETUNREACH',
  'ENETDOWN',
  'EHOSTUNREACH',
  'EHOSTDOWN',
  'EADDRNOTAVAIL',
  'UND_ERR_CONNECT_TIMEOUT',
]);

/** True for a fetch failure that provably sent nothing (`UNSENT_CODES`, on the error or its `cause` chain). */
export function isUnsentError(e: unknown): boolean {
  for (let c: unknown = e, depth = 0; c && typeof c === 'object' && depth < 4; depth++) {
    const code = (c as { code?: unknown }).code;
    if (typeof code === 'string' && UNSENT_CODES.has(code)) return true;
    c = (c as { cause?: unknown }).cause;
  }
  return false;
}
