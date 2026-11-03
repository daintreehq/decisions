# Voice privacy

Dictation is optional, off by default, and the only part of Decisions that is **not** end-to-end encrypted. If you do not enable it, nothing on this page applies.

## What happens when you dictate

1. You tap the microphone and accept the disclosure. The phone captures mono 16 kHz audio only while recording.
2. The phone asks your Worker for a one-use ticket (30 seconds), then opens a WebSocket to the Worker. The Worker opens its own connection to the transcription provider (xAI by default) using the API key stored as a Worker secret and streams audio through, with a few names from the question (option labels and distinctive words) so it hears them right. The browser never holds a provider key.
3. Transcript text comes back. When you stop recording, one request sends the whole transcript to the cleanup provider (Anthropic Claude Haiku by default, or OpenAI) together with the question you are answering: its text, the newest part of its context, the options and their descriptions, the project name, when it was asked, and the part of your answer typed before the dictation. The cleanup uses the same rules as Daintree desktop dictation: it takes out filler and false starts, fixes punctuation and misheard words, and reads the question so a short "yeah, the second one" comes out right.
4. The cleaned text replaces what you dictated, in the answer box, as Daintree desktop does. There is no automatic meaning check: you read it before you send it, and **Use what I said** puts back exactly what was transcribed in one tap. Words the model was unsure of are marked with what you said and its best guess. If you edit the text while the cleanup is running, your edit wins and the cleanup is dropped. If the cleanup fails or times out, the raw transcript stays. Nothing is submitted until you press Submit.

## Who sees what

| Party                     | Sees                                                            |
| ------------------------- | --------------------------------------------------------------- |
| Your Worker               | audio and text in memory while relaying; not stored, not logged |
| Transcription provider    | the audio, and names from the question to help it hear them     |
| Cleanup provider          | the transcript, the question, its context, options and project  |
| Cloudflare (as a network) | encrypted transport only                                        |

Provider retention and training policies are the provider's. Read them before enabling.

## Limits and controls

One session at a time per device, five minutes per session, a monthly audio budget counted by audio duration, rate limits on correction. Remove the provider secrets from the Worker, or turn dictation off in the phone's settings, to disable it completely. Typing always works.

## Alternatives

The single-provider mode (OpenAI) needs one key instead of two and is marked preview. A future option is to route dictation through the desktop over the encrypted channel; that does not exist yet.
