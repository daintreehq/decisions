# Contributing

```bash
pnpm install
pnpm typecheck && pnpm test     # must both pass
pnpm build
```

- TypeScript is `strict`. Validate every trust boundary at runtime with the schemas in `packages/protocol`; do not invent message shapes in another package.
- Anything that changes the wire protocol edits `packages/protocol` and `docs/protocol.md` in the same pull request, bumps nothing silently, and adds a test to `worker/tests`.
- Code that awaits between reading and writing state in the Durable Object must re-check the actor, revision and expiry inside the final synchronous `room.tx` section. `worker/tests/hardening.test.ts` shows the shape.
- Security-sensitive changes (crypto, pairing, delivery, MCP auth) need tests that fail when the control is removed.
- No new runtime dependencies in the Worker or PWA without a reason; the bundle is audited by hand.
- Never commit secrets, claim secrets, recovery kits or `.dev.vars`.
- Run `pnpm exec prettier --write .` before committing.
