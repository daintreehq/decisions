# @daintreehq/decisions-cli

The `decisions` command for [Daintree Decisions](https://github.com/daintreehq/decisions): claim your
self-hosted relay, pair your phone, serve the HTTP MCP that gives agents `ask_human`, and receive the answers.

```bash
npm install -g @daintreehq/decisions-cli

decisions deploy    # deploy the matching relay to your Cloudflare account (--dry-run shows the plan)
decisions update --url https://<your-worker>.workers.dev   # move it to the newest compatible release
decisions setup --url https://<your-worker>.workers.dev   # asks for the claim secret
decisions pair      # scan the QR code with your phone
decisions mcp       # prints the line that adds the MCP to your agent
decisions remove https://<your-worker>.workers.dev   # take the relay out of Cloudflare (--dry-run lists it)
decisions --help
```

`decisions deploy` uploads the prebuilt relay from `@daintreehq/decisions-relay`, installed at the same version,
after checking every file against a SHA-256 manifest pinned in the CLI. The claim secret is shown once and never
saved. More in the [self-hosting guide](https://github.com/daintreehq/decisions/blob/main/docs/self-host.md).

Node 22+. Apache-2.0.
