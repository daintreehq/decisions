import { useMemo, useState } from 'react';
import { useApp, useNow, useQuestions } from '../app/hooks.js';
import { Link } from '../app/router.js';
import {
  badgeClass,
  currentAnswer,
  effectiveStatus,
  hiddenQuestionText,
  originLabel,
  proxyNeedsReview,
  statusLabel,
} from '../domain/selectors.js';
import { previewText } from '../lib/safe-text.js';
import { shortDateLabel } from '../lib/time.js';
import { Origin } from '../components/Icons.js';

export function HistoryPage() {
  const snap = useApp();
  const all = useQuestions();
  const now = useNow();
  const [q, setQ] = useState('');
  const done = useMemo(
    () =>
      all.filter((v) => effectiveStatus(v, now) !== 'open').sort((a, b) => b.lastSeq - a.lastSeq),
    [all, now],
  );
  const hits = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return done;
    return done.filter((v) => {
      const a = currentAnswer(v);
      const chosen = (a?.content?.selected_option_ids ?? []).map(
        (id) => v.content?.options.find((o) => o.id === id)?.label ?? '',
      );
      const hay = [
        v.content?.question,
        v.content?.context,
        a?.content?.text,
        originLabel(v),
        ...chosen,
      ]
        .join(' ')
        .toLowerCase();
      return hay.includes(needle);
    });
  }, [done, q]);
  const incomplete = snap.syncing || snap.connection !== 'live';

  return (
    <div className="page">
      <h1>History</h1>
      <label className="field">
        <span className="sr-only">Search history</span>
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search your decisions"
          aria-describedby="history-privacy"
        />
      </label>
      <p className="note" id="history-privacy">
        Search runs on this phone. Your relay never sees what you search for.
      </p>
      <p className="sr-only" role="status">
        {q.trim() ? `${hits.length} ${hits.length === 1 ? 'match' : 'matches'}` : ''}
      </p>
      {incomplete && (
        <p className="note warn" role="status">
          Not fully synced yet, so results may be incomplete.
        </p>
      )}
      {hits.length === 0 ? (
        <div className="empty">
          <h2>{q ? 'No matches' : 'No history yet'}</h2>
          {q ? (
            <button type="button" className="btn" onClick={() => setQ('')}>
              Clear search
            </button>
          ) : (
            <p>
              Questions you have answered, and ones that expired or were withdrawn, appear here.
            </p>
          )}
        </div>
      ) : (
        <ul className="list">
          {hits.map((v) => {
            const s = effectiveStatus(v, now);
            const a = currentAnswer(v);
            return (
              <li key={v.id}>
                <Link to={`/q/${v.id}`} className="row-card">
                  <span className="row-top">
                    <Origin v={v} />
                    <span className="when">{shortDateLabel(v.lastEventAt, now)}</span>
                  </span>
                  <span className="row-text">
                    {v.content ? previewText(v.content.question, 140) : hiddenQuestionText(v)}
                  </span>
                  <span className="row-badges">
                    <span className={`badge ${badgeClass(s, v)}`}>{statusLabel(s, v)}</span>
                    {proxyNeedsReview(v, now) && <span className="badge warn">To review</span>}
                    {a && v.actions.filter((x) => x.action === 'override').length > 0 && (
                      <span className="badge">Corrected</span>
                    )}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
