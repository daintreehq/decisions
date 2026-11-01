# Platform compatibility

Verified facts and the things to test. Update this page when you verify new combinations.

## Cloudflare (checked against current documentation when written)

- Durable Object SQLite classes are declared with the `exports` map in `wrangler.jsonc` (`"DecisionRoom": { "type": "durable-object", "storage": "sqlite" }`) plus a `durable_objects.bindings` entry. `exports` and the legacy `migrations` array cannot be mixed.
- Static assets: `run_worker_first: true` so the Worker can add security headers to every response and `not_found_handling: "single-page-application"`.
- The Deploy to Cloudflare button needs a **public** GitHub or GitLab repository, reads secrets from `.dev.vars.example`, and supports monorepos only when the Worker lives at the repository root, which is why `wrangler.jsonc` and a root `build` script are at the root.
- `compatibility_date` is pinned to a date the local `workerd` supports so `wrangler dev` and the test runtime work.

## Browsers

| Platform                              | Needs              | Notes                                                                                     |
| ------------------------------------- | ------------------ | ----------------------------------------------------------------------------------------- |
| iOS / iPadOS 16.4+                    | Add to Home Screen | Web Push only works for installed web apps. The app explains this. Test with Focus modes. |
| Android Chrome                        | HTTPS              | Install prompt available                                                                  |
| Desktop Chrome, Edge, Firefox, Safari | HTTPS              | Usable as a second answering device                                                       |

The app needs WebCrypto ECDSA/ECDH P-256 and AES-GCM, IndexedDB, Service Workers and WebSocket. Non-extractable key persistence in IndexedDB has to be verified on the oldest iOS you intend to support; if a platform cannot keep keys across restarts, re-pair.

## Model and provider identifiers

Model ids are configuration. `claude-haiku-5-5` (correction) and `gpt-5-mini` (OpenAI correction, preview) are defaults that must be checked against the provider's current list before relying on them. The xAI streaming endpoint is `wss://api.x.ai/v1/stt`; the OpenAI realtime transcription endpoint is `wss://api.openai.com/v1/realtime?intent=transcription`.

## Agents

The Decisions MCP is standard Streamable HTTP MCP. `decisions mcp` prints add-commands for Claude Code; for other CLIs add an HTTP server with the same URL and `Authorization: Bearer` header per that CLI's documentation. Session resume commands differ per agent and are supplied by the host (Daintree); the standalone client does not guess them.
