import {
  imagesMatchRecord,
  type ImageMime,
  type PhoneImageReference,
} from '@daintreehq/decisions-protocol';
import { decryptAttachment, sha256Hex, sniffImageMime } from '@daintreehq/decisions-crypto';
import type { BridgeContext } from './context.js';
import { RelayError } from './errors.js';
import { isTypablePath } from './notice.js';
import type { QuestionOrigin } from './types.js';

/*
 * Phone images (protocol section 17) on their way to the agent. A person can attach photos to an answer or a
 * follow-up message; only the host knows where the agent in a pane can read a file, so the library fetches the
 * ciphertext, decrypts it, checks it, and hands the plaintext to the host's `PhoneImageStore`, which says where
 * it put it. The block typed into the pane lists that path, or why the image is unavailable. An image never
 * holds back the words it came with.
 */

/** The answer or message an image belongs to. */
export type PhoneImageCarrier =
  { kind: 'answer'; actionId: string } | { kind: 'message'; messageId: string };

/** One verified phone image, handed to the host. The library keeps no copy of the bytes. */
export interface PhoneImageFile {
  questionId: string;
  carrier: PhoneImageCarrier;
  /** Where the asking pane is (local only): what the host needs to put the file where that agent can read it. */
  origin: QuestionOrigin;
  attachmentId: string;
  /** SHA-256 (hex) of `bytes`: the digest the person's phone signed, checked against the decrypted image. */
  sha256: string;
  /** The image type, declared by the phone and confirmed from the bytes. */
  mime: ImageMime;
  /** The person's description of the image, as they wrote it (untrusted text). */
  alt?: string;
  bytes: Uint8Array;
}

/**
 * The host seam: where phone images go on the host's disk. Without one, every image is listed as unavailable
 * (`no_image_store`) and the words are delivered as usual.
 *
 * - `store` writes the image somewhere the agent in `origin`'s pane can read it and resolves with that path.
 *   Where is the host's choice; the library never writes a file itself, and never into the project tree.
 * - It must be idempotent per `(questionId, attachmentId)`: a crash between storing and delivering calls it again
 *   for the same image, and it should return the same path rather than write a second copy.
 * - The path is typed into the pane as given, so it must be one line of at most `MAX_IMAGE_PATH_BYTES` UTF-8
 *   bytes with no control characters; anything else is reported as `store_failed`. It is also kept in the local
 *   store, in clear, as delivery bookkeeping (so a retried delivery reuses the file), so it must not carry the
 *   alt text or other content.
 * - A rejection lists the image as unavailable (`store_failed`).
 * - The file must stay readable while the answer may still be delivered; removing it later is the host's call.
 */
export interface PhoneImageStore {
  store(image: PhoneImageFile): Promise<{ path: string }>;
}

/** Why an image is listed as unavailable in the typed block. Stable: hosts and agents may match on them. */
export type PhoneImageUnavailableReason =
  /** The content's images are not exactly the ones the phone signed into the record. Nothing is fetched. */
  | 'record_mismatch'
  /** The image is encrypted under a key epoch this device does not hold. */
  | 'key_unavailable'
  /** The relay did not serve the ciphertext (gone, not yet uploaded, past retention, or unreachable). */
  | 'fetch_failed'
  /** The ciphertext is not the size the reference declares. */
  | 'size_mismatch'
  /** The ciphertext does not decrypt under the image's binding. */
  | 'decrypt_failed'
  /** The decrypted image does not hash to the digest the phone signed. */
  | 'digest_mismatch'
  /** The decrypted bytes are not a PNG, JPEG or WebP image. */
  | 'unsupported_type'
  /** The decrypted image is a different type from the one declared. */
  | 'type_mismatch'
  /** The host has no `PhoneImageStore`. */
  | 'no_image_store'
  /** The host's store rejected the image or returned a path that cannot be typed. */
  | 'store_failed';

/** One image as the block lists it: the stored path, or why there is none. */
export type ResolvedPhoneImage =
  | { attachmentId: string; alt?: string; path: string }
  | { attachmentId: string; alt?: string; unavailable: PhoneImageUnavailableReason };

/** AES-GCM appends a 16-byte tag: the ciphertext is exactly this much longer than the image. */
const GCM_TAG_BYTES = 16;

export interface ResolvePhoneImagesInput {
  questionId: string;
  carrier: PhoneImageCarrier;
  origin: QuestionOrigin;
  /** The image ids the signed record lists (`ActionRecord.attachment_ids` or `MessageRecord.attachment_ids`). */
  signedIds: readonly string[];
  /** The image references in the decrypted content, in the order the person attached them. */
  images: readonly PhoneImageReference[];
  /** Paths the host already returned for this carrier, by attachment id: reused without a fetch or a write. */
  stored?: ReadonlyMap<string, string>;
}

