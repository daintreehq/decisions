---
name: release
description: Prepare and publish a Daintree Decisions release using Git flow, verify the published artifacts, and merge the release back into develop. Supports regular releases from develop and prepared urgent hotfixes from main. Use when the user asks to cut a release.
argument-hint: '[patch | minor | major | X.Y.Z | X.Y.Z-rc.N | hotfix [patch | X.Y.Z]]'
disable-model-invocation: true
---

# Release Daintree Decisions

Requested mode and version: `$ARGUMENTS`. With no arguments, prepare a regular release and recommend the version.

Read `CONTRIBUTING.md` ("Branching (Git flow)"), `docs/operations.md` ("Releasing to npm"), both `.github/workflows/{ci,release}.yml`, and `tools/release/{version,workspace,publish}.mjs` before starting. These are the source of truth for branch conventions, checks, version constants and publishable packages. If they disagree with this skill, follow the current repository and report the discrepancy.

```
select source → choose version → branch + bump → local CI → CONFIRM → PR → PR CI → merge to main → tag exact merge → publish → verify → merge main back → cleanup
```

Prepare and validate locally before the single release confirmation. After confirmation, finish the approved release, including the merge back into `develop`, without asking again for routine steps. Stop on a failure or a change to the approved contents. If the user already explicitly approved the exact version, contents and publishing consequences, honor that authorization. Invoking this skill only to review or edit it does not authorize a release.

## Hard rules

- **Pushing a `v*` tag publishes to npm, and npm never accepts the same version twice.** Never move, delete, or re-push a published tag. If a published release is broken, fix forward with a new version.
- Never run `npm publish` by hand or `release:publish` without `--check` or `--dry-run` locally. Only `release.yml` publishes real releases.
- Regular releases start from `develop` as `release/<version>`. Hotfixes start from `main` as `hotfix/<name>`. Both target `main` with a merge commit; tag that exact merge SHA. Never squash or rebase these merges.
- After publishing, merge `main` into `develop` with a merge commit. For hotfixes, also merge `main` into any active release branch. Never delete `main` or `develop` during PR cleanup.
- Freeze the chosen source SHA. New work on `develop` after the release branch is cut belongs to the next release. Do not pull it into this release automatically.
- Do not stash, reset, force-push, overwrite an existing branch/tag, or fix unrelated code to get a release through. Report failures with the branch, SHA and remaining work so the run can resume safely.
- Commits, PRs and release notes carry no AI or Claude attribution. Follow the user's global attribution instructions.
- Prefix shell commands with `rtk`. Use `rtk proxy <cmd>` for output used as evidence, including Git history, test results and machine-readable JSON. The examples below use it throughout.

## 1. Preflight and source selection

Check the working tree **before switching branches**. It must be clean, including untracked files. Record the original branch and worktree; use an isolated worktree if the needed branch is checked out elsewhere. Create an actual temporary scratch directory, recorded as `SCRATCH`, for PR bodies, deployment output and registry verification; keep it outside the repository.

```bash
rtk proxy git status --porcelain
rtk proxy git branch --show-current
rtk proxy git worktree list
rtk proxy git fetch origin --prune --tags
rtk proxy gh auth status
rtk proxy node --version
rtk proxy pnpm --version
```

Node must satisfy the root `engines` and CI requirements; pnpm must match `packageManager`. Confirm `origin` is the intended repository. Fetch `main` and `develop`, and record `MAIN_SHA` and `DEVELOP_SHA` from their remote-tracking refs. Bring a local source branch up to date only by fast-forward; stop on local-only commits or divergence rather than publishing them accidentally.

Choose the mode explicitly:

| Mode              | Source and preparation                                                                                                                                                                  | Release branch                                                        |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Regular (default) | Latest `origin/develop`; record it as `SOURCE_SHA`. Require `origin/main` to be an ancestor, so released hotfixes and version bumps are already integrated.                             | Create `release/$VERSION` at `SOURCE_SHA` after choosing the version. |
| `hotfix`          | A clean, prepared `hotfix/<name>` branch descended from latest `origin/main`; record its tip as `SOURCE_SHA`. Review its commits against `MAIN_SHA` and require an actual intended fix. | Keep that hotfix branch; do not create it from or merge in `develop`. |

