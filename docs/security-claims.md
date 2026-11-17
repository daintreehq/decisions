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

Your notification settings (quiet hours and reminders) and your involvement preference are stored in plaintext: the relay sees whether you want agents to involve you early or bring you a recommendation, how many agents they should consult, and when a temporary setting ends. The involvement preference is signed by the phone, tablet or computer you set it on, so the relay cannot change it or attribute it to another device. An agent's report of how it prepared a question travels inside the encrypted question.

When your desktop reports that you are at the computer (presence), the relay learns that you are, and when: it sees each report and renewal, so it can tell roughly when you sat at the computer and when you left it or it went to sleep. It keeps only when the current report lapses, never a history, and a report carries nothing about questions, panes or content. While a report is current, the relay holds a new question's phone notification for up to two minutes.

## What is authenticated

- Every request is signed by a paired device (ECDSA P-256) and includes a timestamp and nonce; replays are rejected.
- Every question and every answer is a signed record committing to the exact ciphertext. Phones and the desktop verify signatures through a certificate chain rooted at the owner key the phone pinned from the QR code, so the relay cannot forge, swap or re-attribute them.
- A human answer must be signed by a phone or tablet device, or by the owner desktop, which certifies every other device and so could pair a phone of its own anyway. An answer from the owner desktop is recorded as the person's answer made on the computer (`human-desktop` provenance) and accepted only for a question whose asking desktop declared support for it. A Remote Host never signs a human answer, and only a phone or tablet overrides an answer or confirms a proxy answer. A proxy answer is signed by a desktop and is always labelled. The relay enforces this, and every client checks the signer's role. The phone app shows an answer made on the computer as the person's, named with the computer's certified name, and a client that cannot yet show one refuses it.
- A human thread message must likewise be signed by a phone or tablet, or by the owner desktop; a Remote Host never signs one. A message from the owner desktop is the person's message sent from the computer, told apart from a phone's by the signer's certified role rather than by anything the relay says. It carries no phone images and is accepted only for a question whose asking desktop declared support for it. The relay enforces this, and every client checks the signer's role. The phone app shows a message sent from the computer as the person's, named with the computer's certified name, and a client that cannot yet show one refuses it.
- Whether a closed question was declined by the person or withdrawn by a desktop is read from the signed cancel alone, never from a field the relay supplies. A cancel signed by a phone or tablet is the person declining. A cancel signed by the owner desktop is a withdrawal unless its signed record carries `decline: true`, the person declining on the computer; no other device may sign that flag, so a Remote Host can withdraw a question but never decline it for the person. The relay commits the owner desktop's decline only for a question whose asking desktop declared support for it, and the first close stands: a decline is never relabelled a withdrawal, nor a withdrawal a decline. A client that predates the flag still verifies it, and shows the question as withdrawn.

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
