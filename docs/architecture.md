# Architecture

Decisions has four parts that deploy as one unit: the **Decisions MCP**, the **relay**, the **phone app**, and the optional **decision model**.

## Components

| Part                              | Where it runs                                       | Code                                                             |
| --------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------- |
| Decisions MCP                     | On the machine where the agent runs, on `127.0.0.1` | `packages/client` (`createDecisionsMcpHandler`, `decisions mcp`) |
| Bridge (policy, queues, delivery) | Same machine                                        | `packages/client` (`DecisionsBridge`)                            |
| Relay                             | Your Cloudflare account                             | `worker/`                                                        |
| Phone app                         | Your phone, served by the relay                     | `app/`                                                           |
| Decision model                    | Same machine as the keys                            | `packages/decision-model`                                        |

## Why non-blocking

Holding an MCP call open for hours is fragile: other agent CLIs time out tool calls in seconds or minutes, pressing Escape or restarting loses the call, and the pane looks busy the whole time. So `ask_human` returns at once with `Asked as q-N. End your turn now…`. The answer later arrives as a message typed into the terminal, which works for every agent CLI.

## Flow

1. The agent calls `ask_human`. The bridge authenticates the pane (a per-pane bearer token, never a pane id sent by the agent), resolves the enforced requirement level from trusted workflow policy, and writes the question's origin (host, pane, generation, ownership principal, agent incarnation, session, worktree) and its encrypted content to the local store **before** any network I/O.
2. The bridge encrypts the question, signs a record that commits to the ciphertext, uploads any encrypted screenshots, and publishes through the outbound queue. Offline is fine; it publishes later exactly once.
3. The relay's Durable Object validates the signatures, appends an event to its ledger, schedules the push and reminders, and pushes the event to connected devices over hibernatable WebSockets.
4. The phone verifies the record against the owner key it pinned when it paired, decrypts it, and shows it. You answer; the phone encrypts and signs the answer.
5. The Durable Object compare-and-swaps on the revision (first human answer wins) and pushes the committed event to the desktop's socket, or holds it until the desktop reconnects.
6. The bridge verifies the answer, persists it sealed, acknowledges receipt, then waits until the exact origin terminal is safe to type into (resuming the agent first if the pane is gone), writes an _injection intent_, types a delimited answer block, and only then reports `terminal-delivered`.

## State is three separate things

- **Resolution** (`open`, `proxy-answered`, `human-answered`, `cancelled`, `expired`) is decided by the relay in one serialized transaction.
- **Delivery** (`relay-queued`, `desktop-received`, `terminal-delivered`, `needs-attention`, `delivery-uncertain`) is reported by the desktop; receipt is never confused with typing.
- **Provenance** (`human` or `proxy`) follows the signer's device role and is verified by every client.

## What the desktop stores

The local store (`LocalStore`: SQLite in the CLI, Daintree's own tables in Daintree) holds origin metadata, status, queues and ciphertext. It never holds question text, context, option labels or answer text in clear:

- A question's content is kept as the envelope it was published with, the same ciphertext the relay holds.
- Each answer's content is sealed with the epoch key when the verified answer is applied, so an answer that has not been typed yet survives a restart and is decrypted in memory when it is delivered, shown by `get_decision` or exported.
- A proxy answer waiting to be sent is sealed until it is signed.

Sealing happens in the bridge, above the store, so any store implementation inherits it. A store written by an older version is sealed when the bridge starts, then compacted so no freed page keeps the old text. The only plaintext the desktop writes is the decision model's history, and only when you opt into learning, with secrets redacted first.

## The relay in detail

- One Worker serves the API (`/api/v1/*`), the PWA (static assets), and a transient dictation proxy.
- One SQLite-backed Durable Object (`DecisionRoom`, named `primary`) holds all state: devices, questions, signed actions, the event ledger, delivery status, push subscriptions, scheduled jobs, rate limits. A Durable Object serializes work, so compare-and-swap is simple and correct.
- WebSocket Hibernation: the object accepts sockets with `ctx.acceptWebSocket`, so sockets stay open while the object is evicted from memory. Plain `ping` frames get a `pong` from the runtime with no code running. Each frame wakes the object, which re-validates the device before acting.
- Awaiting `crypto.subtle` is not covered by a Durable Object's input gate, so every handler verifies signatures first and then re-checks the actor, the revision, expiry and quotas in one synchronous transaction.
- A single alarm drives a SQL job table: first notification, reminders, proxy review nudges, expiry, attachment retention, orphan collection, nightly purge.
- R2 stores only encrypted attachments under random keys. The Worker streams uploads straight into R2 with an integrity check.

## Where the keys are

| Key                             | Held by                                         | Never                                                          |
| ------------------------------- | ----------------------------------------------- | -------------------------------------------------------------- |
| Owner signing and exchange keys | The owner desktop                               | leave it unencrypted; sent to Cloudflare                       |
| Epoch content key               | Owner desktop (raw); each device (sealed grant) | stored by the relay; stored in the local database              |
| Phone keys                      | The phone, as non-extractable WebCrypto keys    | exported                                                       |
| VAPID private key               | The Durable Object                              | sent to clients (a notification credential, not a content key) |
| Dictation provider API keys     | Worker secrets                                  | exposed to the browser                                         |

## Extending

The protocol in [protocol.md](protocol.md) is vendor-neutral. A relay on another platform is valid if it passes the Worker test suite's semantics. `packages/decision-model` plugs into the bridge through structural interfaces: `ProxyEngine` (suggestions and proxy answers, via `asBridgeEngine`) and `DecisionLearner` (human answers into the history, via `asBridgeLearner`).
