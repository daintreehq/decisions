import { memo, type MouseEvent, type ReactNode } from 'react';
import type { QuestionView } from '../../domain/model.js';
import {
  STATUS_LABEL,
  answerSummary,
  dueLabel,
  principalStatus,
  type RowStatus,
} from '../../domain/lists.js';
import { hiddenQuestionText, proxyNeedsReview } from '../../domain/selectors.js';
import { previewText } from '../../lib/safe-text.js';
import { ageLabel } from '../../lib/time.js';
import { Origin } from '../Icons.js';
import { StatusGlyph } from './StatusGlyph.js';

export interface RowExtras {
  draft: boolean;
  pending: 'queued' | 'sending' | undefined;
}

/** Compact relative time for a row's corner: "4 min", "3 h", "2 d". */
function since(iso: string, now: number): string {
  const s = ageLabel(iso, now);
  return s === 'just now' ? 'now' : s.replace(/ ago$/, '');
}

/**
 * One question in the navigator. The whole row opens it. It carries project · computer, the question (2–3 lines),
 * the answer in force ("You: …" / "Model: …"), one principal status (glyph; the word too when statuses mix), and
 * only extras someone can act on: a draft, a queued answer, a model answer to review, a delivery issue, a due time.
 */
export const QuestionRow = memo(function QuestionRow({
  v,
  now,
  selected,
  showStatusWord,
  extras,
  onOpen,
}: {
  v: QuestionView;
  now: number;
  selected: boolean;
  showStatusWord: boolean;
  extras: RowExtras;
  onOpen: (e: MouseEvent<HTMLAnchorElement>, id: string) => void;
}) {
  const status: RowStatus = principalStatus(v, now);
  const answer = answerSummary(v);
  const due = dueLabel(v, now);
  const files = v.content?.attachments.length ?? 0;
  const review = status !== 'review' && proxyNeedsReview(v, now);
  const meta: { key: string; node: ReactNode; tone?: 'warn' }[] = [];
  if (showStatusWord) meta.push({ key: 'status', node: STATUS_LABEL[status] });
  if (due) meta.push({ key: 'due', node: due.label, tone: due.urgent ? 'warn' : undefined });
  if (extras.pending)
    meta.push({ key: 'pending', node: extras.pending === 'queued' ? 'Queued' : 'Sending…' });
  if (extras.draft && !extras.pending) meta.push({ key: 'draft', node: 'Draft' });
  if (review) meta.push({ key: 'review', node: 'Review' });
  if (files > 0)
    meta.push({
      key: 'files',
      node: (
        <>
          {files} {files === 1 ? 'file' : 'files'}
        </>
      ),
    });

  return (
    <li className="qrow-item">
      <a
        href={`/q/${v.id}`}
        className="qrow"
        data-row-id={v.id}
        data-status={status}
        aria-current={selected ? 'page' : undefined}
        onClick={(e) => onOpen(e, v.id)}
      >
        <span className="qrow-glyph">
          <StatusGlyph status={status} />
        </span>
        <span className="qrow-top">
          <Origin v={v} />
          <time className="qrow-time" dateTime={v.lastEventAt}>
            {since(status === 'needs' ? v.createdAt : v.lastEventAt, now)}
          </time>
        </span>
        <span className="qrow-q">
          {v.content ? previewText(v.content.question, 220) : hiddenQuestionText(v)}
        </span>
        {answer && (answer.text || status !== 'needs') && (
          <span className="qrow-a">
            <span className="who">{answer.author}:</span> {answer.text || 'No note'}
          </span>
        )}
        {(meta.length > 0 || status === 'delivery') && (
          <span className="qrow-meta">
            {status === 'delivery' && !showStatusWord && (
              <span className="m warn">Delivery issue</span>
            )}
            {meta.map((m) => (
              <span key={m.key} className={m.tone ? `m ${m.tone}` : 'm'}>
                {m.node}
              </span>
            ))}
          </span>
        )}
      </a>
    </li>
  );
});
