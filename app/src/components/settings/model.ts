/**
 * Settings logic with no UI: section routing, relay-settings validation and the words the screens use. Kept pure so
 * each rule is tested directly.
 */
import type { ServerSettings } from '../../app/controller.js';
import type { PushSupport } from '../../features/push.js';

export const SECTIONS = [
  { id: 'appearance', title: 'Appearance' },
  { id: 'dictation', title: 'Dictation' },
  { id: 'notifications', title: 'Notifications' },
  { id: 'quiet-hours', title: 'Quiet hours & reminders' },
  { id: 'devices', title: 'Devices' },
  { id: 'privacy', title: 'Privacy & security' },
  { id: 'about', title: 'About & help' },
] as const;

export type SectionId = (typeof SECTIONS)[number]['id'];

export function isSectionId(s: string | undefined): s is SectionId {
  return SECTIONS.some((x) => x.id === s);
}

export function sectionTitle(id: SectionId): string {
  return SECTIONS.find((s) => s.id === id)!.title;
}

/** The path each section lives at. Devices also answers at `/devices`, which shows the same screen. */
export function sectionPath(id: SectionId): string {
  return `/settings/${id}`;
}

/**
 * Which section a settings route shows. `undefined` is the index; an unknown id is `'unknown'` (shown as "not
 * found" with a way back, never silently as another section).
 */
export function resolveSection(
  route: { name: 'settings'; section?: string } | { name: 'devices' },
): SectionId | 'unknown' | undefined {
  if (route.name === 'devices') return 'devices';
  if (route.section === undefined) return undefined;
  return isSectionId(route.section) ? route.section : 'unknown';
}

/* ---------------- quiet hours and reminders ---------------- */

export type QuietHours = NonNullable<ServerSettings['quiet_hours']>;
export type Reminders = NonNullable<ServerSettings['reminders']>;

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const HOUR = 3_600_000;

export function defaultServerSettings(timeZone: string): ServerSettings {
  return {
    quiet_hours: { enabled: false, start: '22:00', end: '07:00', time_zone: timeZone },
    reminders: { enabled: true, first_ms: 4 * HOUR, interval_ms: 24 * HOUR, max: 3 },
    proxy_review_reminder: true,
  };
}

/** Fills in what an older relay left out, so the form never shows a blank where a default applies. */
export function withDefaults(s: ServerSettings, timeZone: string): ServerSettings {
  const d = defaultServerSettings(timeZone);
  return {
    ...s,
    quiet_hours: s.quiet_hours ?? d.quiet_hours,
    reminders: s.reminders ?? d.reminders,
    proxy_review_reminder: s.proxy_review_reminder ?? d.proxy_review_reminder,
  };
}

/** Why these quiet hours cannot be saved, or null. Off is always valid: the times are kept but unused. */
export function quietHoursError(qh: QuietHours): string | null {
  if (!qh.enabled) return null;
  if (!TIME.test(qh.start) || !TIME.test(qh.end)) return 'Enter a start and an end time';
  if (qh.start === qh.end)
    return 'Quiet hours can’t start and end at the same time: it could mean all day or not at all. Choose different times.';
  return null;
}

