# Contributing

```bash
pnpm install
pnpm typecheck && pnpm test     # must both pass
pnpm build
```

- The libraries in `packages/` publish built ESM from `dist`, but inside the workspace everything (TypeScript, Vitest, Vite, Wrangler) resolves them to `src` through the `@daintreehq/source` export condition, so tests and typechecks never need a build first. A new package export lists `"@daintreehq/source": "./src/…ts"` before `types` and `default`; a new Vite or Vitest config spreads `sourceConditions` from `vitest.shared.ts`; a new workspace import in the Worker gets an `alias` in `wrangler.jsonc`. `pnpm pack:check` proves the published tarballs work outside the repository.
- `packages/relay` is the Worker bundle, phone app and Wrangler config that `decisions deploy` uploads, built from `wrangler.jsonc` by `packages/relay/scripts/build.mjs`. Its build must stay reproducible (no timestamps or absolute paths in the output): the CLI embeds the SHA-256 of the relay manifest at build time and refuses to deploy anything else. Changes to `wrangler.jsonc` reach it automatically; check them with `pnpm pack:check`.
- TypeScript is `strict`. Validate every trust boundary at runtime with the schemas in `packages/protocol`; do not invent message shapes in another package.
- Anything that changes the wire protocol edits `packages/protocol` and `docs/protocol.md` in the same pull request, bumps nothing silently, and adds a test to `worker/tests`.
- Code that awaits between reading and writing state in the Durable Object must re-check the actor, revision and expiry inside the final synchronous `room.tx` section. `worker/tests/hardening.test.ts` shows the shape.
- Security-sensitive changes (crypto, pairing, delivery, MCP auth) need tests that fail when the control is removed.
- No new runtime dependencies in the Worker or PWA without a reason; the bundle is audited by hand.
- Never commit secrets, claim secrets, recovery kits or `.dev.vars`.
- Run `pnpm exec prettier --write .` before committing.
