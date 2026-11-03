# Self-hosting

You deploy the relay to your own Cloudflare account. The free plan is enough for one person's usage; see [operations.md](operations.md).

## Option 1: Deploy to Cloudflare button

1. Click **Deploy to Cloudflare** in the [README](../README.md). Sign in to Cloudflare if asked.
2. Cloudflare reads `wrangler.jsonc`, creates the R2 bucket `daintree-decisions` and the `DecisionRoom` Durable Object, builds with `pnpm build` (which builds the PWA), and runs `wrangler deploy`.
3. When it asks for `CLAIM_SECRET`, enter a long random string. Save it; you need it once.
4. Open the resulting `https://<name>.<subdomain>.workers.dev`. It shows that the relay is ready to be claimed.

R2 must be enabled on your account (it needs a payment method on file; the free allowance applies).

## Option 2: Guided deploy from the CLI

```bash
npx @daintreehq/decisions-cli deploy --dry-run   # print the plan; changes nothing
npx @daintreehq/decisions-cli deploy
```

No clone is needed. The command:

1. Checks Node 22+ and runs the exact Wrangler version the relay was built with (`npx wrangler@<version>`).
2. Logs in with Wrangler's browser flow. With `--api-token` it asks for a Cloudflare API token instead (or uses `CLOUDFLARE_API_TOKEN` if it is already set); the token stays in memory and reaches Wrangler only through its environment. `--account-id` picks an account when you have several.
3. At a terminal, asks the setup questions before it changes anything in your account: the account (when your login has several), the Worker and bucket names (the flags are the defaults), whether to use dictation transcription (xAI or OpenAI) and transcript cleanup (Anthropic or OpenAI, and which model), and each provider's API key, read with hidden input and checked with the provider straight away. It then shows a summary, with keys only as present or absent, and deploys only once you confirm it. Without a terminal it asks nothing and deploys without dictation, as before.
4. Creates the private R2 bucket (`--bucket`, default `daintree-decisions`; an existing one is reused).
5. Deploys the Worker (`--name`, default `daintree-decisions`), its Durable Object and the phone app from `@daintreehq/decisions-relay`, the prebuilt relay published with the same version as the CLI. Before anything runs, it checks the relay's manifest against the SHA-256 the CLI was built with and every file against the manifest, and refuses to deploy on any mismatch.
6. Generates `CLAIM_SECRET` in memory and gives it to `wrangler secret put` on standard input. It is never written to disk, to a command line or to the environment. If the relay is already claimed (you are updating it), this step is skipped.
7. Sets the provider keys you entered (`XAI_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`) the same way, on standard input only. The chosen cleanup model is deployed as `ANTHROPIC_CORRECTION_MODEL` or `OPENAI_CORRECTION_MODEL`. Keys already set on the Worker are left as they are.
8. Runs `decisions doctor` against the new Worker.
9. Prints the Worker URL and the claim secret once, with the next step. Copy the secret then: it is not saved anywhere. If you lose it before claiming, run the deploy again to set a new one.

