import { useRef, useState } from 'react';
import { useLayer } from '../../app/layers.js';
import type { ImageResult } from '../../data/images.js';
import { DownloadIcon, ExternalIcon, GridIcon, MoreIcon } from '../Icons.js';
import {
  downloadBlobUrl,
  handoffBusy,
  handoffExplained,
  markHandoffExplained,
  openInNewTab,
  settleHandoff,
} from './handoff.js';
import { Menu, Sheet, type MenuItem } from './Layer.js';
import { downloadName, type FileItem } from './sequence.js';

type Action = 'open' | 'download';
type Ask = { action: Action; reason: 'explain' | 'settled' | 'blocked' };

/** The viewer's file menu: All files, Open (new tab) and Download, with the one-time handoff explanation. */
export function FileMenu({
  item,
  result,
  total,
  onAllFiles,
}: {
  item: FileItem;
  result: ImageResult | undefined;
  total: number;
  /** The question's files have an All files grid; the person's own photos don't need one. */
  onAllFiles?: () => void;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState(false);
  const [ask, setAsk] = useState<Ask | null>(null);
  // Closing by state unwinds each layer's history entry silently, so a menu item can open a sheet in one step.
  useLayer(menu, () => setMenu(false));
  useLayer(!!ask, () => setAsk(null));

  const url = result?.ok ? result.image.url : null;
  const name = downloadName(item.index, item.d.mime);

  const doOpen = () => {
    if (!url) return;
    markHandoffExplained();
    if (openInNewTab(url)) setAsk(null);
    else setAsk({ action: 'open', reason: 'blocked' });
  };
  const doDownload = () => {
    if (!url) return;
    markHandoffExplained();
    downloadBlobUrl(url, name);
    setAsk(null);
  };
  const run = (action: Action) => (action === 'open' ? doOpen() : doDownload());

  const choose = (action: Action) => {
    setMenu(false);
    if (action === 'open' && handoffBusy()) {
      // Stop and save dictation first; the stop is async, so opening needs a fresh tap.
      void settleHandoff().then(() => setAsk({ action, reason: 'settled' }));
      return;
    }
    if (!handoffExplained()) setAsk({ action, reason: 'explain' });
    else run(action);
  };

  const items: MenuItem[] = [];
  if (total > 1 && onAllFiles)
    items.push({
      key: 'all',
      label: 'All files',
      icon: <GridIcon size={18} />,
      onSelect: () => {
        setMenu(false);
        onAllFiles?.();
      },
    });
  items.push(
    {
      key: 'open',
      label: 'Open in new tab',
      icon: <ExternalIcon size={18} />,
      disabled: !url,
      onSelect: () => choose('open'),
    },
    {
      key: 'download',
      label: `Download`,
      icon: <DownloadIcon size={18} />,
      disabled: !url,
      onSelect: () => choose('download'),
    },
  );
  const note = url
    ? undefined
    : result && !result.ok && result.reason === 'unverified'
      ? 'This file failed verification, so it cannot leave Decisions.'
      : 'Open and Download are available once this file is verified.';

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="btn ghost icon"
        aria-label="File menu"
        aria-haspopup="menu"
        aria-expanded={menu}
        onClick={() => setMenu((m) => !m)}
      >
        <MoreIcon />
      </button>
      {menu && (
        <Menu
          label={`${item.label} file`}
          items={items}
          anchor={trigger.current}
          onDismiss={() => setMenu(false)}
          note={note}
        />
      )}
      {ask && (
        <Sheet
          title={
            ask.reason === 'blocked'
              ? 'The browser blocked the new tab'
              : ask.reason === 'settled'
                ? 'Dictation stopped'
                : ask.action === 'open'
                  ? 'Open outside Decisions?'
                  : 'Download this file?'
          }
          onDismiss={() => setAsk(null)}
          footer={
            <>
              {ask.reason === 'blocked' ? (
                <>
                  <button type="button" className="btn" onClick={doDownload}>
                    <DownloadIcon size={18} />
                    Download instead
                  </button>
                  <button type="button" className="btn primary" onClick={doOpen}>
                    Try again
                  </button>
                </>
              ) : (
                <>
                  <button type="button" className="btn" onClick={() => setAsk(null)}>
                    Cancel
                  </button>
                  <button type="button" className="btn primary" onClick={() => run(ask.action)}>
                    {ask.action === 'open'
                      ? ask.reason === 'settled'
                        ? 'Open file now'
                        : 'Open file'
                      : 'Download'}
                  </button>
                </>
              )}
            </>
          }
        >
          {ask.reason === 'blocked' ? (
            <p>Allow pop-ups for Decisions and try again, or download the file instead.</p>
          ) : ask.reason === 'settled' ? (
            <p>
              Your words are saved in your answer. Opening this file makes a readable copy available
              outside Decisions.
            </p>
          ) : (
            <>
              <p>
                {ask.action === 'open'
                  ? 'Opening this file makes a readable copy available outside Decisions.'
                  : `Downloading saves a readable copy outside Decisions, named ${name}.`}
              </p>
              <p className="fx-sheet-hint">You’ll only be asked this once.</p>
            </>
          )}
        </Sheet>
      )}
    </>
  );
}
