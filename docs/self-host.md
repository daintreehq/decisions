# Self-hosting

You deploy the relay to your own Cloudflare account. The free plan is enough for one person's usage; see [operations.md](operations.md).

## Option 1: Deploy to Cloudflare button

1. Click **Deploy to Cloudflare** in the [README](../README.md). Sign in to Cloudflare if asked.
2. Cloudflare reads `wrangler.jsonc`, creates the R2 bucket `daintree-decisions` and the `DecisionRoom` Durable Object, builds with `pnpm build` (which builds the PWA), and runs `wrangler deploy`.
3. When it asks for `CLAIM_SECRET`, enter a long random string. Save it; you need it once.
4. Open the resulting `https://<name>.<subdomain>.workers.dev`. It shows that the relay is ready to be claimed.

R2 must be enabled on your account (it needs a payment method on file; the free allowance applies).

## Option 2: Guided script

```bash
pnpm install
pnpm decisions:deploy            # add --dry-run to see the plan first
```

The script logs in with Wrangler's browser flow (no API token needed), creates the bucket, builds, deploys, generates and installs `CLAIM_SECRET`, runs the health check, and saves the secret to `~/.decisions/deploy.json` (mode 0600; delete it after setup).

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

## Claim and pair

```bash
pnpm decisions setup --url https://<your-worker>.workers.dev --claim-secret <secret>
pnpm decisions pair
```

The claim can happen exactly once; afterwards the endpoint is permanently closed. `pair` prints a QR code and a link. On the phone, scan or open it, then confirm that the **same six digits** appear on both screens before approving on the computer.

## Optional dictation

Add provider keys as Worker secrets (Cloudflare dashboard → Workers → your Worker → Settings → Variables and Secrets, or `wrangler secret put NAME`): `XAI_API_KEY` (streaming transcription), `ANTHROPIC_API_KEY` (correction), `OPENAI_API_KEY` (single-provider mode, preview). Read [voice-privacy.md](voice-privacy.md) first. Model names are configuration: `CORRECTION_MODEL` and `OPENAI_CORRECTION_MODEL` in `wrangler.jsonc`.

## Custom domain

Changing the origin later invalidates installed apps, push subscriptions and phone keys, because browsers scope them to the origin. Choose the domain before pairing phones; moving means re-pairing.

## Cloudflare Access

Optional. If you put Access in front of the Worker, allow the paths the installed app and service worker need (`/api/*` with its own signatures, `/sw.js`, `/manifest.webmanifest`, `/assets/*`) or push and sync will fail. Test with the installed app.

## Updating

Pull a new release and run the same deploy again. Nothing updates itself and nothing is deployed on your behalf. The Worker and desktop check each other's protocol range; the app shows a banner when a new version is ready and never discards unsent answers.
