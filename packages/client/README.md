# @daintreehq/decisions-client

The desktop side of [Daintree Decisions](https://github.com/daintreehq/decisions): the relay client, the
hibernatable socket, durable local stores, the delivery bridge that types answers back into the right agent pane,
and the HTTP MCP server that gives agents the `ask_human` tool.

```bash
npm install @daintreehq/decisions-client
```

```ts
import { DecisionsBridge, createDecisionsMcpHandler } from '@daintreehq/decisions-client';
```

The `decisions` command ([`@daintreehq/decisions-cli`](https://www.npmjs.com/package/@daintreehq/decisions-cli))
is a complete host built on this package; [docs/architecture.md](https://github.com/daintreehq/decisions/blob/main/docs/architecture.md)
and the [Daintree integration spec](https://github.com/daintreehq/decisions/blob/main/docs/daintree-integration-spec.md)
describe how the pieces fit.

ESM only, Node 22+. As with `@daintreehq/decisions-crypto`, TypeScript projects need `"DOM"` in `lib` for
WebCrypto's `CryptoKey`. Apache-2.0.
