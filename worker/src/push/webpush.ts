import {
  base64UrlToBytes,
  bytesToBase64Url,
  concatBytes,
  utf8ToBytes,
} from '@daintreehq/decisions-protocol';

/** Web Push (RFC 8030) with aes128gcm payload encryption (RFC 8291) and VAPID (RFC 8292), on WebCrypto only. */

const subtle = crypto.subtle;
const buf = (u: Uint8Array): BufferSource => u as unknown as BufferSource;

export interface PushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface VapidKeys {
  /** Private key as JWK (kept in the Durable Object's SQLite, never sent anywhere). */
  privateJwk: JsonWebKey;
  /** Raw uncompressed public key, base64url: the `applicationServerKey`. */
  publicKey: string;
}

export async function generateVapidKeys(): Promise<VapidKeys> {
  const pair = (await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const privateJwk = (await subtle.exportKey('jwk', pair.privateKey)) as JsonWebKey;
  return {
    privateJwk,
    publicKey: bytesToBase64Url(
      new Uint8Array((await subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer),
    ),
  };
}

async function hkdf(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
  bytes: number,
): Promise<Uint8Array> {
  const key = await subtle.importKey('raw', buf(ikm), 'HKDF', false, ['deriveBits']);
  return new Uint8Array(
    await subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: buf(salt), info: buf(info) },
      key,
      bytes * 8,
    ),
  );
}

const RECORD_SIZE = 4096;

/** Encrypts `payload` for the user agent per RFC 8291 section 3-4. `_test` pins randomness for vectors. */
export async function encryptPushPayload(
  target: Pick<PushTarget, 'p256dh' | 'auth'>,
  payload: Uint8Array,
  _test?: { asKeys?: CryptoKeyPair; salt?: Uint8Array },
): Promise<Uint8Array> {
  if (payload.length > RECORD_SIZE - 17 - 1) throw new Error('push payload too large');
  const uaPublic = base64UrlToBytes(target.p256dh);
  const authSecret = base64UrlToBytes(target.auth);
  if (uaPublic.length !== 65 || authSecret.length !== 16)
    throw new Error('invalid push subscription keys');
  const as =
    _test?.asKeys ??
    ((await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
      'deriveBits',
    ])) as CryptoKeyPair);
  const asPublic = new Uint8Array((await subtle.exportKey('raw', as.publicKey)) as ArrayBuffer);
  const uaKey = await subtle.importKey(
    'raw',
    buf(uaPublic),
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
  const ecdh = new Uint8Array(
    await subtle.deriveBits({ name: 'ECDH', public: uaKey } as never, as.privateKey, 256),
  );
  const keyInfo = concatBytes(utf8ToBytes('WebPush: info\0'), uaPublic, asPublic);
  const ikm = await hkdf(ecdh, authSecret, keyInfo, 32);
  const salt = _test?.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(ikm, salt, utf8ToBytes('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(ikm, salt, utf8ToBytes('Content-Encoding: nonce\0'), 12);
  const aes = await subtle.importKey('raw', buf(cek), 'AES-GCM', false, ['encrypt']);
  const padded = concatBytes(payload, new Uint8Array([2]));
  const ciphertext = new Uint8Array(
    await subtle.encrypt({ name: 'AES-GCM', iv: buf(nonce) }, aes, buf(padded)),
  );
  const header = new Uint8Array(16 + 4 + 1);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE, false);
  header[20] = asPublic.length;
  return concatBytes(header, asPublic, ciphertext);
}

export async function vapidAuthorization(
  endpoint: string,
  vapid: VapidKeys,
  subject: string,
): Promise<string> {
  const aud = new URL(endpoint).origin;
  const enc = (o: unknown) => bytesToBase64Url(utf8ToBytes(JSON.stringify(o)));
  const signingInput =
    enc({ typ: 'JWT', alg: 'ES256' }) +
    '.' +
    enc({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject });
  const key = await subtle.importKey(
    'jwk',
    vapid.privateJwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
  const sig = new Uint8Array(
    await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, buf(utf8ToBytes(signingInput))),
  );
  return `vapid t=${signingInput}.${bytesToBase64Url(sig)}, k=${vapid.publicKey}`;
}

/** Known push-service host suffixes. Anything else is refused to prevent SSRF through subscriptions. */
const DEFAULT_ALLOWED_SUFFIXES = [
  'fcm.googleapis.com',
  'android.googleapis.com',
  'push.services.mozilla.com',
  'push.apple.com',
  'notify.windows.com',
  'wns.windows.com',
];

export function isAllowedPushEndpoint(endpoint: string, extra: string[] = []): boolean {
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443'))
    return false;
  const host = u.hostname.toLowerCase();
  if (/^[\d.]+$/.test(host) || host.includes(':')) return false;
  return [...DEFAULT_ALLOWED_SUFFIXES, ...extra].some((s) => host === s || host.endsWith('.' + s));
}

export interface PushOptions {
  ttlSeconds?: number;
  urgency?: 'very-low' | 'low' | 'normal' | 'high';
  topic?: string;
}

/** Returns the push service HTTP status. 201 = accepted; 404/410 = subscription gone. */
export async function sendWebPush(
  target: PushTarget,
  payload: unknown,
  vapid: VapidKeys,
  subject: string,
  opts: PushOptions = {},
  fetcher: typeof fetch = fetch,
): Promise<number> {
  const body = await encryptPushPayload(target, utf8ToBytes(JSON.stringify(payload)));
  const headers: Record<string, string> = {
    'Content-Encoding': 'aes128gcm',
    'Content-Type': 'application/octet-stream',
    TTL: String(opts.ttlSeconds ?? 86_400),
    Urgency: opts.urgency ?? 'normal',
    Authorization: await vapidAuthorization(target.endpoint, vapid, subject),
  };
  if (opts.topic) headers.Topic = opts.topic;
  const res = await fetcher(target.endpoint, {
    method: 'POST',
    headers,
    body: body as unknown as BodyInit,
    redirect: 'manual',
  });
  await res.body?.cancel();
  return res.status;
}
