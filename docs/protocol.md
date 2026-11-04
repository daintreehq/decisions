# Decisions relay protocol (v1)

This is the normative description of the wire protocol between a **desktop** (the Daintree installation, the
owner authority), one or more **phones/tablets** (the PWA) and the **relay** (the Cloudflare Worker + Durable
Object). It is deliberately not Cloudflare-specific: any server that implements it is a valid relay. The
machine-readable schemas live in [`packages/protocol`](../packages/protocol/src) (`schema.ts`, `api.ts`) and are
the source of truth; this document explains the semantics.

Everything marked **MUST** is covered by tests in `worker/tests` and `packages/*/tests`.

## 1. Versions and fail-closed behaviour

| Field                      | Value                                            | Meaning                                                          |
| -------------------------- | ------------------------------------------------ | ---------------------------------------------------------------- |
| `protocol_version`         | `1`                                              | Wire/API major. Unknown majors fail with `426 upgrade_required`. |
| `crypto_version` / `suite` | `1` / `P256-ECDH-HKDF-SHA256-A256GCM-ECDSA-P256` | No silent mixed suites.                                          |
| API prefix                 | `/api/v1`                                        |                                                                  |

Signed JSON uses RFC 8785 (JCS) canonicalisation (`canonicalize`). Signatures are ECDSA P-256/SHA-256 in IEEE
P1363 `r‖s` form (64 bytes → 86 base64url chars). Public keys are uncompressed SEC1 points (65 bytes → 87 chars).
All binary values are unpadded base64url. All timestamps on the wire are ISO-8601 UTC with milliseconds.

## 2. Principals and roles

| Role              | Who                                              | May                                                                                                                     |
| ----------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `owner-desktop`   | The Daintree installation that claimed the relay | create questions, proxy answer/abstain, cancel, reopen, pair/revoke devices, rotate keys, read diagnostics, delete data |
| `desktop-host`    | Additional trusted desktop (a Daintree Host)     | create questions, proxy answer/abstain, cancel, delivery acks                                                           |
| `phone`, `tablet` | Paired human devices                             | answer, override, confirm-proxy, settings, push, voice                                                                  |

With the extensions in sections 16 to 18, a phone or tablet also sends human messages, attaches phone images and asks
for pane snapshots, and the desktop that published a question (its `originating_device_id`, whatever its role)
publishes that question's agent messages and pane snapshots and reports delivery of its human messages.

A role is part of the owner-signed **device certificate**; the relay and every client check it. Provenance follows
role: only `phone`/`tablet` can sign `answer`, `override` and `confirm-proxy` (**human** provenance); only
desktops sign `proxy-answer` (**proxy** provenance). A `human-required` question can never be satisfied by a proxy
(`state.ts`).

## 3. Authentication

Every authenticated request carries

```
Authorization: Decisions-Sig v=1,i=<installation_id>,d=<device_id>,t=<epoch ms>,n=<nonce b64url>,s=<signature>
```

where `s` signs `canonicalize({v, method, path, query, body_sha256, installation_id, device_id, ts, nonce})`
(`requestSigningString`). `query` is the query string with parameters sorted by key; **duplicate keys are rejected**.
`body_sha256` is lowercase hex SHA-256 of the exact body bytes (the SHA-256 of the empty string for no body).

The relay MUST: reject `|now − t| > 120 s`; reject a replayed `(device, nonce)` for 10 minutes; resolve the device
by `d`, reject revoked/unknown devices; verify the signature; apply per-device rate limits. Responses to all
authenticated routes carry `Cache-Control: no-store`.

Unauthenticated routes: `GET /health`, `GET /api/v1/info`, `POST /api/v1/setup/claim`,
`POST /api/v1/pairing/candidates`, `GET /api/v1/pairing/{id}/status` (these last three are protected by one-time
secrets and IP rate limits).

Errors are `{ "code", "message", "request_id", "retry_after_ms?", "details?" }` with the status from `ERROR_STATUS`
(`errors.ts`).

## 4. Setup and pairing

### 4.1 Claim (once)

`POST /api/v1/setup/claim` `{protocol_version, claim_secret, installation_id, cert}` where `cert` is the owner's
self-signed `owner-desktop` device certificate. The relay compares `claim_secret` in constant time to the
`CLAIM_SECRET` Worker secret, verifies the self-signature, stores the owner device, generates the VAPID key pair,
and **permanently disables claiming** (`409 already_claimed`). Returns `{installation_id, vapid_public_key, server_time}`.

The owner generates the epoch-1 content key locally; the relay never receives it.

### 4.2 Pairing a phone

1. Owner: `POST /pairing/invitations {pairing_id, invite_digest = sha256hex(secret), expires_at ≤ now+5 min, role}`.
   QR/link: `https://<relay>/pair#<base64url(PairingInvitePayload)>`. The fragment carries `{o, i, p, s, e, k, d, r}`
   (origin, installation, pairing id, 256-bit secret, expiry, **owner signing key**, owner device id, role). The
   phone pins `k`; the fragment never reaches a server.
2. Phone: generates its keys and `POST /pairing/candidates {pairing_id, secret, device_id, label, signing_pub,
exchange_pub, pop}`; `pop` signs `pairingPopString`. The relay checks `sha256(secret)`, expiry, single use, and
   returns `{pairing_id, short_code, expires_at, owner_cert, installation_id}`. The phone verifies `owner_cert`
   against the pinned key and shows the 6-digit `short_code`.
