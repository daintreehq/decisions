# @daintreehq/decisions-cli

The `decisions` command for [Daintree Decisions](https://github.com/daintreehq/decisions): claim your
self-hosted relay, pair your phone, serve the HTTP MCP that gives agents `ask_human`, and receive the answers.

```bash
npm install -g @daintreehq/decisions-cli

decisions setup --url https://<your-worker>.workers.dev --claim-secret-file <file>
decisions pair      # scan the QR code with your phone
decisions mcp       # prints the line that adds the MCP to your agent
decisions --help
```

Deploying the relay itself is covered in the [setup guide](https://github.com/daintreehq/decisions#set-up-about-five-minutes).

Node 22+. Apache-2.0.
