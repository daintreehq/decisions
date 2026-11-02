# Key recovery

Everything on the relay is encrypted with keys that only your own devices hold. That is the point, and it has a consequence: **if every device that holds your keys is lost and you have no recovery kit, your history on Cloudflare cannot be decrypted by anyone, including you.**

## What to back up

- The **recovery kit**: a passphrase-protected file with your owner signing and exchange keys and your content keys. Create it with `decisions recovery export --out <file>` (passphrase of at least 12 characters, asked for or read from `DECISIONS_RECOVERY_PASSPHRASE`; PBKDF2-SHA256, 600,000 iterations, AES-256-GCM). Store it somewhere other than the computer it protects, such as a password manager attachment.
- Check it works: `decisions recovery verify <file>`. Daintree's setup wizard requires a successful verification before it finishes.

## Restoring on a new computer

1. `decisions recovery import <file>` and enter the passphrase.
2. The new computer is now the owner. Open pairing for each phone again if they were revoked; existing phones keep working because their keys and certificates are unchanged.
3. Review the device list and revoke anything you no longer recognize.

## If you lose a phone

Re-pair a new one. Phone keys are non-extractable and are not recoverable by design. Revoke the old one.

## If you lose everything

Deploy a new relay (or run `decisions delete-data --scope everything` on the old one), claim it, pair devices. Old encrypted data is unreadable; delete it from Cloudflare.
