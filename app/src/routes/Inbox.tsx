import { useMemo, useState } from 'react';
import { app } from '../app/controller.js';
import { useApp, useNow, useQuestions } from '../app/hooks.js';
import { Link } from '../app/router.js';
import type { QuestionView } from '../domain/model.js';
import {
  currentAnswer,
  effectiveStatus,
  needsYou,
  originLabel,
  proxyNeedsReview,
  sortNeedsYou,
} from '../domain/selectors.js';
import { ageLabel, untilLabel } from '../lib/time.js';
import { previewText } from '../lib/safe-text.js';
import { QuestionDetail } from './QuestionDetail.js';

type Tab = 'needs' | 'proxy' | 'all';

function Row({ v, now, selected }: { v: QuestionView; now: number; selected: boolean }) {
  const status = effectiveStatus(v, now);
  const pending = app.outbox?.pendingState(v.id);
  const a = currentAnswer(v);
  return (
    <li>
      <Link
        to={`/q/${v.id}`}
        className={`row-card ${selected ? 'selected' : ''}`}
        aria-current={selected ? 'page' : undefined}
      >
        <span className="row-top">
          <span className="origin">{originLabel(v)}</span>
          <span className="muted">{ageLabel(v.createdAt, now)}</span>
        </span>
        <span className="row-text">
          {v.content ? previewText(v.content.question, 160) : 'Could not verify this question'}
        </span>
        <span className="row-badges">
          {status === 'open' && v.requirement === 'human-required' && (
            <span className="badge strong">Needs a person</span>
          )}
          {status === 'proxy-answered' && <span className="badge proxy">Proxy answered</span>}
          {status === 'human-answered' && <span className="badge human">Answered</span>}
          {status === 'expired' && <span className="badge expired">Expired</span>}
          {status === 'cancelled' && <span className="badge">Withdrawn</span>}
          {status === 'unverified' && <span className="badge danger">Unverified</span>}
          {pending && (
            <span className="badge pending">
              {pending === 'queued' ? 'Queued, not sent' : 'Sending…'}
            </span>
          )}
          {status === 'open' && v.expiresAt && Date.parse(v.expiresAt) - now < 24 * 3_600_000 && (
            <span className="badge warn">{untilLabel(v.expiresAt, now)}</span>
          )}
          {a?.provenance === 'proxy' && proxyNeedsReview(v, now) && (
            <span className="badge warn">Review</span>
          )}
        </span>
      </Link>
    </li>
  );
}

function Skeleton() {
  return (
    <ul className="list" aria-busy="true" aria-label="Loading questions">
      {[0, 1, 2].map((i) => (
        <li key={i} className="row-card skeleton-row" />
      ))}
    </ul>
  );
}

export function QuestionList({ selectedId }: { selectedId?: string }) {
  const snap = useApp();
  const all = useQuestions();
  const now = useNow();
  const [tab, setTab] = useState<Tab>('needs');
  const [origin, setOrigin] = useState('');
  const [newest, setNewest] = useState(false);

  const origins = useMemo(() => [...new Set(all.map(originLabel))].sort(), [all]);
  const counts = useMemo(
    () => ({
      needs: all.filter((v) => needsYou(v, now)).length,
      proxy: all.filter((v) => proxyNeedsReview(v, now)).length,
    }),
    [all, now],
  );
  const shown = useMemo(() => {
    const base = all.filter((v) => !origin || originLabel(v) === origin);
    if (tab === 'needs')
      return sortNeedsYou(
        base.filter((v) => needsYou(v, now)),
        newest,
        now,
      );
    if (tab === 'proxy')
      return base
        .filter((v) => effectiveStatus(v, now) === 'proxy-answered')
        .sort((a, b) => b.lastSeq - a.lastSeq);
    return base.sort((a, b) => b.lastSeq - a.lastSeq);
  }, [all, tab, origin, newest, now]);

  const loading =
    snap.phase === 'loading' || (snap.syncing && all.length === 0 && !snap.lastSyncedAt);

  return (
    <section className="pane-list" aria-label="Questions">
      <div className="tabs" role="tablist" aria-label="Filter">
        {(
          [
            ['needs', 'Needs you', counts.needs],
            ['proxy', 'Proxy answered', counts.proxy],
            ['all', 'All', 0],
          ] as [Tab, string, number][]
        ).map(([id, label, n]) => (
          <button
            key={id}
            role="tab"
            type="button"
            aria-selected={tab === id}
            className={tab === id ? 'tab on' : 'tab'}
            onClick={() => setTab(id)}
          >
            {label}
            {n > 0 && <span className="count">{n}</span>}
          </button>
        ))}
      </div>
      <div className="filters">
        {origins.length > 1 && (
          <label>
            <span className="sr-only">Project or machine</span>
            <select value={origin} onChange={(e) => setOrigin(e.target.value)}>
              <option value="">All projects and machines</option>
              {origins.map((o) => (
                <option key={o}>{o}</option>
              ))}
            </select>
          </label>
        )}
        {tab === 'needs' && (
          <button type="button" className="link-btn" onClick={() => setNewest((n) => !n)}>
            {newest ? 'Newest first' : 'Most urgent first'}
          </button>
        )}
      </div>
      {snap.lastError && snap.connection !== 'live' && (
        <p className="note warn" role="status">
          Could not sync: {snap.lastError}
        </p>
      )}
      {loading ? (
        <Skeleton />
      ) : shown.length === 0 ? (
        <div className="empty">
          <h2>
            {tab === 'needs'
              ? 'Nothing is waiting on you'
              : tab === 'proxy'
                ? 'No proxy answers to review'
                : 'No questions yet'}
          </h2>
          <p>
            {tab === 'needs'
              ? 'When an agent needs a decision it will appear here and you will get a notification.'
              : snap.connection === 'live'
                ? 'You are all caught up.'
                : 'You are offline. Showing what is saved on this phone.'}
          </p>
        </div>
      ) : (
        <ul className="list">
          {shown.map((v) => (
            <Row key={v.id} v={v} now={now} selected={v.id === selectedId} />
          ))}
        </ul>
      )}
    </section>
  );
}

/** Narrow screens show list OR detail; wide screens show both side by side (CSS decides). */
export function InboxLayout({ selectedId }: { selectedId?: string }) {
  return (
    <div className={`inbox-layout ${selectedId ? 'has-selection' : ''}`}>
      <QuestionList selectedId={selectedId} />
      <section className="pane-detail" aria-label="Question">
        {selectedId ? (
          <QuestionDetail id={selectedId} />
        ) : (
          <div className="empty wide-only">
            <h2>Select a question</h2>
            <p>Pick one from the list to read it and answer.</p>
          </div>
        )}
      </section>
    </div>
  );
}
