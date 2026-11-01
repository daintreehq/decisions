import type {
  CryptoEnvelope,
  DecisionContentV1,
  EnvelopePurpose,
} from '@daintreehq/decisions-protocol';
import { decryptEnvelope, encryptEnvelope } from '@daintreehq/decisions-crypto';
import {
  ANSWER_CONTENT_FIELDS,
  EMPTY_ANSWER_CONTENT,
  hasLegacyContent,
  legacyContent,
  parseAnswers,
  serializeAnswers,
  type AnswerContent,
  type AnswerEntry,
  type OpenAnswerEntry,
} from './answers.js';
import { currentEpochKey, type Identity } from './identity.js';
import { TransientError, type Mutex } from './mutex.js';
import type { LocalStore } from './store.js';
import type { OutboxItem, QuestionRow } from './types.js';

/**
 * Question and answer content at rest.
 *
 * The local store never holds question text, context, option labels or answer text in clear. Content is
 * sealed with the same envelope scheme the relay protocol uses (AES-256-GCM under a key derived from the
 * installation's epoch key, which lives only in the identity), so the store holds ciphertext and origin
 * metadata and nothing a stolen database file could be read with:
 *
 * - A question's content is the envelope it was published with: byte for byte the ciphertext the relay holds.
 * - An answer's content is sealed locally when the verified answer is applied (`local-answer`), so an
 *   undelivered answer survives a restart and is opened again in memory when it is typed.
 * - A proxy answer waiting in the outbox is sealed until it is signed for sending (`local-proxy-draft`).
 * - Imported and migrated questions are sealed locally (`local-question`).
 *
 * Local seals use record types the relay never accepts, so a local blob can never pass as a relay record.
 * Old epoch keys stay in the identity, so content sealed before a key rotation stays readable.
 */

export const LOCAL_RECORD = {
  question: 'local-question',
  answer: 'local-answer',
  proxyDraft: 'local-proxy-draft',
} as const;

/** What sealing needs: the identity holding the epoch keys, and a way to reload it after a rotation. */
export interface SealContext {
  identity: Identity;
  refreshIdentity?: () => Promise<void>;
}

/** The sealed content could not be opened (corrupt, or sealed under a key this identity does not hold). */
export class SealedContentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SealedContentError';
  }
}

async function seal(
  ctx: SealContext,
  b: {
    questionId: string;
    recordId: string;
    recordType: string;
    revision: number;
    purpose: EnvelopePurpose;
  },
  plaintext: unknown,
): Promise<string> {
  const id = ctx.identity;
  const env = await encryptEnvelope({
    epochKey: currentEpochKey(id),
    installationId: id.config.installationId,
    questionId: b.questionId,
    recordId: b.recordId,
    recordType: b.recordType,
    revision: b.revision,
    senderDeviceId: id.config.deviceId,
    purpose: b.purpose,
    plaintext,
  });
  return JSON.stringify(env);
}

async function open<T>(
  ctx: SealContext,
  sealed: string,
  want: {
    questionId: string;
    recordId: string;
    recordTypes: readonly string[];
    purpose: EnvelopePurpose;
  },
): Promise<T> {
  let env: CryptoEnvelope;
  try {
    env = JSON.parse(sealed) as CryptoEnvelope;
  } catch {
    throw new SealedContentError('sealed content is not an envelope');
  }
  // The visible binding must be exactly what this row expects: a blob moved from another row or record
  // fails here (and the AEAD fails for anything altered).
  if (
    !env ||
    typeof env !== 'object' ||
    !env.aad ||
    env.record_id !== want.recordId ||
    !want.recordTypes.includes(env.aad.record_type)
  ) {
    throw new SealedContentError('sealed content belongs to another record');
  }
  const binding = {
    installationId: ctx.identity.config.installationId,
    questionId: want.questionId,
    purpose: want.purpose,
  };
  if (!ctx.identity.epochs.has(env.key_epoch)) {
    // Rotated by another process: reload the key material once before giving up.
    await ctx.refreshIdentity?.();
    if (!ctx.identity.epochs.has(env.key_epoch))
      throw new TransientError(`missing epoch key ${env.key_epoch}`);
  }
  try {
    return await decryptEnvelope<T>(env, ctx.identity.epochs, binding);
  } catch (e) {
    throw new SealedContentError(`sealed content could not be opened: ${(e as Error).message}`);
  }
}