Add `--claim` to claim the relay from this computer straight away (as `decisions setup` does, creating this computer's keys); the secret is then used up and not shown. `--outdir <dir>` only verifies the relay and writes the deployable files and Wrangler config to `<dir>`, for inspection or to deploy them yourself.

In a clone of this repository, `pnpm decisions:deploy` builds everything and runs the same command from the workspace.

## Option 3: Manual

```bash
pnpm install --frozen-lockfile
pnpm build
npx wrangler login
npx wrangler r2 bucket create daintree-decisions
npx wrangler deploy
openssl rand -hex 32 | npx wrangler secret put CLAIM_SECRET   # note the value first, e.g. by saving the command output
pnpm decisions:doctor --url https://<your-worker>.workers.dev
```

## Removing a relay

```bash
npx @daintreehq/decisions-cli remove https://<your-worker>.workers.dev --dry-run   # list what it would remove
npx @daintreehq/decisions-cli remove https://<your-worker>.workers.dev             # or the Worker name
```

`decisions remove` takes a relay out of your Cloudflare account. It needs no relay keys and no claim secret, so it also works on a relay that was never claimed or whose owner keys are lost. It logs in as `deploy` does (`--api-token` and `--account-id` work the same way), finds the account from the URL (a workers.dev URL or a custom domain attached to the Worker) or the Worker name, and lists the Worker, the Durable Object storage it implements and its R2 attachments bucket. Nothing is deleted until you type the Worker name and then answer yes. A Worker that does not look like a Decisions relay also needs `remove anyway` typed first.

It removes the Worker first (which deletes its Durable Object storage with it), then empties and removes the bucket, and reports each. If a step fails it names what is left; run the same command again to finish. The bucket's name is saved in `~/.decisions/removals/` until the removal completes, so the rerun finds it even though the Worker is gone; without that record, pass `--bucket <name>`. Keys and history on this computer are not touched. Afterwards `decisions deploy` sets up a new relay from nothing; to claim it from a computer that still holds the old relay's keys, use a separate state directory: `decisions --home <dir> deploy --claim`.

## Claim and pair

```bash
pnpm decisions setup --url https://<your-worker>.workers.dev   # asks for the claim secret (hidden); or --claim-secret-file, --claim-secret-stdin, DECISIONS_CLAIM_SECRET
pnpm decisions pair
```

The claim can happen exactly once; afterwards the endpoint is permanently closed. `pair` prints a QR code and a link. On the phone, scan or open it, then confirm that the **same six digits** appear on both screens before approving on the computer.

## Optional dictation

The guided deploy sets this up for you. Otherwise, add provider keys as Worker secrets (Cloudflare dashboard → Workers → your Worker → Settings → Variables and Secrets, or `wrangler secret put NAME`): `XAI_API_KEY` (streaming transcription), `ANTHROPIC_API_KEY` (correction), `OPENAI_API_KEY` (single-provider mode, preview). Read [voice-privacy.md](voice-privacy.md) first. Model names are configuration: `ANTHROPIC_CORRECTION_MODEL` (`claude-haiku-5-5`, or `claude-sonnet-5-5`) and `OPENAI_CORRECTION_MODEL` (`gpt-6.1-terra`) in `wrangler.jsonc`, the same defaults Daintree desktop dictation uses.

## Custom domain

Changing the origin later invalidates installed apps, push subscriptions and phone keys, because browsers scope them to the origin. Choose the domain before pairing phones; moving means re-pairing.

## Cloudflare Access

Optional. If you put Access in front of the Worker, allow the paths the installed app and service worker need (`/api/*` with its own signatures, `/sw.js`, `/manifest.webmanifest`, `/assets/*`) or push and sync will fail. Test with the installed app.

## Updating

```bash
npx @daintreehq/decisions-cli@latest update --url https://<your-worker>.workers.dev
```

`update` reads the relay's version and protocol range from the URL, finds the Worker and account behind it in Cloudflare (it asks you to pick when the URL is a domain it cannot match; `--name` and `--account-id` answer that up front), and picks the newest published release whose protocol range overlaps the one the caller supports. Daintree passes its own range with `--protocol 1-2`; the default is the CLI's. It shows the current and target versions with their release notes and what it keeps, and changes nothing until you confirm (`--yes` skips the question, `--dry-run` stops before it, `--to <version>` picks an exact release). Already current, or nothing compatible, changes nothing.

The release is downloaded from npm, checked against the registry's integrity digest and its own manifest, and deployed as is with the exact Wrangler version it was built with. The Worker keeps its claim, paired devices, questions and answers (Durable Object storage), its bucket, its secrets, every variable with its current value (a release's defaults only fill in variables the Worker does not have yet), workers.dev and preview URL exposure, and observability, placement, limits, tail and Logpush settings. A Worker with bindings the release does not declare, or a different Durable Object class, is refused before anything changes. Afterwards it waits for the relay, and then its Durable Object, to report the new version (up to a few minutes) and runs `decisions doctor`; a failed update says which version the relay reports.

Nothing updates itself and nothing is deployed on your behalf. The Worker and desktop check each other's protocol range; the app shows a banner when a new version is ready and never discards unsent answers.
