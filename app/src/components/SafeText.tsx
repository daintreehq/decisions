import { Fragment } from 'react';
import { parseSafeText, type Inline } from '../lib/safe-text.js';

function InlineRun({ run }: { run: Inline }) {
  if (run.t === 'code') return <code>{run.text}</code>;
  if (run.t === 'bold') return <strong>{run.text}</strong>;
  return <>{run.text}</>;
}

/** Renders untrusted text. Output is React text nodes only; there is no path to markup or script. */
export function SafeText({ text, className }: { text: string; className?: string }) {
  const blocks = parseSafeText(text);
  return (
    <div className={className ? `safe-text ${className}` : 'safe-text'}>
      {blocks.map((b, i) =>
        b.type === 'code' ? (
          <pre key={i}>
            <code>{b.text}</code>
          </pre>
        ) : (
          <p key={i}>
            {b.lines.map((line, j) => (
              <Fragment key={j}>
                {j > 0 && <br />}
                {line.map((run, k) => (
                  <InlineRun key={k} run={run} />
                ))}
              </Fragment>
            ))}
          </p>
        ),
      )}
    </div>
  );
}
