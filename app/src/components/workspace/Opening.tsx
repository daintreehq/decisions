import { useEffect, useState } from 'react';
import { app } from '../../app/controller.js';
import { useApp, useNow, useQuestions } from '../../app/hooks.js';
import { openNavigator } from '../../app/navigator.js';
import { needsAction } from '../../domain/selectors.js';
import { RefreshIcon } from '../Icons.js';
import { AllQaButton, AnswerDock } from './AnswerDock.js';
import { WorkspaceHeader } from './WorkspaceHeader.js';

/**
 * A question this device does not hold (yet): the workspace frame stays put (header, body, the dock reserved), and
 * the body says honestly what is happening. Nothing for 400 ms, then a skeleton, then "Still loading" after 5 s.
 */
export function WorkspaceOpening() {
  const snap = useApp();
  const now = useNow();
  const all = useQuestions();
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setSlow(true), 5_000);
    return () => clearTimeout(t);
  }, []);
  const waiting = all.filter((v) => needsAction(v, now)).length;
  const offline = !snap.online;
  const synced = snap.lastSyncedAt !== null && !snap.syncing;
  let body;
  if (offline && !synced) {
    body = (
      <div className="ws-state">
        <h1 className="ws-state-title">This question is not saved on this device</h1>
        <p>It will open when you are back online.</p>
      </div>
    );
  } else if (synced || (offline && synced)) {
    body = (
      <div className="ws-state">
        <h1 className="ws-state-title">This question is no longer available</h1>
        <p>It may have been removed from your relay, or it belongs to another installation.</p>
      </div>
    );
  } else {
    body = (
      <div className="ws-loading" aria-busy="true">
        <h1 className="sr-only">Loading this question</h1>
        <div className="skeleton sk-line" />
        <div className="skeleton sk-line short" />
        <div className="skeleton sk-stage" />
        {slow && (
          <div className="ws-state" role="status">
            <p>Still loading this question…</p>
            <button
              type="button"
              className="btn small"
              onClick={() => {
                setSlow(false);
                app.sync?.kick();
              }}
            >
              <RefreshIcon size={16} />
              Retry
            </button>
          </div>
        )}
      </div>
    );
  }
  return (
    <div className="ws" data-state="opening">
      <WorkspaceHeader project="" machine="" />
      <div className="ws-body">
        <div className="ws-column">{body}</div>
      </div>
      <div id="workspace-overlay" className="ws-overlay" />
      <AnswerDock
        left={<AllQaButton waiting={waiting} recording={false} onClick={openNavigator} />}
      />
    </div>
  );
}
