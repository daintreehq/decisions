# Operations

## Checks

- `pnpm decisions:doctor --url <relay>` runs unauthenticated checks (health, protocol range, claim state, headers, CSP, manifest, service worker).
- `decisions doctor` also runs authenticated checks: a signed request, a WebSocket upgrade, an encrypted attachment round trip, and the push configuration.
- `decisions status` shows relay connection, queued work, delivery states, and the last HTTP sync of a listener without a socket. In Daintree, Settings → Decisions shows the relay connection, queue and delivery states.
- `GET /api/v1/admin/diagnostics` (owner) returns counters only: jobs, alarm time, attachment totals, sockets, push health. It never contains content.

## Listening without a live socket

`decisions listen` and `decisions mcp` normally keep a WebSocket open to the relay, which pushes each answer the moment it is committed. Where a socket cannot stay open (a proxy that drops long-lived connections, a sandbox, a batch job), receive over HTTP instead:

| Command                        | What it does                                                                                                                                                                                                                                             |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `decisions listen`             | Keeps the live socket (the default).                                                                                                                                                                                                                     |
| `decisions listen --no-socket` | Polls the relay over HTTP and keeps running until Ctrl-C (SIGINT/SIGTERM).                                                                                                                                                                               |
| `decisions listen --once`      | Fetches what the relay holds, delivers it to the sink, and exits: 0 when the relay was read (even if nothing was waiting), 1 when it could not be. An answer that arrives later waits for the next run, as may one the sink held back (`exec:` exit 75). |
| `decisions mcp --no-socket`    | Serves the MCP as usual and polls the relay over HTTP for the outcomes.                                                                                                                                                                                  |

A polling listener reads again 15 seconds after each successful sync. When a read fails, it retries after 1–2 s, then 2–4 s, doubling with jitter up to 30–60 s, or later when the relay asks for a longer wait (`retry_after_ms`, honoured up to 15 minutes). Each request a sync makes (the feature declaration, the event pages and the receipt for them) has a 10-second deadline and is not retried within the sync, apart from one correction for clock skew. A relay that refuses this device's signature for any reason but revocation (a clock it cannot correct, a relay that does not know the installation) is asked again only every 5 minutes, which keeps the listener's own reads far under the relay's limit on failed authentications from one address. A relay that needs a newer client (`upgrade_required`) stops the listener with status 1. The listener resumes from the event cursor saved in its state directory (`--home`, `$DECISIONS_HOME`, by default `~/.decisions`), so a restart or an outage of any length loses no event, and an answer the sink confirmed is not typed again after a restart; one whose write is uncertain is flagged for attention, never retried. If the relay reports the device revoked, the listener stops and exits with status 1.

Each sync is reported on standard error: the first success, every failure with the error code and the next retry, and the recovery. `decisions status` shows the last HTTP sync: when it last read the whole ledger, at which event, and, while it is failing, the error code and how many attempts in a row have failed since the listener started. It is a record kept in the state directory, not a liveness check: a listener that has stopped leaves its last result behind. None of this includes question or answer text.

Run one receiving process per state directory (`--home`): the receiver reads the relay, publishes what is queued (every 5 seconds, beside its socket or polling), and delivers what it finds to its own sink. `listen` and `mcp` refuse to start while another process receives for the same directory (status 1). `ask --wait` and `wait` receive when nothing else does; while something else does, they only read the shared state, and take over if it exits. A plain `ask` publishes its own question while nothing else receives. While another process does, it leaves the publishing to that one and watches for up to 30 seconds, taking over if that process exits; a question still queued then is reported on standard error, and the next receiver sends it. The right to receive is a lock on `receiver.lock` in the state directory, released when its process ends, however it ends.

**From an MCP client.** Run `decisions mcp --no-socket --sink file:./decisions.log` (or `exec:<command>`, or the default stdout) and add it to the agent with the line it prints. `ask_human` returns the question ID at once. When the person answers or dismisses the question, or it expires, the next sync fetches the outcome and writes the notice to the sink. An agent that cannot be woken by the sink calls `get_decision` with that ID. It reads this listener's local copy, which catches up with the relay at the next sync that reads and applies the outcome: normally within one poll interval, later while the relay is unreachable. Only `status: human-answered` with `provenance: human` is the person's decision. A dismissal (`closed_reason: declined`) or an expiry never authorises the gated step. Restart with the same `--home` and token to carry on where it stopped.

