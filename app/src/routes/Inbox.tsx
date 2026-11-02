import { useEffect, useMemo, useState } from 'react';
import { app } from '../app/controller.js';
import { useApp, useNow, useQuestions } from '../app/hooks.js';
import { Link } from '../app/router.js';
import type { QuestionView } from '../domain/model.js';
import {
  badgeClass,
  deliveryNeedsAttention,
  effectiveStatus,
  hiddenQuestionText,
  needsAction,
  originLabel,
  proxyNeedsReview,
  sortNeedsYou,
  statusLabel,
} from '../domain/selectors.js';
import { ageLabel, untilLabel } from '../lib/time.js';
import { previewText } from '../lib/safe-text.js';
import { currentSubscription, isIos, isStandalone, pushSupport } from '../features/push.js';
import { CheckIcon, ClockIcon, Origin, PersonIcon } from '../components/Icons.js';
import { QuestionDetail } from './QuestionDetail.js';

type Filter = 'needs' | 'proxy' | 'all';

const DAY = 24 * 3_600_000;

function Row({
  v,
  now,
  selected,
  showOpen,
}: {
  v: QuestionView;
  now: number;
  selected: boolean;
  showOpen: boolean;
}) {
  const status = effectiveStatus(v, now);
  const pending = app.outbox?.pendingState(v.id);
  const urgent = status === 'open' && !!v.expiresAt && Date.parse(v.expiresAt) - now < DAY;
  return (
    <li>
      <Link
        to={`/q/${v.id}`}
        className={`row-card ${selected ? 'selected' : ''}`}
        aria-current={selected ? 'page' : undefined}
      >
        <span className="row-top">
          <Origin v={v} />
          {urgent ? (
            <span className="when urgent">
              <ClockIcon />
              {untilLabel(v.expiresAt!, now)}
            </span>
          ) : (
            <span className="when">{ageLabel(v.createdAt, now)}</span>
          )}
        </span>
        <span className="row-text">
          {v.content ? previewText(v.content.question, 160) : hiddenQuestionText(v)}
        </span>
        <span className="row-badges">
          {status === 'open' && showOpen && <span className="badge open">Needs you</span>}
          {status === 'open' && v.requirement === 'human-required' && (
            <span className="badge req">
              <PersonIcon />
              Needs a person
            </span>
          )}
          {status === 'proxy-answered' && (
            <span className="badge proxy">{statusLabel(status)}</span>
          )}
          {status === 'proxy-answered' && proxyNeedsReview(v, now) && (
            <span className="badge warn">To review</span>
          )}
          {(status === 'human-answered' ||
            status === 'expired' ||
            status === 'cancelled' ||
            status === 'unverified') && (
            <span className={`badge ${badgeClass(status, v)}`}>{statusLabel(status, v)}</span>
          )}
          {deliveryNeedsAttention(v) && (
            <span className="badge warn">Delivery needs attention</span>
          )}
          {pending && (
            <span className="badge pending">
              {pending === 'queued' ? 'Queued, not sent' : 'Sending…'}
            </span>
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

/** Whether a new question would actually reach this phone as a notification right now. */
function useNotificationsReady(): boolean | null {
  const [ready, setReady] = useState<boolean | null>(null);
  useEffect(() => {
    if (!pushSupport().ok) {
      setReady(false);
      return;
    }
    void currentSubscription()
      .then((s) => setReady(!!s && Notification.permission === 'granted'))
      .catch(() => setReady(false));
  }, []);
  return ready;
}

function QueueClear() {
  const ready = useNotificationsReady();
  const needsInstall = isIos() && !isStandalone();
  return (
    <div className="empty">
      <div className="empty-icon">
        <CheckIcon />
      </div>
      <h2>Nothing is waiting on you</h2>
      {ready === false ? (
        <>
          <p>New questions from your agents will appear here.</p>
          <p>
            {needsInstall
              ? 'To be notified when one arrives, add Decisions to your Home Screen first.'
              : 'Turn on notifications to hear about them when they arrive.'}
          </p>
          <Link to={needsInstall ? '/install' : '/settings'} className="btn">
            {needsInstall ? 'Add to Home Screen' : 'Turn on notifications'}
          </Link>
        </>
      ) : (
        <p>When an agent needs a decision it will appear here, and you will get a notification.</p>
      )}
    </div>
  );
}

export function QuestionList({ selectedId }: { selectedId?: string }) {
  const snap = useApp();
  const all = useQuestions();
  const now = useNow();
  const [filter, setFilter] = useState<Filter>('needs');
  const [origin, setOrigin] = useState('');
  const [newest, setNewest] = useState(false);

  const origins = useMemo(() => [...new Set(all.map(originLabel))].sort(), [all]);
  // Counts follow the project filter, so a count never promises rows the list will not show.
  const base = useMemo(
    () => all.filter((v) => !origin || originLabel(v) === origin),
    [all, origin],
  );
  const counts = useMemo(
    () => ({
      needs: base.filter((v) => needsAction(v, now)).length,
      proxy: base.filter((v) => proxyNeedsReview(v, now)).length,
    }),
    [base, now],
  );
  const shown = useMemo(() => {
    if (filter === 'needs')
      return sortNeedsYou(
        base.filter((v) => needsAction(v, now)),
        newest,
        now,
      );
    if (filter === 'proxy')
      return base.filter((v) => proxyNeedsReview(v, now)).sort((a, b) => b.lastSeq - a.lastSeq);
    return [...base].sort((a, b) => b.lastSeq - a.lastSeq);
  }, [base, filter, newest, now]);

  const loading =
    snap.phase === 'loading' || (snap.syncing && all.length === 0 && !snap.lastSyncedAt);
  const offline = !snap.online || snap.connection === 'offline';

  const FILTERS: [Filter, string, number, string][] = [
    ['needs', 'Needs you', counts.needs, ' waiting'],
    ['proxy', 'Model answers', counts.proxy, ' to review'],
    ['all', 'All', 0, ''],
  ];

  return (
    <section className="pane-list" aria-labelledby="inbox-h">
      <h1 id="inbox-h" className="sr-only">
        Inbox
      </h1>
      <div className="seg" role="group" aria-label="Show">
        {FILTERS.map(([id, label, n, unit]) => (
          <button key={id} type="button" aria-pressed={filter === id} onClick={() => setFilter(id)}>
            {label}
            {n > 0 && (
              <span
                className={`count ${filter === id ? '' : 'quiet'} ${id === 'proxy' ? 'proxy' : ''}`}
              >
                <span className="sr-only">, </span>
                {n}
                <span className="sr-only">{unit}</span>
              </span>
            )}
          </button>
        ))}
      </div>
      {(origins.length > 1 || filter === 'needs') && (
        <div className="filters">
          {origins.length > 1 && (
            <label className="grow">
              <span className="sr-only">Project and machine</span>
              <select value={origin} onChange={(e) => setOrigin(e.target.value)}>
                <option value="">All projects</option>
                {origins.map((o) => (
                  <option key={o}>{o}</option>
                ))}
              </select>
            </label>
          )}
          {filter === 'needs' && shown.length > 1 && (
            <label className="sort">
              <span className="sr-only">Order</span>
              <select
                value={newest ? 'newest' : 'urgent'}
                onChange={(e) => setNewest(e.target.value === 'newest')}
              >
                <option value="urgent">Most urgent first</option>
                <option value="newest">Newest first</option>
              </select>
            </label>
          )}
        </div>
      )}
      {snap.lastError && snap.connection !== 'live' && snap.online && (
        <p className="note warn" role="status">
          Could not reach your relay just now. Showing what is saved on this phone.
        </p>
      )}
      {loading ? (
        <Skeleton />
      ) : shown.length === 0 ? (
        origin ? (
          <div className="empty">
            <h2>Nothing here for {origin}</h2>
            <p>Other projects may still have questions for you.</p>
            <button type="button" className="btn" onClick={() => setOrigin('')}>
              Show all projects
            </button>
          </div>
        ) : filter === 'needs' ? (
          offline ? (
            // Offline, the phone cannot know whether anything new arrived, so it never says "all clear".
            <div className="empty">
              <h2>Nothing waiting on this phone</h2>
              <p>You are offline, so new questions cannot arrive until you reconnect.</p>
            </div>
          ) : snap.connection === 'live' || snap.connection === 'polling' ? (
            <QueueClear />
          ) : (
            // Not connected yet: do not reassure until the relay has actually been checked.
            <div className="empty" aria-busy="true">
              <h2>Checking for questions…</h2>
              <p>Connecting to your relay.</p>
            </div>
          )
        ) : filter === 'proxy' ? (
          <div className="empty">
            <h2>No model answers to review</h2>
            <p>When the decision model answers for you, you can confirm or overrule it here.</p>
          </div>
        ) : (
          <div className="empty">
            <h2>No questions yet</h2>
            <p>Questions your agents ask will be listed here.</p>
          </div>
        )
      ) : (
        <ul className="list">
          {shown.map((v) => (
            <Row
              key={v.id}
              v={v}
              now={now}
              selected={v.id === selectedId}
              showOpen={filter !== 'needs'}
            />
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
