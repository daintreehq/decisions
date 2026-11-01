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

## Adding a Daintree Host

Each remote Daintree Host is its own `desktop-host` device with its own keys (Daintree does this for you over its link). By hand, with the CLI:

1. On the Host (with its own `--home`): `decisions host request --label "Build box"` prints a request and a code. The private keys stay on the Host.
2. On the owner machine: `decisions host enroll <request>` (or `--request-file <file>`) shows the same code; confirm it, and it prints a response. A request piped on standard input cannot be confirmed interactively, so it needs `--yes` once you have compared the code.
3. On the Host: `decisions host accept <response>`. It prints the owner key fingerprint; compare it with the owner's output.

Remove a Host like any other device: `decisions revoke <deviceId>`, which also rotates the content key.

## Releasing to npm

Every workspace package without `"private": true` is published to npm under `@daintreehq` (today `decisions-protocol`, `decisions-crypto`, `decisions-client`, `decisions-model` and `decisions-cli`). They share one version and are published dependencies first, with npm provenance, by [`.github/workflows/release.yml`](../.github/workflows/release.yml) when a `v*` tag is pushed. The same run attaches the PWA (`decisions-app-<tag>.tar.gz`), the bundled Worker (`decisions-worker-<tag>.tar.gz`) and `SHA256SUMS` to a GitHub release.

Publishing uses npm trusted publishing (OIDC), so there is no npm token in the repository's secrets. [`tools/release/publish.mjs`](../tools/release/publish.mjs) finds the packages from the workspace, so a new public package is picked up without editing a list (it still needs a trusted publisher first; see the end of this section). It packs each one with `pnpm pack`, which turns `workspace:*` into the real version, and uploads the tarball with `npm publish <tarball> --provenance`, because npm 11.5.1 or later is what performs the OIDC exchange. Never run `npm publish` in a package directory: plain npm publishes `workspace:*` unchanged.

### Cutting a release

1. On a branch, set the new version everywhere: `pnpm release:version 0.2.0`. This rewrites the `version` of every workspace package and the version constants the CLI, the MCP server and the Worker report. Commit it (`chore: release v0.2.0`), open a pull request and merge it.
2. Tag the merged commit on `main` and push the tag:
   ```bash
   git switch main && git pull
   git tag v0.2.0 && git push origin v0.2.0
   ```
3. The workflow runs `verify` (the tag must equal `v` + every package's version, then typecheck and tests), then `npm` and `github-release` in parallel. The `npm` job runs in the `npm` GitHub environment.
4. Check the result: `npm view @daintreehq/decisions-cli@0.2.0` and the "Provenance" panel on each package's npm page.

A version with a prerelease suffix (`pnpm release:version 0.3.0-rc.1`, tag `v0.3.0-rc.1`) is published under the `next` dist-tag, never `latest`.

If the `npm` job fails partway, fix the cause and use "Re-run failed jobs": every `name@version` already on npm is skipped, and the rest are published in order. npm never accepts the same version twice, so if a published package turns out to be broken, release the next patch version; do not move or delete a tag that has been published.

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
  @daintreehq/decisions-client@0.2.0 @daintreehq/decisions-model@0.2.0 @daintreehq/decisions-cli@0.2.0
npm audit signatures        # registry signatures and provenance attestations
npx decisions --version
```

`pnpm pack:check` runs the import and type-check half of this against local tarballs on every pull request.
