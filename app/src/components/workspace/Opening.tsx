import { useEffect, useRef, useState } from 'react';
import { app } from '../../app/controller.js';
import { useApp } from '../../app/hooks.js';
import { cameFromApp } from '../../app/listState.js';
import { navigate } from '../../app/router.js';
import { ArrowRight, RefreshIcon } from '../Icons.js';
import { AnswerDock } from './AnswerDock.js';
import { WorkspaceHeader } from './WorkspaceHeader.js';

/** How long a fetch runs before the screen says it is still loading and offers Retry (guide 2.6). */
const SLOW_MS = 5_000;

/** The way out of a question that will not open here: Home, where every question this device holds is listed. */
function HomeLink() {
  return (
    <button type="button" className="btn small" onClick={() => navigate('/')}>
      Go to Home
      <ArrowRight size={16} />
    </button>
  );
}

/**
 * A question this device does not hold (yet): the workspace frame stays put (header, body, the dock reserved), and
 * the body says honestly what is happening. Nothing for 400 ms, then a skeleton of the part of the thread every
 * question has (the sender line and the question's first lines), then "Still loading" with Retry after 5 s. Each
 * Retry starts the 5 s again, and the row stays put (with the button saying it is trying) so focus is never lost.
 */
export function WorkspaceOpening() {
  const snap = useApp();
  const [attempt, setAttempt] = useState(0);
  const [slow, setSlow] = useState(false);
  const [retrying, setRetrying] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => {
      setSlow(true);
      setRetrying(false);
    }, SLOW_MS);
    return () => clearTimeout(t);
  }, [attempt]);
  const offline = !snap.online;
  const synced = snap.lastSyncedAt !== null && !snap.syncing;
  const outcome = offline ? 'offline' : synced ? 'gone' : null;
  // When loading ends here, say so (the busy region announces nothing) and, if the person was on Retry, move focus
  // to the outcome's heading rather than letting it fall to the page.
  const titleRef = useRef<HTMLHeadingElement>(null);
  const focusWasHere = useRef(false);
  useEffect(() => {
    if (outcome && focusWasHere.current) titleRef.current?.focus();
  }, [outcome]);
  let body;
  let loading = false;
  // Offline is checked first: without a connection this device cannot know the question is gone, only that it
  // doesn't hold it.
  if (outcome === 'offline') {
    body = (
      <div className="ws-state">
        <h1 className="ws-state-title" ref={titleRef} tabIndex={-1}>
          This question is not saved on this device
        </h1>
        <p>It will open when you are back online.</p>
        <HomeLink />
      </div>
    );
  } else if (outcome === 'gone') {
    body = (
      <div className="ws-state">
        <h1 className="ws-state-title" ref={titleRef} tabIndex={-1}>
          This question is no longer available
        </h1>
        <p>
          It may have been removed from your relay, or it was asked on a computer this device isn’t
          paired with.
        </p>
        <HomeLink />
      </div>
    );
  } else {
    loading = true;
    body = (
      <>
        {/* The shape every question shares, at the thread's own line heights, so nothing moves when it lands. */}
        <div className="ws-loading" aria-busy="true">
          <h1 className="sr-only">Loading this question</h1>
          <div className="sk-from">
            <span className="sk sk-name" />
          </div>
          <div className="sk-question">
            <span className="sk sk-q1" />
            <span className="sk sk-q2" />
          </div>
        </div>
        {/* Outside the busy region, so it is announced when it appears. */}
        {slow && (
          <div
            className="ws-state ws-slow"
            onFocus={() => (focusWasHere.current = true)}
            // Only a move to somewhere else clears it; the row being replaced by the outcome must not.
            onBlur={(e) => {
              if (e.relatedTarget) focusWasHere.current = false;
            }}
          >
            <p>Still loading this question…</p>
            <button
              type="button"
              className="btn small"
              aria-disabled={retrying || undefined}
              onClick={() => {
                if (retrying) return;
                setRetrying(true);
                setAttempt((a) => a + 1);
                app.sync?.kick();
              }}
            >
              <RefreshIcon size={16} />
              {retrying ? 'Trying again…' : 'Retry'}
            </button>
          </div>
        )}
      </>
    );
  }
  return (
    <div className="ws" data-state="opening">
      <WorkspaceHeader project="" machine="" back={cameFromApp()} />
      <div className="ws-body">
        <div className="ws-column">{body}</div>
      </div>
      {/* Always mounted, so each change is announced: still loading after 5 s, then how loading ended. */}
      <p className="sr-only" role="status">
        {outcome === 'offline'
          ? 'This question is not saved on this device.'
          : outcome === 'gone'
            ? 'This question is no longer available.'
            : slow
              ? 'Still loading this question.'
              : ''}
      </p>
      <div id="workspace-overlay" className="ws-overlay" />
      {/* While it loads, the composer's place is held so nothing moves when the question arrives. A question that
          won't open here has nothing to answer, so the dock stays empty rather than showing a field that never wakes. */}
      <AnswerDock>
        {loading && (
          <div className="composer" aria-hidden="true">
            <div className="composer-pill placeholder" />
          </div>
        )}
      </AnswerDock>
    </div>
  );
}