const withAlt = (alt: string | undefined) => (alt ? { alt } : {});

/**
 * Fetch, decrypt and check each image, then hand it to the host. Never throws: each image comes back with a path
 * or an `unavailable` reason, in the content's order, so the words are always delivered.
 *
 * Checks, in order: the content's images are exactly the signed ones (`imagesMatchRecord`); the key epoch is
 * held; the ciphertext is exactly the declared size plus the tag (never reading more); it decrypts under the
 * image's binding; the plaintext hashes to the signed digest; its bytes are a PNG, JPEG or WebP image of the
 * declared type. Only then does the host see it.
 */
export async function resolvePhoneImages(
  ctx: Pick<BridgeContext, 'identity' | 'client' | 'refreshIdentity'>,
  store: PhoneImageStore | undefined,
  i: ResolvePhoneImagesInput,
): Promise<ResolvedPhoneImage[]> {
  if (!imagesMatchRecord(i.signedIds, i.images)) {
    // List everything either side names, and fetch nothing: the phone's content and signature disagree.
    const named = new Set(i.images.map((m) => m.attachment_id));
    return [
      ...i.images.map((m) => ({
        attachmentId: m.attachment_id,
        ...withAlt(m.alt),
        unavailable: 'record_mismatch' as const,
      })),
      ...[...new Set(i.signedIds)]
        .filter((id) => !named.has(id))
        .map((id) => ({ attachmentId: id, unavailable: 'record_mismatch' as const })),
    ];
  }
  const out: ResolvedPhoneImage[] = [];
  for (const image of i.images) {
    const known = i.stored?.get(image.attachment_id);
    if (known !== undefined && isTypablePath(known)) {
      out.push({ attachmentId: image.attachment_id, ...withAlt(image.alt), path: known });
      continue;
    }
    const r = await resolveOne(ctx, store, i, image);
    out.push(
      typeof r === 'string'
        ? { attachmentId: image.attachment_id, ...withAlt(image.alt), unavailable: r }
        : { attachmentId: image.attachment_id, ...withAlt(image.alt), path: r.path },
    );
  }
  return out;
}

async function resolveOne(
  ctx: Pick<BridgeContext, 'identity' | 'client' | 'refreshIdentity'>,
  store: PhoneImageStore | undefined,
  i: ResolvePhoneImagesInput,
  image: PhoneImageReference,
): Promise<PhoneImageUnavailableReason | { path: string }> {
  // Nothing to hand it to: don't fetch an image only to drop it.
  if (!store) return 'no_image_store';
  let key = ctx.identity.epochs.get(image.key_epoch);
  if (!key && ctx.refreshIdentity) {
    try {
      await ctx.refreshIdentity();
    } catch {
      /* still missing below */
    }
    key = ctx.identity.epochs.get(image.key_epoch);
  }
  if (!key) return 'key_unavailable';

  const expected = image.size + GCM_TAG_BYTES;
  let ciphertext: Uint8Array;
  try {
    ciphertext = await ctx.client.downloadAttachment(image.attachment_id, { maxBytes: expected });
  } catch (e) {
    return e instanceof RelayError && e.code === 'payload_too_large'
      ? 'size_mismatch'
      : 'fetch_failed';
  }
  if (ciphertext.length !== expected) return 'size_mismatch';

  let bytes: Uint8Array;
  try {
    bytes = await decryptAttachment(
      key,
      {
        installationId: ctx.identity.config.installationId,
        questionId: i.questionId,
        attachmentId: image.attachment_id,
        keyEpoch: image.key_epoch,
      },
      image.nonce,
      ciphertext,
    );
  } catch {
    return 'decrypt_failed';
  }
  if ((await sha256Hex(bytes)) !== image.sha256.toLowerCase()) return 'digest_mismatch';
  const sniffed = sniffImageMime(bytes);
  if (!sniffed) return 'unsupported_type';
  if (sniffed !== image.mime) return 'type_mismatch';

  let stored: { path: string };
  try {
    stored = await store.store({
      questionId: i.questionId,
      carrier: i.carrier,
      origin: i.origin,
      attachmentId: image.attachment_id,
      sha256: image.sha256.toLowerCase(),
      mime: sniffed,
      ...withAlt(image.alt),
      bytes,
    });
  } catch {
    return 'store_failed';
  }
  const path = (stored as { path?: unknown } | null | undefined)?.path;
  return isTypablePath(path) ? { path } : 'store_failed';
}