export function settingsEqual(a: ServerSettings | null, b: ServerSettings | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** "4 hours", "1 day", "36 hours", "1 week". Whole days read as days; anything else as hours or minutes. */
export function durationLabel(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = ms / HOUR;
  if (hours === 168) return '1 week';
  if (hours >= 24 && hours % 24 === 0) {
    const days = hours / 24;
    return `${days} day${days === 1 ? '' : 's'}`;
  }
  const h = Math.round(hours * 10) / 10;
  return `${h} hour${h === 1 ? '' : 's'}`;
}

/** "every day", "every 12 hours". */
function everyLabel(ms: number): string {
  const d = durationLabel(ms);
  return d.startsWith('1 ') ? `every ${d.slice(2)}` : `every ${d}`;
}

/** The reminder schedule as one sentence, so the numbers never have to be decoded. */
export function reminderSummary(rm: Reminders): string {
  if (!rm.enabled || rm.max === 0) return 'No reminders will be sent';
  const first = `First reminder after ${durationLabel(rm.first_ms)}`;
  if (rm.max === 1) return `${first}, and no more`;
  return `${first}, then ${everyLabel(rm.interval_ms)}, up to ${rm.max} reminders`;
}

/**
 * The index row's summary for the section as a whole: the quiet range when it is on, otherwise whether reminders
 * still run, so an active reminder schedule never reads as "Off".
 */
export function quietHoursSummary(s: ServerSettings | null): string {
  const qh = s?.quiet_hours;
  if (!qh) return '';
  if (qh.enabled) return `${qh.start}–${qh.end}`;
  const rm = s?.reminders;
  const reminding = (rm?.enabled && rm.max > 0) || s?.proxy_review_reminder !== false;
  return reminding ? 'Reminders on' : 'Off';
}

/** Hours offered for the reminder delays, plus whatever the relay already holds if it is not one of them. */
export const REMINDER_HOURS = [1, 2, 3, 4, 6, 8, 12, 24, 48, 72, 168];

export function reminderHourOptions(currentMs: number): number[] {
  const h = currentMs / HOUR;
  return REMINDER_HOURS.includes(h) ? REMINDER_HOURS : [...REMINDER_HOURS, h].sort((a, b) => a - b);
}

/* ---------------- notifications ---------------- */

export type NotificationState =
  | 'checking'
  | 'unsupported'
  | 'install-needed'
  | 'check-failed'
  | 'blocked'
  | 'not-requested'
  | 'granted-no-subscription'
  | 'on';

export function notificationState(input: {
  support: PushSupport;
  permission: NotificationPermission;
  /** null while the check is still running. */
  subscribed: boolean | null;
  checkFailed: boolean;
}): NotificationState {
  const { support, permission, subscribed, checkFailed } = input;
  if (!support.ok) return support.reason === 'ios-not-installed' ? 'install-needed' : 'unsupported';
  if (permission === 'denied') return 'blocked';
  if (checkFailed) return 'check-failed';
  if (subscribed === null) return 'checking';
  if (subscribed) return 'on';
  return permission === 'granted' ? 'granted-no-subscription' : 'not-requested';
}

export const NOTIFICATION_SUMMARY: Record<NotificationState, string> = {
  checking: '',
  unsupported: 'Not available',
  'install-needed': 'Install first',
  'check-failed': 'Couldn’t check',
  blocked: 'Blocked',
  'not-requested': 'Off',
  'granted-no-subscription': 'Not set up',
  on: 'On',
};

/* ---------------- unpairing ---------------- */

export interface LocalData {
  questions: number;
  unsent: number;
  drafts: number;
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * Exactly what unpairing erases from this device, in the order it matters to the person. Only what is really there:
 * nothing waiting is said once, beside the list, not as an erasure.
 */
export function unpairErasures(d: LocalData): string[] {
  return [
    ...(d.unsent > 0 ? [count(d.unsent, 'unsent answer', 'unsent answers')] : []),
    ...(d.drafts > 0 ? [count(d.drafts, 'draft', 'drafts')] : []),
    ...(d.questions > 0
      ? [
          d.questions === 1
            ? '1 saved question and its answers'
            : `${d.questions} saved questions and their answers`,
        ]
      : []),
    'The keys that let this device read and answer your questions',
    'Your settings on this device: theme, dictation and notifications',
  ];
}

/* ---------------- devices ---------------- */

export type DeviceGroup = 'this' | 'computers' | 'others' | 'revoked';

export function deviceGroup(
  d: { device_id: string; role: string; revoked_at: string | null },
  myId: string | undefined,
): DeviceGroup {
  if (d.device_id === myId) return 'this';
  if (d.revoked_at) return 'revoked';
  if (d.role === 'owner-desktop' || d.role === 'desktop-host') return 'computers';
  return 'others';
}

/** The Devices index summary: how many devices are paired now, this one included ("3 devices"). Always fits a row. */
export function devicesSummary(
  devices: { device_id: string; role: string; revoked_at: string | null }[] | undefined,
  myId: string | undefined,
): string {
  if (!devices) return '';
  const paired = devices.filter((d) => deviceGroup(d, myId) !== 'revoked').length;
  return count(Math.max(paired, 1), 'device', 'devices');
}

/* ---------------- keyboard ---------------- */

export function isApplePlatform(ua = globalThis.navigator?.userAgent ?? ''): boolean {
  return /Mac|iPhone|iPad|iPod/.test(ua);
}
