# Contributing

```bash
pnpm install
pnpm typecheck && pnpm test     # must both pass
pnpm build
```

- The libraries in `packages/` publish built ESM from `dist`, but inside the workspace everything (TypeScript, Vitest, Vite, Wrangler) resolves them to `src` through the `@daintreehq/source` export condition, so tests and typechecks never need a build first. A new package export lists `"@daintreehq/source": "./src/…ts"` before `types` and `default`; a new Vite or Vitest config spreads `sourceConditions` from `vitest.shared.ts`; a new workspace import in the Worker gets an `alias` in `wrangler.jsonc`. `pnpm pack:check` proves the published tarballs work outside the repository.
- Releases are cut by pushing a `v*` tag after `pnpm release:version <version>` lands; the release workflow publishes every package that is not `"private": true` to npm. [docs/operations.md](docs/operations.md#releasing-to-npm) has the procedure and the one-time npm setup. A new public package also needs an entry in `tools/pack-check/pack-check.mjs` and a trusted publisher on npm. Never `npm publish` by hand: plain npm leaves `workspace:*` ranges unconverted.
- TypeScript is `strict`. Validate every trust boundary at runtime with the schemas in `packages/protocol`; do not invent message shapes in another package.
- Anything that changes the wire protocol edits `packages/protocol` and `docs/protocol.md` in the same pull request, bumps nothing silently, and adds a test to `worker/tests`.
- Code that awaits between reading and writing state in the Durable Object must re-check the actor, revision and expiry inside the final synchronous `room.tx` section. `worker/tests/hardening.test.ts` shows the shape.
- Security-sensitive changes (crypto, pairing, delivery, MCP auth) need tests that fail when the control is removed.
- No new runtime dependencies in the Worker or PWA without a reason; the bundle is audited by hand.
- Never commit secrets, claim secrets, recovery kits or `.dev.vars`.
- Run `pnpm exec prettier --write .` before committing.
