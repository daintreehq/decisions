import { NavigatorPanel } from '../components/navigator/Navigator.js';
import { QuestionDetail } from './QuestionDetail.js';

/** Home: the Questions & answers list as a page, at every width (the sidebar holds only the most recent few). */
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
 * `/` and `/q/:id`. A question is always rendered alone: below 1100px the workspace owns the whole frame, and at
 * 1100px and up it fills the column beside the sidebar. The workspace host has a definite height on wide screens,
 * so the workspace fills it with `height: 100%`.
 */
export function InboxLayout({ selectedId }: { selectedId?: string }) {
  if (selectedId)
    return (
      <section className="workspace-host" aria-label="Question">
        <QuestionDetail id={selectedId} />
      </section>
    );
  return <QuestionsPage />;
}
