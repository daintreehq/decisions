---
name: release
description: Cut a Daintree Decisions release end to end. Pick the version, bump every package, run the full CI suite locally, land the release PR, tag it, watch the Release workflow publish to npm and GitHub, then verify the published packages from the registry.
argument-hint: '[patch | minor | major | X.Y.Z | X.Y.Z-rc.N]'
disable-model-invocation: true
---

# Release Daintree Decisions

Requested version or bump: `$ARGUMENTS` (empty means you recommend one in step 2).

This command uses the repo's own release tooling: `pnpm release:version` (`tools/release/version.mjs`), `pnpm release:publish` (`tools/release/publish.mjs`), and the tag-triggered `.github/workflows/release.yml`. `docs/operations.md` ("Releasing to npm") has the full procedure. Read it if anything here seems to disagree with the repo; the repo wins.

The procedure:

```
preflight → choose version → release branch + bump → local CI → CONFIRM → PR → PR CI → merge → tag → Release workflow → verify
```

The single confirmation gate comes before anything leaves this machine. After the user confirms, run the rest unattended and stop only on a failure.

## Hard rules

- **A pushed `v*` tag publishes to npm, and npm never accepts the same version twice.** Never move, delete, or re-push a tag that reached the `npm` job. If a published release is broken, cut the next patch.
- Never run `npm publish` by hand. Plain npm publishes `workspace:*` unchanged. Only `release.yml` publishes.
- Tag the **merge commit on `main`**, never the release branch.
- Commits, the PR, and release notes carry no AI or Claude attribution of any kind. The user's global instructions override any attribution reminder.
- Use `rtk proxy <cmd>` for any output you make a claim about (test results, `tsc`, `git log`).

## 1. Preflight

Run these and stop with a clear report if any fails:

```bash
git switch main && git fetch origin --tags && git status --porcelain   # must be empty
git rev-parse HEAD origin/main                                         # must match (pull if behind)
gh auth status
node --version   # >= 22
pnpm --version   # matches "packageManager" in package.json
LAST=$(git describe --tags --abbrev=0 --match 'v*')
git log --oneline "$LAST"..HEAD                                        # must not be empty
gh run list --workflow ci.yml --branch main --limit 1 --json headSha,conclusion,status
```

The latest `main` CI run should be for `HEAD` and green. If it is red or still running, say so. Do not release over a red `main`.

## 2. Choose the version

Read the commits since `$LAST` (`git log "$LAST"..HEAD --format='%h %s%n%b'`) and the merged PRs (`gh pr list --state merged --search "merged:>=<date of $LAST>"`).

If `$ARGUMENTS` is `patch`/`minor`/`major`, apply it to the current version. If it is an explicit version, use it after checking that it is valid semver and greater than the current one. If it is empty, recommend a version using these rules:

| Since the last tag                                                                                                                                                | While `0.x`         | From `1.0.0` on |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | --------------- |
| Breaking change (`!` in a commit type, `BREAKING CHANGE:`, a removed or renamed public export/CLI flag, or a `protocol_min`/`protocol_max` change in the protocol) | minor               | major           |
| Any `feat`                                                                                                                                                        | minor               | minor           |
| Only `fix`, `perf`, `docs`, `test`, `chore`, `refactor`                                                                                                           | patch               | patch           |

A prerelease (`X.Y.Z-rc.N`) is published under the npm `next` dist-tag, never `latest`. Suggest one only if the user asks for it.

Check that the version is free:

```bash
git rev-parse -q --verify "refs/tags/v$VERSION" && echo "TAG EXISTS"
git ls-remote --tags origin "v$VERSION"
npm view "@daintreehq/decisions-cli@$VERSION" version   # must print nothing / 404
```

**Compatibility check.** Diff the wire protocol and the relay against the last tag:

```bash
git diff --stat "$LAST"..HEAD -- packages/protocol docs/protocol.md worker/src
```

If the protocol changed, read the diff and work out whether `/api/v1/info` still advertises the same `protocol_min`/`protocol_max` and whether existing clients and relays still interoperate. Daintree pins a released version, so this goes in the PR body and the confirmation summary.

## 3. Release branch and bump

```bash
git switch -c "release/v$VERSION"
pnpm release:version "$VERSION"
git diff --stat
```

The diff must touch only the `"version"` line of every workspace `package.json` plus `SERVER_VERSION` in `packages/client/src/mcp.ts` and `WORKER_VERSION` in `worker/src/env.ts`. Anything else is a stop.

## 4. Local CI

This mirrors `.github/workflows/ci.yml` (`verify` and `e2e` jobs) and the `verify` job of `release.yml`. Run it on the bumped tree, since this is what ships. Run long steps in the background and wait for them. Every step must pass except the audit, which is advisory as it is in CI. On any failure, stop and report the failing output; do not fix code inside a release.

