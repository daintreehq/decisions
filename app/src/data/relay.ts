import { API_PREFIX, normalizeQuery, type ApiErrorBody } from '@daintree/decisions-protocol';
import { signRequest } from '@daintree/decisions-crypto';

export class RelayError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
    readonly details?: Record<string, unknown>,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'RelayError';
  }
  /** Network failures and 5xx are retryable; everything else is a definitive answer from the relay. */
  get retryable(): boolean {
    return this.status === 0 || this.status >= 500 || this.status === 429;
  }
}

export interface RelayDeps {
  origin: string;
  installationId: string;
  deviceId: string;
  signingKey: CryptoKey;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

type Query = Record<string, string | number | undefined>;

function queryString(q?: Query): string {
  if (!q) return '';
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined) p.set(k, String(v));
  return normalizeQuery(p);
}

async function parseError(res: Response): Promise<RelayError> {
  let body: Partial<ApiErrorBody> = {};
  try {
    body = (await res.json()) as Partial<ApiErrorBody>;
  } catch {
    /* non-JSON error */
  }
  return new RelayError(
    body.code ?? 'http_error',
    res.status,
    body.message ?? `Relay returned ${res.status}`,
    body.details,
    body.retry_after_ms,
  );
}

/** Unauthenticated JSON call (pairing candidate/status, info). */
export async function publicJson<T>(
  origin: string,
  method: string,
  path: string,
  opts: { body?: unknown; headers?: Record<string, string>; fetchImpl?: typeof fetch } = {},
): Promise<T> {
  const f = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await f(origin + path, {
      method,
      headers: {
        ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...opts.headers,
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
    });
  } catch {
    throw new RelayError('network', 0, 'Could not reach the relay');
  }
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as T;
}

/** Signed, same-origin client for the relay REST API. Every attempt gets a fresh nonce and timestamp. */
export class Relay {
  private readonly f: typeof fetch;
  constructor(private readonly d: RelayDeps) {
    // Never store the bare global: calling it as a method (`this.f(...)`) throws "Illegal invocation" in browsers.
    this.f = d.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  get origin(): string {
    return this.d.origin;
  }

  private async send(
    method: string,
    path: string,
    query: Query | undefined,
    bodyText: string | undefined,
  ): Promise<Response> {
    const q = queryString(query);
    const fullPath = API_PREFIX + path;
    const { authorization } = await signRequest({
      method,
      path: fullPath,
      query: q,
      body: bodyText ?? null,
      installationId: this.d.installationId,
      deviceId: this.d.deviceId,
      signingKey: this.d.signingKey,
      now: this.d.now?.(),
    });
    try {
      return await this.f(this.d.origin + fullPath + (q ? `?${q}` : ''), {
        method,
        headers: {
          authorization,
          ...(bodyText !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: bodyText,
        credentials: 'omit',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
      });
    } catch {
      throw new RelayError('network', 0, 'Could not reach the relay');
    }
  }

  async json<T>(
    method: string,
    path: string,
    opts: { query?: Query; body?: unknown } = {},
  ): Promise<T> {
    const res = await this.send(
      method,
      path,
      opts.query,
      opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    );
    if (!res.ok) throw await parseError(res);
    return (await res.json()) as T;
  }

  /** Pre-serialised body: used by the outbox so a retry sends byte-identical content. */
  async jsonRaw<T>(method: string, path: string, bodyText: string): Promise<T> {
    const res = await this.send(method, path, undefined, bodyText);
    if (!res.ok) throw await parseError(res);
    return (await res.json()) as T;
  }

  async bytes(path: string): Promise<Uint8Array> {
    const res = await this.send('GET', path, undefined, undefined);
    if (!res.ok) throw await parseError(res);
    return new Uint8Array(await res.arrayBuffer());
  }

  /** Raw signed response (voice/correct needs status handling of its own). */
  async raw(method: string, path: string, body?: unknown): Promise<Response> {
    return this.send(
      method,
      path,
      undefined,
      body !== undefined ? JSON.stringify(body) : undefined,
    );
  }
}