For hotfix mode, use `patch` by default and only an explicitly requested stable patch version otherwise. This skill releases an already prepared fix; if the fix or branch is missing, stop with the preparation needed. Do not invent a fix or cherry-pick unselected work. Record active release branches using open release PRs targeting `main` and unmerged remote `release/*` branches (including older `release/v*` names); include the affected targets in the confirmation.

For a regular release, require successful `ci.yml` **push** runs for both `DEVELOP_SHA` on `develop` and `MAIN_SHA` on `main`. For a hotfix, require the `main` push run; the prepared hotfix is validated locally and by its release PR. Select runs by branch, event and exact SHA, not merely the newest run:

```bash
rtk proxy gh run list --workflow ci.yml --branch main --event push --commit "$MAIN_SHA" --json databaseId,headSha,status,conclusion,url
```

Use the equivalent command for `develop` when required. Wait for pending runs; stop if a required run is missing or unsuccessful. A green run for another commit does not count.

Keep a short release record under `$SCRATCH` with the original checkout, mode, source/base SHAs, branch, version, included PRs, validation results, and later PR numbers, merge SHA and workflow run ID. Report its path when stopping so another session can resume.

For a resumed release, recover the existing branch, PR, tag and recorded SHAs first. Reuse completed steps only when their commits and artifacts match; do not bump again, duplicate PRs, or push a tag again. An existing tag is resumable only when its remote SHA is exactly the intended merge SHA. A previously prepared bump left by this skill is the exception to the clean-tree requirement: inspect it against the recorded source and revalidate before continuing; never discard unrelated changes. Skip fresh-release source/version selection after a release has already merged or published; continue from the recorded stage.

## 2. Choose the version and contents

Find the preceding release on **`main`'s first-parent history**, not an arbitrary tag reachable through a feature branch:

```bash
LAST=$(rtk proxy git describe --first-parent --tags --abbrev=0 --match 'v*' "$MAIN_SHA")
rtk proxy git log "$LAST..$SOURCE_SHA" --format='%h %s%n%b'
rtk proxy git diff --stat "$LAST" "$SOURCE_SHA"
```

Require release content beyond the previous tag. Read the source and `main` package versions and inspect intervening stable/prerelease tags. Apply a requested bump to the current intended release version; validate explicit versions as SemVer and require them to advance the relevant released and source versions. Allow promotion of `X.Y.Z-rc.N` to `X.Y.Z`. Compare numeric prerelease identifiers numerically (`rc.10` follows `rc.9`). Before a stable release, check the current public packages' npm `latest` versions so an older maintenance patch cannot move `latest` backwards. Do not use a stale `develop` version after a hotfix.

With no requested regular-release version, recommend:

| Changes since the previous release                                                                 | While `0.x` | From `1.0.0` |
| -------------------------------------------------------------------------------------------------- | ----------- | ------------ |
| Breaking public API/CLI change, `BREAKING CHANGE:`, commit type with `!`, or protocol range change | minor       | major        |
| Any `feat`                                                                                         | minor       | minor        |
| Only fixes, performance, docs, tests, chores or refactoring                                        | patch       | patch        |

Publish a requested prerelease under npm `next`; stable releases use `latest`. Do not suggest a prerelease unless asked. Record the previous stable tag as well when `$LAST` is a prerelease, so final-release notes can cover the full stable-to-stable change.

Use merged PRs to explain the commits in `$LAST..$SOURCE_SHA`. Filter by merge-commit reachability in that range and deduplicate; a merge-date search alone is insufficient. This excludes later `develop` work, unrelated hotfixes and previously released PRs. Include notable direct commits. The release PR now contains the accumulated feature work as well as its version bump, so describe both.

Check the proposed version is unused locally, remotely and on **every public workspace package**. Discover that set from `listWorkspace()` / `publishOrder()` in `tools/release/workspace.mjs`, rather than assuming a fixed list. Currently it is protocol, crypto, client, model, relay and cli.

```bash
rtk proxy git show-ref --verify "refs/tags/v$VERSION"
rtk proxy git ls-remote --tags origin "refs/tags/v$VERSION" "refs/tags/v$VERSION^{}"
rtk proxy npm view "@daintreehq/decisions-cli@$VERSION" version --json
```

