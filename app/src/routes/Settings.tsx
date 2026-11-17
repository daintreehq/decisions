import { useEffect, useLayoutEffect, useRef, useState, type ComponentType } from 'react';
import { app } from '../app/controller.js';
import { useApp } from '../app/hooks.js';
import { Link, useRoute } from '../app/router.js';
import { AboutSection, aboutSummary } from '../components/settings/AboutSection.js';
import { AppearanceSection, THEME_LABEL } from '../components/settings/AppearanceSection.js';
import { DevicesSection } from '../components/settings/DevicesSection.js';
import { DictationSection, dictationSummary } from '../components/settings/DictationSection.js';
import { InvolvementSection } from '../components/settings/InvolvementSection.js';
import { involvementSummary } from '../domain/involvement.js';
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
  PeopleIcon,
  ShieldIcon,
} from '../components/Icons.js';

const BODY: Record<SectionId, ComponentType> = {
  appearance: AppearanceSection,
  dictation: DictationSection,
  notifications: NotificationsSection,
  'quiet-hours': QuietHoursSection,
  involvement: InvolvementSection,
  devices: DevicesSection,
  privacy: PrivacySection,
  about: AboutSection,
};

const ICON: Record<SectionId, ComponentType<{ size?: number }>> = {
  appearance: PaletteIcon,
  dictation: MicIcon,
  notifications: BellIcon,
  'quiet-hours': MoonIcon,
  involvement: PeopleIcon,
  devices: LaptopIcon,
  privacy: ShieldIcon,
  about: HelpIcon,
};

/** Two clusters: how the app behaves for you, then the pairing and the app itself. */
const GROUPS: SectionId[][] = [
  ['appearance', 'dictation', 'notifications', 'quiet-hours', 'involvement'],
  ['devices', 'privacy', 'about'],
];

/** Whether the relay keeps the involvement preference; until it does, the section is not offered. */
function involvementServed(snap: { info: { features?: string[] } | null }): boolean {
  return snap.info?.features?.includes('involvement-v1') ?? false;
}

/** The preference as this device last read it, kept current, for the index row. Read once when first shown. */
function useInvolvementSummary(served: boolean): string {
  const [state, setState] = useState(() => app.involvementState());
  useEffect(() => app.onInvolvement(() => setState(app.involvementState())), []);
  useEffect(() => {
    if (served && app.involvementState().status === 'idle')
      void app.loadInvolvement().catch(() => undefined);
  }, [served]);
  // Repaint when a temporary mode ends, so the row never shows one that is over.
  const [, tick] = useState(0);
  const until = state.status === 'ready' && state.record?.override?.until;
  useEffect(() => {
    if (!until) return;
    const wait = Date.parse(until) - Date.now();
    if (!(wait > 0)) return;
    const t = setTimeout(() => tick((n) => n + 1), Math.min(wait + 50, 2_000_000_000));
    return () => clearTimeout(t);
  }, [until]);
  if (!served) return '';
  if (state.status === 'invalid') return 'Couldn’t verify';
  return involvementSummary(state.status === 'ready' ? state.record : undefined, Date.now());
}

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

function useSummaries(): Record<SectionId, string> {
  const snap = useApp();
  const involvement = useInvolvementSummary(involvementServed(snap));
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
    involvement,
    devices: devicesSummary(snap.devices?.devices, snap.config?.deviceId),
    privacy: 'Paired',
    about: aboutSummary(snap.updateAvailable),
  };
}

/** Where the index was scrolled and which row opened a section, so coming back lands in the same place. */
const memory = { scrollY: 0, from: null as SectionId | null };

function SettingsIndex({ active, split }: { active?: SectionId; split: boolean }) {
  const values = useSummaries();
  const served = involvementServed(useApp());
  const groups = GROUPS.map((ids) => ids.filter((id) => id !== 'involvement' || served));

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
      {groups.map((ids, i) => (
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
                  {/* On a phone the value trails the label; in the wide rail it sits beneath it. */}
                  <span className="s-index-text">
                    {/* "&" stays with the word after it, so a wrapped title never ends on it. */}
                    <span className="s-index-label">
                      {sectionTitle(id).replace(' & ', ' &\u00a0')}
                    </span>
                    {split && values[id] && <span className="s-index-sub">{values[id]}</span>}
                  </span>
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

/** A relay that does not keep the preference: nothing is read or offered, and the person is told why. */
function InvolvementUnavailable() {
  return (
    <p className="s-lead">
      Your relay doesn’t keep an involvement preference yet. Update it from Daintree on your
      computer, then come back here.
    </p>
  );
}

function SectionView({ id, split }: { id: SectionId; split: boolean }) {
  const served = involvementServed(useApp());
  const Body = id === 'involvement' && !served ? InvolvementUnavailable : BODY[id];
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