/* ---------------- questions ---------------- */

/** Seal question content locally (imports, migrated rows). Published questions keep their relay envelope. */
export function sealQuestionContent(
  ctx: SealContext,
  questionId: string,
  content: unknown,
): Promise<string> {
  return seal(
    ctx,
    {
      questionId,
      recordId: questionId,
      recordType: LOCAL_RECORD.question,
      revision: 0,
      purpose: 'question-content',
    },
    content,
  );
}

/**
 * The question's content, decrypted in memory. Null when the row has none. Throws `SealedContentError` if it
 * cannot be opened, or `TransientError` if the epoch key it needs is not (yet) in the identity.
 */
export async function openQuestionContent(
  ctx: SealContext,
  row: Pick<QuestionRow, 'question_id' | 'content_sealed' | 'legacy_content_json'>,
): Promise<DecisionContentV1 | null> {
  if (row.content_sealed) {
    return open<DecisionContentV1>(ctx, row.content_sealed, {
      questionId: row.question_id,
      recordId: row.question_id,
      recordTypes: ['question', LOCAL_RECORD.question],
      purpose: 'question-content',
    });
  }
  if (row.legacy_content_json) {
    try {
      return JSON.parse(row.legacy_content_json) as DecisionContentV1;
    } catch {
      return null;
    }
  }
  return null;
}

/* ---------------- answers ---------------- */

/** Seal one answer's content for storage in its entry. */
export function sealAnswerContent(
  ctx: SealContext,
  questionId: string,
  entryId: string,
  revision: number,
  content: AnswerContent,
): Promise<string> {
  const c: AnswerContent = {
    choices: content.choices,
    text: content.text,
    reviewed_attachment_digests: content.reviewed_attachment_digests,
    ...(content.confidence !== undefined ? { confidence: content.confidence } : {}),
    ...(content.model_id ? { model_id: content.model_id } : {}),
  };
  return seal(
    ctx,
    {
      questionId,
      recordId: entryId,
      recordType: LOCAL_RECORD.answer,
      revision,
      purpose: 'answer-content',
    },
    c,
  );
}

/** One answer's content, decrypted in memory. Entries without content (expiry notices) open as empty. */
export async function openAnswerContent(
  ctx: SealContext,
  questionId: string,
  e: AnswerEntry,
): Promise<AnswerContent> {
  if (e.sealed) {
    const c = await open<Partial<AnswerContent>>(ctx, e.sealed, {
      questionId,
      recordId: e.entry_id,
      recordTypes: [LOCAL_RECORD.answer],
      purpose: 'answer-content',
    });
    return {
      choices: Array.isArray(c.choices) ? c.choices : [],
      text: typeof c.text === 'string' ? c.text : '',
      reviewed_attachment_digests: Array.isArray(c.reviewed_attachment_digests)
        ? c.reviewed_attachment_digests
        : [],
      ...(typeof c.confidence === 'number' ? { confidence: c.confidence } : {}),
      ...(typeof c.model_id === 'string' && c.model_id ? { model_id: c.model_id } : {}),
    };
  }
  if (hasLegacyContent(e)) return legacyContent(e);
  return { ...EMPTY_ANSWER_CONTENT, choices: [], reviewed_attachment_digests: [] };
}

/** Strip any clear-text content fields an entry carries, leaving only bookkeeping and the seal. */
export function storedEntry(e: AnswerEntry | OpenAnswerEntry, sealed: string | null): AnswerEntry {
  const r = { ...(e as unknown as Record<string, unknown>) };
  for (const k of ANSWER_CONTENT_FIELDS) delete r[k];
  return { ...(r as unknown as AnswerEntry), sealed };
}

