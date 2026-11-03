import { CliError } from './runtime.js';

/**
 * A small read-only client for the Cloudflare REST API, used by `decisions update` to find the
 * Worker behind a relay URL and read its live configuration. Every request carries the token only
 * to api.cloudflare.com; nothing here writes.
 */

export const CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4';

export interface Account {
  id: string;
  name: string;
}

/** A binding as the Workers settings endpoint reports it. */
export interface LiveBinding {
  type: string;
  name: string;
  [k: string]: unknown;
}

/** The parts of a Worker's live configuration an update has to keep. */
export interface WorkerSnapshot {
  account: Account;
  name: string;
  bindings: LiveBinding[];
  /** Whether the Worker answers on workers.dev and on preview URLs. */
  workersDev: boolean;
  previewUrls: boolean;
  /** Settings carried into the new deployment as they are, when the Worker has them. */
  carried: {
    observability?: unknown;
    placement?: unknown;
    limits?: unknown;
    tail_consumers?: unknown;
    logpush?: unknown;
  };
}

interface Envelope<T> {
  success?: boolean;
  result?: T;
  errors?: { code?: number; message?: string }[];
  result_info?: { page?: number; total_pages?: number };
}

export class CloudflareApi {
  constructor(
    private readonly fetchFn: typeof fetch,
    private readonly token: string,
  ) {}

  private async request<T>(path: string): Promise<{ status: number; body: Envelope<T> | null }> {
    let res: Response;
    try {
      res = await this.fetchFn(`${CLOUDFLARE_API}${path}`, {
        headers: { authorization: `Bearer ${this.token}`, accept: 'application/json' },
      });
    } catch (e) {
      throw new CliError(`could not reach the Cloudflare API: ${(e as Error).message}`);
    }
    const body = (await res.json().catch(() => null)) as Envelope<T> | null;
    return { status: res.status, body };
  }

  private async get<T>(path: string, what: string): Promise<T> {
    const { status, body } = await this.request<T>(path);
    if (status >= 200 && status < 300 && body?.success !== false && body?.result !== undefined)
      return body.result;
    const why =
      body?.errors
        ?.map((e) => e.message)
        .filter(Boolean)
        .join('; ') || `HTTP ${status}`;
    throw new CliError(`Cloudflare refused to ${what}: ${why}`);
  }

  /** Like `get`, but a 404 is `null` (the thing does not exist in that account). */
  private async find<T>(path: string, what: string): Promise<T | null> {
    const { status, body } = await this.request<T>(path);
    if (status === 404) return null;
    if (status >= 200 && status < 300 && body?.success !== false && body?.result !== undefined)
      return body.result;
    const why =
      body?.errors
        ?.map((e) => e.message)
        .filter(Boolean)
        .join('; ') || `HTTP ${status}`;
    throw new CliError(`Cloudflare refused to ${what}: ${why}`);
  }

  private async pages<T>(path: string, what: string): Promise<T[]> {
    const out: T[] = [];
    const sep = path.includes('?') ? '&' : '?';
    for (let page = 1; page <= 50; page++) {
      const { status, body } = await this.request<T[]>(`${path}${sep}page=${page}&per_page=50`);
      if (
        status < 200 ||
        status >= 300 ||
        body?.success === false ||
        !Array.isArray(body?.result)
      ) {
        const why =
          body?.errors
            ?.map((e) => e.message)
            .filter(Boolean)
            .join('; ') || `HTTP ${status}`;
        throw new CliError(`Cloudflare refused to ${what}: ${why}`);
      }
      out.push(...body.result);
      const total = body.result_info?.total_pages;
      if (!total || page >= total || body.result.length === 0) break;
    }
    return out;
  }

  async accounts(): Promise<Account[]> {
    const rows = await this.pages<{ id?: unknown; name?: unknown }>('/accounts', 'list accounts');
    return rows
      .filter((a): a is { id: string; name: unknown } => typeof a.id === 'string')
      .map((a) => ({ id: a.id, name: typeof a.name === 'string' ? a.name : a.id }));
  }

  /** The account's workers.dev subdomain, or null when it has none. */
  async workersSubdomain(accountId: string): Promise<string | null> {
    const r = await this.find<{ subdomain?: unknown }>(
      `/accounts/${accountId}/workers/subdomain`,
      'read the workers.dev subdomain',
    );
    return typeof r?.subdomain === 'string' ? r.subdomain.toLowerCase() : null;
  }

  /** The Worker attached to a custom domain in this account, if there is one. */
  async customDomainService(accountId: string, hostname: string): Promise<string | null> {
    const rows = await this.pages<{ hostname?: unknown; service?: unknown; environment?: unknown }>(
      `/accounts/${accountId}/workers/domains?hostname=${encodeURIComponent(hostname)}`,
      'list custom domains',
    );
    const hit = rows.find(
      (d) =>
        typeof d.hostname === 'string' &&
        d.hostname.toLowerCase() === hostname &&
        typeof d.service === 'string' &&
        (d as { enabled?: unknown }).enabled !== false &&
        (d.environment === undefined || d.environment === 'production'),
    );
    return hit ? (hit.service as string) : null;
  }

  async workerNames(accountId: string): Promise<string[]> {
    const rows = await this.pages<{ id?: unknown }>(
      `/accounts/${accountId}/workers/scripts`,
      'list Workers',
    );
    return rows.map((r) => r.id).filter((id): id is string => typeof id === 'string');
  }

  /** The Worker's live configuration, or null when there is no Worker of that name. */
  async snapshot(account: Account, name: string): Promise<WorkerSnapshot | null> {
    const base = `/accounts/${account.id}/workers/scripts/${encodeURIComponent(name)}`;
    const settings = await this.find<{
      bindings?: unknown;
      observability?: unknown;
      placement?: unknown;
      limits?: unknown;
      tail_consumers?: unknown;
      logpush?: unknown;
    }>(`${base}/settings`, `read the settings of the Worker "${name}"`);
    if (!settings) return null;
    if (!Array.isArray(settings.bindings)) {
      throw new CliError(`Cloudflare did not report the bindings of the Worker "${name}"`);
    }
    const bindings = settings.bindings.filter(
      (b): b is LiveBinding =>
        !!b &&
        typeof (b as LiveBinding).type === 'string' &&
        typeof (b as LiveBinding).name === 'string',
    );
    const sub = await this.get<{ enabled?: unknown; previews_enabled?: unknown }>(
      `${base}/subdomain`,
      `read whether "${name}" is on workers.dev`,
    );
    const carried: WorkerSnapshot['carried'] = {};
    for (const k of [
      'observability',
      'placement',
      'limits',
      'tail_consumers',
      'logpush',
    ] as const) {
      if (settings[k] !== undefined && settings[k] !== null) carried[k] = settings[k];
    }
    return {
      account,
      name,
      bindings,
      workersDev: sub.enabled === true,
      previewUrls: sub.previews_enabled === true,
      carried,
    };
  }
}
