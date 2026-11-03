/** Product limits enforced identically by the MCP bridge, the PWA and the Worker. */
export const LIMITS = {
  questionChars: 8_000,
  contextBytes: 32 * 1024,
  maxOptions: 12,
  optionIdChars: 64,
  optionLabelChars: 240,
  optionDescriptionChars: 1_000,
  answerTextBytes: 16 * 1024,
  /** Max size of one encrypted envelope (base64url ciphertext), default 128 KiB of plaintext + overhead. */
  envelopeCiphertextChars: 180 * 1024,
  /** Max JSON request body for non-attachment routes. */
  jsonBodyBytes: 512 * 1024,
  attachmentBytes: 20 * 1024 * 1024,
  attachmentsPerQuestion: 8,
  attachmentTotalBytes: 64 * 1024 * 1024,
  concurrentUploads: 2,
  uploadAuthorizationMs: 10 * 60 * 1000,
  openQuestionsPerInstallation: 100,
  openQuestionsPerPane: 10,
  eventPageSize: 100,
  eventPageBytes: 256 * 1024,
  maxDevices: 12,
  deviceLabelChars: 60,
  pairingTtlMs: 5 * 60 * 1000,
  wsTicketTtlMs: 30 * 1000,
  voiceTicketTtlMs: 30 * 1000,
  voiceMaxSessionMs: 5 * 60 * 1000,
  voiceCorrectionChars: 16_000,
  /** The question context a cleanup request carries; the cleanup keeps only the newest 3000 characters anyway. */
  voiceCleanupContextChars: 3_000,
  voiceCleanupPrecedingChars: 500,
  requestSkewMs: 2 * 60 * 1000,
  nonceTtlMs: 10 * 60 * 1000,
  /** A finite question expiry is at most this far after the relay receives the question (or its reopen). */
  maxQuestionExpiryMs: 366 * 24 * 60 * 60 * 1000,
} as const;

export const DEFAULTS = {
  questionExpiryMs: 7 * 24 * 60 * 60 * 1000,
  firstReminderMs: 4 * 60 * 60 * 1000,
  reminderIntervalMs: 24 * 60 * 60 * 1000,
  maxReminders: 3,
  proxyReviewReminderMs: 24 * 60 * 60 * 1000,
  attachmentRetentionMs: 30 * 24 * 60 * 60 * 1000,
  jobBackoffBaseMs: 1_000,
  jobBackoffMaxMs: 5 * 60 * 1000,
} as const;

/**
 * How long one dictation cleanup may take, retry included: 7 s for a short passage and from 15 s for a long one,
 * plus 4 s when the model reasons first (Daintree desktop's budget). Shared so the phone waits a little longer
 * than the Worker does.
 */
export function voiceCleanupTimeoutMs(chars: number, reasoning: boolean): number {
  const extra = reasoning ? 4_000 : 0;
  if (chars < 140) return 7_000 + extra;
  return Math.min(60_000, 15_000 + Math.max(0, chars - 1000) * 5 + extra);
}
