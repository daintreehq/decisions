import {
  ApiError,
  InvolvementBody,
  involvementWriteIssue,
  type InvolvementReceipt,
  type InvolvementRecord,
  type InvolvementResponse,
} from '@daintreehq/decisions-protocol';
import { sha256Hex, verifyObject } from '@daintreehq/decisions-crypto';
import type { Handler, Room, RouteCtx } from '../room/types.js';
import { iso, json, nowMs, type ApiResponse } from '../util.js';
import { priorReceipt, storeReceipt } from './receipts.js';

/*
 * The involvement preference (docs/protocol.md section 20): a phone, a tablet or the owner desktop replaces it
 * (never a `desktop-host`), every paired device reads it. The relay keeps the latest signed record and nothing
 * older, and tells declaring clients with a content-free hint that replaces the previous one. Reading it creates
 * nothing.
 */

/** The `meta` key holding `{ record, received_at }`. */
export const INVOLVEMENT_META = 'involvement';

interface StoredInvolvement {
  record: InvolvementRecord;
  /** Relay time, epoch ms. */
  received_at: number;
}

export function storedInvolvement(room: Room): StoredInvolvement | null {
  const raw = room.getMeta(INVOLVEMENT_META);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredInvolvement;
  } catch {
    return null;
  }
}

/** The idempotency digest covers the route as well as the body, as the snapshot routes' does. */
async function commandDigest(c: RouteCtx): Promise<string> {
  return sha256Hex(`${c.req.method} ${c.req.path}\n${await c.bodyDigest()}`);
}

/* ---------------- GET /involvement ---------------- */

export const getInvolvement: Handler = async (room) => {
  const s = storedInvolvement(room);
  return json(200, {
    preference: s?.record ?? null,
    received_at: s ? iso(s.received_at) : null,
  } satisfies InvolvementResponse);
};

/* ---------------- PUT /involvement ---------------- */

export const putInvolvement: Handler = async (room, c) => {
  const auth = c.auth!;
  const body = c.body(InvolvementBody);
  const record = body.preference;
  const bad = (m: string) => new ApiError('validation_error', m);
  if (record.installation_id !== auth.installationId || record.signer_device_id !== auth.deviceId) {
    throw bad('record does not belong to the authenticated device');
  }
  const signer = room.getDevice(auth.deviceId)!;
  if (!(await verifyObject(await room.devicePublicKey(signer), record)))
    throw bad('record signature invalid');
  const digest = await commandDigest(c);

  return room.tx((): ApiResponse => {
    // Everything above awaited: re-check the actor, the revision and the end time in the final section.
    room.assertActive(auth.deviceId);
    const retry = priorReceipt(room, auth.deviceId, body.idempotency_key, digest);
    if (retry) return retry;
    const t = nowMs();
    const issue = involvementWriteIssue(record, t);
    if (issue) throw bad(issue);
    const latest = storedInvolvement(room)?.record.revision ?? 0;
    if (record.revision !== latest + 1) {
      throw new ApiError('revision_conflict', 'the involvement preference changed', {
        details: { latest_revision: latest },
      });
    }
    room.setMeta(INVOLVEMENT_META, JSON.stringify({ record, received_at: t }));
    // A hint only says "fetch the current preference": the one before it tells nobody anything.
    room.run(`DELETE FROM events WHERE event_type = 'involvement.updated'`);
    const ev = room.emit('involvement.updated', {
      deviceId: auth.deviceId,
      data: { revision: record.revision },
    });
    return storeReceipt(
      room,
      auth.deviceId,
      body.idempotency_key,
      digest,
      json(200, { revision: record.revision, event_seq: ev.seq } satisfies InvolvementReceipt),
    );
  });
};
