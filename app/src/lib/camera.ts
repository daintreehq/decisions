import { useSyncExternalStore } from 'react';

/*
 * Whether "Take photo" means anything here. `capture` asks a phone or tablet for its camera; a desktop browser ignores
 * it and opens the file picker (W3C HTML Media Capture), so offering it there would be a second "Choose photos" under
 * another name. It is offered on a touch-first device that has a camera: a coarse primary pointer, and a video input
 * among the media devices (listed without asking for permission; labels stay hidden until one is granted).
 */

let camera: boolean | null = null;
const listeners = new Set<() => void>();

function coarse(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
}

function probe() {
  if (camera !== null) return;
  camera = coarse();
  const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
  if (!camera || !md?.enumerateDevices) return;
  void md
    .enumerateDevices()
    .then((list) => {
      const has = list.some((d) => d.kind === 'videoinput');
      if (has !== camera) {
        camera = has;
        for (const l of listeners) l();
      }
    })
    .catch(() => undefined);
}

/** True when the device can take a photo for the composer. */
export function useCamera(): boolean {
  probe();
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => camera ?? false,
    () => false,
  );
}
