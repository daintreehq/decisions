import { Workspace } from '../components/workspace/Workspace.js';

/** `/q/:id`: the question workspace. Keyed by id so moving to another question starts a fresh workspace. */
export function QuestionDetail({ id }: { id: string }) {
  return <Workspace key={id} id={id} />;
}
