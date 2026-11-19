import { describe, expect, it } from 'vitest';
import { deliveredLine } from '../src/commands/daemon.js';

describe('the listener line for a settled delivery', () => {
  it('names what was delivered, so an expiry or timeout is never called an answer', () => {
    expect(deliveredLine('q-1', 'answer')).toBe('✓ delivered answer for q-1');
    expect(deliveredLine('q-1', 'decline')).toBe('✓ delivered decline for q-1');
    expect(deliveredLine('q-1', 'expiry')).toBe('✓ delivered expiry notice for q-1');
    expect(deliveredLine('q-1', 'advisory-timeout')).toBe(
      '✓ delivered advisory timeout notice for q-1',
    );
    expect(deliveredLine('q-1', 'notice')).toBe('✓ delivered notice for q-1');
  });
});
