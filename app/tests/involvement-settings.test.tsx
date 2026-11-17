// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InvolvementRecord } from '@daintreehq/decisions-protocol';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/*
 * The section against the real store over a fake relay: reads, compare-and-swap saves and conflicts behave as they
 * do on a phone. Signatures are the domain tests' business; here a record is "signed" by naming its device.
 */
const relay = vi.hoisted(() => ({
  current: null as InvolvementRecord | null,
  puts: [] as InvolvementRecord[],
  failNext: null as Error | null,
}));

const store = vi.hoisted(() => ({ s: null as unknown }));

vi.mock('../src/app/hooks.js', () => ({ useApp: () => ({ online: true }) }));
vi.mock('../src/app/controller.js', () => ({
  app: {
    involvementState: () => (store.s as { get(): unknown }).get(),
    onInvolvement: (l: () => void) =>
      (store.s as { subscribe(l: () => void): () => void }).subscribe(l),
    loadInvolvement: () => (store.s as { load(): Promise<unknown> }).load(),
    saveInvolvement: (d: unknown, base: number) =>
      (store.s as { save(d: unknown, base: number): Promise<unknown> }).save(d, base),
  },
}));

const { InvolvementSection } = await import('../src/components/settings/InvolvementSection.js');
const { InvolvementStore } = await import('../src/data/involvement.js');
const { RelayError } = await import('../src/data/relay.js');
const { endLabel } = await import('../src/domain/involvement.js');

const HOUR = 3_600_000;

function record(o: Partial<InvolvementRecord>): InvolvementRecord {
  return {
    v: 1,
    type: 'involvement.preference',
    installation_id: 'inst_00000001',
    revision: 1,
    normal_mode: 'involve-early',
    consult_count: 3,
    override: null,
    created_at: new Date().toISOString(),
    signer_device_id: 'phone_000001',
    signature: 's'.repeat(86),
    ...o,
  };
}

function newStore() {
  return new InvolvementStore({
    fetch: async () => ({
      preference: relay.current,
      received_at: relay.current ? new Date().toISOString() : null,
    }),
    put: async (r) => {
      if (relay.failNext) {
        const e = relay.failNext;
        relay.failNext = null;
        throw e;
      }
      if (r.revision !== (relay.current?.revision ?? 0) + 1)
        throw new RelayError('revision_conflict', 409, 'stale');
      relay.puts.push(r);
      relay.current = r;
      return { revision: r.revision, event_seq: 1 };
    },
    verify: async (raw) => {
      const r = raw as { preference: InvolvementRecord | null; received_at: string | null };
      return { ok: true, value: { record: r.preference, receivedAt: r.received_at } };
    },
    sign: async (d, rev) =>
      record({
        revision: rev + 1,
        normal_mode: d.normalMode,
        consult_count: d.consultCount,
        override: d.override,
        signer_device_id: 'this_phone01',
      }),
  });
}

let root: Root;
let host: HTMLElement;
const flush = () => act(async () => new Promise((r) => setTimeout(r, 0)));
const button = (name: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === name)!;
const radio = (group: number, value: string) =>
  host
    .querySelectorAll<HTMLElement>('[role="radiogroup"]')
    [group]!.querySelector<HTMLInputElement>(`input[value="${value}"]`)!;
const text = () => host.textContent ?? '';

async function mount() {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(InvolvementSection)));
  await flush();
}

