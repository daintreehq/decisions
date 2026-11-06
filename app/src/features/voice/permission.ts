import { useEffect, useState } from 'react';

export type MicPermission = 'granted' | 'denied' | 'prompt' | 'unavailable' | 'unknown';

/** Permission is browser-owned and can expire between visits, including installed PWA launches. Never cache it. */
export function useMicPermission(): MicPermission {
  const [permission, setPermission] = useState<MicPermission>('unknown');
  useEffect(() => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setPermission('unavailable');
      return;
    }
    let generation = 0;
    let status: PermissionStatus | null = null;
    const changed = () => status && setPermission(status.state);
    const read = async () => {
      const mine = ++generation;
      try {
        const next = await navigator.permissions?.query({ name: 'microphone' as PermissionName });
        if (mine !== generation) return;
        status?.removeEventListener('change', changed);
        status = next ?? null;
        setPermission(status?.state ?? 'unknown');
        status?.addEventListener('change', changed);
      } catch {
        if (mine === generation) setPermission('unknown');
      }
    };
    const visible = () => {
      if (document.visibilityState === 'visible') void read();
    };
    void read();
    window.addEventListener('focus', visible);
    document.addEventListener('visibilitychange', visible);
    return () => {
      generation++;
      status?.removeEventListener('change', changed);
      window.removeEventListener('focus', visible);
      document.removeEventListener('visibilitychange', visible);
    };
  }, []);
  return permission;
}
