import { useEffect, useState } from 'react';
import { dictation, useDictation } from '../../features/voice/dictation.js';
import { clockLabel } from '../../lib/time.js';
import { StopIcon } from '../Icons.js';

/**
 * Stop while the viewer's chrome (and the dock with it) is hidden: recording is never stranded behind a tap (guide
 * 9.2, "Stop stays reachable everywhere"). It only ever stops; it never starts dictation or sends.
 */
export function ViewerStop() {
  const dict = useDictation();
  const p = dict.phase;
  const since = dict.startedAt;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (p !== 'recording' || since == null) return;
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [p, since]);
  if (p !== 'starting' && p !== 'recording' && p !== 'finishing') return null;
  const finishing = p === 'finishing';
  const label =
    p === 'starting' ? 'Cancel dictation' : finishing ? 'Finishing your words' : 'Stop dictation';
  return (
    <div className="fx-stop">
      <span className="fx-stop-text">
        <span className="rec-dot" aria-hidden="true" />
        {p === 'recording' ? (
          <span>
            Recording ·{' '}
            <span className="tabular">{clockLabel(since == null ? 0 : now - since)}</span>
          </span>
        ) : finishing ? (
          'Finishing…'
        ) : (
          'Starting microphone…'
        )}
      </span>
      <button
        type="button"
        className="btn icon fx-stop-btn"
        aria-label={label}
        title={label}
        aria-disabled={finishing || undefined}
        onClick={() => {
          if (!finishing) void dictation.stop();
        }}
      >
        <StopIcon size={18} />
      </button>
    </div>
  );
}
