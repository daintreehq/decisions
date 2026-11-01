import { reset } from 'cloudflare:test';
import { beforeEach } from 'vitest';

// Every test starts from an unclaimed relay: Durable Object storage and R2 are wiped.
beforeEach(async () => {
  await reset();
});
