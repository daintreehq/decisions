/**
 * Durable Object SQLite schema. Versioned and idempotent: `migrate()` only ever moves forward, each step
 * runs inside the object's implicit transaction, and old columns are never dropped (rolling deploys must
 * keep working). Timestamps are epoch milliseconds (INTEGER); ISO strings are produced at the edge.
 */
export const SCHEMA_VERSION = 4;

const V1 = [
  `CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS devices (
    device_id TEXT PRIMARY KEY,
    role TEXT NOT NULL CHECK(role IN ('owner-desktop','desktop-host','phone','tablet')),
    label TEXT NOT NULL,
    signing_pub TEXT NOT NULL,
    exchange_pub TEXT NOT NULL,
    cert_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    revoked_at INTEGER,
    last_seen_at INTEGER,
    last_ack_seq INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS device_key_grants (
    device_id TEXT NOT NULL,
    key_epoch INTEGER NOT NULL,
    grant_json TEXT NOT NULL,
    PRIMARY KEY (device_id, key_epoch)
  )`,
  `CREATE TABLE IF NOT EXISTS questions (
    question_id TEXT PRIMARY KEY,
    creator_device_id TEXT NOT NULL,
    target_host_id TEXT NOT NULL,
    origin_ref TEXT NOT NULL,
    requirement TEXT NOT NULL CHECK(requirement IN ('human-required','proxy-ok','proxy-first')),
    status TEXT NOT NULL DEFAULT 'open'
      CHECK(status IN ('open','proxy-answered','human-answered','cancelled','expired')),
    revision INTEGER NOT NULL DEFAULT 0,
    proxy_abstained INTEGER NOT NULL DEFAULT 0,
    key_epoch INTEGER NOT NULL,
    record_json TEXT NOT NULL,
    envelope_json TEXT NOT NULL,
    envelope_digest TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER,
    resolved_at INTEGER,
    last_event_seq INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE INDEX IF NOT EXISTS questions_status_idx ON questions(status, created_at)`,
  `CREATE INDEX IF NOT EXISTS questions_origin_idx ON questions(origin_ref, status)`,
  `CREATE INDEX IF NOT EXISTS questions_created_idx ON questions(created_at DESC, question_id DESC)`,
  `CREATE TABLE IF NOT EXISTS actions (
    action_id TEXT PRIMARY KEY,
    question_id TEXT NOT NULL,
    action TEXT NOT NULL,
    revision INTEGER NOT NULL,
    provenance TEXT CHECK(provenance IN ('human','proxy')),
    actor_device_id TEXT NOT NULL,
    record_json TEXT NOT NULL,
    envelope_json TEXT,
    created_at INTEGER NOT NULL,
    event_seq INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS actions_question_idx ON actions(question_id, event_seq)`,
  `CREATE TABLE IF NOT EXISTS events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL UNIQUE,
    event_type TEXT NOT NULL,
    question_id TEXT,
    question_revision INTEGER,
    origin_device_id TEXT,
    data TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS events_question_idx ON events(question_id)`,
  `CREATE TABLE IF NOT EXISTS command_receipts (
    device_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    request_digest TEXT NOT NULL,
    status INTEGER NOT NULL,
    response_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (device_id, idempotency_key)
  )`,
  `CREATE TABLE IF NOT EXISTS request_nonces (
    device_id TEXT NOT NULL,
    nonce TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    PRIMARY KEY (device_id, nonce)
  )`,
  `CREATE INDEX IF NOT EXISTS nonces_exp_idx ON request_nonces(expires_at)`,
  `CREATE TABLE IF NOT EXISTS rate_limits (
    key TEXT PRIMARY KEY,
    window_start INTEGER NOT NULL,
    count INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS tickets (
    ticket_hash TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK(kind IN ('ws','voice')),
    device_id TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}',
    expires_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS push_subscriptions (
    subscription_id TEXT PRIMARY KEY,
    device_id TEXT NOT NULL,
    endpoint TEXT NOT NULL,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    last_success_at INTEGER,
    last_error_code TEXT,
    UNIQUE(device_id, endpoint)
  )`,
  `CREATE TABLE IF NOT EXISTS attachments (
    attachment_id TEXT PRIMARY KEY,
    question_id TEXT NOT NULL,
    creator_device_id TEXT NOT NULL,
    object_key TEXT NOT NULL UNIQUE,
    ciphertext_bytes INTEGER NOT NULL,
    sha256_ciphertext TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('reserved','uploading','uploaded','available','deleted')),
    bound INTEGER NOT NULL DEFAULT 0,
    upload_expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    delete_after INTEGER,
    deleted_at INTEGER,
    object_deleted INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE INDEX IF NOT EXISTS attachments_question_idx ON attachments(question_id)`,
  `CREATE TABLE IF NOT EXISTS scheduled_jobs (
    job_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    question_id TEXT,
    attachment_id TEXT,
    payload TEXT NOT NULL DEFAULT '{}',
    run_at INTEGER NOT NULL,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','done','cancelled','failed'))
  )`,
  `CREATE INDEX IF NOT EXISTS jobs_due_idx ON scheduled_jobs(status, run_at)`,
  `CREATE INDEX IF NOT EXISTS jobs_question_idx ON scheduled_jobs(question_id, status)`,
  `CREATE TABLE IF NOT EXISTS deliveries (
    question_id TEXT NOT NULL,
    answer_revision INTEGER NOT NULL,
    target_host_id TEXT NOT NULL,
    event_seq INTEGER NOT NULL,
    status TEXT NOT NULL,
    received_at INTEGER,
    terminal_delivered_at INTEGER,
    injection_id TEXT,
    error_code TEXT,
    PRIMARY KEY (question_id, answer_revision, target_host_id)
  )`,
  `CREATE INDEX IF NOT EXISTS deliveries_status_idx ON deliveries(status, event_seq)`,
  `CREATE TABLE IF NOT EXISTS pairing_sessions (
    pairing_id TEXT PRIMARY KEY,
    role TEXT NOT NULL,
    invite_digest TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    state TEXT NOT NULL DEFAULT 'waiting-for-candidate'
      CHECK(state IN ('waiting-for-candidate','pending-approval','approved','rejected')),
    candidate_json TEXT,
    cert_json TEXT,
    grant_json TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    consumed_at INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS voice_usage (
    month TEXT PRIMARY KEY,
    ms INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS voice_sessions (
    session_id TEXT PRIMARY KEY,
    device_id TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    activated_at INTEGER,
    ended_at INTEGER
  )`,
];

