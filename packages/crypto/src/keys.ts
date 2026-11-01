import { base64UrlToBytes, bytesToBase64Url } from '@daintree/decisions-protocol';
import { buf, subtle } from './util.js';

export interface DeviceKeys {
  signing: CryptoKeyPair;
  exchange: CryptoKeyPair;
}

/**
 * Generate a device's two independent P-256 key pairs. Pass `extractable: false` on phones so the
 * private keys can live in IndexedDB as non-extractable CryptoKey objects; the desktop uses
 * `extractable: true` so it can persist PKCS#8 in the OS keychain / recovery bundle.
 */
export async function generateDeviceKeys(extractable: boolean): Promise<DeviceKeys> {
  const signing = (await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, extractable, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const exchange = (await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, extractable, [
    'deriveBits',
  ])) as CryptoKeyPair;
  return { signing, exchange };
}

/** Raw uncompressed SEC1 point (65 bytes) as base64url (87 chars). */
export async function exportPublicKey(key: CryptoKey): Promise<string> {
  return bytesToBase64Url(new Uint8Array(await subtle.exportKey('raw', key)));
}

export async function importSigningPublicKey(b64: string): Promise<CryptoKey> {
  const raw = base64UrlToBytes(b64);
  if (raw.length !== 65 || raw[0] !== 4) throw new Error('invalid P-256 public key');
  return subtle.importKey('raw', buf(raw), { name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'verify',
  ]);
}

export async function importExchangePublicKey(b64: string): Promise<CryptoKey> {
  const raw = base64UrlToBytes(b64);
  if (raw.length !== 65 || raw[0] !== 4) throw new Error('invalid P-256 public key');
  return subtle.importKey('raw', buf(raw), { name: 'ECDH', namedCurve: 'P-256' }, true, []);
}

export interface SerializedDeviceKeys {
  signing_private_pkcs8: string;
  signing_public: string;
  exchange_private_pkcs8: string;
  exchange_public: string;
}

/** Only possible for extractable keys. Treat the output as a secret. */
export async function serializeDeviceKeys(keys: DeviceKeys): Promise<SerializedDeviceKeys> {
  return {
    signing_private_pkcs8: bytesToBase64Url(
      new Uint8Array(await subtle.exportKey('pkcs8', keys.signing.privateKey)),
    ),
    signing_public: await exportPublicKey(keys.signing.publicKey),
    exchange_private_pkcs8: bytesToBase64Url(
      new Uint8Array(await subtle.exportKey('pkcs8', keys.exchange.privateKey)),
    ),
    exchange_public: await exportPublicKey(keys.exchange.publicKey),
  };
}

export async function deserializeDeviceKeys(
  s: SerializedDeviceKeys,
  extractable = true,
): Promise<DeviceKeys> {
  const signingPrivate = await subtle.importKey(
    'pkcs8',
    buf(base64UrlToBytes(s.signing_private_pkcs8)),
    { name: 'ECDSA', namedCurve: 'P-256' },
    extractable,
    ['sign'],
  );
  const exchangePrivate = await subtle.importKey(
    'pkcs8',
    buf(base64UrlToBytes(s.exchange_private_pkcs8)),
    { name: 'ECDH', namedCurve: 'P-256' },
    extractable,
    ['deriveBits'],
  );
  return {
    signing: {
      privateKey: signingPrivate,
      publicKey: await importSigningPublicKey(s.signing_public),
    },
    exchange: {
      privateKey: exchangePrivate,
      publicKey: await importExchangePublicKey(s.exchange_public),
    },
  };
}

/** SHA-256 fingerprint of a public key, grouped for human comparison. */
export async function fingerprint(publicKeyB64: string): Promise<string> {
  const { sha256Hex } = await import('./util.js');
  const hex = await sha256Hex(base64UrlToBytes(publicKeyB64));
  return (hex.slice(0, 32).match(/.{4}/g) ?? []).join(' ');
}
