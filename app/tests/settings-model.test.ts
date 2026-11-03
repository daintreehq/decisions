import { describe, expect, it } from 'vitest';
import { matchRoute } from '../src/app/router.js';
import {
  devicesSummary,
  durationLabel,
  notificationState,
  quietHoursError,
  quietHoursSummary,
  reminderHourOptions,
  reminderSummary,
  resolveSection,
  sectionPath,
  SECTIONS,
  unpairErasures,
  withDefaults,
} from '../src/components/settings/model.js';
import {
  codeGroups,
  pairingProblem,
  spokenCode,
} from '../src/components/settings/pairingErrors.js';

const H = 3_600_000;

describe('settings section routing', () => {
  it('maps every section path to its section and back', () => {
    for (const s of SECTIONS) {
      const route = matchRoute(sectionPath(s.id));
      expect(route).toEqual({ name: 'settings', section: s.id });
      expect(resolveSection(route as { name: 'settings'; section?: string })).toBe(s.id);
    }
  });

  it('shows the index at /settings and the Devices section at /devices', () => {
    expect(resolveSection({ name: 'settings' })).toBeUndefined();
    expect(matchRoute('/settings/')).toEqual({ name: 'settings' });
    expect(resolveSection({ name: 'devices' })).toBe('devices');
    expect(matchRoute('/devices')).toEqual({ name: 'devices' });
  });

  it('never shows an unknown section as another one', () => {
    expect(resolveSection({ name: 'settings', section: 'nope' })).toBe('unknown');
    expect(matchRoute('/settings/Quiet_Hours').name).toBe('not-found');
  });
});

describe('quiet hours validation', () => {
  const qh = { enabled: true, start: '22:00', end: '07:00', time_zone: 'Europe/London' };

  it('accepts different start and end times, including across midnight', () => {
    expect(quietHoursError(qh)).toBeNull();
    expect(quietHoursError({ ...qh, start: '09:00', end: '17:30' })).toBeNull();
  });

  it('rejects equal start and end with an explanation', () => {
    const err = quietHoursError({ ...qh, end: '22:00' });
    expect(err).toMatch(/same time/);
    expect(err).toMatch(/all day or not at all/);
  });

  it('rejects a missing or malformed time', () => {
    expect(quietHoursError({ ...qh, end: '' })).toMatch(/start and an end/);
    expect(quietHoursError({ ...qh, start: '25:00' })).toMatch(/start and an end/);
  });

  it('never blocks saving while quiet hours are off', () => {
    expect(quietHoursError({ ...qh, enabled: false, end: '22:00' })).toBeNull();
  });

  it('summarises for the index', () => {
    expect(quietHoursSummary({ quiet_hours: qh })).toBe('22:00–07:00');
    expect(quietHoursSummary({ quiet_hours: { ...qh, enabled: false } })).toBe('Off');
    expect(quietHoursSummary(null)).toBe('');
  });

  it('fills in what an older relay left out, without inventing over saved values', () => {
    const s = withDefaults({ proxy_review_reminder: false }, 'Asia/Tokyo');
    expect(s.quiet_hours).toMatchObject({ enabled: false, time_zone: 'Asia/Tokyo' });
    expect(s.reminders).toMatchObject({ enabled: true, max: 3 });
    expect(s.proxy_review_reminder).toBe(false);
  });
});

describe('reminder copy', () => {
  const rm = { enabled: true, first_ms: 4 * H, interval_ms: 24 * H, max: 3 };

  it('reads as a sentence', () => {
    expect(reminderSummary(rm)).toBe(
      'First reminder after 4 hours, then every day, up to 3 reminders',
    );
    expect(reminderSummary({ ...rm, first_ms: 1 * H, interval_ms: 12 * H, max: 2 })).toBe(
      'First reminder after 1 hour, then every 12 hours, up to 2 reminders',
    );
    expect(reminderSummary({ ...rm, interval_ms: 48 * H })).toBe(
      'First reminder after 4 hours, then every 2 days, up to 3 reminders',
    );
  });

  it('says one reminder plainly', () => {
    expect(reminderSummary({ ...rm, max: 1 })).toBe('First reminder after 4 hours, and no more');
  });

  it('says when nothing will be sent', () => {
    expect(reminderSummary({ ...rm, max: 0 })).toBe('No reminders will be sent');
    expect(reminderSummary({ ...rm, enabled: false })).toBe('No reminders will be sent');
  });

  it('labels durations in the largest whole unit', () => {
    expect(durationLabel(30 * 60_000)).toBe('30 minutes');
    expect(durationLabel(1 * H)).toBe('1 hour');
    expect(durationLabel(36 * H)).toBe('36 hours');
    expect(durationLabel(24 * H)).toBe('1 day');
    expect(durationLabel(72 * H)).toBe('3 days');
    expect(durationLabel(168 * H)).toBe('1 week');
  });

  it('keeps a stored delay that is not one of the offered ones', () => {
    expect(reminderHourOptions(4 * H)).not.toContain(5);
    expect(reminderHourOptions(5 * H)).toContain(5);
  });
});

