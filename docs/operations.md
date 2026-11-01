# Operations

## Checks

- `pnpm decisions:doctor --url <relay>` runs unauthenticated checks (health, protocol range, claim state, headers, CSP, manifest, service worker).
- `decisions doctor` also runs authenticated checks: a signed request, a WebSocket upgrade, an encrypted attachment round trip, and the push configuration.
- `decisions status` shows relay connection, queued work, and delivery states. In Daintree the same information is in Settings → Decisions.
- `GET /api/v1/admin/diagnostics` (owner) returns counters only: jobs, alarm time, attachment totals, sockets, push health. It never contains content.

## Limits and costs (verify against Cloudflare's pages before relying on them)

These were published when this was written and can change: [Workers](https://developers.cloudflare.com/workers/platform/limits/), [Durable Objects](https://developers.cloudflare.com/durable-objects/platform/limits/), [R2 pricing](https://developers.cloudflare.com/r2/pricing/).

- A single person asking tens of questions a day is far below the free plan's request and Durable Object limits. Question text is megabytes over years.
- Screenshots dominate storage. With the default 30-day retention, two 1 MB screenshots for 40 questions a day is a few GB in R2 at steady state, near the free allowance; shorten retention in settings if you want margin.
- Idle WebSockets are hibernated, so an open connection does not accrue duration charges while quiet. Keep-alive uses plain `ping`/`pong`, which does not wake the object.
- Dictation is billed by the speech and language providers, not Cloudflare. A monthly cap (`VOICE_MONTHLY_MINUTES`, default 600) counts audio duration.
- Set a Cloudflare budget alert. This project cannot promise a zero bill.

## Retention

Question and answer ciphertext is kept until you delete it (it is your decision history). Attachments are deleted 30 days after a question reaches a terminal state (configurable 1–365 days). Orphaned uploads are collected after two hours. Nonces, tickets, receipts and finished jobs are purged nightly.

## Backups and recovery

The relay stores ciphertext only; a backup of it is useless without your keys. Back up your keys (`decisions recovery export`), not the relay. See [key-recovery.md](key-recovery.md). To rebuild a relay: deploy again, claim with the same desktop keys, and re-pair phones; history on the old relay is discarded unless you export it first (`decisions export`).

## Deleting data

- One question: `DELETE /api/v1/questions/{id}` (owner), which also removes its events and schedules removal of its attachments.
- All questions: `decisions delete-data --scope questions`.
- Everything including devices and the claim: `decisions delete-data --scope everything` (closes all sockets and releases the claim).
- Cloudflare's own backups and logs follow Cloudflare's retention. Phones keep local copies until unpaired.

## Incident: lost phone

Revoke it from Daintree or `decisions revoke <deviceId>`. The relay blocks it immediately, closes its sockets, deletes its push subscriptions, and requires a new content key for everything created afterwards.
