import {
  ApiError,
  DESKTOP_ROLES,
  HUMAN_ROLES,
  LIMITS,
  type PhoneImageBinding,
  type Role,
} from '@daintreehq/decisions-protocol';
import { deviceFeatures } from '../routes/devices.js';
import type { Room } from './types.js';

/*
 * Phone images (docs/protocol.md section 17). A phone reserves each image for one answer or message on an
 * existing question, uploads and completes it, then lists its id in the signed record. Nothing can read an image
 * until that record commits; the commit binds every listed image or none.
 */

interface PhoneImageRow {
  attachment_id: string;
  kind: string;
  state: string;
  creator_device_id: string;
  question_id: string;
  binding_kind: string | null;
  binding_record_id: string | null;
  bound: number;
  created_at: number;
}

/**
 * Uploads and completions share one route for both kinds of image, so the reservation's kind decides who may
 * touch it: a desktop for question images, a phone or tablet for phone images. Checked before ownership, so a
 * device of the other family is refused as a role (403), exactly as when the route admitted desktops only.
 */
export function assertUploaderRole(kind: string, role: Role): void {
  const roles = kind === 'phone' ? HUMAN_ROLES : DESKTOP_ROLES;
  if (!roles.includes(role)) throw new ApiError('forbidden', `role ${role} may not do this`);
}

/** The question's publishing desktop must understand images, or it would type the text and drop them. */
export function assertPublisherTakesImages(room: Room, publisherDeviceId: string): void {
  if (!deviceFeatures(room, publisherDeviceId).includes('phone-images-v1'))
    throw new ApiError('invalid_state', "the question's desktop does not accept phone images");
}

/**
 * Binds the phone images a committing answer or message lists. Call it inside the committing `room.tx`, after
 * every other check: it throws before writing anything unless each id is a completed phone image that the signer
 * reserved for this question and exactly this record, not yet bound and not past its orphan deadline. Retention
 * runs from the commit (`retainMs` later), whatever the question's status does afterwards.
 */
export function bindPhoneImages(
  room: Room,
  a: {
    questionId: string;
    signerDeviceId: string;
    binding: PhoneImageBinding;
    ids: readonly string[];
    publisherDeviceId: string;
    t: number;
    retainMs: number;
  },
): void {
  if (a.ids.length === 0) return;
  const bad = (m: string) => new ApiError('validation_error', m);
  if (new Set(a.ids).size !== a.ids.length) throw bad('duplicate attachment id');
  assertPublisherTakesImages(room, a.publisherDeviceId);
  for (const id of a.ids) {
    const r = room.q1<PhoneImageRow>(
      `SELECT attachment_id, kind, state, creator_device_id, question_id, binding_kind, binding_record_id, bound,
         created_at FROM attachments WHERE attachment_id = ?`,
      id,
    );
    if (
      !r ||
      r.kind !== 'phone' ||
      r.state !== 'available' ||
      r.creator_device_id !== a.signerDeviceId ||
      r.question_id !== a.questionId ||
      r.binding_kind !== a.binding.kind ||
      r.binding_record_id !== a.binding.record_id ||
      r.bound ||
      r.created_at + LIMITS.phoneImageOrphanMs <= a.t
    ) {
      throw bad(`image ${id} is not an uploaded image reserved for this ${a.binding.kind}`);
    }
  }
  const deleteAfter = a.t + a.retainMs;
  for (const id of a.ids) {
    room.run(
      `UPDATE attachments SET bound = 1, bound_at = ?, delete_after = ? WHERE attachment_id = ?`,
      a.t,
      deleteAfter,
      id,
    );
    // Keyed by the image alone, so the question's own job cancellations (answer, cancel, expiry) never touch it.
    room.schedule({ kind: 'delete_phone_image', runAt: deleteAfter, attachmentId: id });
  }
}