## Asking from a script or an agent without Daintree

`decisions ask` asks the person from the command line, and `decisions mcp` serves `ask_human` to an agent. Both commit the question on this computer first and report it at once; publishing and the outcome follow. This walkthrough follows one question with a 15-minute reply window from the asking terminal to its outcome, and back after a restart.

### Ask

```sh
decisions --json ask "Which fixture should I use?" \
  --option mem="In memory" --option disk="On disk" \
  --expires-in 15m \
  --planned-fallback "I will use the in-memory fixture." \
  --correlation-id fixture-choice \
  --wait --wait-timeout 20m
```

- `--expires-in` (a whole number and one unit, `s`, `m`, `h` or `d`, from `61s` to `365d`) or `--expires-at` (an ISO 8601 time) sets the deadline, never both. Policy may shorten it. Neither means the default of 7 days.
- `--planned-fallback` asks for advice instead of a decision: what you will do if no answer arrives by the deadline. It is refused (status 1, with the reason after the error code, such as `not_supported: relay-unsupported: …`) for an approval, for a question without a finite deadline, by a relay that does not support advice, or when no paired phone or tablet can show it; ask again without it for a decision. A relay that cannot be read when you ask leaves that unknown (`invalid_state: support-unknown`): ask again once it can be reached. Without it, the question waits for a decision, and its expiry authorises nothing.
- `--correlation-id` makes a retry safe: the same id and the same request return the original question and its original deadline (`duplicate: true`). A changed question, option, deadline or plan under the same id asks a new question.

