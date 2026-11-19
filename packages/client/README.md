# @daintreehq/decisions-client

The desktop side of [Daintree Decisions](https://github.com/daintreehq/decisions): the relay client, the
hibernatable socket, durable local stores, the delivery bridge that types answers and the person's follow-up
messages back into the right agent pane, and the HTTP MCP server that gives agents the `ask_human`,
`send_followup` and `get_involvement` tools.

```bash
npm install @daintreehq/decisions-client
```

```ts
import { DecisionsBridge, createDecisionsMcpHandler } from '@daintreehq/decisions-client';
```

The root entry point holds the `LocalStore` interface and the in-memory `MemoryLocalStore`, and importing it has
no side effects: no timers, sockets or file access, and it never loads `node:sqlite`. A host with its own durable
store implements `LocalStore` and pays for nothing else. The reference SQLite store, built on `node:sqlite`, is a
separate entry point:

```ts
import { SqliteLocalStore } from '@daintreehq/decisions-client/sqlite';

const store = new SqliteLocalStore('/path/to/decisions.db');
```

`bridge.start()` keeps a live socket to the relay. A host that cannot keep one starts with `{ socket: false, poll: true }`
(or `poll: { intervalMs, retryBaseMs, retryCapMs, requestTimeoutMs }`) and the bridge syncs over HTTP until `stop()`:
every 15 s, with equal-jitter backoff up to a minute while the relay is unreachable, one sync at a time, resuming from
the stored cursor. Each sync emits `sync` and records its outcome in the store (`readHttpSyncStatus`); a revoked device
stops the bridge, and a relay that needs a newer client stops the polling (`fatal`). `bridge.sync()` runs a single sync for a host that schedules its own, and `RelayClient.close()`
aborts every request in flight when the process shuts down.

The MCP tools tell agents to attach screenshots when a decision is visual, and describe an attachment's
`local_resource_id` as Daintree resolves it: an image path relative to the folder the agent's terminal started in.
A host whose `AttachmentResolver` takes something else says so with `attachmentIdDescription` (on
`createDecisionsMcpHandler` and `startDecisionsMcpServer`); it changes only what agents are told, never what
the resolver accepts.

The `decisions` command ([`@daintreehq/decisions-cli`](https://www.npmjs.com/package/@daintreehq/decisions-cli))
is a complete host built on this package; [docs/architecture.md](https://github.com/daintreehq/decisions/blob/main/docs/architecture.md)
and the [Daintree integration spec](https://github.com/daintreehq/decisions/blob/main/docs/daintree-integration-spec.md)
describe how the pieces fit.

ESM only, Node 22+. As with `@daintreehq/decisions-crypto`, TypeScript projects need `"DOM"` in `lib` for
WebCrypto's `CryptoKey`. Apache-2.0.
