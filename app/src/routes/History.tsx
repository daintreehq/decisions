import { useMemo, useState } from 'react';
import { useApp, useNow, useQuestions } from '../app/hooks.js';
import { Link } from '../app/router.js';
import { currentAnswer, effectiveStatus, originLabel } from '../domain/selectors.js';
import { previewText } from '../lib/safe-text.js';
import { absoluteLabel } from '../lib/time.js';

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
      const hay = [v.content?.question, v.content?.context, a?.content?.text, originLabel(v)]
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
        />
      </label>
      <p className="note">
        Search runs on this phone, on your decrypted history. Your relay never sees what you search
        for.
      </p>
      {incomplete && (
        <p className="note warn" role="status">
          Not fully synced yet, so results may be incomplete.
        </p>
      )}
      {hits.length === 0 ? (
        <div className="empty">
          <h2>{q ? 'No matches' : 'No history yet'}</h2>
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
                    <span className="origin">{originLabel(v)}</span>
                    <span className="muted">{absoluteLabel(v.lastEventAt)}</span>
                  </span>
                  <span className="row-text">
                    {v.content
                      ? previewText(v.content.question, 140)
                      : 'Could not verify this question'}
                  </span>
                  <span className="row-badges">
                    <span className={`badge ${s}`}>
                      {s === 'human-answered'
                        ? 'Answered by you'
                        : s === 'proxy-answered'
                          ? 'Answered by decision model'
                          : s}
                    </span>
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
