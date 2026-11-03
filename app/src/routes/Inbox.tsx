import { useMemo } from 'react';
import { useApp, useNow, useQuestions } from '../app/hooks.js';
import { openQuestion } from '../app/listState.js';
import { useWide } from '../app/media.js';
import { NavigatorPanel, isMac } from '../components/navigator/Navigator.js';
import { needsYou, sortNeedsYou } from '../domain/selectors.js';
import { ageLabel } from '../lib/time.js';
import { NavGlyph } from '../components/NavGlyphs.js';
import { QuestionDetail } from './QuestionDetail.js';

/** Questions on phones and tablets: the navigator as a full page under the tab bar (or the top navigation). */
function QuestionsPage() {
  return (
    <div className="page questions-page">
      <NavigatorPanel
        presentation="page"
        title={
          <h1 className="page-title" id="questions-h">
            Questions
          </h1>
        }
      />
    </div>
  );
}

/**
 * Questions at 1100px and up: the rail already holds the list, so the right column stays calm. It says what is
 * waiting and offers the first question that needs you, without opening anything on its own.
 */
function ChooseQuestion() {
  const snap = useApp();
  const all = useQuestions();
  const now = useNow();
  const waiting = useMemo(
    () =>
      sortNeedsYou(
        all.filter((v) => needsYou(v, now)),
        false,
        now,
      ),
    [all, now],
  );
  const first = waiting[0];
  const checking = snap.syncing && !snap.lastSyncedAt;
  return (
    <div className="choose" aria-labelledby="choose-h">
      <div className="choose-icon">
        <NavGlyph name="questions" size={22} />
      </div>
      <h1 id="choose-h">Choose a question</h1>
      {checking ? (
        <p>Checking for questions…</p>
      ) : first ? (
        <>
          <p>
            {waiting.length === 1
              ? 'One question needs you'
              : `${waiting.length} questions need you`}
            {`. The first has waited ${ageLabel(first.createdAt, now).replace(/ ago$/, '')}.`}
          </p>
          <button
            type="button"
            className="btn primary"
            onClick={() => openQuestion(first.id, 'questions', null, { refocus: false })}
          >
            Open the first question
          </button>
        </>
      ) : (
        <p>Nothing needs you right now. Pick any question from the list to read it.</p>
      )}
      <p className="choose-hint">
        <kbd>{isMac() ? '⌘' : 'Ctrl'}</kbd>
        <kbd>K</kbd> searches questions
      </p>
    </div>
  );
}

/**
 * `/` and `/q/:id`. A question is always rendered alone: below 1100px the workspace owns the whole frame, and at
 * 1100px and up the rail (in the shell) is the list beside it. The workspace host has a definite height on wide
 * screens, so the workspace fills it with `height: 100%`.
 */
export function InboxLayout({ selectedId }: { selectedId?: string }) {
  const wide = useWide();
  if (selectedId)
    return (
      <section className="workspace-host" aria-label="Question">
        <QuestionDetail id={selectedId} />
      </section>
    );
  return wide ? <ChooseQuestion /> : <QuestionsPage />;
}