/** Types into a controlled input the way a person would, so React hears it. */
function type(input: HTMLInputElement, value: string) {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  set.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

beforeEach(() => {
  history.replaceState(null, '', '/settings/involvement');
  relay.current = null;
  relay.puts = [];
  relay.failNext = null;
  store.s = newStore();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('the involvement section', () => {
  it('says nothing is set, and saves a first preference as revision 1', async () => {
    await mount();
    expect(text()).toContain('Not set');
    expect(text()).toContain('doesn’t change what they’re allowed to do');
    expect(radio(0, 'involve-early').checked).toBe(true);
    expect(text()).not.toContain('Agents to consult');
    await act(async () => radio(0, 'recommend').click());
    expect(text()).toContain('Agents to consult');
    expect(text()).toContain('Unsaved changes');
    await act(async () => button('Save').click());
    await flush();
    expect(relay.puts).toHaveLength(1);
    expect(relay.puts[0]).toMatchObject({
      revision: 1,
      normal_mode: 'recommend',
      consult_count: 3,
      override: null,
    });
    expect(text()).toContain('Saved on your relay');
    expect(text()).toContain('Bring me a recommendation');
    expect(text()).toContain('Your normal mode.');
  });

  it('shows a temporary mode with when it ends and what comes after', async () => {
    const until = new Date(Date.now() + 2 * HOUR).toISOString();
    relay.current = record({
      revision: 4,
      normal_mode: 'recommend',
      override: { mode: 'involve-early', until },
    });
    await mount();
    expect(text()).toContain(
      `Until ${endLabel(until, Date.now())}, then back to Bring me a recommendation.`,
    );
    const toggle = host.querySelector<HTMLInputElement>('input[role="switch"]')!;
    expect(toggle.checked).toBe(true);
    expect(radio(1, 'involve-early').checked).toBe(true);
    // Ending it early is a save like any other.
    await act(async () => toggle.click());
    await act(async () => button('Save').click());
    await flush();
    expect(relay.puts[0]).toMatchObject({ revision: 5, override: null });
  });

  it('follows a temporary mode ending while the screen is open, and stays savable', async () => {
    relay.current = record({
      revision: 4,
      normal_mode: 'recommend',
      override: { mode: 'involve-early', until: new Date(Date.now() + 40).toISOString() },
    });
    await mount();
    expect(host.querySelector<HTMLInputElement>('input[role="switch"]')!.checked).toBe(true);
    // An unrelated render right after it ends, before the boundary timer fires.
    await act(async () => new Promise((r) => setTimeout(r, 60)));
    await act(async () => (store.s as InstanceType<typeof InvolvementStore>).refresh());
    await act(async () => new Promise((r) => setTimeout(r, 100)));
    expect(host.querySelector<HTMLInputElement>('input[role="switch"]')!.checked).toBe(false);
    expect(text()).toContain('Your normal mode.');
    expect(text()).not.toContain('Choose an end time in the future');
    expect(text()).not.toContain('Unsaved changes');
  });

  it('turns on a temporary mode, and refuses an end time in the past', async () => {
    await mount();
    await act(async () => host.querySelector<HTMLInputElement>('input[role="switch"]')!.click());
    expect(radio(1, 'recommend').checked).toBe(true);
    const until = host.querySelector<HTMLInputElement>('input[type="datetime-local"]')!;
    expect(until.value).not.toBe('');
    await act(async () => type(until, '2020-01-01T09:00'));
    expect(text()).toContain('Choose an end time in the future');
    expect(button('Save').disabled).toBe(true);
    const later = new Date(Date.now() + 3 * HOUR);
    const p = (n: number) => String(n).padStart(2, '0');
    const local = `${later.getFullYear()}-${p(later.getMonth() + 1)}-${p(later.getDate())}T${p(later.getHours())}:${p(later.getMinutes())}`;
    await act(async () => type(until, local));
    expect(text()).not.toContain('Choose an end time in the future');
    await act(async () => button('Save').click());
    await flush();
    expect(relay.puts[0]!.override).toEqual({
      mode: 'recommend',
      until: new Date(local).toISOString(),
    });
  });

  it('tells you when another device saved first, keeps your edits, and saves over it only when asked', async () => {
    relay.current = record({ revision: 2, normal_mode: 'involve-early' });
    await mount();
    await act(async () => radio(0, 'recommend').click());
    // Meanwhile the tablet changes the consult count.
    relay.current = record({ revision: 3, consult_count: 6, signer_device_id: 'tablet_00001' });
    await act(async () => button('Save').click());
    await flush();
    expect(relay.puts).toHaveLength(0);
    expect(text()).toContain('Another device changed this while you were editing');
    expect(text()).toContain('Your changes weren’t saved');
    expect(radio(0, 'recommend').checked).toBe(true);
    await act(async () => button('Save').click());
    await flush();
    expect(relay.puts[0]).toMatchObject({ revision: 4, normal_mode: 'recommend' });
    expect(text()).not.toContain('Another device changed this');
  });

  it('keeps your edits when the relay can’t be reached', async () => {
    await mount();
    await act(async () => radio(0, 'recommend').click());
    relay.failNext = new RelayError('network', 0, 'Could not reach the relay');
    await act(async () => button('Save').click());
    await flush();
    expect(text()).toContain('Couldn’t save to your relay');
    expect(radio(0, 'recommend').checked).toBe(true);
    expect(button('Try again')).toBeTruthy();
  });

  it('offers a retry when the first read fails, and the retry loads the form', async () => {
    let fails = 1;
    store.s = new InvolvementStore({
      fetch: async () => {
        if (fails-- > 0) throw new Error('offline');
        return { preference: record({ normal_mode: 'recommend' }), received_at: null };
      },
      put: async () => ({}),
      verify: async (raw) => {
        const r = raw as { preference: InvolvementRecord | null; received_at: string | null };
        return { ok: true, value: { record: r.preference, receivedAt: r.received_at } };
      },
      sign: async () => record({}),
    });
    await mount();
    expect(text()).toContain('Couldn’t load your involvement from your relay');
    await act(async () => button('Try again').click());
    await flush();
    expect(text()).not.toContain('Couldn’t load your involvement');
    expect(radio(0, 'recommend').checked).toBe(true);
  });

  it('with nothing set, what it shows can be saved as it is', async () => {
    await mount();
    expect(text()).toContain('Not saved on your relay yet');
    expect(button('Save').disabled).toBe(false);
    await act(async () => button('Save').click());
    await flush();
    expect(relay.puts[0]).toMatchObject({
      revision: 1,
      normal_mode: 'involve-early',
      consult_count: 3,
    });
    expect(text()).toContain('Saved on your relay');
  });

  it('follows another device’s change while there is nothing unsaved', async () => {
    relay.current = record({ revision: 2, normal_mode: 'involve-early' });
    await mount();
    relay.current = record({
      revision: 3,
      normal_mode: 'recommend',
      signer_device_id: 'tablet_00001',
    });
    await act(async () => (store.s as InstanceType<typeof InvolvementStore>).refresh());
    await flush();
    expect(radio(0, 'recommend').checked).toBe(true);
    expect(text()).not.toContain('Unsaved changes');
  });

  it('discarding after another device’s change starts the next edit from that change', async () => {
    relay.current = record({ revision: 2, normal_mode: 'involve-early' });
    await mount();
    await act(async () => radio(0, 'recommend').click());
    relay.current = record({ revision: 3, consult_count: 6, signer_device_id: 'tablet_00001' });
    await act(async () => (store.s as InstanceType<typeof InvolvementStore>).refresh());
    await flush();
    await act(async () => button('Discard').click());
    await act(async () => radio(0, 'recommend').click());
    await act(async () => button('Save').click());
    await flush();
    expect(text()).not.toContain('Another device changed this');
    expect(relay.puts[0]).toMatchObject({
      revision: 4,
      normal_mode: 'recommend',
      consult_count: 6,
    });
  });

  it('a change that arrives while you edit is a conflict when you save, never silently replaced', async () => {
    relay.current = record({ revision: 2, normal_mode: 'involve-early' });
    await mount();
    await act(async () => radio(0, 'recommend').click());
    // The tablet saves, and its hint reaches this phone while the edit is open.
    relay.current = record({ revision: 3, consult_count: 6, signer_device_id: 'tablet_00001' });
    await act(async () => (store.s as InstanceType<typeof InvolvementStore>).refresh());
    await flush();
    expect(radio(0, 'recommend').checked).toBe(true);
    await act(async () => button('Save').click());
    await flush();
    expect(relay.puts).toHaveLength(0);
    expect(text()).toContain('Another device changed this while you were editing');
    await act(async () => button('Save').click());
    await flush();
    expect(relay.puts[0]).toMatchObject({ revision: 4, normal_mode: 'recommend' });
  });
});
