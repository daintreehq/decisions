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
  requestSkewMs: 2 * 60 * 1000,
  nonceTtlMs: 10 * 60 * 1000,
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