/**
 * Thread messages (docs/protocol.md section 16) and feature negotiation (section 19). `message_id` is unique
 * within the installation; `message_seq` orders one question's thread and is never reused, so a question's
 * lifetime message count is its highest `message_seq`. Only human messages have a delivery row.
 */
const V2 = [
  `ALTER TABLE devices ADD COLUMN features TEXT NOT NULL DEFAULT '[]'`,
  `CREATE TABLE IF NOT EXISTS messages (
    message_id TEXT PRIMARY KEY,
    question_id TEXT NOT NULL,
    message_seq INTEGER NOT NULL,
    side TEXT NOT NULL CHECK(side IN ('human','agent')),
    expects_reply INTEGER NOT NULL DEFAULT 0,
    signer_device_id TEXT NOT NULL,
    record_json TEXT NOT NULL,
    envelope_json TEXT NOT NULL,
    committed_at INTEGER NOT NULL,
    event_seq INTEGER NOT NULL,
    UNIQUE (question_id, message_seq)
  )`,
  `CREATE TABLE IF NOT EXISTS message_deliveries (
    message_id TEXT PRIMARY KEY,
    question_id TEXT NOT NULL,
    target_host_id TEXT NOT NULL,
    status TEXT NOT NULL
      CHECK(status IN ('relay-queued','received','terminal-delivered','needs-attention','delivery-uncertain')),
    received_at INTEGER,
    terminal_delivered_at INTEGER,
    injection_id TEXT,
    error_code TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS message_deliveries_question_idx ON message_deliveries(question_id)`,
];

/**
 * Pane snapshots (docs/protocol.md section 18). `question_snapshots` holds at most one row per question,
 * replaced in place. `last_observed_at` is the order watermark and outlives the snapshot it came from;
 * `sharing_off` outlives it too, until a shared snapshot arrives. `retain_until` is when the stored ciphertext
 * must go. `refresh_json` is the latest refresh request.
 */
const V3 = [
  `CREATE TABLE IF NOT EXISTS question_snapshots (
    question_id TEXT PRIMARY KEY,
    last_observed_at INTEGER,
    sharing_off INTEGER NOT NULL DEFAULT 0,
    snapshot_id TEXT,
    record_json TEXT,
    envelope_json TEXT,
    received_at INTEGER,
    retain_until INTEGER,
    refresh_json TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS question_snapshots_retain_idx ON question_snapshots(retain_until)
    WHERE retain_until IS NOT NULL`,
];

/**
 * Phone images (docs/protocol.md section 17) share the `attachments` table with the desktop's question images.
 * `kind` tells them apart; every row from before is a question image. A phone image is reserved for exactly one
 * answer or message (`binding_kind`, `binding_record_id`), and `bound_at` is when the record that lists it
 * committed: its retention runs from then, whatever the question does later.
 */
const V4 = [
  `ALTER TABLE attachments ADD COLUMN kind TEXT NOT NULL DEFAULT 'question' CHECK(kind IN ('question','phone'))`,
  `ALTER TABLE attachments ADD COLUMN binding_kind TEXT CHECK(binding_kind IN ('answer','message'))`,
  `ALTER TABLE attachments ADD COLUMN binding_record_id TEXT`,
  `ALTER TABLE attachments ADD COLUMN bound_at INTEGER`,
  `CREATE INDEX IF NOT EXISTS attachments_creator_unbound_idx ON attachments(creator_device_id, bound)`,
];

export function migrate(sql: SqlStorage): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  const row = sql.exec(`SELECT value FROM meta WHERE key = 'schema_version'`).toArray()[0] as
    { value: string } | undefined;
  const current = row ? Number(row.value) : 0;
  if (current > SCHEMA_VERSION) {
    throw new Error(`database schema ${current} is newer than this Worker (${SCHEMA_VERSION})`);
  }
  if (current < 1) for (const stmt of V1) sql.exec(stmt);
  if (current < 2) for (const stmt of V2) sql.exec(stmt);
  if (current < 3) for (const stmt of V3) sql.exec(stmt);
  if (current < 4) for (const stmt of V4) sql.exec(stmt);
  sql.exec(
    `INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    String(SCHEMA_VERSION),
  );
}