The local tag check should report no ref, the remote query should be empty, and each npm query should report a missing version (E404 or empty successful output). Distinguish an expected missing ref/version from network, auth or registry failures; those failures are blockers. Repeat the npm query for every discovered public package.

Diff `packages/protocol`, `docs/protocol.md` and `worker/src` against `$LAST`. If they changed, read the relevant diff and assess whether `/api/v1/info` still advertises compatible `protocol_min`/`protocol_max` and existing clients and relays interoperate. Daintree pins a released relay version; include the compatibility verdict in the PR and confirmation.

## 3. Branch and version bump

For a regular release:

```bash
BRANCH="release/$VERSION"
rtk proxy git switch -c "$BRANCH" "$SOURCE_SHA"
```

For a hotfix, set `BRANCH` to the selected existing hotfix branch and stay on it. Then:

```bash
rtk proxy pnpm release:version "$VERSION"
rtk proxy git diff --stat
rtk proxy git diff
```

The **new uncommitted bump** may change only the top-level `version` line in workspace manifests and the constants listed in `VERSION_CONSTANTS` in `tools/release/workspace.mjs`. Currently those are `SERVER_VERSION` in `packages/client/src/mcp.ts` and `WORKER_VERSION` in `worker/src/env.ts`. Stop on unexpected edits. This restriction applies to the bump, not the full release PR's feature/fix diff against `main`.

## 4. Local CI on the release tree

Mirror the current `ci.yml` jobs and `release.yml` verification, using their current commands if they change. Run long steps with the environment's background execution tools and wait for completion. Every check must pass except the advisory dependency audit. On a failure, report it; do not mix code repairs into a publishing run. Release fixes belong on the release/hotfix branch in a separate preparation step, followed by fresh validation.

```bash
rtk proxy pnpm install --frozen-lockfile
rtk proxy pnpm release:publish --check --tag "v$VERSION"
rtk proxy pnpm typecheck
rtk proxy pnpm test
rtk proxy pnpm build:all
rtk proxy pnpm pack:check
rtk proxy pnpm release:publish --dry-run --no-build --tag "v$VERSION"
rtk proxy pnpm exec wrangler deploy --dry-run --outdir "$SCRATCH/wrangler-out"
rtk proxy node packages/cli/dist/bin.js deploy --dry-run
rtk proxy node packages/cli/dist/bin.js --version
rtk proxy pnpm audit --prod --audit-level high
rtk proxy pnpm --filter @daintreehq/decisions-e2e exec playwright-core install chromium
rtk proxy pnpm --filter @daintreehq/decisions-e2e test
rtk proxy git status --porcelain
```

The CLI must print `$VERSION`. On Linux, use Playwright's `--with-deps` installation as CI does when system dependencies are required. The final working tree must contain only the reviewed version bump; build output is ignored. Do not proceed if checks generated tracked edits or unexpected untracked files.

## 5. Confirm the concrete release

Use the environment's user-question tool (AskUserQuestion in Claude Code), or ask directly if unavailable. Show:

- Mode, `$LAST → v$VERSION`, reason for the bump, npm dist-tag, source branch and `SOURCE_SHA`.
- What ships: one line per included PR or notable commit, plus the compatibility verdict.
- Local check results and advisory audit findings.
- Next actions: push the branch, PR into `main`, merge commit, tag and publish every discovered public package, GitHub release, registry verification, and `main → develop` merge (plus named active release branches for a hotfix).

Ask "Release v$VERSION?" with options to release, choose a different version, or stop. Do not add another routine permission gate after approval. A different version requires a fresh availability check, branch rename for a regular release, new bump, **full** local validation and an updated confirmation; the CLI embeds a version-dependent relay bundle hash. If the user stops, leave the local branch and explain its state.

## 6. Release PR and checks

Stage only the reviewed bump files, then:

```bash
rtk proxy git commit -m "chore: release v$VERSION"
RELEASE_HEAD=$(rtk proxy git rev-parse HEAD)
rtk proxy git push -u origin "$BRANCH"
rtk proxy gh pr create --base main --head "$BRANCH" --title "chore: release v$VERSION" --body-file "$SCRATCH/release-pr.md"
```

Write the actual body file first. Include mode/source SHA, version bump, what ships since `$LAST` with PR links, compatibility, local results and advisory findings, and the planned merge back. State that tagging the merged commit publishes. Record `PR_NUMBER` and URL. Reuse a matching existing PR on resume.

