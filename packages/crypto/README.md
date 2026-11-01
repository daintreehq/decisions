# @daintreehq/decisions-crypto

The WebCrypto implementation of the [Daintree Decisions](https://github.com/daintreehq/decisions) crypto suite:
P-256 ECDSA device signatures, ECDH key wrapping, HKDF and AES-256-GCM envelopes, attachments, grants,
certificates, pairing and recovery kits. It uses only `crypto.subtle`, so the same code runs in browsers, Node 22+
and Cloudflare Workers.

```bash
npm install @daintreehq/decisions-crypto
```

```ts
import { generateDeviceKeys, exportPublicKey, fingerprint } from '@daintreehq/decisions-crypto';

const keys = await generateDeviceKeys(true);
console.log(await fingerprint(await exportPublicKey(keys.signing.publicKey)));
```

Known-answer test vectors for other implementations ship as `@daintreehq/decisions-crypto/fixtures/vectors.json`.
See [docs/security-claims.md](https://github.com/daintreehq/decisions/blob/main/docs/security-claims.md) for what
the suite does and does not protect.

ESM only. The type declarations use WebCrypto's global `CryptoKey`, so TypeScript projects need `"DOM"` in `lib`
(or another declaration of the WebCrypto globals). Apache-2.0.
