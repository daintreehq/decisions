import { useState, type ReactNode } from 'react';
import { app } from '../../app/controller.js';
import { useApp } from '../../app/hooks.js';
import { Link } from '../../app/router.js';
import { isApplePlatform } from './model.js';
import { Callout, Row, SettingsGroup, Sheet } from './ui.js';

function Keys({ keys }: { keys: string[] }) {
  return (
    <span className="s-keys">
      {keys.map((k, i) => (
        <kbd key={i}>{k}</kbd>
      ))}
    </span>
  );
}

export function shortcutList(apple: boolean): { group: string; rows: [string[], ReactNode][] }[] {
  const mod = apple ? '⌘' : 'Ctrl';
  return [
    {
      group: 'Answering',
      rows: [
        [[mod, 'Enter'], 'Send, when Send is available'],
        [[mod, 'Shift', 'Space'], 'Start or stop dictation'],
        [[mod, 'K'], 'Open Questions & answers and search'],
        [['Esc'], 'Close the top sheet, menu or viewer'],
      ],
    },
    {
      group: 'Viewing files',
      rows: [
        [['←', '→'], 'Previous or next file (pans when zoomed)'],
        [['+', '−'], 'Zoom in or out'],
        [['0'], 'Fit the file to the screen'],
      ],
    },
  ];
}

export function ShortcutsSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const groups = shortcutList(isApplePlatform());
  return (
    <Sheet open={open} onClose={onClose} title="Keyboard shortcuts">
      <p className="s-row-desc">
        Shortcuts always use a modifier key, so typing never triggers one by accident.
      </p>
      {groups.map((g) => (
        <section key={g.group} className="s-keys-group">
          <h3 className="s-sheet-sub">{g.group}</h3>
          <dl className="s-keys-list">
            {g.rows.map(([keys, what], i) => (
              <div key={i}>
                <dt>
                  <Keys keys={keys} />
                </dt>
                <dd>{what}</dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </Sheet>
  );
}

/** "Version 0.4.0", or "Update available" when one is waiting. */
export function aboutSummary(updateAvailable: boolean): string {
  return updateAvailable ? 'Update available' : `Version ${__APP_VERSION__}`;
}

export function AboutSection() {
  const { updateAvailable, info } = useApp();
  const [keys, setKeys] = useState(false);
  const [update, setUpdate] = useState<'idle' | 'restarting' | 'refused'>('idle');
  const [check, setCheck] = useState<'idle' | 'checking' | 'none' | 'failed'>('idle');

  const restart = () => {
    setUpdate('restarting');
    void app.applyUpdate().then((ok) => {
      if (!ok) setUpdate('refused');
    });
  };
  const lookForUpdate = () => {
    setCheck('checking');
    app
      .checkForUpdate()
      // An update found here installs in the background and then shows as available.
      .then(() => setCheck('none'))
      .catch(() => setCheck('failed'));
  };

  return (
    <>
      <SettingsGroup>
        <Row
          label="Decisions"
          description={info ? `Relay ${info.worker_version}` : undefined}
          control={<span className="s-value mono">{__APP_VERSION__}</span>}
        />
        {updateAvailable ? (
          <div className="s-row stacked">
            <div className="s-row-text">
              <span className="s-row-label">Update available</span>
              <span className="s-row-desc">
                Restarting first stops any dictation and saves your drafts. Unsent answers stay
                queued and send afterwards. You come back to this screen.
              </span>
            </div>
            {update === 'refused' && (
              <Callout tone="warn" role="alert" title="The update waited">
                A dictation couldn’t be stopped safely, so nothing restarted. Stop dictating, then
                retry.
              </Callout>
            )}
            <div className="s-actions">
              <button
                type="button"
                className="btn small primary"
                disabled={update === 'restarting'}
                onClick={restart}
              >
                {update === 'restarting'
                  ? 'Restarting…'
                  : update === 'refused'
                    ? 'Retry'
                    : 'Restart to update'}
              </button>
            </div>
          </div>
        ) : (
          <Row
            label="Updates"
            description={
              check === 'checking'
                ? 'Checking your relay…'
                : check === 'none'
                  ? 'No newer version yet. One that arrives later shows here.'
                  : check === 'failed'
                    ? 'Couldn’t check. Try again when you’re online.'
                    : 'Your relay serves new versions; they install in the background'
            }
            control={
              <button
                type="button"
                className="btn small"
                disabled={check === 'checking'}
                onClick={lookForUpdate}
              >
                Check now
              </button>
            }
          />
        )}
      </SettingsGroup>

      <SettingsGroup label="Help">
        <ul className="nav-list s-nav-rows">
          <li>
            <Link to="/install">
              <span className="s-nav-text">
                <span>Install Decisions</span>
                <span className="s-row-desc">On a phone, tablet or computer</span>
              </span>
            </Link>
          </li>
          <li>
            <button type="button" aria-haspopup="dialog" onClick={() => setKeys(true)}>
              <span className="s-nav-text">
                <span>Keyboard shortcuts</span>
                <span className="s-row-desc">For a computer or a tablet with a keyboard</span>
              </span>
            </button>
          </li>
          <li>
            <Link to="/privacy">
              <span className="s-nav-text">
                <span>Who sees what</span>
                <span className="s-row-desc">What your relay and providers can see</span>
              </span>
            </Link>
          </li>
        </ul>
      </SettingsGroup>
      <ShortcutsSheet open={keys} onClose={() => setKeys(false)} />
    </>
  );
}
