# Security policy

Decisions handles approvals that can steer coding agents, so security reports are welcome and taken seriously.

## Reporting a vulnerability

Please do **not** open a public issue. Use GitHub's private vulnerability reporting on this repository ("Security" tab → "Report a vulnerability"). Include what you found, how to reproduce it, and the impact. You will get an acknowledgement within a few days.

Particularly interesting: forging or replaying a human approval, getting a proxy or model answer accepted for a `human-required` question, injecting text into a terminal other than the one that asked, reading plaintext on the relay, bypassing pairing or claim, key or secret exposure, and cross-site attacks on the PWA.

## Scope

In scope: everything in this repository. Out of scope: Cloudflare, push services and model providers themselves; attacks that require control of the user's Cloudflare account, computer or phone (see [docs/security-claims.md](docs/security-claims.md) for the honest limits).

## Supported versions

The latest release. The protocol is versioned; older clients fail closed with `upgrade_required` rather than downgrading.
