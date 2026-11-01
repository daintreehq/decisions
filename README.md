# Daintree Decisions

Let your AI coding agents ask you things, and answer from your phone whenever you get to it.

An agent that hits a question it should not answer alone (a product choice, an ambiguous requirement, approval of a design change) calls one MCP tool, `ask_human`, and stops. Minutes or a day later you answer on your phone, and the answer is typed back into that agent's terminal, resuming the session first if it has to.

Everything runs in **your own Cloudflare account**. There is no Daintree-operated server, no account to create, and nothing for Daintree to read: questions, answers and screenshots are end-to-end encrypted between your computer and your phone.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/daintreehq/decisions)

## How it works

```text
 agent ──ask_human──▶ Decisions MCP ──encrypt+sign──▶  your Cloudflare Worker  ──push──▶ your phone (PWA)
 (any CLI)           (HTTP, loopback)   outbound WSS   + Durable Object + R2    ◀─answer─  encrypted + signed
    ▲
    └── answer typed into the right terminal, when it is idle ◀── hibernatable WebSocket ───┘
```

- **Non-blocking.** `ask_human` returns immediately. The agent ends its turn instead of holding a tool call open for hours, so it works with every agent CLI, survives restarts and sleep, and never looks "stuck".
- **The Decisions MCP** is a plain HTTP MCP server that you can add to any agent. Inside Daintree it is wired in for you; anywhere else run `decisions mcp` and it prints the exact `claude mcp add --transport http …` line. It serves `/mcp` by default; `--path /mcp/decisions` (or `path` in `createDecisionsMcpHandler`) mounts it somewhere else, matched exactly.
- **The relay** is a Cloudflare Worker, one SQLite Durable Object, and a private R2 bucket. The desktop and phone stay connected through Cloudflare's WebSocket Hibernation API, so an idle connection costs almost nothing.
- **The app** is an installable PWA served by the same Worker, with push notifications, an offline outbox, and optional dictation.
- **The decision model** (optional) can answer the way you would, from your own decision history, only where a workflow allows it, always labelled as a proxy, never for anything that needs you.

## Safety rules that do not bend

- A workflow can require a human (`human-required`). A model, a proxy, or the agent itself can never satisfy it, and the agent cannot lower the level.
- Only a signed answer from a device you paired counts as a human answer. The relay cannot forge one.
- Answers are typed into the exact pane they were asked from, or not at all. If that pane or session cannot be found, the answer waits and tells you.
- An expired question never authorizes anything.
- Push notifications say only "a question needs your input". Never the question.

Read [docs/security-claims.md](docs/security-claims.md) for exactly what is and is not protected, including the places where plaintext necessarily exists (your computer, your phone, and the optional dictation path).

## Set up (about five minutes)

You need a Cloudflare account (the free plan is enough for one person), Node 22+, and a phone.

1. **Deploy.** Click the button above. Cloudflare copies this repository into your account, creates the R2 bucket and Durable Object, and asks for one secret, `CLAIM_SECRET`: type any long random string (`openssl rand -hex 32`) and keep it for step 2. Prefer a terminal? `pnpm install && pnpm decisions:deploy` does the same thing and generates the secret for you. More detail in [docs/self-host.md](docs/self-host.md).
2. **Claim it** from the computer your agents run on: `pnpm decisions setup --url https://<your-worker>.workers.dev --claim-secret-file <file containing the secret>` (or set `DECISIONS_CLAIM_SECRET`; avoid putting the secret on the command line, where it shows in the process list). In Daintree this is Settings → Decisions. The claim can only happen once.
3. **Pair your phone:** `pnpm decisions pair` shows a QR code. Scan it, then confirm the same six digits appear on both screens. On iPhone open the link in Safari, tap Share → Add to Home Screen, and open the installed app (iOS only delivers push to installed web apps).
4. **Add the MCP to your agent:** `pnpm decisions mcp` prints the line for your agent.
5. **Test it:** `pnpm decisions ask "Does this work?" --option yes=Yes --option no=No` and answer on your phone.

Back up your keys: `pnpm decisions recovery export`. **If you lose every device that holds your keys, the encrypted data on Cloudflare cannot be recovered.**

## Repository layout

| Path                       | What it is                                                                                                        |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `worker/`                  | Cloudflare Worker + `DecisionRoom` Durable Object (SQLite) + R2 attachment streaming + Web Push + dictation proxy |
| `app/`                     | The phone app (React + Vite PWA)                                                                                  |
| `packages/protocol/`       | Versioned wire protocol: schemas, canonical signing, state machine, errors                                        |
| `packages/crypto/`         | WebCrypto implementation (P-256 ECDSA/ECDH, HKDF, AES-256-GCM) shared by browser, Node and Workers                |
| `packages/client/`         | Desktop client library: relay client, hibernatable socket, durable stores, delivery engine, HTTP MCP server       |
| `packages/cli/`            | The `decisions` command                                                                                           |
| `packages/decision-model/` | The optional local opinion model                                                                                  |
| `tools/`                   | Guided deploy and health check                                                                                    |
| `docs/`                    | Protocol, architecture, security, operations, and the Daintree integration spec                                   |

## Documentation

- [Protocol](docs/protocol.md): the normative relay protocol; any server that implements it is a valid relay.
- [Architecture](docs/architecture.md) · [Security claims](docs/security-claims.md) · [Threat model](docs/threat-model.md)
- [Self-hosting](docs/self-host.md) · [Operations and costs](docs/operations.md) · [Key recovery](docs/key-recovery.md) · [Voice privacy](docs/voice-privacy.md) · [Platform compatibility](docs/platform-compatibility.md)
- [Daintree integration spec](docs/daintree-integration-spec.md): how Daintree itself connects to this.

## Develop

```bash
pnpm install
pnpm build        # builds the PWA into app/dist (what the Worker serves)
pnpm build:all    # also builds the libraries and the CLI (needed for `pnpm decisions`)
pnpm pack:check   # packs every library and the CLI, installs them in a scratch project, imports and type-checks
pnpm test         # every package, including the Worker in a real workerd runtime
pnpm typecheck
pnpm dev          # wrangler dev on http://localhost:8787
pnpm release:publish --dry-run   # what a release would publish to npm, without uploading
```

Releases are published to npm from a `v*` tag; see [docs/operations.md](docs/operations.md#releasing-to-npm).

## License

Apache-2.0. "Daintree" and the Daintree logo are marks of Greg Priday and are not licensed under Apache-2.0.
