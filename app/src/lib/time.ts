export function ageLabel(fromIso: string, now = Date.now()): string {
  const ms = Math.max(0, now - Date.parse(fromIso));
  const m = Math.floor(ms / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  return `${d} d ago`;
}

export function absoluteLabel(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function untilLabel(toIso: string, now = Date.now()): string {
  const ms = Date.parse(toIso) - now;
  if (ms <= 0) return 'expired';
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${Math.max(m, 1)} min left`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h left`;
  return `${Math.floor(h / 24)} d left`;
}

export function timeZones(): string[] {
  try {
    const f = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] })
      .supportedValuesOf;
    if (f) return f('timeZone');
  } catch {
    /* fall through */
  }
  return [Intl.DateTimeFormat().resolvedOptions().timeZone];
}
