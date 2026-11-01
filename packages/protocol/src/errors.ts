export const ERROR_STATUS = {
  validation_error: 400,
  not_authenticated: 401,
  forbidden: 403,
  not_found: 404,
  revision_conflict: 409,
  idempotency_collision: 409,
  already_claimed: 409,
  invalid_state: 409,
  expired: 410,
  payload_too_large: 413,
  upgrade_required: 426,
  rate_limited: 429,
  not_configured: 503,
  temporarily_unavailable: 503,
  internal_error: 500,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

export interface ApiErrorBody {
  code: ErrorCode;
  message: string;
  request_id?: string;
  retry_after_ms?: number;
  /** Safe, non-sensitive extras (e.g. latest_revision on a conflict). */
  details?: Record<string, unknown>;
}

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly retryAfterMs?: number;
  readonly details?: Record<string, unknown>;
  constructor(
    code: ErrorCode,
    message: string,
    opts: { retryAfterMs?: number; details?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = ERROR_STATUS[code];
    if (opts.retryAfterMs !== undefined) this.retryAfterMs = opts.retryAfterMs;
    if (opts.details !== undefined) this.details = opts.details;
  }
  toBody(requestId?: string): ApiErrorBody {
    const body: ApiErrorBody = { code: this.code, message: this.message };
    if (requestId) body.request_id = requestId;
    if (this.retryAfterMs !== undefined) body.retry_after_ms = this.retryAfterMs;
    if (this.details) body.details = this.details;
    return body;
  }
}
