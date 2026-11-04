import { knownFeatures, type ProtocolFeature } from '@daintreehq/decisions-protocol';
import type { DeviceRow } from './types.js';

/*
 * Feature negotiation (docs/protocol.md section 19). A client declares what it understands per socket ticket and
 * per `GET /events` request; the device row keeps the latest socket-ticket declaration for `GET /devices` and for
 * the relay's own checks.
 */

/** A device's stored declaration (`devices.features`, a JSON array): the tokens as sent, unknown ones too. */
export function storedFeatures(raw: string | null | undefined): string[] {
  try {
    const v = JSON.parse(raw ?? '[]') as unknown;
    return Array.isArray(v) ? v.filter((t): t is string => typeof t === 'string') : [];
  } catch {
    return [];
  }
}

/** Whether an active device declared `feature` on its latest socket ticket. */
export function deviceHasFeature(
  d: Pick<DeviceRow, 'features' | 'revoked_at'> | undefined,
  feature: ProtocolFeature,
): boolean {
  return Boolean(
    d && d.revoked_at === null && knownFeatures(storedFeatures(d.features)).has(feature),
  );
}
