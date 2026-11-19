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
decisions listen    # receive answers into stdout, a file (--sink file:<path>) or a command (--sink exec:<cmd>)
decisions remove https://<your-worker>.workers.dev   # take the relay out of Cloudflare (--dry-run lists it)
decisions --help
```

`decisions deploy` uploads the prebuilt relay from `@daintreehq/decisions-relay`, installed at the same version,
after checking every file against a SHA-256 manifest pinned in the CLI. The claim secret is shown once and never
saved. An app that starts the deploy for its user can supply the answers' defaults and receive the result over a
local socket (`--host-channel`). More in the [self-hosting guide](https://github.com/daintreehq/decisions/blob/main/docs/self-host.md).

`listen` and `mcp` keep a live socket to the relay. Where one cannot stay open, `--no-socket` polls over HTTP
instead (every 15 s, backing off while the relay is unreachable), and `listen --once` fetches what is waiting,
delivers it and exits. The [operations guide](https://github.com/daintreehq/decisions/blob/main/docs/operations.md#listening-without-a-live-socket)
has the retry schedule, exit codes, what `decisions status` reports, and how an MCP client gets its answers this way.

Node 22+. Apache-2.0.
