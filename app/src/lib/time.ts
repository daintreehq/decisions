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

export function untilLabel(toIso: string, now = Date.now(), long = false): string {
  const ms = Date.parse(toIso) - now;
  if (ms <= 0) return 'expired';
  const m = Math.floor(ms / 60_000);
  const unit = (n: number, short: string, word: string) =>
    long ? `${n} ${word}${n === 1 ? '' : 's'} left` : `${n} ${short} left`;
  if (m < 60) return unit(Math.max(m, 1), 'min', 'minute');
  const h = Math.floor(m / 60);
  if (h < 48) return unit(h, 'h', 'hour');
  return unit(Math.floor(h / 24), 'd', 'day');
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

/** Compact date for list rows: time today, day and month this year, full date otherwise. */
export function shortDateLabel(iso: string, now = Date.now()): string {
  const d = new Date(iso);
  const n = new Date(now);
  if (d.toDateString() === n.toDateString())
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (d.getFullYear() === n.getFullYear())
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

/** "Due in 2 h", "Due in 12 min", "Due in 3 d": the workspace's deadline wording. */
export function dueLabel(toIso: string, now = Date.now()): string {
  const ms = Date.parse(toIso) - now;
  if (ms <= 0) return 'Expired';
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `Due in ${Math.max(m, 1)} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `Due in ${h} h`;
  return `Due in ${Math.floor(h / 24)} d`;
}

/** A moment as a reader wants it on a record: "14:02" today, "3 Nov, 14:02" otherwise. */
export function momentLabel(iso: string, now = Date.now()): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === new Date(now).toDateString()) return time;
  return `${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}, ${time}`;
}

/** "00:24" for a running recording. */
export function clockLabel(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
