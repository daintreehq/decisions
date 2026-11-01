# Voice privacy

Dictation is optional, off by default, and the only part of Decisions that is **not** end-to-end encrypted. If you do not enable it, nothing on this page applies.

## What happens when you dictate

1. You tap the microphone and accept the disclosure. The phone captures mono 16 kHz audio only while recording.
2. The phone asks your Worker for a one-use ticket (30 seconds), then opens a WebSocket to the Worker. The Worker opens its own connection to the transcription provider (xAI by default) using the API key stored as a Worker secret and streams audio through. The browser never holds a provider key.
3. Transcript text comes back. When you stop recording, one request sends the whole transcript, the question text, option labels and a few project terms to the correction provider (Anthropic Haiku by default) to fix punctuation and obvious recognition errors.
4. You review the result. Words the model is unsure of are marked. Nothing is submitted until you press Submit, and if correction fails, times out, changes yes/no meaning, or adds names that were not said, the raw transcript is kept.

## Who sees what

| Party                     | Sees                                                            |
| ------------------------- | --------------------------------------------------------------- |
| Your Worker               | audio and text in memory while relaying; not stored, not logged |
| Transcription provider    | the audio                                                       |
| Correction provider       | the transcript, the question text and option labels             |
| Cloudflare (as a network) | encrypted transport only                                        |

Provider retention and training policies are the provider's. Read them before enabling.

## Limits and controls

One session at a time per device, five minutes per session, a monthly audio budget counted by audio duration, rate limits on correction. Remove the provider secrets from the Worker, or turn dictation off in the phone's settings, to disable it completely. Typing always works.

## Alternatives

The single-provider mode (OpenAI) needs one key instead of two and is marked preview. A future option is to route dictation through the desktop over the encrypted channel; that does not exist yet.
