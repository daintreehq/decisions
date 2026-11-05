// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MicUnavailableError, type Capture } from '../src/features/voice/capture.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mic = vi.hoisted(() => ({ start: vi.fn() }));
vi.mock('../src/features/voice/capture.js', async (original) => ({
  ...(await original<typeof import('../src/features/voice/capture.js')>()),
  startMic: mic.start,
}));
import { MicTest } from '../src/components/settings/MicTest.js';
import { useMicPermission } from '../src/features/voice/permission.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  mic.start.mockReset();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const click = async () => act(async () => host.querySelector('button')!.click());

describe('the local microphone test', () => {
  it('aborts pending startup on Stop and releases a late capture', async () => {
    const gate = deferred<Capture>();
    mic.start.mockReturnValue(gate.promise);
    act(() => root.render(createElement(MicTest)));
    await click();
    const signal = mic.start.mock.calls[0]![2] as AbortSignal;
    expect(signal.aborted).toBe(false);
    await click();
    expect(signal.aborted).toBe(true);
    const stop = vi.fn();
    await act(async () => gate.resolve({ stop }));
    expect(stop).toHaveBeenCalledTimes(1);
    expect(host.textContent).not.toContain('Listening');
  });

  it('aborts setup as soon as the settings screen unmounts', async () => {
    mic.start.mockReturnValue(new Promise(() => undefined));
    act(() => root.render(createElement(MicTest)));
    await click();
    const signal = mic.start.mock.calls[0]![2] as AbortSignal;
    act(() => root.render(null));
    expect(signal.aborted).toBe(true);
  });

  it('stops when hidden and never resumes on return', async () => {
    const stop = vi.fn();
    mic.start.mockResolvedValue({ stop });
    act(() => root.render(createElement(MicTest)));
    await click();
    expect(host.textContent).toContain('Listening');
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    expect(stop).toHaveBeenCalledTimes(1);
    expect(host.textContent).not.toContain('Listening');
    expect(mic.start).toHaveBeenCalledTimes(1);
  });

  it('explains blocked permission using the error kind', async () => {
    mic.start.mockRejectedValue(new MicUnavailableError('Microphone access is blocked.', 'denied'));
    act(() => root.render(createElement(MicTest)));
    await click();
    expect(host.textContent).toContain('browser’s site settings');
  });

  it('shows runtime microphone failures and ignores late levels', async () => {
    const stop = vi.fn();
    mic.start.mockResolvedValue({ stop });
    act(() => root.render(createElement(MicTest)));
    await click();
    const [, level, , failed] = mic.start.mock.calls[0]!;
    act(() => failed(new MicUnavailableError('The microphone disconnected. Try again.')));
    act(() => level(0.2));
    expect(host.textContent).toContain('disconnected');
    expect(host.querySelector('[role="meter"]')!.getAttribute('aria-valuenow')).toBe('0');
    expect(stop).toHaveBeenCalledTimes(1);
  });
});

describe('browser-owned microphone permission', () => {
  function Probe() {
    return createElement('span', null, useMicPermission());
  }
  const status = (state: PermissionState) => Object.assign(new EventTarget(), { state });

  it('observes expiry and rechecks permission after returning to the app', async () => {
    const allowed = status('granted');
    const prompt = status('prompt');
    const query = vi.fn().mockResolvedValueOnce(allowed).mockResolvedValue(prompt);
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn() }, permissions: { query } });
    await act(async () => root.render(createElement(Probe)));
    expect(host.textContent).toBe('granted');
    allowed.state = 'prompt';
    act(() => allowed.dispatchEvent(new Event('change')));
    expect(host.textContent).toBe('prompt');
    await act(async () => window.dispatchEvent(new Event('focus')));
    expect(query).toHaveBeenCalledTimes(2);
    expect(host.textContent).toBe('prompt');
  });

  it('does not attach permission listeners after unmount', async () => {
    const gate = deferred<PermissionStatus>();
    const allowed = status('granted');
    const add = vi.spyOn(allowed, 'addEventListener');
    vi.stubGlobal('navigator', {
      mediaDevices: { getUserMedia: vi.fn() },
      permissions: { query: () => gate.promise },
    });
    act(() => root.render(createElement(Probe)));
    act(() => root.render(null));
    await act(async () => gate.resolve(allowed as PermissionStatus));
    expect(add).not.toHaveBeenCalled();
  });
});