3. Owner: `GET /pairing/pending` (and a `pairing` WebSocket hint) lists candidates with the same `short_code`.
   The human compares the codes on both screens and approves: `POST /pairing/{id}/approve {cert, grant}` where
   `cert` is an owner-signed device certificate and `grant` an owner-signed epoch grant sealed to the candidate's
   exchange key. `POST /pairing/{id}/reject` aborts.
4. Phone polls `GET /pairing/{id}/status` with header `X-Pairing-Secret: <secret>` until `approved`, then verifies
   `cert`/`grant` against the pinned owner key and opens the grant with its private exchange key.

## 5. Encryption model

- One random 256-bit **epoch key** per `key_epoch`, held by the owner desktop and distributed as signed grants.
- Per-record AES-256-GCM key = `HKDF-SHA256(epoch key, salt="decisions/v1", info=envelopeKeyInfo)`; fresh random
  96-bit nonce per encryption; AAD = `envelopeAadString` binds crypto version, suite, epoch, record id, purpose,
  installation, question, record type, revision and sender device.
- Content is JSON inside a `CryptoEnvelope`. **Signed records** (`QuestionRecord`, `ActionRecord`, and the
  extensions' `MessageRecord` and `PaneSnapshotRecord`) commit to `sha256(canonicalize(envelope))`, so a relay
  cannot swap ciphertext, and carry the metadata the relay needs
  for routing (requirement, expiry, target host). Everything else — question, context, options, answers,
  attachment captions — is inside the envelope.
- Envelope purposes: `question-content`, `answer-content`, `history-export`, and for the extensions
  `message-content` (section 16) and `snapshot-content` (section 18). Message and snapshot envelopes set
  `aad.revision` to 0: neither belongs to an answer revision.
- Attachments are encrypted separately (`encryptAttachment`): one AES-GCM blob per image; the nonce, plaintext
  SHA-256 and MIME live in the encrypted `DecisionContentV1.attachments[]` descriptor (phone images: the
  `PhoneImageReference` in answer or message content, section 17).
- Clients MUST verify record signatures against the device certificate chain (owner key pinned at pairing) before
  decrypting or acting.

## 6. Questions and actions

Lifecycle: `open → human-answered | proxy-answered | cancelled | expired`; `proxy-answered → human-answered
(override/confirm) | cancelled`; `cancelled|expired → open (reopen)`. See `state.ts` for the authoritative table.
`revision` starts at 0; answer/override/proxy-answer/confirm-proxy/reopen increment it; cancel/abstain/expire do not.
Every state-changing command carries `expected_revision` and the relay compare-and-swaps: **first human answer
wins**, later answers get `409 revision_conflict {latest_revision, status}`.

| Route                                   | Role          | Notes                                                                                           |
| --------------------------------------- | ------------- | ----------------------------------------------------------------------------------------------- |
| `POST /questions`                       | desktops      | `{protocol_version, idempotency_key, question:{record, envelope}}` → `201 CommandReceipt`       |
| `GET /questions?status=&cursor=&limit=` | any           | `QuestionList` (summaries only)                                                                 |
| `GET /questions/{id}`                   | any           | `QuestionDetail` incl. action log, attachments, deliveries                                      |
| `POST /questions/{id}/answer`           | phone, tablet | `ActionBody`; `record.action = "answer"`, `expected_revision` = revision seen                   |
| `POST /questions/{id}/override`         | phone, tablet | replace a proxy answer, or (deprecated, section 16.1) a human answer; delivered as a correction |
| `POST /questions/{id}/confirm-proxy`    | phone, tablet | human affirms the proxy answer; not re-delivered                                                |
| `POST /questions/{id}/proxy-answer`     | desktops      | rejected for `human-required`                                                                   |
| `POST /questions/{id}/proxy-abstain`    | desktops      | escalates `proxy-first`/`proxy-ok` to the human and pushes immediately                          |
| `POST /questions/{id}/cancel`           | desktops      | idempotent; cannot remove a committed human answer                                              |
| `POST /questions/{id}/reopen`           | owner-desktop | new revision, optional new `expires_at`                                                         |
| `DELETE /questions/{id}`                | owner-desktop | hard-delete question, answers, messages, attachments; emits `decision.deleted`                  |

Idempotency: a repeated `idempotency_key` with identical body returns the original receipt; a different body is
`409 idempotency_collision`. Duplicate `(question_id, action_id)` is also idempotent.

Limits (`LIMITS`): 100 open questions per installation, 10 per `origin_ref` (opaque pane hash). Default expiry is
chosen by the desktop (`expires_at`, `null` = never). A finite `expires_at` on a create or a reopen must be in the
future and at most `LIMITS.maxQuestionExpiryMs` (366 days) away. `now >= expires_at` means expired (checked lazily
on every read/write as well as by the alarm).

## 7. Event ledger and sync

Every committed transition appends an immutable `LedgerEvent` with a monotonically increasing `seq` assigned by
the Durable Object. Delivery is **at-least-once**; consumers dedupe by `event_id`. Event types added after 0.3.0 are
sent only to clients that declared the feature they belong to (section 19). Event types and `data` shapes are
in `api.ts` (`EventData`). Notable: `decision.created` and `decision.*.committed` carry the signed record plus
ciphertext; `decision.expired` is relay-asserted and unsigned (it never authorises anything).

`GET /events?after=<seq>&limit=<n>` returns `EventsPage` (`has_more`, `next_after`, `high_water_seq`). A client MUST
NOT advance its cursor past a partial page and MUST persist events before acknowledging them.

**Sequence numbers can have holes.** Deleting a question (`DELETE /questions/{id}`) removes its events and appends a
`decision.deleted` tombstone, and a pane snapshot hint replaces the question's earlier hint of its type (section 18),
so the surviving `seq` values are not contiguous. Therefore a "contiguous" cursor means
"everything the relay holds up to here": a client advances to `next_after` after a complete page, and after a pushed
`event` frame it advances only if the frame is the next one the relay holds for it (otherwise it re-requests from its
cursor via `sync` or `GET /events` rather than trusting a gap). Receiving the same `event_id` again is harmless.

Desktop catch-up: persist `last_contiguous_seq` only after the event is durably recorded (not after terminal
injection); connect; `sync`; process; `ack`; later `POST /deliveries/terminal` once the text was really typed.

## 8. Hibernatable WebSocket (`/api/v1/socket`)

Both the desktop and the PWA hold one socket to the single Durable Object using the WebSocket Hibernation API, so an
idle connection costs nothing and survives deploys with a reconnect + `sync`.

1. `POST /socket-ticket {protocol_version, features?}` (signed) → `{ticket, expires_at, ws_path}`; the ticket is
   single-use, bound to the device, valid 30 s. `features` (section 19) sets what the socket is sent.
2. `GET /api/v1/socket?ticket=…` (WebSocket upgrade). The relay attaches `{device_id, role}` to the socket.
   A second socket from the same device closes the older one with code `4409`.
3. Server frames (`ServerFrame`): `hello`, `event`, `caught_up {high_water, has_more}`, `pairing`, `res`, `revoked`, `error`.
   A `sync` replay is bounded (2000 events or 8 MiB, 30 syncs per minute per device). `caught_up.has_more = true` means the
   replay was cut short: send `sync` again from the cursor. Only `has_more = false` means fully caught up.
   Client frames (`ClientFrame`): `sync {after}`, `ack {seq}`, `req {…}` (a signed REST request tunnelled over the
   socket, answered by a `res` frame with the same `id`).
4. Keep-alive: send the text frame `ping`; the runtime answers `pong` without waking the object.
5. New events are pushed as `event` frames the moment they commit, so the PWA is live without polling and the
   desktop is woken instantly. On revoke the socket gets `revoked` and closes with `4401`.

Attachment content and voice streams use plain HTTP / dedicated sockets, not this channel.

## 9. Attachments

`POST /attachments/reservations {idempotency_key, question_id, attachment_id, ciphertext_bytes, sha256_ciphertext,
mime_category}` (desktop) → `{attachment_id, upload_path, expires_at}`. The **client chooses `attachment_id`** (the
ciphertext's AAD binds it, and the ciphertext digest is needed to reserve); the relay rejects reuse. Then `PUT /attachments/{id}/content` with the ciphertext as
the body; the request is signed with `body_sha256 = sha256_ciphertext` and the Worker streams it to private R2 with
an integrity check (no plaintext, no file name — object keys are random). `POST /attachments/{id}/complete` verifies
the stored object and publishes availability (`attachment.available`). Only then may a question reference it.
`GET /attachments/{id}/content` (any paired device) streams the ciphertext, `Cache-Control: no-store`.
Defaults: 8 files, 20 MiB each, 64 MiB per question; deleted 30 days after the question reaches a terminal state;
orphaned reservations are garbage-collected.

**Answer rules and image binding (end to end, never seen by the relay).** `DecisionContentV1.options` and
`allow_text` are the answer rules: a phone offers only those options and shows a free-text field only when
`allow_text` is true, and the desktop refuses (never delivers) an answer that names an unknown option or carries
text the question did not allow. Questions under a desktop workflow gate with choices carry exactly the gate's
choices; a gate that binds artifacts publishes `kind: "approval"`, and a phone sends an approval only once every
attached image has been downloaded, decrypted and checked against its descriptor's `sha256`. The answer's
`reviewed_attachment_digests` lists the plaintext SHA-256 of each image the phone displayed. The desktop reports
the answer as bound to the images only when that list equals the question's attachment digests. Attachments are
fixed when a question is created, so different images are always a different question, and an answer to one
never applies to another. Images a phone attaches later (section 17) are a separate set with their own budget; they
never join the question's attachments or `reviewed_attachment_digests`.

## 10. Devices, keys and revocation

- `GET /devices` → certificates of **all** devices, including revoked ones (so old signatures stay verifiable).
- `GET /devices/{id}/key-grants` → sealed epoch keys for that device (self only).
- `POST /devices/{id}/revoke {new_key_epoch, grants[]}` (owner): grants for every remaining non-owner device sealed
  to the new epoch key. Blocks the device immediately, closes its sockets, deletes its push subscriptions and tickets,
  emits `device.revoked` and `device.key_rotated`. Content the revoked device already downloaded cannot be recalled.
- `POST /devices/enroll-host {cert, grant}` (owner): registers an additional desktop (a Daintree Host) as a `desktop-host` device. The host creates its own key pairs and sends the public halves to the owner, who signs the device certificate and seals the current epoch key to the host's exchange key. A `desktop-host` can create questions, answer as a proxy, cancel and acknowledge deliveries, but cannot pair, revoke, reopen or answer as a human.

### 10.1 Host enrollment exchange (device to device)

The relay sees only `POST /devices/enroll-host`. The two messages around it pass between the Host and the owner,
over Daintree's authenticated link or copied by hand (`decisions host request | enroll | accept`). Each is a single
line, `<prefix><base64url(canonical JSON)>`; the prefix carries the format version, and whitespace is ignored when
decoding (terminal line wraps). Both objects are strict: unknown top-level fields are rejected.

- **Request** (Host → owner), prefix `decisions-host-request.v1.`:
  `{v, type: "host.enroll-request", device_id, label, signing_pub, exchange_pub, created_at, signature}`.
  The Host generates `device_id` and both P-256 key pairs, keeps the private halves, and signs the request with its
  own signing key (proof of possession). The owner refuses it if the signature fails, if it is older than 24 hours
  or dated more than 10 minutes ahead, if either key is already used by a device, or if `device_id` is already
  registered (including a revoked Host: a revoked identity is never re-enrolled).
- **Enrollment** (owner → Host), prefix `decisions-host-enrollment.v1.`:
  `{v, type: "host.enrollment", relay_origin, installation_id, owner_cert, cert, grant, issued_at, signature}`,
  signed as a whole by the owner. `owner_cert` is the owner's self-signed certificate as the relay holds it, `cert`
  the Host's `desktop-host` certificate (exactly the requested keys and id) and `grant` the relay's current epoch key
  sealed to the Host's exchange key. The Host accepts it only if it matches its pending request, `owner_cert` is a
  valid self-signed `owner-desktop` certificate for `installation_id`, the enrollment signature, `cert` and `grant`
  all verify against that owner key, and a signed `GET /devices` shows the same owner and this Host as active. It
  then pins `owner_cert`: every certificate and grant it accepts afterwards must chain to that key.
- Both sides print a fingerprint for a human to compare when copying by hand: the request code (SHA-256 of the
  canonical `{t: "host.enroll.code", device_id, signing_pub, exchange_pub}`, first 128 bits as hex in groups of four)
  and the owner key fingerprint.
- After a `device.key_rotated` event a Host fetches `GET /devices/{id}/key-grants` and opens the new grant with the
  pinned owner key. Revoking a Host is the normal `POST /devices/{id}/revoke`.
- Running as a `desktop-host`, a client verifies every device certificate against the pinned owner key (never its
  own: a Host cannot introduce devices), and accepts exactly one `owner-desktop`, the pinned owner. It acts only on
  the questions it created: events for any other device's questions are stored and acknowledged for sync, but never
  verified for delivery or acted on. It never attempts the owner-only routes (pairing, revoke, rotate, enroll-host,
  reopen, delete, diagnostics), and like every desktop it never signs `answer`, `override` or `confirm-proxy`.
- `POST /epoch/rotate` (owner): same body, without revoking anyone.

## 11. Push, reminders and expiry

`GET /push/config`, `POST /push/subscriptions {endpoint, p256dh, auth}`, `DELETE /push/subscriptions/{id}`,
`POST /push/test`. Payloads are generic JSON (`{"type":"decision-new","question_id":"…"}`; every allowed shape is `PushPayload`, which
admits a type and a question id and nothing else, and `decision-reply` marks an agent message that expects a reply)
encrypted per RFC 8291 and
signed with VAPID (RFC 8292); the lock-screen text is fixed client-side by the service worker. Endpoints must be HTTPS
on a known push-service host. One Durable Object alarm drives a SQL `scheduled_jobs` table: initial notification
(deferred for `proxy-*` questions until the proxy abstains or a grace period passes), reminders (first after 4 h, then
every 24 h, max 3), proxy-review reminder, expiry, attachment deletion and orphan GC. `GET/PUT /settings` stores quiet
hours and reminder preferences (notification preferences only; they never delay sync).

## 12. Deliveries

`POST /deliveries/received {seq}` (also the `ack` frame): the desktop durably stored events up to `seq`.
`POST /deliveries/terminal {question_id, answer_revision, injection_id, host_id}`: text was actually typed into the
agent terminal (**not** inferred from receipt). `POST /deliveries/failed {…, status: needs-attention |
delivery-uncertain, error_code}`. Each emits a ledger event so the phone shows `queued → delivered to desktop →
terminal delivered`. Human thread messages have their own per-message receipts (section 16.4).

## 13. Voice (optional, separately disclosed)

`POST /voice/session {provider: xai|openai, consent: true, keyterms[], language?}` → one-use ticket; `GET
/voice/ws?ticket=` is a transient proxy to the provider (the Worker holds the API key; the browser never does).
The client sends **binary mono PCM16 little-endian, 16 kHz** frames (~100 ms) and the text frames `{"type":"finalize"}` /
`{"type":"audio.done"}`; it receives normalised events `transcript.created`, `transcript.partial {text, is_final,
speech_final}`, `transcript.done {text}` and `error {message}`. `POST /voice/correct {provider: anthropic|openai,
consent: true, raw_transcript, question, context?, options[{label, description?}], asked_at?, project_label?,
preceding_text?, transcriber?: xai|openai, language?}` returns `{result: CorrectionResult, model}`: one whole-passage
cleanup with Daintree desktop dictation's rules and request shape, the question given as the agent's last reply.
**This path is not end-to-end encrypted**: the Worker and provider see audio/text transiently; nothing is stored or
logged.

## 14. Admin

`GET /admin/diagnostics` (owner) → `Diagnostics` (counters only, no content). `POST /admin/delete-data {confirm:
"DELETE", scope: "questions" | "everything"}` (owner). Both scopes also remove every thread message, message receipt,
phone image and reservation, pane snapshot and outstanding snapshot refresh.

## 15. Conformance

A compatible relay MUST pass `worker/tests/*.test.ts` semantics: signature/replay rejection, CAS and first-answer-wins,
proxy never satisfying `human-required`, idempotency, ordered event paging, revocation, reminder cancellation,
attachment integrity, no plaintext in storage, and feature filtering that keeps a 0.3.0 client parsing every page and
frame (section 19).

## Extensions: threads, phone images and pane snapshots

Sections 16 to 19 define three opt-in extensions, each named by a feature (section 19). Their shapes are in
`thread.ts`, `snapshot.ts`, `features.ts` and `schema.ts`, and in `schemas.json`. Their routes join `ROUTE_MANIFEST`
and `openapi.json` when the relay serves them (the thread-message routes have); until a relay advertises a feature in
`GET /info`, clients MUST NOT use it. `@daintreehq/decisions-protocol/fixtures` exports shared test data for relay, client and app tests: a thread
with messages in both directions (`THREAD_FIXTURE`), phone image references, a fresh snapshot, stale snapshots and a
sharing-off record. Content there is plaintext and records are unsigned templates that each test encrypts and signs
with its own keys.

## 16. Thread messages (`thread-messages-v1`)

A message is a follow-up on one existing question, from one of two sides:

- **human**: signed by a paired `phone` or `tablet`;
- **agent**: signed by the desktop that published the question on behalf of the asking pane, the device whose id is
  the question's `originating_device_id`. `target_host_id` is a host reference, not a device id. No other desktop,
  not even the owner, speaks for another desktop's agent.

`MessageRecord` (signed): `{v, type: "thread.message", installation_id, question_id, message_id, side,
expects_reply, attachment_ids, created_at, envelope_digest, signer_device_id, signature}`. The signer chooses
`message_id`, which never changes and is never reused. `expects_reply` is true only on an agent message that waits on
the person. `attachment_ids` lists phone images (section 17) and is empty on an agent message.

The envelope has purpose `message-content`, `record_id = message_id`, `aad.record_type = "thread.message"` and
`aad.revision = 0`. Content is `HumanMessageContentV1 {content_version: 1, side: "human", text, images[]}` (text,
images or both) or `AgentMessageContentV1 {content_version: 1, side: "agent", text}` (non-blank text). Message
content has no options, approval or reason: unknown fields are dropped. Before showing a message, a client checks
that `content.side` equals `record.side` and that the content's image ids equal the record's (`imagesMatchRecord`).

**Order.** The relay assigns `message_seq` (1, 2, … per question) when it commits a message. It is independent of
the question's `revision`: nothing is compare-and-swapped, so concurrent senders never conflict. A retry with the same
`idempotency_key` and body, or the same record under the same `message_id`, returns the original receipt; the same
`message_id` with a different record is `409 idempotency_collision`. Retries are recognised before the state and
quota checks.

**Which states take messages** (`applyMessage`, `isThreadClosedStatus`):

| `status`                  | App shows    | Human message       | Agent message       |
| ------------------------- | ------------ | ------------------- | ------------------- |
| `open`                    | Needs you    | accepted            | accepted            |
| `human-answered`          | Answered     | accepted            | accepted            |
| `proxy-answered`          | Model answer | accepted            | accepted            |
| `expired`                 | Expired      | `410 expired`       | `410 expired`       |
| `cancelled` ("withdrawn") | Withdrawn    | `409 invalid_state` | `409 invalid_state` |

"Withdrawn" is how the app shows `cancelled`; there is no separate status. An answer is final for the answer, not for
the thread, so answered questions keep taking messages. Expired and cancelled questions are closed, and a `reopen`
opens the thread again with its earlier messages and order intact. The relay checks the status inside the committing
transaction.

**A message never changes the decision.** It leaves `status`, `revision`, the proxy state, the answer in force,
`deliverable` and every gate outcome as they were, and it never counts as approval: "approved" in a message is text,
and a human message on a `proxy-answered` question does not confirm the model's answer. `applyMessage` returns the
question state unchanged with `deliverable: false` and `approval: false`.

**Limits** (`LIMITS`): text 16 KiB UTF-8 (`messageTextBytes`, the same budget as an answer's text); 4 images per
message; 200 messages per question over its lifetime, both sides together, not reset by a reopen
(`messagesPerQuestion`, `409 invalid_state` beyond it); 50 messages per page, and a page also stops before 256 KiB of
records and envelopes (`eventPageBytes`, like an events page) while always holding at least one message. The envelope
is bounded by `envelopeCiphertextChars`, like every envelope. The relay never sees the text, so the text limit and
"text or an image" are the sender's and reader's checks; the relay enforces the envelope bound, the image count in the
signed record and the per-question count. Until it advertises `phone-images-v1`, it refuses a message that lists
images (`400 validation_error`).

| Route                                        | Role                                  | Notes                                                                               |
| -------------------------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------- |
| `POST /questions/{id}/messages`              | phone, tablet; the publishing desktop | `MessageBody {protocol_version, idempotency_key, message}` → `201 MessageReceipt`   |
| `GET /questions/{id}/messages?after=&limit=` | any                                   | `MessagesPage`: `MessageView` (entry, `event_seq`, delivery) in `message_seq` order |
| `POST /deliveries/messages`                  | the publishing desktop                | `MessageReceiptBody` (section 16.4)                                                 |

Events: `decision.message.posted` (`EventData.messagePosted`: the `MessageEntry` and `target_host_id`; the event's
`question_revision` is null) and `delivery.message` (`EventData.messageDelivery`).

### 16.1 Answers are final

A human answer is final in the product: saying more after answering is a message, not an `override`, and an app built
for threads never offers to change a human answer. For compatibility, the relay still accepts a phone's `override`
of a human answer, unchanged (a new revision, delivered as a correction). Today's phone app corrects answers that way
until its thread UI ships, phones keep running cached copies of it, 0.3.0 Daintree delivers corrections, and the relay
cannot tell an older app from a newer one. It is deprecated, and a later protocol version may refuse it. Confirming or
overruling a proxy (model) answer with `confirm-proxy` or `override` is unchanged and not deprecated.

### 16.2 Waiting on the person

An agent message with `expects_reply: true` asks the person something. The thread waits on the person
(`threadAwaitsHuman`) while the latest agent message expects a reply and nothing human came after it in ledger order:
a human message, or a human answer, override or confirmation. A later agent message that asks nothing withdraws the
request. Closed threads wait on nobody. An open question needs the person anyway; this is what shows an answered one as
"Needs you" again. The relay sends a `decision-reply` push (`{type, question_id}` and nothing else) for an agent message
that expects a reply. Quiet hours hold it back like any push, a newer asking message on the same question replaces one
not yet sent, and when it is due the relay sends it only if the thread still waits on the person.

### 16.3 Delivering human messages

The publishing desktop types each human message into the asking pane the way it types an answer, but as a follow-up,
never as an answer or an approval. Agent messages are not delivered anywhere; phones read them.

### 16.4 Message receipts

Each human message has its own delivery: `relay-queued → received → terminal-delivered`, or `needs-attention` /
`delivery-uncertain` with an `error_code`. Only the publishing desktop reports it, with `POST /deliveries/messages`
`{protocol_version, idempotency_key, question_id, message_id, host_id, status, injection_id (terminal-delivered),
error_code (needs-attention, delivery-uncertain)}`; `host_id` is the question's `target_host_id`, and an agent message,
an unknown message or another host is `404 not_found`. `received` is an explicit receipt: a ledger `ack` never marks a
message received. Nothing moves a message back from `terminal-delivered`: a repeat with the same `injection_id` is
harmless, and a different injection or a later failure is `409 invalid_state`. A failure can be followed by
`terminal-delivered` once the desktop recovers, and a late `received` only fills in `received_at`. Each change emits
`delivery.message`, and `GET /questions/{id}/messages` carries each human message's current delivery. The crash-recovery key is `messageDeliveryKey(question_id, message_id)`, in place of an answer's
`(question_id, answer_revision)`: the desktop records its injection intent under that key before touching the
terminal, reuses its `injection_id` after a restart, and reconciles an uncertain attempt rather than typing again.

## 17. Phone images (`phone-images-v1`)

A phone can attach images to a human answer or a human message after the question exists. Each is a
`PhoneImageReference {attachment_id, mime: image/png | image/jpeg | image/webp, size, sha256, nonce, key_epoch, alt?}`
in `HumanAnswerContentV1.images` or `HumanMessageContentV1.images`. `sha256` is the plaintext digest that identifies
the image. Proxy answer content never carries images.

**Encryption.** Exactly as a question attachment (`encryptAttachment`, `attachmentAadString`, `attachmentKeyInfo`):
the epoch content key, bound to the installation, question, attachment id and epoch, with a fresh attachment id and
nonce for every upload.

**Binding an upload to one answer or message.**

1. `POST /questions/{id}/images/reservations` (phone, tablet) `PhoneImageReserveBody {protocol_version,
idempotency_key, attachment_id, binding: {kind: "answer" | "message", record_id}, ciphertext_bytes,
sha256_ciphertext, mime_category: "image"}` → `AttachmentReservation`. `record_id` is the `action_id` or
   `message_id` the image will be signed into. The question must exist and take messages (section 16).
2. `PUT /attachments/{id}/content` and `POST /attachments/{id}/complete`, as for question attachments, by the same
   device.
3. The signer lists the ids in the signed record (`ActionRecord.attachment_ids` on an `answer` or `override`, or
   `MessageRecord.attachment_ids`) and the same images in the encrypted content. At commit the relay requires every
   listed id to be completed, reserved by the signer for this question and exactly this `binding`, and not yet bound;
   it binds them all or commits nothing. An image binds once.
4. Readers check `imagesMatchRecord`, then the downloaded image's size, MIME and `sha256`. A reader that cannot fetch
   or verify an image still shows the answer or message, and shows that image as unavailable. A desktop types the
   words with each image's local path, or its reason for being unavailable, into the asking pane (integration spec
   section 6.4); plaintext images exist only on the phone and the host's disk.

`ActionRecord.attachment_ids` is optional with no default, so records signed without it verify exactly as before.
Phone images never join the question's attachments or `reviewed_attachment_digests`, and never count as approval
evidence. Until a relay advertises `phone-images-v1` it refuses an action that lists images (`400
validation_error`).

**Limits.** 10 MiB per image; 4 per answer or message; 16 per question over its lifetime, reserved or bound; 64 MiB of
ciphertext per question; 8 unbound reservations per device. These are separate from the desktop's question-image
budgets (section 9).

**Retention.** An image no committed record references (reserved, uploaded or completed) is deleted 2 hours after its
reservation (`phoneImageOrphanMs`). A bound image is kept for the attachment retention period
(`attachment_retention_days`, default 30) from the commit of the answer or message that references it, whatever the
question's status later; its reference stays in the encrypted content, and the image then reads as unavailable.

**Delete and export.** `DELETE /questions/{id}` and both `POST /admin/delete-data` scopes remove phone images and
their reservations along with the question's messages, receipts and snapshot. Copies other devices already downloaded
cannot be recalled. The desktop's history export carries verified message text and image references (digest, MIME,
size), not image bytes, as it already treats question attachments; pane snapshots are never exported.

## 18. Pane snapshots (`pane-snapshots-v1`)

A snapshot is what the asking pane looked like, published by the question's publishing desktop. The relay keeps one
per question: a new one replaces the last.

`PaneSnapshotRecord` (signed): `{v, type: "pane.snapshot", installation_id, question_id, snapshot_id,
question_revision, observed_at, sharing: "on" | "off", envelope_digest, signer_device_id, signature}`. The envelope
has purpose `snapshot-content`, `record_id = snapshot_id`, `aad.record_type = "pane.snapshot"` and `aad.revision = 0`.
Content is `PaneSnapshotContentV1`:

| Field            | Meaning                                                          | Limit                                                                                |
| ---------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `observed_at`    | when the desktop read the pane; equals the record's              |                                                                                      |
| `agent_state`    | `idle`, `working`, `waiting`, `directing`, `completed`, `exited` | a lowercase token; a newer one parses and `snapshotAgentState` reads it as `unknown` |
| `waiting_reason` | `prompt`, `question`, `approval`, `error` or `null`              | a lowercase token or null; a newer one reads as `null` (`snapshotWaitingReason`)     |
| `pane_title`     | plain text                                                       | 240 characters                                                                       |
| `terminal_lines` | the newest terminal lines, oldest first, plain text              | 200 lines, 32 KiB joined by `\n`                                                     |

Plain text means no control characters (tab excepted), escape sequences or line breaks inside a line.
`boundTerminalLines` turns raw terminal text into lines within these limits.

**Publishing.** `PUT /questions/{id}/snapshot` `PaneSnapshotBody {protocol_version, idempotency_key, snapshot}`
(the publishing desktop only: the owner cannot publish for another desktop's pane) → `200 CommandReceipt`. A retry
with the same `idempotency_key` and body returns the original receipt and changes nothing, so it never brings back an
older snapshot. The relay refuses a snapshot for a closed question (`410 expired`, `409
invalid_state`), for a revision other than the question's current one (`409 revision_conflict`), with an
`observed_at` no later than the last it accepted for the question (`409 revision_conflict`; the relay keeps that time
after clearing, so a delayed older snapshot never returns), or with an `observed_at` more than 120 s ahead of relay
time (`400 validation_error`). That cap is the clock allowance every signed request already has (section 3), so it
asks nothing more of a desktop, and it stops a desktop clock running ahead from setting an order watermark that its
corrected clock could not pass.

**Limits.** 30 snapshots per question per minute, shared and sharing-off records together
(`snapshotWritesPerQuestionMinute`, `429 rate_limited` beyond it); a desktop coalesces rapid changes so it never
reaches this. The envelope's ciphertext is at most 96 KiB of base64url (`snapshotCiphertextChars`, `413
payload_too_large`): the largest valid `PaneSnapshotContentV1` encrypts to about 91 KiB. The relay cannot check the
content limits inside the ciphertext; readers do, with `PaneSnapshotContentV1`.

**Sharing off.** A record with `sharing: "off"` and no envelope replaces and clears the snapshot and says the desktop
does not share its panes. It is also how a desktop clears a snapshot on purpose. The relay then refuses refresh
requests (`409 invalid_state`) until the desktop publishes a shared snapshot again, across a reopen too.

**Refresh.** `POST /questions/{id}/snapshot/refresh` (phone, tablet) `SnapshotRefreshBody {protocol_version,
idempotency_key}` → `SnapshotRefresh {refresh_id, requested_by_device_id, requested_at, deadline_at}`, where
`deadline_at` is `requested_at` + 15 s (`snapshotRefreshTimeoutMs`), in relay time. While a refresh is outstanding
(its deadline has not passed), another, from any phone, returns the same one and notifies nobody again; a device may
ask 6 times a minute, coalesced requests included. A request past its deadline stays in `GET` responses, so phones can
call the snapshot stale, until a snapshot fulfils it, the next request replaces it, or the snapshot is cleared. The
relay also refuses a refresh while the publishing desktop's latest socket-ticket declaration (section 19) lacks
`pane-snapshots-v1` (`409 invalid_state`). The publishing desktop gets
`decision.snapshot.refresh_requested`, reads the pane after receiving it and publishes; the first snapshot the relay
accepts after the request fulfils it. `GET /questions/{id}/snapshot` (any paired device) →
`PaneSnapshotResponse {question_id, snapshot, received_at, refresh}`, where `received_at` is when the relay accepted
the snapshot and `refresh` is the outstanding request or null.

**Stale** (`snapshotFreshness`). Freshness is measured in relay time only, so the desktop's, relay's and phone's clocks
are never compared: `now` is the phone's clock corrected by the offset it measures from the relay (`hello.server_time`),
age runs from `received_at`, and the refresh deadline is the relay's. `observed_at` (desktop time) is shown to the
person and orders one desktop's snapshots, but freshness never uses it.

| Result    | When                                                                                                                                                        |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `none`    | the question is expired or cancelled, or there is no snapshot and no outstanding request                                                                    |
| `off`     | the desktop said sharing is off                                                                                                                             |
| `pending` | a refresh is outstanding and its deadline has not passed                                                                                                    |
| `stale`   | a refresh passed its deadline with no new snapshot (however recent the last one), or the relay received the snapshot more than 60 s ago (`snapshotFreshMs`) |
| `fresh`   | otherwise                                                                                                                                                   |

**Cleared** when the question expires, is cancelled or is deleted, when the desktop turns sharing off, and 24 hours
after the relay received it (`snapshotRetentionMs`). A reopened question starts with no snapshot and no outstanding request.
An answer does not clear it: the thread is still live. Clearing removes the ciphertext from relay storage, by the
relay's alarm and before any read. `DELETE /questions/{id}` and both `POST /admin/delete-data` scopes remove a
question's snapshot state entirely; otherwise the relay keeps only the order watermark and the sharing-off choice.

**Events and push.** `decision.snapshot.updated {snapshot_id, observed_at, sharing, target_host_id}` and
`decision.snapshot.refresh_requested {SnapshotRefresh, target_host_id}` are hints: they carry no title, state or
terminal text, and readers fetch the current snapshot, so replaying an old hint shows the latest one. Their
`question_revision` is null. The relay keeps only the latest hint of each type per question: a new one removes the
one before, an accepted snapshot removes the refresh hint it fulfils, and closing, reopening or deleting the question
removes both, so the ledger holds no history of snapshots. When retention removes a snapshot (with any refresh waiting on it),
the relay appends a `decision.snapshot.updated` hint naming it (with a null `origin_device_id`), and a reader that
fetches finds none.
Snapshots never trigger a push, and no snapshot field fits a `PushPayload`.

| Route                                   | Role                   | Notes                                                     |
| --------------------------------------- | ---------------------- | --------------------------------------------------------- |
| `PUT /questions/{id}/snapshot`          | the publishing desktop | `PaneSnapshotBody` → `200 CommandReceipt`                 |
| `GET /questions/{id}/snapshot`          | any                    | `PaneSnapshotResponse`; nulls for a closed question       |
| `POST /questions/{id}/snapshot/refresh` | phone, tablet          | `SnapshotRefreshBody` → `200 SnapshotRefresh` (coalesced) |

## 19. Feature negotiation and 0.3.0 clients

A 0.3.0 client validates every events page and socket frame against a closed `EventType` enum: a page with an unknown
type fails its whole catch-up, and an unknown frame is dropped. So a relay sends each client only what it declared it
understands.

**Features** (`ProtocolFeature`): `thread-messages-v1`, `phone-images-v1`, `pane-snapshots-v1`. Lists a client
receives use `FeatureToken`, so a newer peer's unknown features parse and are ignored (`knownFeatures`).

**Declaring.** A client declares its features on `POST /socket-ticket` (`SocketTicketBody.features`, for that socket)
and on `GET /events` as the signed query parameter `features`: sorted and comma-separated (`formatFeatures`). No
declaration, which is every 0.3.0 client, means the 0.3.0 baseline, whatever the device declared before. A socket-ticket
body without `features` (the 0.3.0 phone app sends `{}`) is such a baseline declaration; a malformed list is
`400 validation_error`.

**Advertising.** The relay lists the features it implements in `GET /info` (`features`; absent means none). It
records each device's latest socket-ticket declaration and shows it in `GET /devices` (`DeviceInfo.features`). A
phone offers messages, images or a snapshot refresh on a question only when the relay and the question's publishing
desktop both advertise the feature, and the relay refuses a human message, a phone image reservation or a refresh for
a question whose publishing desktop does not (`409 invalid_state`).

**Filtering** (`requiredFeaturesForEvent`, `isEventVisible`). An event is sent only to a client that declared every
feature it needs: the new event types need their feature, and an answer or message that lists phone images also needs
`phone-images-v1`, because a 0.3.0 client would type the answer's text and silently drop its images. This applies to
`GET /events` (also when tunnelled in a `req` frame), to socket `sync` replays and to live `event` frames.

**Cursors** (`buildEventsPage`), so a client never stalls on events it is not sent:

- `has_more` is true only when another event the client may see is left, so a page that says "more" is never empty;
- a page that ends the stream sets `next_after` to the high-water mark, past any hidden events;
- a page cut by its size stops at its last event and never skips a visible one;
- a socket `caught_up` frame carries the same `next_after` as `high_water`, and the same `has_more`.

A client that turns a feature on later (after an upgrade) backfills from that feature's own routes
(`GET /questions/{id}/messages`, `GET /questions/{id}/snapshot`): its cursor may already be past events it was not
sent.

**Version.** `PROTOCOL_VERSION` stays 1. Everything here is additive and opt-in, and a client that declares nothing
sees exactly the 0.3.0 protocol. The new optional fields in existing shapes (`ActionRecord.attachment_ids`,
`HumanAnswerContentV1.images`, `InfoResponse.features`, `DeviceInfo.features`, `SocketTicketBody.features`) parse
under 0.3.0 schemas, and a non-empty `attachment_ids` appears only on events a 0.3.0 client is never sent (an empty
list is harmless).

**Proof.** `@daintreehq/decisions-protocol/fixtures` exports `Legacy030` (the 0.3.0 schemas, frozen) and the 0.3.0
desktop and phone catch-up loops. `packages/protocol/tests/features.test.ts` runs them against `buildEventsPage`, and
`worker/tests/legacy-client.test.ts` against the relay.
