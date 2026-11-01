import {
  PROTOCOL_VERSION,
  base64UrlToBytes,
  bytesToBase64Url,
  grantAadString,
  grantKeyInfo,
  utf8ToBytes,
  type EpochGrant,
} from '@daintree/decisions-protocol';
import { importEpochKey, type EpochKey } from './envelope.js';
import { exportPublicKey, importExchangePublicKey } from './keys.js';
import { signObject, verifyObject } from './sign.js';
import { buf, ecdhParams, nowIso, randomBytes, subtle, type Usage } from './util.js';

async function grantKey(shared: ArrayBuffer, salt: Uint8Array, info: string, usage: Usage[]) {
  const ikm = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: buf(salt), info: buf(utf8ToBytes(info)) },
    ikm,
    { name: 'AES-GCM', length: 256 },
    false,
    usage,
  );
}

export interface CreateGrantInput {
  issuerDeviceId: string;
  issuerSigningKey: CryptoKey;
  installationId: string;
  recipientDeviceId: string;
  /** base64url raw P-256 point of the recipient's exchange key */
  recipientExchangePub: string;
  epoch: number;
  epochKeyRaw: Uint8Array;
}

/** Seal an epoch key to one device: ephemeral ECDH + HKDF + AES-GCM, signed by the issuing owner. */
export async function createEpochGrant(i: CreateGrantInput): Promise<EpochGrant> {
  const eph = (await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ])) as CryptoKeyPair;
  const recipient = await importExchangePublicKey(i.recipientExchangePub);
  const shared = await subtle.deriveBits(ecdhParams(recipient), eph.privateKey, 256);
  const salt = randomBytes(32);
  const nonce = randomBytes(12);
  const ephemeralPub = await exportPublicKey(eph.publicKey);
  const meta = {
    installation_id: i.installationId,
    device_id: i.recipientDeviceId,
    key_epoch: i.epoch,
  };
  const key = await grantKey(shared, salt, grantKeyInfo(meta), ['encrypt']);
  const sealed = new Uint8Array(
    await subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: buf(nonce),
        additionalData: buf(utf8ToBytes(grantAadString({ ...meta, ephemeral_pub: ephemeralPub }))),
      },
      key,
      buf(i.epochKeyRaw),
    ),
  );
  return signObject(i.issuerSigningKey, {
    v: PROTOCOL_VERSION,
    type: 'epoch.grant' as const,
    ...meta,
    ephemeral_pub: ephemeralPub,
    salt: bytesToBase64Url(salt),
    nonce: bytesToBase64Url(nonce),
    sealed: bytesToBase64Url(sealed),
    issuer_device_id: i.issuerDeviceId,
    issued_at: nowIso(),
  }) as Promise<EpochGrant>;
}

/**
 * Verify the issuer's signature (against the pinned owner key) and open the grant with this
 * device's exchange private key. `keepRaw` is true only on the owner desktop.
 */
export async function openEpochGrant(args: {
  grant: EpochGrant;
  ownerSigningPublicKey: CryptoKey;
  exchangePrivateKey: CryptoKey;
  expectedInstallationId: string;
  expectedDeviceId: string;
  keepRaw?: boolean;
}): Promise<EpochKey> {
  const g = args.grant;
  if (g.installation_id !== args.expectedInstallationId || g.device_id !== args.expectedDeviceId) {
    throw new Error('grant is for another device or installation');
  }
  if (!(await verifyObject(args.ownerSigningPublicKey, g)))
    throw new Error('grant signature invalid');
  const eph = await importExchangePublicKey(g.ephemeral_pub);
  const shared = await subtle.deriveBits(ecdhParams(eph), args.exchangePrivateKey, 256);
  const key = await grantKey(
    shared,
    base64UrlToBytes(g.salt),
    grantKeyInfo({
      installation_id: g.installation_id,
      device_id: g.device_id,
      key_epoch: g.key_epoch,
    }),
    ['decrypt'],
  );
  let raw: Uint8Array;
  try {
    raw = new Uint8Array(
      await subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: buf(base64UrlToBytes(g.nonce)),
          additionalData: buf(
            utf8ToBytes(
              grantAadString({
                installation_id: g.installation_id,
                device_id: g.device_id,
                key_epoch: g.key_epoch,
                ephemeral_pub: g.ephemeral_pub,
              }),
            ),
          ),
        },
        key,
        buf(base64UrlToBytes(g.sealed)),
      ),
    );
  } catch {
    throw new Error('grant decryption failed');
  }
  return importEpochKey(raw, g.key_epoch, args.keepRaw === true);
}
