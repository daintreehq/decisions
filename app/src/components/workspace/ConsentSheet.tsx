import { Sheet } from './Sheet.js';

/**
 * The first press on the mic (or a hold on the empty field): say plainly where audio goes before the microphone is asked for. Consent is recorded only
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
