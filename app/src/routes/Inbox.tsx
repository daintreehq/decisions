import { useQuestions } from '../app/hooks.js';
import { useWide } from '../app/media.js';
import { NavigatorPanel, isMac } from '../components/navigator/Navigator.js';
import { NavGlyph } from '../components/NavGlyphs.js';
import { QuestionDetail } from './QuestionDetail.js';

/**
 * The calm pane beside the list on wide screens, while no question is chosen: what to do, and how to search. It
 * opens nothing on its own and counts nothing (the list beside it owns the counts, under its filters). With no
 * questions at all it stays empty: the list says so once.
 */
function ChooseQuestion() {
  const all = useQuestions();
  if (all.length === 0) return <div className="choose" aria-hidden="true" />;
  return (
    <div className="choose" aria-labelledby="choose-h">
      <div className="choose-icon">
        <NavGlyph name="questions" size={22} />
      </div>
      <h2 id="choose-h">Choose a question</h2>
      <p className="choose-hint">
        <kbd>{isMac() ? '⌘K' : 'Ctrl K'}</kbd> searches questions
      </p>
    </div>
  );
}

/**
 * `/` and `/q/:id`.
 * - Below 1100px one surface at a time: Home is the list, and a question is the workspace alone.
 * - 1100px and up the list stays in its own column beside the sidebar, and the pane beside it holds the chosen
 *   question, or a calm "Choose a question" until one is chosen. The list keeps its scroll and its selection as
 *   questions open beside it.
 */
export function InboxLayout({ selectedId }: { selectedId?: string }) {
  const wide = useWide();
  const question = selectedId ? (
    <section className="workspace-host" aria-label="Question">
      <QuestionDetail id={selectedId} />
    </section>
  ) : null;
  if (!wide)
    return (
      question ?? (
        <div className="page questions-page">
          <NavigatorPanel presentation="page" />
        </div>
      )
    );
  return (
    <div className="home" data-layout="split">
      <div className="home-list">
        <NavigatorPanel presentation="page" currentId={selectedId} />
      </div>
      <div className="home-pane">{question ?? <ChooseQuestion />}</div>
    </div>
  );
}