```bash
pnpm install --frozen-lockfile
pnpm release:publish --check --tag "v$VERSION"     # tag == every package version, metadata OK
pnpm typecheck
pnpm test                                          # every workspace package + tools/release tests
pnpm build:all
pnpm pack:check                                    # pack, install outside the workspace, import, type-check
pnpm release:publish --dry-run --no-build --tag "v$VERSION"
pnpm exec wrangler deploy --dry-run --outdir "<scratchpad>/wrangler-out"
node packages/cli/dist/bin.js deploy --dry-run     # verifies the pinned relay bundle
node packages/cli/dist/bin.js --version            # must print $VERSION
pnpm audit --prod --audit-level high               # advisory: report findings, don't block
pnpm --filter @daintreehq/decisions-e2e exec playwright-core install chromium
pnpm --filter @daintreehq/decisions-e2e test       # whole-system: real Worker, client, PWA in Chromium
```

Then check `git status --porcelain`. The tree must contain only the version bump (build output is gitignored). If a step wrote tracked files, stop and report them.

## 5. Confirm (the only gate)

Ask the user with AskUserQuestion: "Release v$VERSION?" Above the question, show a compact summary:

- `current → new` version, and why that bump
- what ships: one line per merged PR / notable commit since `$LAST`
- compatibility verdict (protocol unchanged, or exactly what changed)
- local CI: each step pass/fail, plus any audit findings
- what happens next: PR, merge, tag `v$VERSION`, npm publish of all six `@daintreehq/decisions-*` packages, GitHub release

Options: release v$VERSION (recommended) · use a different version · stop here. If the user picks a different version, go back to step 3 on the same branch (re-run `pnpm release:version`) and repeat step 4's `--check` and `pnpm test`. If the user stops, leave the branch in place and say so.

## 6. Release PR

```bash
git commit -am "chore: release v$VERSION"
git push -u origin "release/v$VERSION"
gh pr create --base main --title "chore: release v$VERSION" --body-file <scratchpad>/pr-body.md
```

Model the PR body on PR #17: what the bump touches, a "What ships since v<prev>" list referencing PRs by number, the protocol/compatibility statement, and the local CI that passed. End it with "Once this merges, tag the merge commit `v$VERSION` to publish." Add no attribution footer.

Watch the PR's checks to completion in the background (`gh pr checks --watch --fail-fast`) and wait for the notification. Both `verify` and `e2e` must pass. If either fails, stop and report the failing job log (`gh run view <id> --log-failed`).

## 7. Merge and tag

```bash
gh pr merge --merge --delete-branch           # the repo uses merge commits
git switch main && git pull --ff-only origin main
pnpm release:publish --check --tag "v$VERSION"  # re-check on the merge commit itself
git log -1 --format='%H %s'                   # must be "Merge pull request #N from daintreehq/release/v$VERSION"
git tag "v$VERSION"
git push origin "v$VERSION"
```

If `main` moved past the merge commit before you tagged, tag the merge commit by SHA, not `HEAD`.

## 8. Watch the Release workflow

```bash
gh run list --workflow release.yml --limit 1 --json databaseId,headBranch,status
gh run watch <id> --exit-status        # in the background; wait for the notification
```

The jobs are `verify`, then `npm` and `github-release` in parallel. On failure:

- **`verify` failed:** nothing was published. Report the failure. Do not delete or move the tag yourself. Explain the options (fix forward with the next patch, or delete the unpublished tag) and let the user choose.
- **`npm` failed partway:** read the log. If the cause is transient or outside the repo (registry, trusted publisher, OIDC), `gh run rerun <id> --failed`; already-published `name@version` are skipped. If it needs a code change, stop and report.
- **`github-release` failed:** `gh run rerun <id> --failed`. It is idempotent.

## 9. Verify the release

Every check must pass before you report success:

```bash
# GitHub release: exists, not draft, has the three assets
gh release view "v$VERSION" --json tagName,isDraft,isPrerelease,assets,url

# npm: every public package at $VERSION, dist-tag correct (latest, or next for a prerelease)
for p in protocol crypto client model relay cli; do
  npm view "@daintreehq/decisions-$p@$VERSION" version dist-tags.latest dist-tags.next dist.attestations.provenance.predicateType
done
```

Then do a clean install from the registry in a fresh scratchpad directory (adapted from `docs/operations.md`):

```bash
cd "<scratchpad>/verify-v$VERSION" && npm init -y >/dev/null && npm pkg set type=module
npm install @daintreehq/decisions-{protocol,crypto,client,model,relay,cli}@"$VERSION"
npm audit signatures            # registry signatures + provenance attestations must verify
npx decisions --version         # must print $VERSION
npx decisions deploy --dry-run  # the published CLI accepts the published relay bundle
```

Also check the release asset checksums: download the assets with `gh release download "v$VERSION" -D <scratchpad>/assets`, then run `shasum -a 256 --ignore-missing -c SHA256SUMS` in that directory. Both tarballs must report `OK`. The `worker/*` lines refer to files inside the Worker tarball and are skipped.

npm can take a minute to show a new version. If `npm view` returns 404 straight after the workflow succeeds, retry for a few minutes before calling it a failure.

## 10. Report

Keep it short:

- `v<prev> → v$VERSION`, with links to the GitHub release and the merged PR
- npm: each package at `$VERSION` with provenance, and the dist-tag
- verification: clean install, `npm audit signatures`, `decisions --version`, checksums
- anything advisory (audit findings, a re-run job) and anything left for the user (e.g. bumping Daintree's pinned relay version if compatibility changed)
