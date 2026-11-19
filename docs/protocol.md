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

| Role              | Who                                              | May                                                                                                                                                                       |
| ----------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `owner-desktop`   | The Daintree installation that claimed the relay | create questions, answer, decline and send messages for the person, proxy answer/abstain, cancel, reopen, pair/revoke devices, rotate keys, read diagnostics, delete data |
| `desktop-host`    | Additional trusted desktop (a Daintree Host)     | create questions, proxy answer/abstain, cancel, delivery acks                                                                                                             |
| `phone`, `tablet` | Paired human devices                             | answer, override, confirm-proxy, decline (cancel an open question), settings, push, voice                                                                                 |

With the extensions in sections 16 to 18 and 20, a phone or tablet also sends human messages, attaches phone images,
asks for pane snapshots and sets the involvement preference, and the desktop that published a question (its
`originating_device_id`, whatever its role) publishes that question's agent messages and pane snapshots and reports
delivery of its human messages. The owner desktop may also send the person's human messages (section 16) and set
the involvement preference (section 20). With `presence-v1` (section 11), the
owner desktop alone also reports that the person is at the computer.

A role is part of the owner-signed **device certificate**; the relay and every client check it. Provenance follows
the signer (`provenanceForSigner` in `state.ts`):

- a `phone` or `tablet` signs `answer`, `override` and `confirm-proxy`: **human** provenance;
- the `owner-desktop` may also sign `answer` on an open question, `human-required` ones included: **human-desktop**
  provenance, the person's answer made on the computer. The owner desktop certifies every other device, so this gives
  it nothing it could not get by pairing a phone of its own. It never signs `override` or `confirm-proxy`. Its other
  human actions are the person's thread message (section 16), a decline, signed as a `cancel` that carries
  `decline: true` (section 6.1), and setting the involvement preference (section 20); phone images, snapshot
  refresh, push and voice keep their roles;
- a `desktop-host` never signs `answer`, `override` or `confirm-proxy`;
- desktops sign `proxy-answer`: **proxy** provenance. A `human-required` question can never be satisfied by a proxy.

`cancel` has no provenance whoever signs it: signed by a phone or tablet, or by the owner desktop with `decline: true`
in the signed record, it records that the person **declined** to answer (section 6.1); any other desktop-signed cancel
**withdraws** the question. `roleMaySign` in `state.ts` is the one role table the relay and every client check action
signers against (thread messages have their own rule, `applyMessage` in section 16), and the relay's provenance claim
must equal what the signer's certified role implies (`provenanceForSigner`). The phone app accepts an owner-desktop `answer` only with
`human-desktop` provenance, shows it as the person's and names the computer from the owner certificate's signed
`label`. The desktop library accepts one on the owner desktop and on a Remote Host, refuses one that lists phone
images, and declares `owner-desktop-answers-v1` on every bridge's socket ticket. It keeps the answer as the person's
with its signer, types it with `source: human` and `answered_on: computer`, and `get_decision` reports
`provenance: human` with `answered_on: computer` (`phone` for a phone or tablet). A host app publishes one with
`DecisionsBridge.answerQuestion`, on the owner desktop only: the library signs it against the revision the person
reviewed, sends it through its outbox, and never moves it to a later revision.

The question's publishing desktop types the answer, and a desktop that predates owner-desktop answers rejects one. So
the relay commits an owner-desktop `answer` only when the publishing desktop (its `originating_device_id`) declared
`owner-desktop-answers-v1` on its latest socket ticket (section 19). Otherwise it refuses with `409 invalid_state`
and `details: {reason: "creator-missing-feature", required_feature: "owner-desktop-answers-v1"}`
(`CREATOR_MISSING_FEATURE`), which a client tells apart by `details.reason`. The check comes after the usual expiry
and revision checks; a refused command stores no receipt, so the same signed answer commits once the publishing desktop
declares support. An owner-desktop answer lists no phone images (`403 forbidden`).

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

