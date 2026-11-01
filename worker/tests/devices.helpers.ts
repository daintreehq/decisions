import { PROTOCOL_VERSION } from '@daintreehq/decisions-protocol';
import {
  createEpochGrant,
  generateEpochKeyBytes,
  importEpochKey,
  type EpochKey,
} from '@daintreehq/decisions-crypto';
import type { Actor, World } from './helpers.js';

/** Signed revoke/rotate body for the next epoch, with one grant per remaining non-owner device. */
export async function buildRotation(
  w: World,
  remaining: Actor[],
): Promise<{
  body: { protocol_version: 1; new_key_epoch: number; grants: unknown[] };
  raw: Uint8Array;
  epoch: EpochKey;
}> {
  const newEpoch = w.epoch.epoch + 1;
  const raw = generateEpochKeyBytes();
  const grants = [];
  for (const d of remaining) {
    grants.push(
      await createEpochGrant({
        issuerDeviceId: w.owner.id,
        issuerSigningKey: w.owner.keys.signing.privateKey,
        installationId: w.installationId,
        recipientDeviceId: d.id,
        recipientExchangePub: d.exchangePub,
        epoch: newEpoch,
        epochKeyRaw: raw,
      }),
    );
  }
  return {
    body: { protocol_version: PROTOCOL_VERSION, new_key_epoch: newEpoch, grants },
    raw,
    epoch: await importEpochKey(raw, newEpoch, true),
  };
}
