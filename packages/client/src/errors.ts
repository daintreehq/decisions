import type { ErrorCode } from '@daintreehq/decisions-protocol';

export class RelayError extends Error {
  readonly code: ErrorCode | 'network_error' | 'unknown_error';
  readonly status: number;
  readonly retryAfterMs: number | undefined;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    code: RelayError['code'],
    message: string,
    status: number,
    extra: { retryAfterMs?: number; details?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = 'RelayError';
    this.code = code;
    this.status = status;
    this.retryAfterMs = extra.retryAfterMs;
    this.details = extra.details;
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