```bash
rtk proxy gh pr checks "$PR_NUMBER" --watch --fail-fast
rtk proxy gh pr view "$PR_NUMBER" --json state,baseRefName,headRefName,headRefOid,statusCheckRollup,url
```

Require both current CI jobs (`verify` and whole-system `e2e`) to pass, plus repository-required checks/reviews, for `RELEASE_HEAD`. Missing, skipped, cancelled or stale checks do not count. If checks have not registered yet, wait and retry discovery. On failure, obtain the job log with `gh run view <id> --log-failed` and stop. Never bypass branch protections with `--admin`.

## 7. Merge and tag the validated commit

Fetch before merging. Require latest `origin/main` to be an ancestor of `RELEASE_HEAD`; if `main` gained changes not in the validated candidate, stop before merging. Integrating those changes needs another preparation/validation pass and an updated confirmation if contents change. Movement of `develop` alone does not change this release.

```bash
rtk proxy gh pr merge "$PR_NUMBER" --merge --match-head-commit "$RELEASE_HEAD"
rtk proxy gh pr view "$PR_NUMBER" --json state,mergeCommit,baseRefName,headRefOid,url
```

Wait until the PR is actually `MERGED` (a merge queue may delay it). Read `MERGE_SHA` from `mergeCommit.oid`; do not infer it from `HEAD` or a commit-message pattern. Fetch `origin/main`, verify `MERGE_SHA` is on it and has the intended release head as a parent, and compare complete trees:

```bash
rtk proxy git fetch origin --tags
rtk proxy git merge-base --is-ancestor "$MERGE_SHA" origin/main
rtk proxy git show -s --format='%H %P' "$MERGE_SHA"
rtk proxy git diff --exit-code "$RELEASE_HEAD" "$MERGE_SHA" --
rtk proxy git switch --detach "$MERGE_SHA"
rtk proxy pnpm release:publish --check --tag "v$VERSION"
```

A nonempty tree diff means the merged artifact differs from what was validated: stop before tagging. Recheck that the tag/version is still unused. Then:

```bash
rtk proxy git tag "v$VERSION" "$MERGE_SHA"
rtk proxy git push origin "refs/tags/v$VERSION"
```

Verify the remote tag resolves to `MERGE_SHA` (peel an annotated tag when resuming). If push status is uncertain, inspect the remote before retrying. Do not delete the release/hotfix branch yet. `main` may advance after the merge; always keep the tag pinned to `MERGE_SHA`.

## 8. Watch this release's workflow

```bash
rtk proxy gh run list --workflow release.yml --event push --commit "$MERGE_SHA" --json databaseId,headSha,headBranch,event,status,conclusion,url
```

Select the run for **both** `v$VERSION` and `MERGE_SHA`; never take an unrelated latest run or another tag at the same SHA. Retry discovery for up to five minutes if Actions has not registered it. Record `RUN_ID`, then watch it to completion with `gh run watch "$RUN_ID" --exit-status` in the background. The jobs are `verify`, then `npm` and `github-release` in parallel.

- **`verify` failed:** nothing published in this run. Report the logs and stop; do not move/delete the tag. Offer fix-forward or user-directed recovery of a confirmed unpublished tag.
- **Publish job failed:** inspect the logs and registry. For a transient registry/network failure or an external OIDC/trusted-publisher issue that has been corrected, rerun failed jobs **once** with `gh run rerun "$RUN_ID" --failed` and watch that attempt. Published versions are skipped. Do not repeatedly retry an unchanged configuration failure.
- **`github-release` failed:** one retry of failed jobs is allowed when the cause is transient or corrected; creating/updating the release is idempotent.
- If a code change is needed, a retry fails, or the cause is unclear, stop with package-by-package publish state and the run URL. Never report a partial publication as success.

## 9. Verify the published release

Every check must pass. Allow bounded retries (up to five minutes) for registry propagation after a successful workflow; distinguish E404 propagation from auth/network errors.

```bash
rtk proxy gh release view "v$VERSION" --json tagName,isDraft,isPrerelease,assets,url
rtk proxy npm view "@daintreehq/decisions-cli@$VERSION" version dist-tags.latest dist-tags.next dist.attestations.provenance.predicateType --json
```

