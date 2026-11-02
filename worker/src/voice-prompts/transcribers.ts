// Mirrors TRANSCRIBER_NOTES in Daintree's shared/config/voiceCorrection.ts (daintreehq/daintree @ 482db05c74), verbatim.
// Keyed by the Decisions provider id: Daintree's "grok" is "xai" here.

export const TRANSCRIBER_NOTES: Record<'xai' | 'openai', string> = {
  xai: `TRANSCRIBER: The target was transcribed by xAI's Grok speech-to-text. Its habits:
- It ends a sentence wherever the speaker paused, even mid-sentence ("we should make the prompt. For the cleanup, aware of any quirks"). Where the words carry straight on, join them back into one sentence.
- It writes a hesitation as "…" or "...", or as a comma before the speaker carried on ("something else is, we should"). Those are pauses, not punctuation the speaker meant: take them out where the sentence reads straight through.
- It hears a rising voice: a question mark it wrote after words that read as a statement is the speaker's question. Keep it.
- It writes ordinals in running prose as digits ("the 1st sentence", "check that 1st"). Write those as words ("the first sentence", "check that first"); keep a date, a version, a count, a numbered item, and anything in backticks, a path, an identifier or a command's arguments as written.
- It drops "um", "uh" and most stutters but keeps "so", "okay", "yeah", "you know" and repeated words ("I'm seeing, I'm seeing"), which the cleanup rules take out.
- It writes compound and technical words as ordinary words, split or misheard ("work tree", "web socket", "the cash key"): repair them where the sentence plainly means the technical word.
- It flags no unsure words, so a misheard word is never tagged.`,
  openai: `TRANSCRIBER: The target was transcribed by OpenAI's live transcription. Its habits:
- It keeps "um", "uh" and "you know", which the cleanup rules take out.
- It spells dictated symbols out as words ("slash", "dash dash", "dot").
- It gets rare names and context-bound words wrong in fluent-looking ways ("Tara", "we'd" for "would"), so a misheard word can read like a real one.
- It flags no unsure words, so a misheard word is never tagged.`,
};