/** Every entry of a row with its content opened, oldest first. */
export async function openAnswers(
  ctx: SealContext,
  row: Pick<QuestionRow, 'question_id' | 'answers_json'>,
): Promise<OpenAnswerEntry[]> {
  const out: OpenAnswerEntry[] = [];
  for (const e of parseAnswers(row.answers_json)) {
    const content = await openAnswerContent(ctx, row.question_id, e);
    const { sealed: _sealed, ...rest } = storedEntry(e, null);
    void _sealed;
    out.push({ ...rest, ...content });
  }
  return out;
}

/* ---------------- proxy drafts in the outbox ---------------- */

export function sealProxyDraft(
  ctx: SealContext,
  questionId: string,
  outboxId: string,
  content: unknown,
): Promise<string> {
  return seal(
    ctx,
    {
      questionId,
      recordId: outboxId,
      recordType: LOCAL_RECORD.proxyDraft,
      revision: 0,
      purpose: 'answer-content',
    },
    content,
  );
}

export function openProxyDraft(
  ctx: SealContext,
  questionId: string,
  outboxId: string,
  sealed: string,
): Promise<Record<string, unknown>> {
  return open<Record<string, unknown>>(ctx, sealed, {
    questionId,
    recordId: outboxId,
    recordTypes: [LOCAL_RECORD.proxyDraft],
    purpose: 'answer-content',
  });
}

/* ---------------- sealing rows written before content was sealed ---------------- */

export interface SealStoredContentResult {
  /** Questions whose content or answers were sealed. */
  questions: number;
  /** Outbox items whose queued proxy draft was sealed. */
  outbox: number;
}

/**
 * Seal every row a pre-sealing store still holds in clear: question content, answer entries and queued proxy
 * drafts. Idempotent and cheap when there is nothing to do; when something was sealed the store is compacted
 * so freed pages cannot retain the old plaintext. The bridge runs this on start, and the CLI whenever it opens
 * a store; a host that reads the store without a bridge should call it after opening.
 */
export async function sealStoredContent(
  ctx: SealContext & { store: LocalStore; lock?: Mutex },
): Promise<SealStoredContentResult> {
  const run = <T>(fn: () => Promise<T>) => (ctx.lock ? ctx.lock.run(fn) : fn());
  return run(async () => {
    const { store } = ctx;
    let questions = 0;
    let outbox = 0;
    for (const row of await store.listQuestions()) {
      const patch: Partial<QuestionRow> = {};
      if (row.legacy_content_json != null) {
        if (!row.content_sealed) {
          let content: unknown = null;
          try {
            content = JSON.parse(row.legacy_content_json);
          } catch {
            /* unreadable legacy content: nothing worth keeping */
          }
          if (content !== null) {
            patch.content_sealed = await sealQuestionContent(ctx, row.question_id, content);
          }
        }
        patch.legacy_content_json = null;
      }
      const entries = parseAnswers(row.answers_json);
      if (entries.some(hasLegacyContent)) {
        const sealed: AnswerEntry[] = [];
        for (const e of entries) {
          if (!hasLegacyContent(e)) {
            sealed.push(e);
            continue;
          }
          const s =
            e.sealed ??
            (e.kind === 'answer'
              ? await sealAnswerContent(
                  ctx,
                  row.question_id,
                  e.entry_id,
                  e.revision,
                  legacyContent(e),
                )
              : null);
          sealed.push(storedEntry(e, s));
        }
        patch.answers_json = serializeAnswers(sealed);
      }
      if (Object.keys(patch).length > 0) {
        await store.updateQuestion(row.question_id, patch);
        questions++;
      }
    }
    for (const item of await store.dueOutbox(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)) {
      if (item.kind !== 'proxy-answer') continue;
      const p = item.payload as { content?: unknown; sealed?: string } | null;
      if (!p || p.content === undefined) continue;
      const next: Record<string, unknown> = { ...p };
      delete next.content;
      if (!p.sealed) next.sealed = await sealProxyDraft(ctx, item.question_id, item.id, p.content);
      await store.putOutbox({ ...item, payload: next } satisfies OutboxItem);
      outbox++;
    }
    if (questions + outbox > 0) await store.compact?.();
    return { questions, outbox };
  });
}
