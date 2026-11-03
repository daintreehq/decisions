// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const relay = vi.hoisted(() => ({
  saved: null as unknown,
  put: vi.fn<(s: unknown) => Promise<void>>(),
}));

vi.mock('../src/app/hooks.js', () => ({ useApp: () => ({ online: true }) }));
vi.mock('../src/app/controller.js', () => ({
  app: {
    getServerSettings: async () => ({
      quiet_hours: { enabled: false, start: '22:00', end: '07:00', time_zone: 'UTC' },
      reminders: { enabled: true, first_ms: 4 * 3_600_000, interval_ms: 86_400_000, max: 3 },
      proxy_review_reminder: true,
    }),
    putServerSettings: (s: unknown) => relay.put(s),
  },
}));

const { QuietHoursSection } = await import('../src/components/settings/QuietHoursSection.js');
const { navigate } = await import('../src/app/router.js');

let root: Root;
let host: HTMLElement;
const flush = () => act(async () => new Promise((r) => setTimeout(r, 0)));
const button = (name: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === name)!;
const byLabel = (name: string) => {
  const el = [...host.querySelectorAll('.s-row-label')].find((l) => l.textContent === name)!;
  return host.querySelector<HTMLInputElement>(`[aria-labelledby="${el.id}"]`)!;
};
const dialogOpen = () => !!host.querySelector('dialog[open]');

beforeEach(async () => {
  history.replaceState(null, '', '/settings/quiet-hours');
  relay.put.mockReset();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(QuietHoursSection)));
  await flush();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('quiet hours: unsaved changes are never lost silently', () => {
  it('lets you leave freely while nothing is edited', async () => {
    await act(async () => navigate('/settings'));
    expect(location.pathname).toBe('/settings');
    expect(dialogOpen()).toBe(false);
  });

  it('asks before leaving with edits, and Keep editing stays with them', async () => {
    await act(async () => byLabel('Quiet hours').click());
    expect(host.textContent).toContain('Unsaved changes');
    await act(async () => navigate('/history'));
    expect(location.pathname).toBe('/settings/quiet-hours');
    expect(dialogOpen()).toBe(true);
    await act(async () => button('Keep editing').click());
    expect(dialogOpen()).toBe(false);
    expect(byLabel('Quiet hours').checked).toBe(true);
    expect(location.pathname).toBe('/settings/quiet-hours');
  });

  it('Discard drops the edits and goes where you were going', async () => {
    await act(async () => byLabel('Quiet hours').click());
    await act(async () => navigate('/history'));
    const dialog = host.querySelector('dialog[open]')!;
    await act(async () =>
      [...dialog.querySelectorAll('button')].find((b) => b.textContent === 'Discard')!.click(),
    );
    expect(location.pathname).toBe('/history');
    expect(relay.put).not.toHaveBeenCalled();
  });

  it('Save stores the edits on the relay, then leaves', async () => {
    relay.put.mockResolvedValue();
    await act(async () => byLabel('Quiet hours').click());
    await act(async () => navigate('/history'));
    const dialog = host.querySelector('dialog[open]')!;
    await act(async () =>
      [...dialog.querySelectorAll('button')].find((b) => b.textContent === 'Save')!.click(),
    );
    await flush();
    expect(relay.put).toHaveBeenCalledWith(
      expect.objectContaining({ quiet_hours: expect.objectContaining({ enabled: true }) }),
    );
    expect(location.pathname).toBe('/history');
  });

  it('a failed save keeps the edits and stays', async () => {
    relay.put.mockRejectedValue(new Error('Relay unavailable.'));
    await act(async () => byLabel('Quiet hours').click());
    await act(async () => navigate('/history'));
    const dialog = host.querySelector('dialog[open]')!;
    await act(async () =>
      [...dialog.querySelectorAll('button')].find((b) => b.textContent === 'Save')!.click(),
    );
    await flush();
    expect(location.pathname).toBe('/settings/quiet-hours');
    expect(byLabel('Quiet hours').checked).toBe(true);
    expect(host.textContent).toContain('Couldn’t save to your relay');
    expect(host.textContent).toContain('Your changes are still here');
  });

  it('browser Back with edits puts the page back and asks', async () => {
    history.pushState(null, '', '/settings/quiet-hours');
    await act(async () => byLabel('Quiet hours').click());
    history.replaceState(null, '', '/settings');
    await act(async () => window.dispatchEvent(new PopStateEvent('popstate')));
    expect(location.pathname).toBe('/settings/quiet-hours');
    expect(dialogOpen()).toBe(true);
  });

  it('refuses to save equal start and end times', async () => {
    await act(async () => byLabel('Quiet hours').click());
    const until = host.querySelector<HTMLInputElement>('input[type="time"][aria-invalid]')!;
    expect(until).toBeTruthy();
    const inputs = host.querySelectorAll<HTMLInputElement>('input[type="time"]');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(inputs[1], '22:00');
      inputs[1]!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(host.textContent).toContain('can’t start and end at the same time');
    expect(button('Save').disabled).toBe(true);
  });
});
