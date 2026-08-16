# mail-engine/keys — DKIM private keys

**Nothing in this directory is committed except this file.** The `.gitignore` rule is
`mail-engine/keys/*` with an exception for `README.md` and `.gitkeep`.

## Why this matters more than most secrets

A DKIM private key is not a password to something — it is the authority to *be* this domain. Whoever
holds `edurankai.in.private` can sign a message that Gmail, Outlook and every other receiving server
will verify as genuinely from edurankai.in, with a valid DMARC alignment. There is no per-message
audit, no second factor, and no way to tell a forged-but-signed message from a real one. A leaked
DKIM key is worse than a leaked SMTP password: rotating the password stops the sending, whereas
rotating a DKIM key requires a DNS change that takes hours to propagate, during which both the old
and the new key are valid.

## Generating a key

```
node --import tsx mail-engine/src/cli.ts keygen edurankai.in
```

That writes `edurankai.in.private` here (mode 0600) and prints the exact TXT record to publish. The
key is *not* live until the record is published and has propagated — until then, mail is signed with
a key nobody can verify, which receiving servers treat as a **failure**, not as "unsigned". Publish
first, verify with `dig +short TXT era1._domainkey.edurankai.in`, and only then start signing.

## Who reads these files

Two processes, deliberately sharing one key so that a message verifies identically whichever path it
took out of the building:

| Process | Reads | Signs |
|---|---|---|
| The Node engine (`src/dkim.ts`) | `<domain>.private` | mail submitted to the engine API |
| OpenDKIM (`docker/opendkim/`) | the same file, mounted read-only | mail that leaves through Postfix |

## Rotation

1. Generate the new key under a **new selector** (`MAIL_DKIM_SELECTOR=era2`, `keygen --force`).
2. Publish `era2._domainkey.<domain>` and wait for it to propagate everywhere.
3. Switch the engine and OpenDKIM to the new selector.
4. Leave the **old** record published for at least a week — mail signed before the switch is still in
   transit and still being verified.
5. Only then remove the old record and delete the old key file.
