import type { QuestionView } from '../../domain/model.js';
import { OptionCards } from './DecisionArea.js';
import { Sheet } from './Sheet.js';

/**
 * Every option with its full description, for questions whose options are long or many. Choosing closes the sheet and
 * returns a summary to the dock. Nothing here sends.
 */
export function ChoiceSheet({
  open,
  view,
  selected,
  currentIds,
  onSelect,
  onClose,
}: {
  open: boolean;
  view: QuestionView;
  selected: readonly string[];
  currentIds?: readonly string[];
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  return (
    <Sheet open={open} title="Choose an option" onClose={onClose} className="choice-sheet">
      <OptionCards
        view={view}
        selected={selected}
        currentIds={currentIds}
        legend="Options"
        onSelect={(id) => {
          onSelect(id);
          onClose();
        }}
      />
    </Sheet>
  );
}

/**
 * The first tap on Dictate: say plainly where audio goes before the microphone is asked for. Consent is recorded only
 * by "Enable and start dictation".
 */
export function ConsentSheet({
  open,
  provider,
  cleanup,
  onAccept,
  onDecline,
}: {
  open: boolean;
  provider: string;
  cleanup: string | null;
  onAccept: () => void;
  onDecline: () => void;
}) {
  return (
    <Sheet
      open={open}
      title="Dictation isn’t end-to-end encrypted"
      onClose={onDecline}
      className="consent-sheet"
      footer={
        <>
          <button type="button" className="btn" onClick={onDecline}>
            Keep typing
          </button>
          <button type="button" className="btn primary" onClick={onAccept}>
            Enable and start dictation
          </button>
        </>
      }
    >
      <p>
        Your audio goes through your relay to <strong>{provider}</strong> for transcription
        {cleanup ? (
          <>
            , and the words go to <strong>{cleanup}</strong> to tidy the wording
          </>
        ) : null}
        . Answers you type stay end-to-end encrypted.
      </p>
      <p className="muted">
        No audio is saved on this device or your relay. You review the text before anything is sent,
        and you can turn dictation off in Settings.
      </p>
    </Sheet>
  );
}
