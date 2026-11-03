import { useEffect, useLayoutEffect, useRef, useState, type ComponentType } from 'react';
import { useApp } from '../app/hooks.js';
import { Link, useRoute } from '../app/router.js';
import { AboutSection, aboutSummary } from '../components/settings/AboutSection.js';
import { AppearanceSection, THEME_LABEL } from '../components/settings/AppearanceSection.js';
import { DevicesSection } from '../components/settings/DevicesSection.js';
import { DictationSection, dictationSummary } from '../components/settings/DictationSection.js';
import {
  devicesSummary,
  NOTIFICATION_SUMMARY,
  quietHoursSummary,
  resolveSection,
  sectionPath,
  sectionTitle,
  SECTIONS,
  type SectionId,
} from '../components/settings/model.js';
import {
  NotificationsSection,
  useNotificationStatus,
} from '../components/settings/NotificationsSection.js';
import { PrivacySection } from '../components/settings/PrivacySection.js';
import {
  fetchServerSettings,
  loadedServerSettings,
  onServerSettings,
  QuietHoursSection,
} from '../components/settings/QuietHoursSection.js';
import {
  BellIcon,
  ChevronLeft,
  HelpIcon,
  LaptopIcon,
  MicIcon,
  MoonIcon,
  PaletteIcon,
  ShieldIcon,
} from '../components/Icons.js';

const BODY: Record<SectionId, ComponentType> = {
  appearance: AppearanceSection,
  dictation: DictationSection,
  notifications: NotificationsSection,
  'quiet-hours': QuietHoursSection,
  devices: DevicesSection,
  privacy: PrivacySection,
  about: AboutSection,
};

const ICON: Record<SectionId, ComponentType<{ size?: number }>> = {
  appearance: PaletteIcon,
  dictation: MicIcon,
  notifications: BellIcon,
  'quiet-hours': MoonIcon,
  devices: LaptopIcon,
  privacy: ShieldIcon,
  about: HelpIcon,
};

/** Two clusters: how the app behaves for you, then the pairing and the app itself. */
const GROUPS: SectionId[][] = [
  ['appearance', 'dictation', 'notifications', 'quiet-hours'],
  ['devices', 'privacy', 'about'],
];

/** Wide enough for the index to sit beside the open section, as in Daintree's settings. */
const SPLIT = '(min-width: 900px)';

function useSplit(): boolean {
  const [on, setOn] = useState(() => globalThis.matchMedia?.(SPLIT).matches ?? false);
  useEffect(() => {
    const m = globalThis.matchMedia?.(SPLIT);
    if (!m) return;
    const f = () => setOn(m.matches);
    m.addEventListener('change', f);
    return () => m.removeEventListener('change', f);
  }, []);
  return on;
}

function deviceNoun(): string {
  const ua = globalThis.navigator?.userAgent ?? '';
  if (/iPad|Tablet/.test(ua) || (/Mac/.test(ua) && navigator.maxTouchPoints > 1)) return 'tablet';
  if (/iPhone|Android.*Mobile|Mobile/.test(ua)) return 'phone';
  return 'device';
}

function useSummaries(): Record<SectionId, string> {
  const snap = useApp();
  const notif = useNotificationStatus(false);
  const [server, setServer] = useState(loadedServerSettings);
  useEffect(() => onServerSettings(() => setServer(loadedServerSettings())), []);
  useEffect(() => {
    if (!loadedServerSettings()) void fetchServerSettings().catch(() => undefined);
  }, []);
  return {
    appearance: THEME_LABEL[snap.prefs.theme],
    dictation: dictationSummary(snap.prefs.voice, snap.info),
    notifications: NOTIFICATION_SUMMARY[notif.state],
    'quiet-hours': quietHoursSummary(server),
    devices: devicesSummary(snap.devices?.devices, snap.config?.deviceId, deviceNoun()),
    privacy: 'Paired',
    about: aboutSummary(snap.updateAvailable),
  };
}

/** Where the index was scrolled and which row opened a section, so coming back lands in the same place. */
const memory = { scrollY: 0, from: null as SectionId | null };

function SettingsIndex({ active, split }: { active?: SectionId; split: boolean }) {
  const values = useSummaries();

  // Phone drill-in: returning to the index restores its scroll and puts focus back on the row that was opened.
  useLayoutEffect(() => {
    if (split || active) return;
    window.scrollTo(0, memory.scrollY);
    if (memory.from)
      document
        .querySelector<HTMLElement>(`[data-section-row="${memory.from}"]`)
        ?.focus({ preventScroll: true });
    memory.from = null;
  }, [split, active]);

  return (
    <nav className="s-index" aria-label="Settings sections">
      {GROUPS.map((ids, i) => (
        <ul key={i} className="nav-list s-index-list">
          {ids.map((id) => {
            const Icon = ICON[id];
            const on = active === id;
            return (
              <li key={id}>
                <Link
                  to={sectionPath(id)}
                  data-section-row={id}
                  aria-current={on ? 'page' : undefined}
                  className={on ? 'on' : undefined}
                  onClick={() => {
                    if (!split) {
                      memory.scrollY = window.scrollY;
                      memory.from = id;
                    }
                  }}
                >
                  <span className="s-index-icon">
                    <Icon size={18} />
                  </span>
                  <span className="s-index-label">{sectionTitle(id)}</span>
                  {!split && <span className="value">{values[id]}</span>}
                </Link>
              </li>
            );
          })}
        </ul>
      ))}
    </nav>
  );
}

function SectionView({ id, split }: { id: SectionId; split: boolean }) {
  const Body = BODY[id];
  const heading = useRef<HTMLHeadingElement>(null);
  // Opening a section focuses its heading, so screen readers start at the top of what changed.
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
  }, [id]);
  const H = split ? 'h2' : 'h1';
  return (
    <div className="s-section" data-section={id}>
      {!split && (
        <Link to="/settings" className="s-back">
          <ChevronLeft size={18} />
          Settings
        </Link>
      )}
      <H className="s-title" ref={heading} tabIndex={-1}>
        {sectionTitle(id)}
      </H>
      <Body />
    </div>
  );
}

/**
 * Settings: an index of sections, each opening a focused screen. On phones it is a drill-in with a back link; from
 * 900 px the index sits beside the open section, as Daintree's settings do.
 */
export function SettingsPage() {
  const route = useRoute();
  const split = useSplit();
  const section =
    route.name === 'settings' || route.name === 'devices' ? resolveSection(route) : undefined;

  if (section === 'unknown') {
    return (
      <div className="page s-page">
        <div className="empty">
          <h1>This setting doesn’t exist</h1>
          <Link to="/settings" className="btn">
            Go to Settings
          </Link>
        </div>
      </div>
    );
  }

  if (split) {
    const open: SectionId = section ?? SECTIONS[0].id;
    return (
      <div className="page s-page s-split">
        <aside className="s-aside">
          <h1 className="s-page-title">Settings</h1>
          <SettingsIndex active={open} split />
        </aside>
        <SectionView id={open} split />
      </div>
    );
  }

  return (
    <div className="page s-page">
      {section ? (
        <SectionView id={section} split={false} />
      ) : (
        <>
          <h1 className="s-page-title">Settings</h1>
          <SettingsIndex split={false} />
        </>
      )}
    </div>
  );
}