describe('unpair summary', () => {
  it('lists unsent answers and drafts first, with counts', () => {
    const items = unpairErasures({ questions: 7, unsent: 2, drafts: 1 });
    expect(items[0]).toBe('2 unsent answers, which will never be sent');
    expect(items[1]).toBe('1 draft');
    expect(items[2]).toBe('7 saved questions and their answers');
    expect(items.join(' ')).toMatch(/keys/);
    expect(items.join(' ')).toMatch(/settings on this device/);
  });

  it('says so when there is nothing unsent', () => {
    const items = unpairErasures({ questions: 1, unsent: 0, drafts: 0 });
    expect(items).toContain('No unsent answers');
    expect(items).toContain('No drafts');
    expect(items).toContain('1 saved question and their answers');
  });

  it('uses the singular for one unsent answer', () => {
    expect(unpairErasures({ questions: 0, unsent: 1, drafts: 3 })[0]).toBe(
      '1 unsent answer, which will never be sent',
    );
  });
});

describe('notification state', () => {
  const base = {
    support: { ok: true } as const,
    permission: 'default' as NotificationPermission,
    subscribed: false as boolean | null,
    checkFailed: false,
  };
  it('covers every state', () => {
    expect(notificationState(base)).toBe('not-requested');
    expect(notificationState({ ...base, permission: 'granted' })).toBe('granted-no-subscription');
    expect(notificationState({ ...base, permission: 'granted', subscribed: true })).toBe('on');
    expect(notificationState({ ...base, permission: 'denied' })).toBe('blocked');
    expect(notificationState({ ...base, subscribed: null })).toBe('checking');
    expect(notificationState({ ...base, checkFailed: true })).toBe('check-failed');
    expect(
      notificationState({ ...base, support: { ok: false, reason: 'ios-not-installed' } }),
    ).toBe('install-needed');
    expect(notificationState({ ...base, support: { ok: false, reason: 'unsupported' } })).toBe(
      'unsupported',
    );
  });
});

describe('devices summary', () => {
  it('counts computers and other devices, never revoked ones', () => {
    const d = (id: string, role: string, revoked: string | null = null) => ({
      device_id: id,
      role,
      revoked_at: revoked,
    });
    const list = [
      d('me', 'phone'),
      d('mac', 'owner-desktop'),
      d('host', 'desktop-host'),
      d('ipad', 'tablet'),
      d('old', 'phone', '2026-01-01T00:00:00Z'),
    ];
    expect(devicesSummary(list, 'me', 'phone')).toBe('This phone + 2 computers + 1 other');
  });
});

describe('pairing copy', () => {
  it('groups and spells out the code', () => {
    expect(codeGroups('123456')).toEqual(['123', '456']);
    expect(codeGroups('123 456')).toEqual(['123', '456']);
    expect(spokenCode('123 456')).toBe('1 2 3 4 5 6');
  });

  it('gives each failure its recovery', () => {
    expect(
      pairingProblem('This pairing link has expired. Create a new one on your computer.'),
    ).toMatchObject({ title: 'The pairing code expired', action: 'start-again' });
    expect(pairingProblem('Pairing was declined on your computer.').title).toMatch(/declined/);
    expect(pairingProblem('This QR code belongs to a different relay.').title).toMatch(
      /different relay/,
    );
    expect(pairingProblem('This pairing link is from a newer version of Decisions.')).toMatchObject(
      { action: 'reload' },
    );
    expect(
      pairingProblem('Could not reach your relay. Check your connection and try again.').title,
    ).toMatch(/Couldn’t reach/);
    for (const m of [
      'The relay presented an owner identity that does not match your QR code. Pairing was stopped.',
      'The confirmation code from the relay is wrong. Pairing was stopped.',
      'The device certificate is not signed by your computer. Pairing was stopped.',
    ]) {
      expect(pairingProblem(m)).toMatchObject({ tone: 'error' });
      expect(pairingProblem(m).body).toMatch(/Don’t retry/);
    }
  });
});
