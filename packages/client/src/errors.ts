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
