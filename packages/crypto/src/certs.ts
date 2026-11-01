import {
  PROTOCOL_VERSION,
  pairingPopString,
  type DeviceCert,
  type Role,
} from '@daintreehq/decisions-protocol';
import { importSigningPublicKey } from './keys.js';
import { signObject, signString, verifyObject, verifyString } from './sign.js';
import { nowIso } from './util.js';

export interface IssueCertInput {
  issuerDeviceId: string;
  issuerSigningKey: CryptoKey;
  installationId: string;
  deviceId: string;
  role: Role;
  label: string;
  signingPub: string;
  exchangePub: string;
}

/** Owner-signed device certificate. The owner's own cert is self-signed (issuer == subject). */
export async function issueDeviceCert(i: IssueCertInput): Promise<DeviceCert> {
  return signObject(i.issuerSigningKey, {
    v: PROTOCOL_VERSION,
    type: 'device.cert' as const,
    installation_id: i.installationId,
    device_id: i.deviceId,
    role: i.role,
    label: i.label,
    signing_pub: i.signingPub,
    exchange_pub: i.exchangePub,
    issued_at: nowIso(),
    issuer_device_id: i.issuerDeviceId,
  }) as Promise<DeviceCert>;
}

/** Verify a cert against the issuer's public signing key (pinned owner key for everything but the owner). */
export async function verifyDeviceCert(
  cert: DeviceCert,
  issuerSigningPub: CryptoKey,
): Promise<boolean> {
  return verifyObject(issuerSigningPub, cert);
}

export async function verifySelfSignedCert(cert: DeviceCert): Promise<boolean> {
  if (cert.issuer_device_id !== cert.device_id) return false;
  return verifyObject(await importSigningPublicKey(cert.signing_pub), cert);
}

export async function signPairingPop(
  signingKey: CryptoKey,
  p: { pairingId: string; deviceId: string; exchangePub: string; signingPub: string },
): Promise<string> {
  return signString(signingKey, pairingPopString(p));
}

export async function verifyPairingPop(
  pop: string,
  p: { pairingId: string; deviceId: string; exchangePub: string; signingPub: string },
): Promise<boolean> {
  return verifyString(await importSigningPublicKey(p.signingPub), pairingPopString(p), pop);
}