These are the fields and rules of `ask_human` (see [daintree-integration-spec.md](daintree-integration-spec.md) section 3.3.1). The first line of output is the receipt, written before this process publishes anything (a question that asks for advice first reads what the relay and the person's devices support): the question ID, the deadline that applies (UTC), the mode (`reply_mode`: `blocking` or `advisory`), the plan, and any change policy made. Keep the `question_id`: it is how you find the question again.

### Wait

With `--wait`, the command stays until the question has an outcome, or until you stop it. It reads the outcome from this computer's copy of the question, so it finds one that settled before it began, or in another `decisions` process on the same state directory, and it never concludes anything from its own clock: a question whose publication is unconfirmed, or whose deadline passed while the relay was unreachable, is waited for until the relay says what happened.

| Exit | Outcome            | What it means                                                                                                                                                              |
| ---- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | `answered`         | An answer is in force. Only `status: human-answered` with `provenance: human` is the person's decision; `proxy` is the opinion model's.                                    |
| 10   | `declined`         | The person chose not to answer. Nothing was approved.                                                                                                                      |
| 11   | `withdrawn`        | A desktop called the question off.                                                                                                                                         |
| 12   | `expired`          | The deadline passed unanswered, and nothing may go ahead: a question that waits for a decision, or advice this host did not let go ahead (`advisory_timeout.disposition`). |
| 13   | `advisory-expired` | The advisory deadline passed unanswered: the plan you stated is yours to carry out, at your discretion (`fallback_due: true`). Nothing was decided or approved.            |
| 14   | `never-published`  | The deadline passed before the question reached the relay, so the person never saw it. `fallback_due` says whether an advisory plan may go ahead.                          |
| 15   | `refused`          | The relay refused the question (`error_code`).                                                                                                                             |
| 16   | `wait-timeout`     | `--wait-timeout` (1s to 365d) passed first. The question is left as it is.                                                                                                 |
| 130  | `interrupted`      | SIGINT (143: SIGTERM) came first. The question is left as it is.                                                                                                           |

Status 1 is an error (a relay that refuses this client, a revoked device, an unknown question ID) and 2 a usage error (a malformed flag, both deadlines); neither is a question outcome, and neither prints a result. Stopping a wait never cancels the question: resume it with `decisions wait <question_id>`. An outcome that arrives as the wait stops is the one reported. A question that needs a person's attention (an answer that could not be accepted, a notice that could not be written) is reported once on standard error, and the wait goes on until it has an outcome: `--wait-timeout` bounds it. An advisory plan whose notice the receiving process's sink refused (a `file:` sink whose directory is missing, or an `exec:` sink whose shell could not be started) has its outcome all the same, in every process: `advisory-expired` (13), `fallback_due: true` and `delivery: needs-attention`, or `expired` once this computer's policy no longer allows advice. (A command that starts and then exits with any status but 0 or 75, a missing program included, leaves the notice `uncertain` instead, which every process also reports; 75 asks for the write to be tried again later.)

With `--json`, standard output carries one JSON object per line, each with a `record` field: `asked` (the receipt), then `notice` lines when this process's own stdout sink writes one (the text the sink would type), and finally `result`. A script reads the last line, or the line whose `record` is `result`; diagnostics (relay connection, sync failures, warnings) go to standard error only. The `result` record has `outcome`, `exit_code`, `delivery`, `signal` (for `interrupted`), and every field of `get_decision`: `status`, `provenance`, `choice`, `text`, `closed_reason`, `fallback_due`, `advisory_timeout`, `publication`, `expires_at`, `reply_mode`, `planned_fallback`, `thread` and the rest. `delivery` says where the outcome's notice stands in the receiving process's sink, kept apart from the outcome: `delivered` (the sink confirmed the write), `pending`, `uncertain` (a write may or may not have happened, and it is never written again on its own), `needs-attention` (nothing was written, and a person has to decide), or `none` (none is due). An answer whose notice is `uncertain` is still the answer in the record. Without `--json`, the receipt and the result are plain sentences, and the outcome is in the exit status.

### Recover by ID

- `decisions wait <question_id>` waits again, with the same outcomes and records as `ask --wait` (without the receipt). Use it after a restart, a lost terminal, or a `--wait-timeout`.
- `decisions get <question_id>` prints where the question stands now, without waiting, reaching the relay or typing anything: the `get_decision` fields, plus `outcome` (null while there is none) and `delivery`. It exits 0 whenever the question is found.

Both take `--pane mcp` for a question an agent asked through `decisions mcp`; the default is a question asked with `decisions ask`. A question asked from another pane is reported as unknown. Both read the state directory's local copy, which a running receiver keeps current.

While another process receives, `wait` and `get` report an advisory plan as due only once that receiver has read the relay and acted on the plan's notice: written it, perhaps written it, or had its sink refuse the write. Until then `wait` goes on and `get` reports `outcome: null` and `fallback_due: false`; neither can see whether the receiver is still reading the relay, where a reopen may be on its way. So while the notice waits to be written again (an `exec:` command that exited 75), or needs attention for another reason (no terminal to write to, or a refusal recorded by an earlier version of decisions), the receiver's own `get_decision` can already say `fallback_due: true` when `get` does not. The receiver writing the notice settles it, and so does stopping the receiver: `wait` then receives itself and reports from its own read of the relay.

### Who gets the notice

Stdout belongs to the process running the sink. A notice is written by the one process that receives for the state directory, to its own sink:

- `decisions ask --wait` with nothing else running receives itself: the default stdout sink prints the notice in the asking terminal (as a `notice` record with `--json`), and the result follows.
- With `decisions listen` or `decisions mcp` running, that process receives, and the notice goes to its sink: its own terminal (stdout), a file (`--sink file:./notices.log`), or a command (`--sink 'exec:<command>'`, which reads the notice on standard input). The waiting terminal gets the outcome in its `result`, read from the shared state, and no notice. Under `ask --json` or `wait --json`, an `exec:` command's own output goes to standard error, so standard output stays one record per line.
- An agent connected to `decisions mcp` is not woken by any of these: the stdout sink prints into the terminal running `decisions mcp`, not into the agent. `decisions mcp` tells its agents so, in its instructions and in every `ask_human` and `send_followup` result: it calls `get_decision` with the ID from `ask_human` when it is ready for the outcome, or runs `decisions wait <question_id> --pane mcp` from its own shell. Daintree's integration types the notice into the agent's own terminal, which wakes it; a standalone setup gets that only from an `exec:` command that wakes its agent itself.

The same 15-minute question through `decisions mcp`: run `decisions mcp --sink file:./notices.log` and add it to the agent with the line it prints. The agent calls `ask_human` with `expires_in: "15m"` and `planned_fallback`, gets its `question_id` at once, and carries on. If the person answers in time, the answer is written to `notices.log`; if not, an `advisory-unanswered` notice is written there once this computer has read the relay's expiry. Either way, `get_decision` (or `decisions --json get <question_id> --pane mcp`) reports it: `fallback_due: true` lets the stated plan go ahead, and `status: human-answered` with `provenance: human` is the person's decision.

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

A client refuses a state directory that a newer client has stored something in that it could misread (its local store holds a newer schema or data format). It says so in an error before it reads, migrates, seals or changes any record there; upgrade the client to use the directory. Stop running listeners before upgrading: a client already running when a newer one opens its state directory does not check again, though it never types an answer entry it does not understand.

## Deleting data

- One question: `DELETE /api/v1/questions/{id}` (owner), which also removes its events and schedules removal of its attachments.
- All questions: `decisions delete-data --scope questions`.
- Everything including devices and the claim: `decisions delete-data --scope everything` (closes all sockets and releases the claim).
- Cloudflare's own backups and logs follow Cloudflare's retention. Phones keep local copies until unpaired.

## Incident: lost phone

Revoke it from Daintree or `decisions revoke <deviceId>`. The relay blocks it immediately, closes its sockets, deletes its push subscriptions, and requires a new content key for everything created afterwards.

## Adding a Daintree Host

Each remote Daintree Host is its own `desktop-host` device with its own keys (Daintree does this for you over its link). By hand, with the CLI:

1. On the Host (with its own `--home`): `decisions host request --label "Build box"` prints a request and a code. The private keys stay on the Host.
2. On the owner machine: `decisions host enroll <request>` (or `--request-file <file>`) shows the same code; confirm it, and it prints a response. A request piped on standard input cannot be confirmed interactively, so it needs `--yes` once you have compared the code.
3. On the Host: `decisions host accept <response>`. It prints the owner key fingerprint; compare it with the owner's output.

Remove a Host like any other device: `decisions revoke <deviceId>`, which also rotates the content key.

## Releasing to npm

Every workspace package without `"private": true` is published to npm under `@daintreehq` (today `decisions-protocol`, `decisions-crypto`, `decisions-client`, `decisions-model`, `decisions-relay` (the Worker bundle and phone app `decisions deploy` uploads) and `decisions-cli`). They share one version and are published dependencies first, with npm provenance, by [`.github/workflows/release.yml`](../.github/workflows/release.yml) when a `v*` tag is pushed. The same run attaches the PWA (`decisions-app-<tag>.tar.gz`), the bundled Worker (`decisions-worker-<tag>.tar.gz`) and `SHA256SUMS` to a GitHub release.

Publishing uses npm trusted publishing (OIDC), so there is no npm token in the repository's secrets. [`tools/release/publish.mjs`](../tools/release/publish.mjs) finds the packages from the workspace, so a new public package is picked up without editing a list (it still needs a trusted publisher first; see the end of this section). It packs each one with `pnpm pack`, which turns `workspace:*` into the real version, and uploads the tarball with `npm publish <tarball> --provenance`, because npm 11.5.1 or later is what performs the OIDC exchange. Never run `npm publish` in a package directory: plain npm publishes `workspace:*` unchanged.

### Cutting a release

1. Create `release/<version>` from the latest `develop` (for example, `git switch develop`, `git pull --ff-only origin develop`, then `git switch -c release/0.2.0`). Set the new version everywhere with `pnpm release:version 0.2.0`. This rewrites the `version` of every workspace package and the version constants the CLI, the MCP server and the Worker report. Commit it (`chore: release v0.2.0`), run `pnpm compat:check --old <previous version>` ([below](#checking-against-the-previous-release)), push the release branch, and open a pull request targeting `main`. Once CI passes, merge it with a merge commit.
2. Tag the merged commit on `main` and push the tag:
   ```bash
   git switch main && git pull --ff-only origin main
   git tag v0.2.0 && git push origin v0.2.0
   ```
3. The workflow runs `verify` (the tag must equal `v` + every package's version, then typecheck and tests), then `npm` and `github-release` in parallel. The `npm` job runs in the `npm` GitHub environment.
4. Check the result: `npm view @daintreehq/decisions-cli@0.2.0` and the "Provenance" panel on each package's npm page. Then run the same compatibility check against what was published: `pnpm compat:check --old <previous version> --new 0.2.0`.
5. Open a pull request from `main` back into `develop` and merge it with a merge commit so the version bump and release fixes return to the integration branch. The release branch can then be deleted.

For an urgent patch, start `hotfix/<name>` from the latest `main`, make the fix and patch version bump there, and follow steps 2–5 after its pull request into `main` passes CI and merges. Also merge `main` into any active release branch. Regular features and bug fixes target `develop`; [CONTRIBUTING.md](../CONTRIBUTING.md#branching-git-flow) describes the branch conventions.

A version with a prerelease suffix (`pnpm release:version 0.3.0-rc.1`, tag `v0.3.0-rc.1`) is published under the `next` dist-tag, never `latest`.

If the `npm` job fails partway, fix the cause and use "Re-run failed jobs": every `name@version` already on npm is skipped, and the rest are published in order. npm never accepts the same version twice, so if a published package turns out to be broken, release the next patch version; do not move or delete a tag that has been published.

### Checking against the previous release

Installations upgrade one piece at a time: a relay updated before Daintree, Daintree before the relay, a Remote Host left behind. [`tools/compat-check/compat-check.mjs`](../tools/compat-check/compat-check.mjs) runs the released packages against the new ones, in both directions, with real relays under `wrangler dev`:

```bash
pnpm compat:check --old 0.8.0                # before publishing: a packed build of this tree
pnpm compat:check --old 0.8.0 --new 0.9.0    # after publishing: what npm serves
```

The old side is installed from npm, and its relay is the bundle attached to its GitHub release, checked against that release's `SHA256SUMS` and against the npm relay package of the same version. The new side is packed from the working tree (`--new packed`, the default) or installed from npm. Each side runs from its own scratch project outside the workspace, through its installed `decisions` CLI and its library. In scenarios 1 to 3 a simulated phone answers and declines with signed requests as the phone app does; scenario 4 runs the released phone app itself in Chromium. It checks that:

1. **an older desktop against the new relay** (the older CLI as the owner) still asks and receives answers and declines, and that while a newer Remote Host asks an advisory question, the older desktop's own reader refuses it if it predates advice (as 0.8.0 does, for its `reply_mode`), reads everything else, and its bridge keeps working with no error and no refused request;
2. **the new desktop against the older relay** still asks and receives answers and declines (`ask --wait`, `get`, `wait`, and the library). Against a relay without advice, an advisory ask is refused as `not_supported: relay-unsupported` and asks nothing; against one without agent-stopped pushes, a push request reports `unsupported`;
3. **an older host with open questions that moves to the new version, and then its relay**, still answers them, keeps the deadline of a reopen made before the upgrade, and expires, reopens and answers a question asked before both upgrades on the new relay, which reads the storage the older one wrote. There, an agent-stopped push request now reaches the relay;
4. **a phone that keeps the older app cached while its relay is updated**, until the app updates itself. The released app pairs and turns notifications on against the older relay, and the relay is replaced on the same storage while the page stays open. The cached app answers and declines ordinary questions; an advisory ask is refused as `not_supported: no-capable-reader` (no paired device can show it) by the CLI and the library, and puts nothing on the relay; and an agent-stopped push request reports `no-subscription`, leaving the phone's subscription untouched. The phone then loads the new app while the older service worker is still active: it asks that worker what it can show, gets no answer, declares nothing, and a push request still reports `no-subscription`. Once the person restarts into the update and the new worker has told the app it can show the push, the same subscription declares `agent-stopped-push-v1`, and the relay picks it for the next request and tries to send it. The questions from before the update show as they ended, and the declined one is reopened and answered in the new app. This is the upgrade from a release with neither advice nor agent-stopped pushes (0.8.0); an `--old` that has either skips it, and the run says so (a run in which every chosen scenario was skipped fails).

It needs the network and the workspace's dependencies, and takes a few minutes (scenario 3 waits for a real deadline). It uses ports from 8870 (`--port` moves them) and refuses to start a relay on a port something already answers on. `--only 1,3` runs some scenarios, `--no-build` packs the existing build, and `--keep` keeps the scratch directory with every relay, CLI and library log; a failed run always keeps it. Scenario 4 also needs the Chromium the e2e suite uses (`pnpm --filter @daintreehq/decisions-e2e exec playwright-core install chromium`, or `E2E_CHROMIUM`); headless Chromium has no push service, so the phone's push subscription is a fixture on `push.compat-check.invalid`, a name that never resolves, and a push the relay sends there fails without reaching anyone. Its log, `phone-4.jsonl`, has every subscription the phone sent and the service workers as the page saw them when it sent it, the phone's relay requests, and, when the scenario stops, what each page showed (with a screenshot beside it).

To see exactly what a release would do without uploading anything, run the same script locally (CI runs it on every pull request):

```bash
pnpm release:publish --dry-run              # build, pack, inspect tarballs, query npm, npm publish --dry-run
pnpm release:publish --dry-run --tag v0.2.0 # also check the tag against the versions
pnpm release:publish --check --tag v0.2.0   # versions, tag and metadata only
```

### One-time setup: npm trusted publishers

This needs an npm account that can publish to the `daintreehq` npm organisation, with two-factor authentication enabled.

1. **Create the packages on npm.** npm only lets you attach a trusted publisher to a package that already exists ([`npm trust`](https://docs.npmjs.com/cli/v12/commands/npm-trust): "The package you're configuring must already exist on the npm registry"). Reserve each name with a placeholder:
   ```bash
   npm login
   pnpm release:publish --bootstrap --dry-run   # lists the packages missing from npm
   pnpm release:publish --bootstrap             # publishes and deprecates 0.0.0-bootstrap.0 for each
   ```
   The placeholder contains no code and is deprecated, so installing it prints a warning. It is published under the `bootstrap` dist-tag, but npm also points `latest` at a package's first version whatever tag it was published with, so a plain `npm install @daintreehq/decisions-…` gets the placeholder until the first real release replaces `latest`. Do steps 2 and 3 without a long gap. Packages that already exist are left alone. Reserving the names this way, rather than publishing the first real release from a laptop, means every real release carries provenance.
2. **Add a trusted publisher to each package.** On npmjs.com open the package, then **Settings → Trusted Publisher → GitHub Actions**, and enter:

   | Field                | Value                                                       |
   | -------------------- | ----------------------------------------------------------- |
   | Organization or user | `daintreehq`                                                |
   | Repository           | `decisions`                                                 |
   | Workflow filename    | `release.yml`                                               |
   | Environment name     | `npm`                                                       |
   | Allowed actions      | `npm publish` must be allowed, not only `npm stage publish` |

   Or from a terminal with npm 11.15.0 or later, once per package:

   ```bash
   npm trust github @daintreehq/decisions-protocol --file release.yml --repo daintreehq/decisions --env npm --allow-publish
   ```

   npm does not validate the form when you save it; a mistake shows up as a failed publish. Every package's `repository.url` must be `https://github.com/daintreehq/decisions` (the publish script checks this).

3. **Release within two days.** A new trusted publisher that has not completed a successful publish within two days expires and has to be deleted and recreated. Cut the release (above) soon after step 2.
4. **Lock down token publishing (recommended).** In each package's **Settings → Publishing access**, choose "Require two-factor authentication and disallow tokens". Trusted publishing is not affected.
5. **Protect the environment (optional).** GitHub creates the `npm` environment on the first release run. Under **Settings → Environments → npm** you can limit it to `v*` tags and require a reviewer before anything is published.

A package added to the workspace later needs steps 1 and 2 before the first release that includes it; until then the `npm` job fails at that package (the packages before it in the order are published, and a re-run picks up the rest once it is set up). Renaming `release.yml` or the `npm` environment breaks every trusted publisher.

To confirm a release works from the registry in a clean project, with provenance checked:

```bash
cd "$(mktemp -d)" && npm init -y >/dev/null && npm pkg set type=module
npm install @daintreehq/decisions-protocol@0.2.0 @daintreehq/decisions-crypto@0.2.0 \
  @daintreehq/decisions-client@0.2.0 @daintreehq/decisions-model@0.2.0 @daintreehq/decisions-relay@0.2.0 \
  @daintreehq/decisions-cli@0.2.0
npm audit signatures        # registry signatures and provenance attestations
npx decisions --version
```

`pnpm pack:check` runs the import and type-check half of this against local tarballs on every pull request.
