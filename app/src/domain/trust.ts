import type { DeviceCert, Role } from '@daintreehq/decisions-protocol';
import {
  importSigningPublicKey,
  verifyDeviceCert,
  verifySelfSignedCert,
} from '@daintreehq/decisions-crypto';

export interface TrustedDevice {
  cert: DeviceCert;
  role: Role;
  revokedAt: string | null;
  signingKey: CryptoKey;
}

/**
 * The chain of trust is one link long: the owner's signing key, pinned from the pairing QR code, signs
 * every device certificate. The relay hands us certificates but is never believed about them.
 * Revoked devices stay in the store so history they signed before revocation remains verifiable.
 */
export class TrustStore {
  private readonly devices = new Map<string, TrustedDevice>();

  private constructor(
    readonly installationId: string,
    readonly ownerCert: DeviceCert,
    private readonly ownerKey: CryptoKey,
  ) {}

  static async create(
    installationId: string,
    ownerCert: DeviceCert,
    pinnedOwnerSigningPub?: string,
  ) {
    if (ownerCert.installation_id !== installationId)
      throw new Error('owner certificate is for another installation');
    if (ownerCert.role !== 'owner-desktop' || ownerCert.issuer_device_id !== ownerCert.device_id) {
      throw new Error('owner certificate is not a self-signed owner certificate');
    }
    if (pinnedOwnerSigningPub && ownerCert.signing_pub !== pinnedOwnerSigningPub) {
      throw new Error('owner key does not match the pinned key');
    }
    if (!(await verifySelfSignedCert(ownerCert)))
      throw new Error('owner certificate signature is invalid');
    const key = await importSigningPublicKey(ownerCert.signing_pub);
    const t = new TrustStore(installationId, ownerCert, key);
    t.devices.set(ownerCert.device_id, {
      cert: ownerCert,
      role: 'owner-desktop',
      revokedAt: null,
      signingKey: key,
    });
    return t;
  }

  get ownerDeviceId(): string {
    return this.ownerCert.device_id;
  }

  /** Accepts a certificate only if the pinned owner key signed it. Returns whether it was accepted. */
  async addCert(cert: DeviceCert, revokedAt: string | null): Promise<boolean> {
    if (cert.installation_id !== this.installationId) return false;
    if (cert.device_id === this.ownerDeviceId) return false; // the owner is fixed at pairing
    if (cert.role === 'owner-desktop') return false; // exactly one owner per installation
    if (cert.issuer_device_id !== this.ownerDeviceId) return false;
    if (!(await verifyDeviceCert(cert, this.ownerKey))) return false;
    const existing = this.devices.get(cert.device_id);
    const keep = existing?.revokedAt ?? null;
    this.devices.set(cert.device_id, {
      cert,
      role: cert.role,
      revokedAt: revokedAt ?? keep,
      signingKey:
        existing && existing.cert.signing_pub === cert.signing_pub
          ? existing.signingKey
          : await importSigningPublicKey(cert.signing_pub),
    });
    return true;
  }

  markRevoked(deviceId: string, at: string): void {
    const d = this.devices.get(deviceId);
    if (d && d.cert.device_id !== this.ownerDeviceId && !d.revokedAt) d.revokedAt = at;
  }

  get(deviceId: string): TrustedDevice | undefined {
    return this.devices.get(deviceId);
  }

  all(): TrustedDevice[] {
    return [...this.devices.values()];
  }
}
