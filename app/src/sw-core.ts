/** Pure helpers for the service worker so push shaping and URL routing can be unit tested. */

export interface ShapedNotification {
  title: string;
  options: {
    body: string;
    tag: string;
    icon: string;
    badge: string;
    data: { url: string };
    renotify: boolean;
    requireInteraction: boolean;
  };
}

const ID = /^[A-Za-z0-9_-]{8,64}$/;

const BODY: Record<string, string> = {
  'decision-new': 'A question needs your input',
  'decision-reminder': 'A question is still waiting',
  'decision-proxy': 'A proxy answer needs your review',
  test: 'Notifications are working',
};

/**
 * The lock screen shows fixed, generic text no matter what the payload says: nothing from the relay,
 * the agent or a push service can put a project name, prompt or code on the screen.
 */
export function shapePush(raw: unknown): ShapedNotification {
  let type = 'decision-new';
  let qid: string | null = null;
  if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    if (typeof o.type === 'string' && Object.hasOwn(BODY, o.type)) type = o.type;
    if (typeof o.question_id === 'string' && ID.test(o.question_id)) qid = o.question_id;
  }
  return {
    title: 'Daintree Decisions',
    options: {
      body: BODY[type]!,
      tag: qid ?? 'decisions',
      icon: '/icons/icon-192.png',
      // Android draws only the badge's alpha channel, tinted: it must be a silhouette, never the coloured tile.
      badge: '/icons/badge-96.png',
      data: { url: notificationUrl(qid) },
      renotify: type !== 'test',
      requireInteraction: false,
    },
  };
}

/** Clicking a notification may only ever open a question page or the inbox; never an arbitrary URL. */
export function notificationUrl(questionId: string | null | undefined): string {
  return questionId && ID.test(questionId) ? `/q/${questionId}` : '/';
}

export function safeTargetUrl(data: unknown): string {
  if (data && typeof data === 'object') {
    const u = (data as { url?: unknown }).url;
    if (typeof u === 'string' && (u === '/' || /^\/q\/[A-Za-z0-9_-]{8,64}$/.test(u))) return u;
  }
  return '/';
}

/** Which requests the service worker may answer from its shell cache. API, sockets and attachments never. */
export function isCacheable(
  url: URL,
  method: string,
  origin: string,
  precache: ReadonlySet<string>,
): 'asset' | 'navigate' | null {
  if (method !== 'GET' || url.origin !== origin) return null;
  if (url.pathname.startsWith('/api/') || url.pathname === '/health') return null;
  if (precache.has(url.pathname)) return 'asset';
  return null;
}
