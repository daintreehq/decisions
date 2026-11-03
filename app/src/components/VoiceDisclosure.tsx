import { Dialog } from './Dialog.js';

/** The full, plain statement of where dictated audio and text go. Shown before voice can be switched on. */
export function VoiceDisclosure({
  open,
  provider,
  correction,
  onAccept,
  onClose,
}: {
  open: boolean;
  provider: string;
  /** Who tidies up the transcript, or null when clean-up is off. */
  correction: string | null;
  onAccept?: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog
      open={open}
      title="Dictation is not end-to-end encrypted"
      onClose={onClose}
      actions={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {onAccept ? 'Not now' : 'Close'}
          </button>
          {onAccept && (
            <button type="button" className="btn primary" onClick={onAccept}>
              I understand, turn on dictation
            </button>
          )}
        </>
      }
    >
      <p>
        Your questions and answers are encrypted so your relay cannot read them.{' '}
        <strong>Dictation is different.</strong> While you dictate:
      </p>
      <ul className="plain">
        <li>
          Your voice is streamed through <strong>your own relay</strong> (a Cloudflare Worker you
          deployed) to <strong>{provider}</strong> for transcription. The relay forwards audio
          without storing or logging it, but it can technically see it in transit.
        </li>
        {correction ? (
          <li>
            After you stop, the transcript and the question you are answering (its text, context,
            options and project name) are sent through your relay to <strong>{correction}</strong>{' '}
            for a single clean-up pass. The cleaned text replaces your words in the answer box, and
            one tap puts back exactly what you said.
          </li>
        ) : (
          <li>Clean-up is off, so the transcript is not sent anywhere else after you stop.</li>
        )}
        <li>Those providers process your words under their own terms and retention policies.</li>
        <li>No audio is ever saved on your phone, your relay or Daintree.</li>
        <li>
          You review the text before anything is sent as an answer. Typing instead never leaves your
          phone unencrypted.
        </li>
      </ul>
      <p>You can switch dictation off at any time in Settings.</p>
    </Dialog>
  );
}