Require a non-draft GitHub release with the expected app tarball, Worker tarball and `SHA256SUMS`. Its prerelease flag must match SemVer. If a requested prerelease was not marked automatically by the current workflow, mark it with `gh release edit "v$VERSION" --prerelease --latest=false`, then verify again.

Repeat the npm query for **every discovered public package**: version must equal `$VERSION`, provenance must exist, and the intended dist-tag must point to it. A prerelease must not become npm `latest`.

Create a fresh registry verification directory under `$SCRATCH`, change into it, and initialize an ESM package. Install all discovered public packages pinned to `$VERSION`. For the current package set:

```bash
rtk proxy npm init -y
rtk proxy npm pkg set type=module
rtk proxy npm install "@daintreehq/decisions-protocol@$VERSION" "@daintreehq/decisions-crypto@$VERSION" "@daintreehq/decisions-client@$VERSION" "@daintreehq/decisions-model@$VERSION" "@daintreehq/decisions-relay@$VERSION" "@daintreehq/decisions-cli@$VERSION"
rtk proxy npm audit signatures
rtk proxy node node_modules/@daintreehq/decisions-cli/dist/bin.js --version
rtk proxy node node_modules/@daintreehq/decisions-cli/dist/bin.js deploy --dry-run
```

Use the installed CLI directly so verification cannot download a fallback. Its version must match; registry signatures/provenance and the pinned relay dry run must pass.

Download the three named assets into a fresh directory with `gh release download`. Check both tarballs against `SHA256SUMS` using `sha256sum --ignore-missing -c SHA256SUMS` on Linux or `shasum -a 256 --ignore-missing -c SHA256SUMS` on macOS. Both tarballs must explicitly report `OK`; missing tarballs must fail verification. The `worker/*` entries refer to files inside the Worker tarball and may be skipped. Return to the repository afterward.

## 10. Merge main back and clean up

After publication is verified, fetch and create (or reuse) the PR **from `main` into `develop`** specified in `docs/operations.md`:

```bash
rtk proxy git fetch origin --prune
rtk proxy gh pr create --base develop --head main --title "chore: merge main into develop after v$VERSION" --body-file "$SCRATCH/back-merge-pr.md"
```

Write the body file before creating the PR. Skip this PR only if `MERGE_SHA` is already an ancestor of `origin/develop` and no release changes remain to return. Otherwise record the PR's current `main` head SHA, describe the returned version/fixes, watch all required checks (including `verify` and `e2e`) and merge with `--merge --match-head-commit <checked-main-sha>`. **Never pass `--delete-branch` for a PR headed by `main`.** If `main` moves, check and validate the updated PR head before merging.

For hotfixes, do the same `main → release/<version>` merge for each still-active release branch identified in preflight, and check for newly active release branches before finishing. Do not silently replace an active release's higher version with the hotfix version. If there are conflicts, stop and report the affected PR and required resolution; retain branches. Conflict resolution and subsequent version changes need validation before those PRs merge.

Fetch again and verify `MERGE_SHA` is an ancestor of `origin/develop` and every applicable active release branch. Publication may be successful while this integration step is incomplete: report that distinction and the outstanding PRs, rather than claiming the workflow is finished.

Only after the required merges succeed, delete the now-merged release/hotfix branch if it still points to the expected `RELEASE_HEAD`; retain any branch with new work. Restore the original branch, or `develop` if the original branch was the completed branch just deleted. In a dedicated release worktree, finish on `develop` or detached if `develop` is checked out elsewhere. Fast-forward a restored branch if appropriate and check that the working tree is clean. Do not remove a pre-existing user worktree.

## 11. Report

Keep the final report short:

- Previous → released version; links to the GitHub release, release PR and merge-back PRs.
- Tagged `MERGE_SHA`, npm package versions, provenance and dist-tag.
- Registry install, signatures, CLI/relay dry run and asset checksum results.
- Confirmation that the release returned to `develop` and any applicable active release branches; branch cleanup/restored checkout status.
- Advisory audit findings, any workflow retry, and follow-up such as updating Daintree's pinned relay version.

On an incomplete run, report the last completed step, publication state, retained branch/tag/PRs and exact remaining action. Do not call the release complete while required verification or merge-back work remains.
