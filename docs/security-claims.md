# Security claims

This page says what Decisions protects, and just as importantly what it does not. It only claims "end-to-end encrypted" where that is accurate.

## What is protected

| Data                                                              | Cloudflare sees                                     | Why                                                                          |
| ----------------------------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------- |
| Question text, context, option labels, project and machine labels | ciphertext only                                     | AES-256-GCM with a key Cloudflare never holds                                |
| Answers (choice and text), proxy answers and their reasoning      | ciphertext only                                     | same                                                                         |
| Screenshots                                                       | ciphertext only, random object names, no file names | encrypted per file before upload                                             |
| Push notification content                                         | nothing useful                                      | payload is a type and an opaque id; the lock-screen text is fixed by the app |

## What Cloudflare can see (metadata)

Ids, timestamps, requirement level (needed to enforce policy), question status, revision numbers, ciphertext sizes, which device acted, when you were notified, device labels you chose, push endpoints, IP addresses and ordinary request metadata. This reveals _activity patterns_ (for example that you answered something at 02:00), not content.

## What is authenticated

- Every request is signed by a paired device (ECDSA P-256) and includes a timestamp and nonce; replays are rejected.
- Every question and every answer is a signed record committing to the exact ciphertext. Phones and the desktop verify signatures through a certificate chain rooted at the owner key the phone pinned from the QR code, so the relay cannot forge, swap or re-attribute them.
- A human answer must be signed by a phone or tablet device; a proxy answer is signed by a desktop and is always labelled. The relay enforces this and so does every client.

## What is not protected

1. **Anyone who controls your Cloudflare account** can change the Worker and the web app it serves. A malicious page could read what your phone decrypts. End-to-end encryption in a web app protects against passive access to stored data, not against a compromised deployment. Mitigations: strict CSP, no third-party scripts, a reproducible build from this repository, and (optionally) Cloudflare Access. This is inherent to web apps.
2. **Your computer and your phone** hold plaintext while you use them. Disk encryption and a screen lock are your responsibility. On disk, the desktop's local database keeps question and answer content only as ciphertext under the content key in your key store. Plaintext is written only where you chose it: the decision model's history if you turn on learning (secrets redacted first), an export you make with `--plaintext`, and the audit log if you turn on debug content logging.
3. **Dictation is not end-to-end encrypted.** If you enable it, audio and text pass through your Worker and then the speech and correction provider (see [voice-privacy.md](voice-privacy.md)). It is off until you turn it on, and it can be disabled entirely.
4. **A revoked or stolen phone** keeps whatever it already downloaded. Revocation blocks future access and rotates the content key for new data; it cannot recall old data.
5. **Agents** continue to send their prompts and code to their own model providers, which is unrelated to Decisions.
6. **The decision model**, if you choose a cloud model, sends the question and a few of your past decisions to that provider. The default is a local agent CLI you already use.
7. Denial of service by someone who can reach your Worker URL is limited by rate limits and Cloudflare, not eliminated.

## Terminal injection

Answer text is data. It is stripped of control and escape sequences, placed in a delimited block that says it is data, labelled with its source, and typed only when the exact origin terminal is at an idle prompt. Daintree never executes it. The sentence around it is written by Daintree, never by the answer.

## Reporting

See [SECURITY.md](../SECURITY.md).
