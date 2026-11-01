# @daintreehq/decisions-protocol

The versioned wire protocol for [Daintree Decisions](https://github.com/daintreehq/decisions): Zod schemas for
every message and API body, the canonical JSON and signing rules, the decision state machine, limits, routes and
error codes. The relay, the desktop client and the phone app all validate against it.

```bash
npm install @daintreehq/decisions-protocol
```

```ts
import { PROTOCOL_VERSION, ApiError, type ApiErrorBody } from '@daintreehq/decisions-protocol';
```

The normative description is [docs/protocol.md](https://github.com/daintreehq/decisions/blob/main/docs/protocol.md).
Machine-readable copies ship with the package as `@daintreehq/decisions-protocol/openapi.json` and
`@daintreehq/decisions-protocol/schemas.json`.

ESM only, Node 22+, browsers and Cloudflare Workers. Apache-2.0.
