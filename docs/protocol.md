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
| `desktop-host`    | Additional trusted desktop (reserved for V2)     | create questions, proxy answer/abstain, cancel, delivery acks                                                           |
| `phone`, `tablet` | Paired human devices                             | answer, override, confirm-proxy, settings, push, voice                                                                  |

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
- Content is JSON inside a `CryptoEnvelope`. **Signed records** (`QuestionRecord`, `ActionRecord`) commit to
  `sha256(canonicalize(envelope))`, so a relay cannot swap ciphertext, and carry the metadata the relay needs
  for routing (requirement, expiry, target host). Everything else — question, context, options, answers,
  attachment captions — is inside the envelope.
- Attachments are encrypted separately (`encryptAttachment`): one AES-GCM blob per image; the nonce, plaintext
  SHA-256 and MIME live in the encrypted `DecisionContentV1.attachments[]` descriptor.
- Clients MUST verify record signatures against the device certificate chain (owner key pinned at pairing) before
  decrypting or acting.

## 6. Questions and actions

Lifecycle: `open → human-answered | proxy-answered | cancelled | expired`; `proxy-answered → human-answered
(override/confirm) | cancelled`; `cancelled|expired → open (reopen)`. See `state.ts` for the authoritative table.
`revision` starts at 0; answer/override/proxy-answer/confirm-proxy/reopen increment it; cancel/abstain/expire do not.
Every state-changing command carries `expected_revision` and the relay compare-and-swaps: **first human answer
wins**, later answers get `409 revision_conflict {latest_revision, status}`.

| Route                                   | Role          | Notes                                                                                     |
| --------------------------------------- | ------------- | ----------------------------------------------------------------------------------------- |
| `POST /questions`                       | desktops      | `{protocol_version, idempotency_key, question:{record, envelope}}` → `201 CommandReceipt` |
| `GET /questions?status=&cursor=&limit=` | any           | `QuestionList` (summaries only)                                                           |
| `GET /questions/{id}`                   | any           | `QuestionDetail` incl. action log, attachments, deliveries                                |
| `POST /questions/{id}/answer`           | phone, tablet | `ActionBody`; `record.action = "answer"`, `expected_revision` = revision seen             |
| `POST /questions/{id}/override`         | phone, tablet | replace a human/proxy answer; returns to the terminal as a correction                     |
| `POST /questions/{id}/confirm-proxy`    | phone, tablet | human affirms the proxy answer; not re-delivered                                          |
| `POST /questions/{id}/proxy-answer`     | desktops      | rejected for `human-required`                                                             |
| `POST /questions/{id}/proxy-abstain`    | desktops      | escalates `proxy-first`/`proxy-ok` to the human and pushes immediately                    |
| `POST /questions/{id}/cancel`           | desktops      | idempotent; cannot remove a committed human answer                                        |
| `POST /questions/{id}/reopen`           | owner-desktop | new revision, optional new `expires_at`                                                   |
| `DELETE /questions/{id}`                | owner-desktop | hard-delete question, answers, attachments; emits `decision.deleted`                      |

Idempotency: a repeated `idempotency_key` with identical body returns the original receipt; a different body is
`409 idempotency_collision`. Duplicate `(question_id, action_id)` is also idempotent.

Limits (`LIMITS`): 100 open questions per installation, 10 per `origin_ref` (opaque pane hash). Default expiry is
chosen by the desktop (`expires_at`, `null` = never). `now >= expires_at` means expired (checked lazily on every
read/write as well as by the alarm).

## 7. Event ledger and sync

Every committed transition appends an immutable `LedgerEvent` with a monotonically increasing `seq` assigned by
the Durable Object. Delivery is **at-least-once**; consumers dedupe by `event_id`. Event types and `data` shapes are
in `api.ts` (`EventData`). Notable: `decision.created` and `decision.*.committed` carry the signed record plus
ciphertext; `decision.expired` is relay-asserted and unsigned (it never authorises anything).

`GET /events?after=<seq>&limit=<n>` returns `EventsPage` (`has_more`, `next_after`, `high_water_seq`). A client MUST
NOT advance its cursor past a partial page and MUST persist events before acknowledging them.

**Sequence numbers can have holes.** Deleting a question (`DELETE /questions/{id}`) removes its events and appends a
`decision.deleted` tombstone, so the surviving `seq` values are not contiguous. Therefore a "contiguous" cursor means
"everything the relay holds up to here": a client advances to `next_after` after a complete page, and after a pushed
`event` frame it advances only if the frame is the next one the relay holds for it (otherwise it re-requests from its
cursor via `sync` or `GET /events` rather than trusting a gap). Receiving the same `event_id` again is harmless.

Desktop catch-up: persist `last_contiguous_seq` only after the event is durably recorded (not after terminal
injection); connect; `sync`; process; `ack`; later `POST /deliveries/terminal` once the text was really typed.

## 8. Hibernatable WebSocket (`/api/v1/socket`)

Both the desktop and the PWA hold one socket to the single Durable Object using the WebSocket Hibernation API, so an
idle connection costs nothing and survives deploys with a reconnect + `sync`.

1. `POST /socket-ticket` (signed) → `{ticket, expires_at, ws_path}`; the ticket is single-use, bound to the
   device, valid 30 s.
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
- `POST /epoch/rotate` (owner): same body, without revoking anyone.

## 11. Push, reminders and expiry

`GET /push/config`, `POST /push/subscriptions {endpoint, p256dh, auth}`, `DELETE /push/subscriptions/{id}`,
`POST /push/test`. Payloads are generic JSON (`{"type":"decision-new","question_id":"…"}`) encrypted per RFC 8291 and
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
terminal delivered`.

## 13. Voice (optional, separately disclosed)

`POST /voice/session {provider: xai|openai, consent: true, keyterms[], language?}` → one-use ticket; `GET
/voice/ws?ticket=` is a transient proxy to the provider (the Worker holds the API key; the browser never does).
The client sends **binary mono PCM16 little-endian, 16 kHz** frames (~100 ms) and the text frames `{"type":"finalize"}` /
`{"type":"audio.done"}`; it receives normalised events `transcript.created`, `transcript.partial {text, is_final,
speech_final}`, `transcript.done {text}` and `error {message}`. `POST /voice/correct {provider: anthropic|openai,
consent: true, raw_transcript, question, option_labels[], keyterms[]}` returns a `CorrectionResult`. **This path is
not end-to-end encrypted**: the Worker and provider see audio/text transiently; nothing is stored or logged.

## 14. Admin

`GET /admin/diagnostics` (owner) → `Diagnostics` (counters only, no content). `POST /admin/delete-data {confirm:
"DELETE", scope: "questions" | "everything"}` (owner).

## 15. Conformance

A compatible relay MUST pass `worker/tests/*.test.ts` semantics: signature/replay rejection, CAS and first-answer-wins,
proxy never satisfying `human-required`, idempotency, ordered event paging, revocation, reminder cancellation,
attachment integrity, and no plaintext in storage.
