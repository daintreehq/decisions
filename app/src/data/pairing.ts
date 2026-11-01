import {
  PairingCandidateResponse,
  PairingStatusResponse,
  PROTOCOL_VERSION,
  type PairingInvitePayload,
} from '@daintreehq/decisions-protocol';
import {
  exportPublicKey,
  generateDeviceKeys,
  importSigningPublicKey,
  newId,
  openEpochGrant,
  pairingShortCode,
  signPairingPop,
  verifyDeviceCert,
  verifySelfSignedCert,
} from '@daintreehq/decisions-crypto';
import type { Db, PairingBundle } from './db.js';
import { generateCacheKey } from './seal.js';
import { publicJson, RelayError } from './relay.js';

export type PairingPhase =
  | { phase: 'registering' }
  | { phase: 'awaiting-approval'; shortCode: string; expiresAt: string }
  | { phase: 'finalizing' }
  | { phase: 'done' }
  | { phase: 'error'; message: string };

export class PairingError extends Error {}

export interface PairingOptions {
  invite: PairingInvitePayload;
  /** The origin this app is served from; an invite for any other relay is refused. */
  expectedOrigin: string;
  label: string;
  db: Db;
  fetchImpl?: typeof fetch;
  onPhase?: (p: PairingPhase) => void;
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  pollMs?: number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function checkInvite(
  invite: PairingInvitePayload,
  expectedOrigin: string,
  now: number,
): void {
  if (invite.v !== 1)
    throw new PairingError('This pairing link is from a newer version of Decisions.');
  if (invite.o.replace(/\/$/, '') !== expectedOrigin.replace(/\/$/, '')) {
    throw new PairingError(
      'This pairing link belongs to a different relay. Open it from your own Decisions address.',
    );
  }
  if (invite.e <= now)
    throw new PairingError('This pairing link has expired. Create a new one on your computer.');
  if (invite.r !== 'phone' && invite.r !== 'tablet')
    throw new PairingError('Unsupported device role.');
}

/**
 * Drives the whole pairing handshake and returns only after everything is verified and durably stored.
 * Trust is anchored in the owner key carried in the QR fragment; nothing the relay says is believed on its own.
 */
export async function runPairing(o: PairingOptions): Promise<PairingBundle> {
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? defaultSleep;
  const f = o.fetchImpl;
  const emit = (p: PairingPhase) => o.onPhase?.(p);
  const { invite } = o;
  try {
    checkInvite(invite, o.expectedOrigin, now());
    emit({ phase: 'registering' });

    const ownerPub = await importSigningPublicKey(invite.k);
    const keys = await generateDeviceKeys(false);
    const deviceId = newId();
    const signingPub = await exportPublicKey(keys.signing.publicKey);
    const exchangePub = await exportPublicKey(keys.exchange.publicKey);
    const pop = await signPairingPop(keys.signing.privateKey, {
      pairingId: invite.p,
      deviceId,
      exchangePub,
      signingPub,
    });

    const cand = PairingCandidateResponse.parse(
      await publicJson(invite.o, 'POST', '/api/v1/pairing/candidates', {
        fetchImpl: f,
        body: {
          protocol_version: PROTOCOL_VERSION,
          pairing_id: invite.p,
          secret: invite.s,
          device_id: deviceId,
          label: o.label,
          signing_pub: signingPub,
          exchange_pub: exchangePub,
          pop,
        },
      }),
    );

    // The relay returns the owner certificate for convenience; it must be exactly the one pinned in the QR code.
    const oc = cand.owner_cert;
    if (
      oc.signing_pub !== invite.k ||
      oc.device_id !== invite.d ||
      oc.installation_id !== invite.i ||
      cand.installation_id !== invite.i ||
      oc.role !== 'owner-desktop' ||
      !(await verifySelfSignedCert(oc))
    ) {
      throw new PairingError(
        'The relay presented an owner identity that does not match your QR code. Pairing was stopped.',
      );
    }
    const expectedCode = await pairingShortCode({ pairingId: invite.p, signingPub, exchangePub });
    if (cand.short_code !== expectedCode) {
      throw new PairingError('The confirmation code from the relay is wrong. Pairing was stopped.');
    }
    emit({ phase: 'awaiting-approval', shortCode: expectedCode, expiresAt: cand.expires_at });

    const deadline = Math.min(Date.parse(cand.expires_at), invite.e) + 60_000;
    for (;;) {
      if (o.signal?.aborted) throw new PairingError('Pairing cancelled.');
      if (now() > deadline)
        throw new PairingError('Pairing timed out before it was approved on your computer.');
      let st;
      try {
        st = PairingStatusResponse.parse(
          await publicJson(invite.o, 'GET', `/api/v1/pairing/${invite.p}/status`, {
            fetchImpl: f,
            headers: { 'x-pairing-secret': invite.s },
          }),
        );
      } catch (e) {
        if (e instanceof RelayError && e.retryable) {
          await sleep(o.pollMs ?? 2000);
          continue;
        }
        throw e;
      }
      if (st.state === 'rejected') throw new PairingError('Pairing was declined on your computer.');
      if (st.state === 'expired')
        throw new PairingError('The pairing link expired before it was approved.');
      if (st.state === 'approved') {
        emit({ phase: 'finalizing' });
        const { cert, grant } = st;
        if (!cert || !grant)
          throw new PairingError('The relay approved pairing without credentials.');
        if (
          cert.device_id !== deviceId ||
          cert.signing_pub !== signingPub ||
          cert.exchange_pub !== exchangePub ||
          cert.installation_id !== invite.i ||
          cert.issuer_device_id !== invite.d ||
          (cert.role !== 'phone' && cert.role !== 'tablet') ||
          cert.role !== invite.r ||
          !(await verifyDeviceCert(cert, ownerPub))
        ) {
          throw new PairingError(
            'The device certificate is not signed by your computer. Pairing was stopped.',
          );
        }
        const epoch = await openEpochGrant({
          grant,
          ownerSigningPublicKey: ownerPub,
          exchangePrivateKey: keys.exchange.privateKey,
          expectedInstallationId: invite.i,
          expectedDeviceId: deviceId,
          keepRaw: false,
        });
        const bundle: PairingBundle = {
          config: {
            relayOrigin: invite.o.replace(/\/$/, ''),
            installationId: invite.i,
            deviceId,
            role: cert.role,
            label: o.label,
            ownerCert: oc,
            pairedAt: new Date(now()).toISOString(),
          },
          keys: {
            signingPrivate: keys.signing.privateKey,
            signingPublic: signingPub,
            exchangePrivate: keys.exchange.privateKey,
            exchangePublic: exchangePub,
          },
          cacheKey: await generateCacheKey(),
          epoch: { epoch: epoch.epoch, key: epoch.key },
          certs: [
            { device_id: oc.device_id, cert: oc, revoked_at: null },
            { device_id: cert.device_id, cert, revoked_at: null },
          ],
        };
        await o.db.savePairing(bundle);
        emit({ phase: 'done' });
        return bundle;
      }
      await sleep(o.pollMs ?? 2000);
    }
  } catch (e) {
    const message =
      e instanceof PairingError
        ? e.message
        : e instanceof RelayError
          ? e.code === 'network'
            ? 'Could not reach your relay. Check your connection and try again.'
            : e.message
          : 'Pairing failed. Check the link and try again.';
    emit({ phase: 'error', message });
    throw e instanceof PairingError ? e : new PairingError(message);
  }
}