| Route                                   | Role                         | Notes                                                                                                                                                                                                                                                |
| --------------------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /questions`                       | desktops                     | `{protocol_version, idempotency_key, question:{record, envelope}}` → `201 CommandReceipt`                                                                                                                                                            |
| `GET /questions?status=&cursor=&limit=` | any                          | `QuestionList` (summaries only)                                                                                                                                                                                                                      |
| `GET /questions/{id}`                   | any                          | `QuestionDetail` incl. action log, attachments, deliveries                                                                                                                                                                                           |
| `POST /questions/{id}/answer`           | phone, tablet, owner-desktop | `ActionBody`; `record.action = "answer"`, `expected_revision` = revision seen; owner-desktop needs `owner-desktop-answers-v1` from the publishing desktop (section 2)                                                                                |
| `POST /questions/{id}/override`         | phone, tablet                | replace a proxy answer, or (deprecated, section 16.1) a human answer; delivered as a correction                                                                                                                                                      |
| `POST /questions/{id}/confirm-proxy`    | phone, tablet                | human affirms the proxy answer; not re-delivered                                                                                                                                                                                                     |
| `POST /questions/{id}/proxy-answer`     | desktops                     | rejected for `human-required`                                                                                                                                                                                                                        |
| `POST /questions/{id}/proxy-abstain`    | desktops                     | escalates `proxy-first`/`proxy-ok` to the human and pushes immediately, or after a presence hold (section 11)                                                                                                                                        |
| `POST /questions/{id}/cancel`           | any                          | idempotent; cannot remove a committed human answer; a phone/tablet only from `open`, and only once the question's desktop declares `person-declines-v1`; an owner-desktop decline (`decline: true`) likewise, with `owner-desktop-declines-v1` (6.1) |
| `POST /questions/{id}/reopen`           | owner-desktop                | new revision, optional new `expires_at`; starts a new presence hold (section 11)                                                                                                                                                                     |
| `DELETE /questions/{id}`                | owner-desktop                | hard-delete question, answers, messages, attachments; emits `decision.deleted`                                                                                                                                                                       |

Idempotency: a repeated `idempotency_key` with identical body returns the original receipt; a different body is
`409 idempotency_collision`. Duplicate `(question_id, action_id)` is also idempotent. A create's retry is recognised
before its deadline is checked: past `expires_at`, the same key and body still return the original receipt while the
relay keeps it (30 days), and the same signed record under any other key returns the question as it stands. Only a
new question must still be due.

Limits (`LIMITS`): 100 open questions per installation, 10 per `origin_ref` (opaque pane hash). Default expiry is
chosen by the desktop (`expires_at`, `null` = never). A finite `expires_at` on a create or a reopen must be in the
future and at most `LIMITS.maxQuestionExpiryMs` (366 days) away. `now >= expires_at` means expired (checked lazily
on every read/write as well as by the alarm). An advisory question (section 21) needs a finite one.

### 6.1 Declining a question

A person who will not answer an open question dismisses it from a phone or tablet: the device signs an ordinary
`cancel` action (no envelope, `expected_revision` = the revision they saw) and posts it to
`POST /questions/{id}/cancel`. There is no new action, status or event type, so every client that already parses
`cancel` and `cancelled` still parses it.

The person at the computer declines on the owner desktop, which signs the same `cancel` with `decline: true` in the
signed `ActionRecord`. The flag is optional with no default, so a record without it signs exactly as before, and its
only value is `true`. Only the owner desktop signs it, and only on a `cancel`: a phone or tablet declines by its role
alone, and a `desktop-host` never declines for the person (the relay refuses either with `403 forbidden`, and the flag
on any other action, or with any other value, is `400 validation_error`). Without the flag an owner-desktop cancel is a
withdrawal, as before, and the flag gives the owner desktop no other human action.

- **Transition.** A person's decline (a phone's or tablet's `cancel`, or the owner desktop's with `decline: true`) is
  legal only from `open` (`409 invalid_state` from `proxy-answered`, `human-answered` or `expired`); it
  compare-and-swaps on `expected_revision` and does not bump the revision, exactly like a desktop's. The first committed
  cancel wins; a retry after it, flagged or not and from any device, is a no-op that stores nothing, so a decline is
  never relabelled a withdrawal or the other way round. A desktop's withdrawal keeps its existing rules (`open` or
  `proxy-answered`).
- **Relay.** The question becomes `cancelled`, emits `decision.cancelled` (provenance `null`, `deliverable: false`) and
  cancels every scheduled job for it: no further new-question, reminder, reply or expiry work is scheduled or run. A
  notification already being sent when the cancel commits may still arrive. Its snapshot is cleared and its thread closed, as for any cancelled question.
- **Attribution.** "Declined by the person" versus "withdrawn by the desktop" is derived only from the signed record:
  the signer's owner-certified role and, for the owner desktop, the signed `decline` flag
  (`isPersonDecline(action, role, record.decline)` in `state.ts`), never from a relay-supplied field. Receivers verify
  the signature and certificate before classifying it; a reader that supports the owner desktop's decline also passes
  the signed flag to `roleMaySign` and `applyAction`, and one that predates the flag reads a flagged owner cancel as a
  withdrawal. The flag is part of the signed bytes, so a relay can neither forge a decline nor turn one into a
  withdrawal.
- **Phones and tablets** show a decline made on a phone or tablet as "Declined by you" in History, and the owner desktop's
  verified decline as "Declined by you on {computer}", named from the owner desktop's certificate, both distinct from
  "Withdrawn on {computer}" and "Expired without an answer"; a decline leaves Needs you and the badge on every paired
  device once it syncs. The phone app passes the signed flag to `roleMaySign` and `applyAction`: a flagged cancel from
  any other signer, or one whose signature fails, is ignored and never shown as the person's.
- **Desktops** that verify a phone's or tablet's cancel, or the owner desktop's with `decline: true`, record a content-free
  decline entry and, if the asking agent is still listening, type a notice with `status: declined` and `authorised: no`,
  the same whichever device declined. An agent that has gone is never resumed, nor
  flagged as a delivery failure, just to hear it. The bridge's `get_decision` reports `status: cancelled` with
  `closed_reason: declined` (`withdrawn` for a desktop cancel, `expired` for an expiry) and no provenance, choice or
  text. A decline never authorises anything.
- **Older desktops.** A desktop that predates declines rejects a phone-signed cancel during verification and only
  audits it, so its copy of the question would stay open while everything else treated it as closed. So the relay
  commits a phone's or tablet's decline only when the question's publishing desktop (its `originating_device_id`) declared
  `person-declines-v1` on its latest socket ticket (section 19). Otherwise it refuses with `409 invalid_state` and
  `details: {reason: "creator-missing-feature", required_feature: "person-declines-v1"}`, stores no receipt, and the
  question stays open until it is answered, withdrawn or expires. A revoked publishing desktop is sent nothing, so its
  questions can always be declined from a phone or tablet. The check comes after the transition and revision checks. Phones and tablets
  offer Dismiss only where the publishing desktop declared it; the desktop library declares it on every bridge.
- **The owner desktop's decline.** A desktop that knows a phone's decline but not the flag would verify an owner-desktop
  decline as an ordinary withdrawal. So the relay commits one only when the question's publishing desktop declared
  `owner-desktop-declines-v1` on its latest socket ticket; otherwise it refuses with `409 invalid_state` and
  `details: {reason: "creator-missing-feature", required_feature: "owner-desktop-declines-v1"}` and stores nothing, as
  above. The owner desktop's decline needs only this feature, not `person-declines-v1`. A revoked publishing desktop
  declares nothing, so the owner desktop can withdraw its questions but not decline them. A client that predates the
  flag still verifies the record and shows the question as withdrawn. The desktop library declares the feature on every
  bridge, and signs the owner desktop's decline only from the host app (`declineQuestion`, never an MCP tool). A cancel of a
  question another cancel closed first answers `200` with a receipt shaped like a committed one's, and a retry of a
  decline gets back the receipt it was first given, so the library confirms a decline by finding its signed record in
  the question's action log (`GET /questions/{id}`) before reporting it declined.

## 7. Event ledger and sync

Every committed transition appends an immutable `LedgerEvent` with a monotonically increasing `seq` assigned by
the Durable Object. Delivery is **at-least-once**; consumers dedupe by `event_id`. Event types added after 0.3.0 are
sent only to clients that declared the feature they belong to (section 19). Event types and `data` shapes are
in `api.ts` (`EventData`). Notable: `decision.created` and `decision.*.committed` carry the signed record plus
ciphertext; `decision.expired` is relay-asserted and unsigned (it never authorises anything). A client believes it only
for the round in force (`question_revision`), the host the question was signed for (`target_host_id`) and the deadline
signed for that round (the question's, or its latest reopen's), and only when both `occurred_at` and `expired_at` are
at or past that deadline; a round reopened with `expires_at: null` never expires. The desktop bridge also refuses one
older than the question's last applied event, and judges by its own clock when it first stored the claim: more than
two minutes before the deadline it is refused, closer than that it waits, in ledger order, until the deadline has
passed locally. The notice it types records the signed deadline as the time the question expired.

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
  reopen, delete, diagnostics), and it never signs `answer`, `override` or `confirm-proxy` (only the owner desktop
  answers for the person, section 2).
- `POST /epoch/rotate` (owner): same body, without revoking anyone.

## 11. Push, reminders and expiry

`GET /push/config`, `POST /push/subscriptions {endpoint, p256dh, auth, features?}`, `DELETE /push/subscriptions/{id}`,
`POST /push/test`. Payloads are generic JSON (`{"type":"decision-new","question_id":"…"}`; every allowed shape is `PushPayload`, which
admits a type and a question id and nothing else, `decision-reply` marks an agent message that expects a reply, and
`test` and `agent-stopped` carry the type alone)
encrypted per RFC 8291 and
signed with VAPID (RFC 8292); the lock-screen text is fixed client-side by the service worker. Endpoints must be HTTPS
on a known push-service host. One Durable Object alarm drives a SQL `scheduled_jobs` table: initial notification
(deferred for `proxy-*` questions until the proxy abstains or a grace period passes), reminders (first after 4 h, then
every 24 h, max 3), proxy-review reminder, expiry, attachment deletion and orphan GC. `GET/PUT /settings` stores quiet
hours and reminder preferences (notification preferences only; they never delay sync).

**Push lifetime.** A push's `TTL` is how long a push service may hold it for a device that is offline. While a question
is open with an `expires_at`, its pushes (`decision-new`, `decision-reminder` and `decision-reply`) live only as long as
the person can still answer: the TTL is the whole seconds left until the deadline, at most 86,400, worked out again
just before each endpoint's send and each retry. Once less than a second is left, nothing more is sent and no retry is
lined up. A push whose job is cancelled while it is going out (the question is answered, say) reaches no further
endpoint and is not retried. Every other push keeps a TTL of 86,400 seconds: a question without a deadline, the `decision-proxy` notice and
proxy-review reminder (a proxy answer ends the deadline), a `decision-reply` for a question no longer open, and test
pushes; `agent-stopped` has its own (below). The relay never queues a new question's push or a reminder to be due with
less than a second left, and drops one that quiet hours or the presence hold would defer that long instead of deferring
it; a reminder dropped this way lines up no next one. A reply push that quiet hours hold still waits for them to end: a
proxy answer meanwhile ends the deadline without answering the agent's message, and the question's expiry cancels the
push otherwise. The lock-screen text stays the same fixed text. A notification already shown can still be opened, and shows the
question as it is now.

**Presence** (`presence-v1`). The owner desktop says the person is at the computer with `PUT /presence`
`PresenceBody {protocol_version, present}` → `200 PresenceResponse {present, until}`. `present: true` starts or renews
a lease that ends `presenceLeaseMs` (60 s) after the relay accepts it, and `until` says when, so the desktop renews in
time; `present: false` ends it at once. Only the owner desktop reports (`403 forbidden` for any other role), and a
report carries nothing about questions, panes or content. The relay keeps only the current lease's end: no history,
no event, no push, and nothing runs when a lease lapses. A desktop that sleeps or loses its connection stops renewing,
so its lease lapses within a minute.

While a lease is current, a question's `decision-new` push waits for the person at the computer: until the lease
lapses or `presenceHoldMs` (120 s) after the relay accepted the question, whichever comes first. The hold counts from
the question's creation, or from its latest reopen, which starts a new round. Renewing the lease, a retry or a proxy
abstaining never moves it, so a question not answered at the computer still reaches the phone, `human-required` ones
included. The relay checks the hold when the push is due, so a lease that starts during a `proxy-*` question's grace
holds that push too; the grace itself is unchanged. Ending a lease releases a held push when the relay was already due
to check it again, at most one lease later. A question answered on any device, declined, withdrawn or expired during
the hold never sends its held push. A push whose sending has begun cannot be recalled.

The hold covers the `decision-new` push of a new question, of a proxy abstaining and of a reopen. It leaves out the
`decision-proxy` notice of a proxy answer and the proxy-review reminder (only a phone or tablet confirms or overrides a
proxy answer), reply pushes (`decision-reply`, for a later agent message once the person already knows of the
question), reminders (never held; the first comes hours later unless the person set it sooner) and test pushes. Quiet
hours apply after the hold as before, and can defer a push past it, though never to the question's deadline. A relay that does not advertise `presence-v1` has
no `/presence` route and pushes as it always has; a client MUST NOT send presence to it.

**Agent stopped** (`agent-stopped-push-v1`). The owner desktop tells the person's phone that an agent stopped while
they were away with `POST /push/agent-stopped` `AgentStoppedPushBody {protocol_version}` →
`200 AgentStoppedPushResponse {outcome}`. Only the owner desktop asks (`403 forbidden` for any other role), and the
request names nothing: which agent stopped, in which pane or project, how many and why all stay on the computer, as do
which stops count, whether the person is away and their setting, which belong to the host app. The body is strict, so
any other field is `400 validation_error`. The push is `{"type":"agent-stopped"}`; no question id or any other field
fits `PushPayload`. From each request, sent or dropped, the relay learns that some agent on the owner computer
stopped, and when, and, since the desktop asks only while the person is away, that they probably were.

It goes only to an endpoint that declared it can show one, by subscribing with `features` listing
`agent-stopped-push-v1`. Each subscription replaces its endpoint's declaration, so the same endpoint subscribed again
without it, by an older app, receives none, and every endpoint from before the relay knew the feature starts unable.
The declaration belongs to the push subscription, so it also covers a row the same browser left, with the same
endpoint and keys, under an earlier pairing that was never revoked. A device's socket-ticket declaration does not count: one device holds up to five endpoints, and the
service worker that shows a push can be an older build than the page that declared, so a phone app MUST declare only
what its active service worker can show. `PushSubscriptionInfo.features` says what the relay applied. The relay reads
each endpoint again just before sending to it, so a declaration withdrawn while a push is going out to other endpoints
applies at once.

The relay drops the request, with the `outcome`:

- `quiet-hours` during quiet hours, never deferred: an agent that stopped at 2am is no news at 7am. The presence hold
  does not apply, since the desktop asks only while the person is away;
- `no-subscription` when no endpoint can show it;
- `rate-limited` when it accepted one within the last `agentStoppedPushWindowMs` (60 s).

Otherwise it accepts the request, which starts a new window, and sends with `Urgency: high`, a TTL of
`agentStoppedPushTtlSeconds` (600 s) and the fixed `Topic: agent-stopped`: for each endpoint of a phone that is
offline, a push service holds at most the latest one, and drops it unsent within ten minutes. The outcome is `sent`
when a push service took it for at least one endpoint and `failed` when none did; a failed push still used the window.
Every outcome is final. A desktop MUST NOT retry a request, whatever its outcome, nor after a refusal that comes before
the route runs, such as a `429 rate_limited` from the relay's per-device request budget. Quiet hours and an empty
endpoint list use no window, so the next stop is asked for as usual. No job or event comes of a request, and the relay keeps
only when it last accepted one, until its daily cleanup once that is a day old, or `POST /admin/delete-data` with
scope `everything`. A relay that does not advertise `agent-stopped-push-v1` has no such route; a desktop MUST NOT ask
it.

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
phone image and reservation, pane snapshot and outstanding snapshot refresh. `everything` also ends the presence lease
(section 11); a questions wipe keeps it.

## 15. Conformance

A compatible relay MUST pass `worker/tests/*.test.ts` semantics: signature/replay rejection, CAS and first-answer-wins,
proxy never satisfying `human-required`, idempotency, ordered event paging, revocation, reminder cancellation, a
presence hold that never outlasts its bound,
attachment integrity, no plaintext in storage, feature filtering that keeps a 0.3.0 client parsing every page and
frame (section 19), and the advisory shape and round table of section 21.

## Extensions: threads, phone images, pane snapshots, involvement and advisory questions

Sections 16 to 21 define five opt-in extensions, each named by a feature (section 19). Their shapes are in
`thread.ts`, `snapshot.ts`, `involvement.ts`, `features.ts` and `schema.ts`, and in `schemas.json`. Their routes join `ROUTE_MANIFEST`
and `openapi.json` when the relay serves them (the thread-message routes have); until a relay advertises a feature in
`GET /info`, clients MUST NOT use it. `@daintreehq/decisions-protocol/fixtures` exports shared test data for relay, client and app tests: a thread
with messages in both directions (`THREAD_FIXTURE`), phone image references, a fresh snapshot, stale snapshots and a
sharing-off record. Content there is plaintext and records are unsigned templates that each test encrypts and signs
with its own keys.

## 16. Thread messages (`thread-messages-v1`)

A message is a follow-up on one existing question, from one of two sides:

- **human**: signed by a paired `phone` or `tablet`, or by the `owner-desktop` for the person on the computer
  (below), never by a `desktop-host`;
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

**From the computer.** The owner desktop may sign the person's human message on any question, its own or a Host's,
before or after an answer, as a phone does; `expects_reply` stays false on it like on every human message. The
reasoning of section 2 holds: it certifies every device, so this gives it nothing it could not get by pairing a phone
of its own. A message carries no provenance field, so a client attributes a human message by its signer's certified
role (`humanMessageSentOn` in `thread.ts`): the person's message sent from the computer for the owner desktop, and
from the phone for a phone or tablet. Nothing the relay says plays a part. An owner-desktop message lists no phone
images (`403 forbidden`).

The question's publishing desktop types the message into the pane (section 16.3), and a desktop that predates
owner-desktop messages rejects one. So the relay commits an owner-desktop human message only when the publishing
desktop (its `originating_device_id`) declared `owner-desktop-messages-v1` on its latest socket ticket (section 19);
a revoked desktop has declared nothing. Otherwise it refuses with `409 invalid_state` and
`details: {reason: "creator-missing-feature", required_feature: "owner-desktop-messages-v1"}` (`CREATOR_MISSING_FEATURE`),
which a client tells apart by `details.reason`. The check comes after the role and state checks of `applyMessage`
and before the `thread-messages-v1` check every human message passes, so a desktop that declared neither gets this
refusal. A refused message stores no receipt, so the same signed message commits once the publishing desktop declares
support, and a retry of a committed one returns its receipt whatever the desktop declared since. The phone app shows
a human message the owner desktop signed as the person's, sent from the computer and named with that desktop's
certified name, and counts it as the person's reply (section 16.2) on every phone. A phone app that cannot verify one
(an unknown or revoked signer, or one that predates this) never shows it as the person's: it refuses that one message
as unverified and goes on with the rest of the thread. The desktop library declares `owner-desktop-messages-v1`
together with `thread-messages-v1` when it types follow-ups, accepts such a message from the pinned owner desktop only
then (never one that lists phone images, and never a `desktop-host`'s), and types it with `sent_from: computer`.

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

"Withdrawn" is how the app shows `cancelled`, and "Declined" when a phone or tablet signed the cancel (section 6.1);
there is no separate status. An answer is final for the answer, not for
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

| Route                                        | Role                                                               | Notes                                                                                                                                                          |
| -------------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /questions/{id}/messages`              | human: phone, tablet, owner-desktop; agent: the publishing desktop | `MessageBody {protocol_version, idempotency_key, message}` → `201 MessageReceipt`; owner-desktop needs `owner-desktop-messages-v1` from the publishing desktop |
| `GET /questions/{id}/messages?after=&limit=` | any                                                                | `MessagesPage`: `MessageView` (entry, `event_seq`, delivery) in `message_seq` order                                                                            |
| `POST /deliveries/messages`                  | the publishing desktop                                             | `MessageReceiptBody` (section 16.4)                                                                                                                            |

Events: `decision.message.posted` (`EventData.messagePosted`: the `MessageEntry` and `target_host_id`; the event's
`question_revision` is null) and `delivery.message` (`EventData.messageDelivery`).

### 16.1 Answers are final

A human answer is final in the product: saying more after answering is a message, not an `override`, and an app built
for threads never offers to change a human answer. The phone app does not: once a question is answered, its composer
sends follow-ups (section 16), and it offers an `override` only to overrule a model answer. For compatibility, the
relay still accepts a phone's `override` of a human answer, unchanged (a new revision, delivered as a correction):
phones keep running cached copies of the 0.3.0 app, which corrected answers that way, 0.3.0 Daintree delivers
corrections, and the relay cannot tell an older app from a newer one. It is deprecated, and a later protocol version
may refuse it. Confirming or overruling a proxy (model) answer with `confirm-proxy` or `override` is unchanged and not
deprecated.

### 16.2 Waiting on the person

An agent message with `expects_reply: true` asks the person something. The thread waits on the person
(`threadAwaitsHuman`) while the latest agent message expects a reply and nothing human came after it in ledger order:
a human message or the person's answer (each from a phone, a tablet or the owner desktop), override or confirmation. A
later agent message that asks nothing withdraws the request. Closed threads wait on nobody. An open question needs the person anyway; this is what shows an answered one as
"Needs you" again. The relay sends a `decision-reply` push (`{type, question_id}` and nothing else) for an agent message
that expects a reply. Quiet hours hold it back like any push, a newer asking message on the same question replaces one
not yet sent, and when it is due the relay sends it only if the thread still waits on the person. While the question
is open with a deadline, the push's lifetime ends there (section 11).

### 16.3 Delivering human messages

The publishing desktop types each human message into the asking pane the way it types an answer, but as a follow-up,
never as an answer or an approval. Agent messages are not delivered anywhere; phones read them.

It follows the answer's rules: the exact pane identity, only at an idle prompt, held while the pane is busy, resumed
when the agent's session must be, and `needs-attention` when the pane is gone. An answer and messages waiting for the
same pane are typed in thread order (ledger order), batched when they fit, and a message never holds back or changes
an answer's delivery. The typed text is its own block, distinct from an answer block, saying that it is a message the
reviewer sent about the question, from their phone or, for one the owner desktop signed, from the computer, and that
it does not change the answer. The client library's format (`[DAINTREE DECISION FOLLOW-UP]`) is specified line by line
in the [integration spec](./daintree-integration-spec.md) section 6.4, with fixtures of the exact bytes: its preface
names no device, and a block for a message sent from the computer adds `sent_from: computer` after `source: human`.

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
   `message_id` the image will be signed into. The question must exist and take messages (section 16), or the
   relay answers `404 not_found`, `410 expired` or `409 invalid_state`; it is also `409 invalid_state` when the
   publishing desktop does not declare `phone-images-v1`. A retry with the same `idempotency_key` and body on the
   same question returns the original reservation; the same key on another question is
   `409 idempotency_collision`.
2. `PUT /attachments/{id}/content` and `POST /attachments/{id}/complete`, as for question attachments, by the same
   device. The reservation's kind decides the role: a desktop is refused a phone image's upload or completion
   (`403 forbidden`), as a phone or tablet is a question attachment's. Completion also checks the stored object's
   SHA-256 against the reservation and publishes nothing: there is no `attachment.available` event for a phone
   image.
3. The signer lists the ids in the signed record (`ActionRecord.attachment_ids` on an `answer` or `override`, or
   `MessageRecord.attachment_ids`) and the same images in the encrypted content. At commit the relay requires every
   listed id to be completed, reserved by the signer for this question and exactly this `binding`, and not yet bound;
   it binds them all or commits nothing (`400 validation_error`). An image binds once, and one past its orphan
   deadline (below) no longer binds. At commit the publishing desktop must still declare `phone-images-v1`, or it
   would be sent nothing it could deliver (`409 invalid_state`).
4. Readers check `imagesMatchRecord`, then the downloaded image's size, MIME and `sha256`. A reader that cannot fetch
   or verify an image still shows the answer or message, and shows that image as unavailable. A desktop types the
   words with each image's local path, or its reason for being unavailable, into the asking pane (integration spec
   section 6.4); plaintext images exist only on the phone and the host's disk. The relay sees only ciphertext: it
   proves the bytes are the ones reserved (R2 checks the digest while streaming, and completion checks it again),
   and that the record lists only images it bound, but a plaintext digest that does not match its image is caught
   by the reader.

**Reading.** `GET /attachments/{id}/content` serves a phone image to any active paired device once a committed
answer or message lists it, and until its retention ends; before that, after it, and for an image nothing listed,
it is `404 not_found`, even for the phone that uploaded it. `GET /questions/{id}` lists only the question's own
attachments: phone images are listed by the records that reference them.

`ActionRecord.attachment_ids` is optional with no default, so records signed without it verify exactly as before.
Phone images never join the question's attachments or `reviewed_attachment_digests`, and never count as approval
evidence. Until a relay advertises `phone-images-v1` it refuses an action that lists images (`400
validation_error`).

**Limits.** 10 MiB per image; 4 per answer or message; 16 per question over its lifetime, reserved or bound; 64 MiB of
ciphertext per question; 8 unbound reservations per device. These are separate from the desktop's question-image
budgets (section 9). The per-question budgets count every phone image ever reserved on the question, so collecting
orphans never refills them; the per-device budget counts reservations not yet bound, completed or not. Over a
budget the relay answers `413 payload_too_large`, or `429 rate_limited` for the per-device one.

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

**Features** (`ProtocolFeature`): `thread-messages-v1`, `phone-images-v1`, `pane-snapshots-v1`,
`owner-desktop-answers-v1`, `involvement-v1`, `person-declines-v1`, `owner-desktop-messages-v1`, `owner-desktop-declines-v1`, `presence-v1`, `agent-stopped-push-v1`, `advisory-deadlines-v1`. Lists a client receives use `FeatureToken`, so a newer peer's unknown
features parse and are ignored (`knownFeatures`).

`advisory-deadlines-v1` filters no events. What it says depends on who declares it, and the relay checks none of the
declarations when it admits a create (section 21).

`owner-desktop-answers-v1` filters no events. A publishing desktop declares it to say it accepts the owner desktop's
answers to its questions (section 2), and the relay checks that desktop's latest socket-ticket declaration before
committing one; a `GET /events` declaration is not recorded and does not count. The committed answer is sent to every
client whatever it declared, so no client's cursor passes over it unseen; whether a client accepts it is the signer
check of section 2.

`presence-v1` filters no events and needs no declaration: it advertises `PUT /presence` and the push hold of
section 11, and a client reports presence only to a relay that lists it.

`agent-stopped-push-v1` filters no events. In `GET /info` it advertises `POST /push/agent-stopped`, and a desktop asks
only a relay that lists it. On a push subscription (`PushSubscribeBody.features`, section 11) it says that endpoint's
service worker can show an `agent-stopped` push, and only that declaration counts: the same token on a socket ticket or
`GET /events` declares nothing about any endpoint.

`person-declines-v1` filters no events either. A publishing desktop declares it to say it files a phone's or tablet's
decline of its questions (section 6.1), and the relay checks that desktop's latest socket-ticket declaration in the
same way before committing one. The committed `decision.cancelled` is sent to every client.

`owner-desktop-messages-v1` adds no event filter either. A publishing desktop declares it to say it accepts the
person's human messages signed by the owner desktop on its questions (section 16), and the relay checks that desktop's
latest socket-ticket declaration in the same way before committing one. The committed `decision.message.posted` needs
`thread-messages-v1`, like every message, and nothing more; whether a client accepts it is the signer check of
section 16.

`owner-desktop-declines-v1` filters no events either. A publishing desktop declares it to say it files the owner
desktop's decline of its questions (a `cancel` with `decline: true`, section 6.1) as the person's, and the relay checks
that desktop's latest socket-ticket declaration before committing one. The committed `decision.cancelled` is sent to
every client; one that predates the flag reads it as a withdrawal.

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
(`GET /questions/{id}/messages`, `GET /questions/{id}/snapshot`, `GET /involvement`): its cursor may already be past
events it was not sent.

**Version.** `PROTOCOL_VERSION` stays 1. Everything here is additive, and a client that declares nothing sees the
0.3.0 protocol but for one new value, below. The new optional fields in existing shapes (`ActionRecord.attachment_ids`,
`ActionRecord.decline`,
`HumanAnswerContentV1.images`, `DecisionContentV1.preparation`, `InfoResponse.features`, `DeviceInfo.features`,
`SocketTicketBody.features`, `PushSubscribeBody.features`, `PushSubscriptionInfo.features`) parse under 0.3.0 schemas, and a non-empty `attachment_ids` appears only on events a 0.3.0
client is never sent (an empty list is harmless). `decline: true` is on a `decision.cancelled` that every client is
sent: the record is a loose object and the flag is part of its signed bytes, so a 0.3.0 client verifies it and reads the
cancel as a withdrawal. The one new value in an existing field is `human-desktop`
provenance, on the action events and question details of an owner-desktop answer, which every client is sent. An
events page still parses under 0.3.0 schemas, since they leave event data unchecked. A client that verifies the event
(its `EventData.action` schema, or the signer's role) rejects that one event and goes on with the rest of the page,
and one that validates a question detail against its old `QuestionDetail` schema fails on a detail that lists it. The
relay commits one only for a question whose publishing desktop declared `owner-desktop-answers-v1`, so a desktop that
cannot read it never has one of its own to deliver.

`EnvelopeAad.reply_mode` is the one new field that a 0.8.0 or older schema refuses, on purpose: it marks an advisory
question, which such a reader must not show as one that waits for a decision (section 21). It appears only on an
advisory question's create, which a host signs only when the relay and a paired phone or tablet declare
`advisory-deadlines-v1`, and an events page still parses under 0.3.0 schemas.

**Proof.** `@daintreehq/decisions-protocol/fixtures` exports `Legacy030` (the 0.3.0 schemas, frozen) and the 0.3.0
desktop and phone catch-up loops. `packages/protocol/tests/features.test.ts` runs them against `buildEventsPage`, and
`worker/tests/legacy-client.test.ts` against the relay.

## 20. Involvement preference (`involvement-v1`)

How involved the person wants to be right now, set on a phone, a tablet or the owner desktop and read by agents through
their desktop.
There is one per installation. It describes how the person wants to take part, never what an agent may do: no
requirement, workflow gate, proxy rule or approval reads it (`enforceRequirement` and `applyAction` take nothing from
it), and a consensus among agents is a recommendation, never an answer. A `human-required` question still goes to the
person, and a preparation must not stop or indefinitely delay it.

**Modes** (`InvolvementMode`):

| Mode            | What the person asked for                                                                                                                                                    |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `involve-early` | ask while exploring the options, rather than waiting for a finished recommendation                                                                                           |
| `recommend`     | consult `consult_count` other agents first, try to agree, then bring the recommendation and its reasoning; if they cannot agree, bring the disagreement and the alternatives |

`InvolvementRecord` (signed by the phone, tablet or owner desktop that sets it, not encrypted): `{v, type:
"involvement.preference", installation_id, revision, normal_mode, consult_count, override, created_at, signer_device_id,
signature}`. `consult_count` is 1 to 8 (`involvementConsultMax`) other agents, the asking agent excluded, and applies to
`recommend`. `override` is null or `{mode, until}`: a temporary mode in force while `now < until`, after which the
normal mode applies again. `created_at` is the signer's clock: shown, never used to order records.

**In force** (`effectiveInvolvement`). Worked out on every read: the temporary mode until `until`, the normal mode
from `until` on. Nothing is written when a temporary mode ends: no timer, event or new revision. A reader that only
compares revisions therefore misses the end of a temporary mode; it compares the mode and `until` too.

**Setting.** `PUT /involvement` (phone, tablet, owner desktop; never a `desktop-host`) `InvolvementBody
{protocol_version, idempotency_key, preference}` → `200 InvolvementReceipt {revision, event_seq}`. The record must name
this installation and the authenticated device as its signer, and its signature must verify (`400 validation_error`).
Its `revision` must be exactly one more than the stored one (0 when there is none); anything else is `409
revision_conflict {details.latest_revision}`, so two devices saving at once cannot both win, the owner desktop included,
and the one that lost reads the preference again rather than re-signing over the other's choice. A temporary mode must
end after relay time and at most 30 days (`involvementOverrideMaxMs`) plus the request skew ahead
(`involvementWriteIssue`, `400 validation_error`). The revision, the end time and the device's standing are checked
again in the final transaction. A retry with the same `idempotency_key` and body returns the original receipt and
changes nothing, even after a later write or after its temporary mode ended; the receipt holds the revision and event
sequence only, never the preference.

**Where it was set.** The signer's certified role says where the person set the preference (`involvementSetOn`):
`computer` for the owner desktop, `phone` for a phone or tablet. A reader takes it from the certificate it verified the
record with, never from the relay. It is for display only: a preference steers agents the same way wherever it was
set, and changes nothing an agent may do or what needs approval. The owner desktop certifies every other device, so
setting the preference gives it nothing it could not get by pairing a phone of its own.

**Reading.** `GET /involvement` (any paired device) → `InvolvementResponse {preference, received_at}`: the latest
signed record and when the relay accepted it, or nulls. The relay keeps no older record. Reading creates nothing: no
event, job or notification.

**Hint.** Each accepted record appends `involvement.updated {revision}` with a null `question_id` and
`question_revision`, and removes the hint before it, so the ledger holds no history of the preference. It is sent only
to clients that declared `involvement-v1`. It only says "read again": its revision is the relay's word and is never
trusted on its own. Setting the preference never triggers a push.

**Verifying.** Readers verify the record before using it: this installation's, signed by the pinned owner desktop or by
a phone or tablet whose certificate chains to it, never by a `desktop-host`, with a signature covering every field. A
record whose signer is revoked (in the device directory, or by a `device.revoked` the reader saw) steers nothing. A
desktop keeps the highest revision it has verified and refuses a lower one, a different record at the same revision, and
no record at all once it has verified one, so a relay cannot roll the preference back or swap it. A signature proves who
set a record, not that it is the newest: a relay can still withhold a newer one, which is why readers report when they
last confirmed it.

**Readers from before the owner desktop could set it** (0.7.0 and earlier) take a record only from a phone or tablet.
A desktop refuses an owner-desktop record and keeps the copy it last verified, so the record never steers its agents;
it reads again each time it retries until a phone or tablet replaces the record. A phone shows nothing from it and
never presents it as the person's, and can replace it, since it knows the served revision. A refusal sets no revision
floor, so either takes the next phone- or tablet-signed record. `@daintreehq/decisions-protocol/fixtures` freezes both
readers (`legacyDesktopInvolvementRead`, `legacyPhoneInvolvementRead`) and `worker/tests/legacy-client.test.ts` runs
them against the relay.

**Storage and deletion.** The relay keeps the latest record and when it accepted it. A questions wipe
(`POST /admin/delete-data {scope: "questions"}`) keeps it; `scope: "everything"` removes it.

| Route              | Role                         | Notes                                                                      |
| ------------------ | ---------------------------- | -------------------------------------------------------------------------- |
| `GET /involvement` | any                          | `InvolvementResponse`; nulls when nobody has set one                       |
| `PUT /involvement` | owner-desktop, phone, tablet | `InvolvementBody` → `200 InvolvementReceipt`; compare-and-swap on revision |

### 20.1 Preparation reports

An agent can say how it prepared a question: `ask_human`'s optional `preparation`, carried inside the encrypted
question content as `DecisionContentV1.preparation`:

`PreparationReport {preference_revision, agents_consulted, outcome, summary?}`, where `preference_revision` is the
involvement revision the agent worked under (null when none was available), `agents_consulted` is how many other
agents it actually consulted (0 to 64), `outcome` is `agreed`, `split` (no agreement, or inconclusive) or `not-run`
(no consultation happened), and `summary` is at most 2,000 characters of its reasoning, the disagreement, or why the
consultation did not run.

It is the agent's own account and nothing checks it. Phones show it as such, never as a verified result. It is not
signed separately and is not visible to the relay, and its absence means only that no report was given, never that a
consultation succeeded. A reader drops a malformed report rather than failing the question, and a 0.3.0 phone ignores
it. Accepting a question never depends on it or on the preference's current revision.

## 21. Advisory questions (`advisory-deadlines-v1`)

A question is **blocking** by default: it waits for a decision, and its expiry authorises nothing. An **advisory**
question asks for input on a step its agent may already take on its own ("Which fixture should I use? If I haven't
heard in 15 minutes, I'll use the in-memory one."). An answer that commits before the deadline is delivered as usual.
If none does, the asking host may tell its agent that the plan it stated is due. An advisory question never approves
anything, and a step that needs approval is never asked this way.

**Signed shape** (`schema.ts`):

- **Mode.** `EnvelopeAad.reply_mode: "advisory"` on the create's `question-content` envelope (`record_type`
  `question`, `revision` 0). Absent means blocking. It is optional with no default, so every blocking envelope
  encrypts, digests and signs exactly as before (`replyModeOf`). AES-GCM authenticates it as part of the AAD, and the
  envelope digest that covers it is signed into the record.
- **Deadline.** The record's signed `expires_at`. It must be finite, and the relay checks it like any other
  (section 6).
- **No gate.** `workflow_gate_id_hash` is null.
- **Plan.** `DecisionContentV1.planned_fallback`, the agent's plan in its own words: at most
  `LIMITS.plannedFallbackChars` (1,000 UTF-16 code units, as JavaScript counts a string), not blank, inside the
  encrypted content. The content parse drops a plan that breaks either rule, which leaves an advisory question with
  no plan (refused below). It is bound to the question
  and its first round because the ciphertext's AAD names the question id, revision 0 and sender, and the envelope digest
  is signed into the record beside the deadline. The relay never sees it, and no hash of it is published, since a
  short plan could be guessed from one.

Every reader of a signed question (`SignedQuestion`, `EventData.created`, `QuestionDetail`) refuses an advisory
question with a null deadline or a gate hash, and the mode on any other envelope (another record type, revision or
purpose). The relay answers `400 validation_error`. A client treats such a question as malformed. Once it decrypts the
content, a reader also refuses an advisory question that is an approval or has no plan, none sent or one the parse
dropped (`advisoryContentIssue`),
whoever signed it, and treats it as malformed: it is never shown as optional, nor with a plan it could not read.

**Rounds.** The advisory round is the one the create opens, at revision 0 (`ADVISORY_ROUND_REVISION`,
`isAdvisoryRound`). A reopen (owner desktop, revision r+1, with its own signed `expires_at`) opens a **blocking**
round: it carries no plan, and its expiry authorises nothing. A new advisory ask is a new question.

**Transition table** (`applyRoundEvent` in `state.ts`; cases in `ROUND_CASES`). `D` is the round's signed deadline.
Every comparison uses the relay's commit time: `now >= D` is due, so an answer committed at exactly `D` is late. A
committed answer stays timely however late a desktop receives it, and a reader replaying history never re-judges it
by its own clock.

The order is the relay's. The route's role check comes first, and a refusal there commits nothing. Then a due deadline
commits (`RoundResult.expired`), because the relay sweeps due questions before it decides. Then the event applies to
the round as it now stands (`transition`, or `error`). A relay that finds the deadline passed inside the submission's
own transaction (it fell between the sweep and the decision) commits the expiry and answers `410 expired` whatever the
action. The round is expired either way, and the submitter re-reads it. The table covers what the relay decides from the round alone. Once the table admits an event, and before the event
commits, the relay also refuses a `confirm-proxy` that does not name the latest proxy answer (`400 validation_error`),
a person's action the publishing desktop has not declared it accepts (`409 invalid_state` with
`creator-missing-feature`, section 19), a human message on a question whose desktop takes no messages
(`409 invalid_state`, section 16), phone images that do not bind (section 17), and a reopen past the open-question
quota (`429 rate_limited`, checked before the reopen's deadline). A deadline that committed first stays committed.

| Input                                       | Authority                                                        | From                         | Revision           | Result                                                                                                             |
| ------------------------------------------- | ---------------------------------------------------------------- | ---------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Timely answer (`answer`)                    | the person: phone, tablet or owner desktop                       | `open`, committed before `D` | CAS `r` → `r+1`    | `human-answered`, delivered as an answer                                                                           |
| Unanswered deadline                         | the relay, unsigned                                              | `open` at `now >= D`         | stays `r`          | `expired`: `advisory-unanswered` in the advisory round (the plan is due), `expired-unsatisfied` in any other round |
| Verified decline (section 6.1)              | the person: phone, tablet, or owner desktop with `decline: true` | `open`                       | CAS `r`, stays `r` | `cancelled`, declined; the plan is never due                                                                       |
| Withdrawal (a desktop's `cancel`)           | a desktop                                                        | `open` or `proxy-answered`   | CAS `r`, stays `r` | `cancelled`, withdrawn; the plan is never due                                                                      |
| Reopen                                      | the owner desktop                                                | `cancelled` or `expired`     | CAS `r` → `r+1`    | `open`, a blocking round with the reopen's deadline                                                                |
| Deletion (`DELETE /questions/{id}`)         | the owner desktop, authenticated and unsigned                    | any                          | none               | gone, with a `decision.deleted` tombstone; every later fresh command is `404 not_found`                            |
| Competing proxy answer                      | a desktop's model (`proxy-ok`, `proxy-first`)                    | `open`, committed before `D` | CAS `r` → `r+1`    | `proxy-answered`; the deadline no longer applies, and the person confirms or overrides it as usual, after `D` too  |
| Proxy abstains                              | a desktop's model                                                | `open`                       | CAS `r`, stays `r` | still `open`; the deadline stays armed                                                                             |
| Follow-up message, either side (section 16) | the person, or the publishing desktop                            | `open` or answered           | none               | nothing changes: never an answer, and the round's deadline stands as it was                                        |

Cancellation and expiry keep the revision, so revision equality alone never shows that a round is open.

**A late phone submission** observes, and then re-reads the question (`GET /questions/{id}`) to show how it closed,
never re-signing the old submission for a newer round. A fresh submission, by the question's current state:

- unanswered and past `D` (the round expires first): an answer `410 expired`, a dismissal `409 invalid_state`, a
  message `410 expired`. Any of them may instead get `410 expired` from the race above;
- answered by a person: another answer `409 revision_conflict` with the latest revision and status, at either revision.
  A message still posts, after `D` too;
- answered by a proxy: an answer `409 revision_conflict`; the person confirms or overrides instead, after `D` too;
- declined or withdrawn: an answer `409 invalid_state`; another cancel at the same revision is a `200` no-op;
- reopened and open: an answer or cancel signed for the earlier round `409 revision_conflict`. Once that round expires too, an
  answer is `410 expired`, whatever revision it names;
- deleted: `404 not_found` (a role the route refuses is `403 forbidden` first).

A retry is not a fresh submission. The same idempotency key with the same body returns the original receipt while
the relay keeps it, even after the question changed or was deleted. The same signed action under a new key returns
`200` with the question's current status and revision and the original event's seq while the question exists, and
`404 not_found` once it was deleted. `applyRoundEvent` describes fresh submissions only.

**Plan, notice and action** are three separate facts:

- The **planned action** is the encrypted `planned_fallback` of question id and round 0: what the agent said it would
  do. It is never an answer, a choice, an approval or a provenance.
- The **delivered notice** is the asking host telling its agent, once, that no answer committed by the deadline.
  `RoundTransition.fallbackDue` says the host may send it, not that it did. Whether it reached the agent is the host's
  own delivery state, keyed by question id and round. The notice says that nothing was decided or approved and that
  the agent may carry out the plan it stated, at its own discretion.
- The **action actually taken** is never observed by Decisions. Neither the deadline nor the notice says the agent
  acted. Only the agent's own later report could, and that report carries no authority.

**A timeout is not an answer.** `decision.expired` is relay-asserted, unsigned, and carries no answer, choice or
provenance. `advisory-unanswered` has `provenance: null`, `deliverable: false` and `trainable: false`. A host never
records it as the person's answer, a proxy prediction or a decision-model example. The model learns only from a
person's answer or override.

**Host support and policy** (`advisoryRefusal` in `policy.ts`). A host signs an advisory question only when every one
of these holds, and none of them defaults to true:

- the relay lists `advisory-deadlines-v1` in `GET /info`;
- the host application opted in (`BridgeOptions.advisoryDeadlines`, which also declares the feature);
- the host's trusted policy allows it (`PolicyRegistryOptions.advisoryQuestions`, default false, never set by an agent);
- at least one active phone or tablet declared `advisory-deadlines-v1` on its latest socket ticket (`GET /devices`);
- the question names no workflow gate at all: none from its origin and none from the agent, registered or not;
- its kind is not `approval`;
- the deadline is finite;
- the plan is valid.

Otherwise the host signs nothing advisory. A refusal never turns the question into a blocking one on its own: the
caller asks again without advice if it wants the person to decide. The requirement resolves as before
(`enforceRequirement`), so an advisory question can be `human-required`, and its deadline never supplies an answer.

**The feature** filters no events. In `GET /info` it says the relay validates advisory creates. On a desktop's socket
ticket it says the host delivers advisory outcomes, and on a phone's or tablet's that the app shows the deadline and
the plan. The relay checks no declaration when it admits a create, since the signer's own signature declares it. A
phone's capability is the host's check (above).

**Older and mixed versions.** A blocking question is unchanged everywhere. The mode sits in the strict AAD on purpose,
so a reader that cannot explain it refuses the question rather than showing it as one that waits:

- **Relay 0.8.0 or older** (no feature): its strict `EnvelopeAad` refuses the create with `400 validation_error`. A
  host never sends one there.
- **Phone or tablet 0.8.0 or older**: `EventData.created` fails on the AAD, so the app shows the question as one it
  cannot read, never as an ordinary one, and the person cannot answer it on that device. Every other question reads
  as before. A marker such a phone could ignore would show "Human decision required" next to the deadline, as if the
  agent would wait, while the agent may go ahead at the deadline. (Its History may still label the unreadable entry
  with that placeholder; the current app does not.)
- **0.3.0 clients**: their page and frame schemas leave event data unchecked, so catch-up goes on. A client that
  verifies the event rejects that one.
- **Strict schema readers**: `schemas.json` closes `EnvelopeAad` and `DecisionContentV1`
  (`additionalProperties: false`). A reader that validates against an older bundle refuses an advisory question's
  envelope, and its content too. The current bundle lists `reply_mode` and `planned_fallback`. `QuestionRecord` is
  unchanged. Like `ActionRecord`'s, the rules that span fields (where the mode may appear, the finite deadline, no gate,
  the plan's non-blank text) are not in the JSON Schemas: a reader enforces them with this package's schemas.
- **Desktops 0.8.0 or older** never sign an advisory question, and a host acts only on its own questions. An older
  client refuses the advisory question where it validates the `decision.created` event or the question detail. A
  `GET /questions` summary carries no envelope, so a client verifies the detail before it offers any action.
- `@daintreehq/decisions-protocol/fixtures` freezes the 0.8.0 question reader (`Legacy080Question`), and
  `worker/tests/advisory.test.ts` runs it, and the 0.3.0 catch-up loops, against the relay.

**When a phone cannot explain the plan** (`advisoryPlanOf`). A phone that declares the feature shows the deadline and
the plan. When it cannot decrypt the content (it holds no key for the content's epoch), it still reads the signed
deadline and mode, and shows the deadline and says the agent may proceed after it, without naming what it will do. A
decrypted plan that is missing or invalid, or an advisory approval, makes the question malformed rather than shown
without its plan. In a round after the first it shows nothing advisory. A phone that does not declare the feature,
whether older or merely without the advisory display, never shows the question as one that waits: it shows one it
cannot read, so the person answers on a phone that can. The phone app in this repository declares the feature once
the relay advertises it, and shows the deadline in local time with the time left, the plan, and how the round ended:
a deadline passed by its own clock is never an outcome until the relay's `decision.expired` arrives, and nothing it
shows says the agent was told or acted.

**Fixtures.** `ADVISORY_QUESTION_FIXTURE` (an advisory question), `BLOCKING_APPROVAL_FIXTURE` (a gated approval that
always waits) and `ROUND_CASES` (the transition table as event sequences, with what every implementation must
observe), as unsigned templates and plaintext content that each test encrypts and signs with its own keys.
`packages/protocol/tests/advisory.test.ts` runs every case through `applyRoundEvent`, and
`worker/tests/advisory.test.ts` holds the relay to the table's admission, timely answer, expiry, late answer, late
dismissal and reopen rows.
