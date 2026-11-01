# @daintreehq/decisions-relay

The prebuilt relay for [Daintree Decisions](https://github.com/daintreehq/decisions): the Cloudflare Worker
bundle, the phone app's static assets and the Wrangler configuration that binds them to the Durable Object and
the R2 bucket, exactly as the repository's `wrangler.jsonc` deploys them.

You do not normally install this yourself. `decisions deploy` in
[`@daintreehq/decisions-cli`](https://www.npmjs.com/package/@daintreehq/decisions-cli) depends on the same
version, checks the manifest against the digest the CLI was built with and every file against the manifest, and
refuses to deploy anything that does not match.

```bash
npx @daintreehq/decisions-cli deploy --dry-run
```

`dist/manifest.json` lists the SHA-256 and size of every deployable file in `dist/`, the package version, and
the exact Wrangler version the bundle was built with and is deployed by.

Apache-2.0.
