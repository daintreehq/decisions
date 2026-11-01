export interface QuietHours {
  enabled: boolean;
  start: string;
  end: string;
  time_zone: string;
}

function minutesOfDay(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** Local minutes-of-day and seconds for `ms` in an IANA zone. Falls back to UTC for unknown zones. */
export function localMinutes(ms: number, timeZone: string): { minutes: number; seconds: number } {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(ms));
  } catch {
    parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'UTC',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(ms));
  }
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return { minutes: get('hour') * 60 + get('minute'), seconds: get('second') };
}

export function isQuiet(ms: number, qh: QuietHours | undefined): boolean {
  if (!qh?.enabled) return false;
  const s = minutesOfDay(qh.start);
  const e = minutesOfDay(qh.end);
  if (s === e) return false;
  const { minutes } = localMinutes(ms, qh.time_zone);
  return s < e ? minutes >= s && minutes < e : minutes >= s || minutes < e;
}

/**
 * First instant at or after `ms` that is outside quiet hours. The wall-clock distance to the window end is only a
 * first guess (a DST change can make it an hour too long or short), so it is corrected against real instants.
 */
export function nextAllowed(ms: number, qh: QuietHours | undefined): number {
  if (!isQuiet(ms, qh)) return ms;
  const e = minutesOfDay(qh!.end);
  const { minutes, seconds } = localMinutes(ms, qh!.time_zone);
  let c = ms + ((e - minutes + 1440) % 1440) * 60_000 - seconds * 1000;
  // Overshot (spring forward): walk back while the previous minute is already allowed.
  for (let i = 0; i < 120 && c - 60_000 > ms && !isQuiet(c - 60_000, qh); i++) c -= 60_000;
  // Undershot (fall back): walk forward until allowed.
  for (let i = 0; i < 180 && isQuiet(c, qh); i++) c += 60_000;
  return c;
}
