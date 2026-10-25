# Mail credential encryption and recovery

This runbook covers the app's AES-256-GCM envelope keys and the four secret fields in
`mail_config`: `smtp_pass`, `imap_pass`, `resend_api_key`, and `inbound_secret`. A field can hold an
encrypted envelope, legacy plaintext, or no value.

## Encryption contract

- Encryption uses AES-256-GCM with a 32-byte key, 12-byte IV, and 16-byte authentication tag.
- New envelopes use version 1 and algorithm `A256GCM`. The envelope stores its `keyId`, so reads
  select the key named by the ciphertext even after `ACTIVE_DATA_KEY_ID` changes.
- The key environment-variable name is case-sensitive: `DATA_ENCRYPTION_KEY_<keyId>`. For the
  existing ID `k1`, the exact name is `DATA_ENCRYPTION_KEY_k1` (lowercase `k`).
- The value is standard or URL-safe Base64 for exactly 32 random bytes. The 32-byte requirement is
  about the decoded key, not the number of Base64 characters. Canonical padded and unpadded encodings
  are accepted. Whitespace is ignored for compatibility.
- `ACTIVE_DATA_KEY_ID` chooses the ID used for new writes and defaults to `k1`. Every key ID still
  present in ciphertext must remain configured for reads. A new key cannot decrypt an older ID.
- Encrypted mail fields are stored as `era-mail-secret:v1:` followed by a JSON envelope. Legacy
  plaintext values remain readable; only a supplied replacement or an approved migration encrypts
  them.

The loader distinguishes missing key material, invalid Base64, and an incorrect decoded length.
Envelope parsing distinguishes malformed ciphertext from AES-GCM authentication failure. The latter
can mean a wrong key or modified ciphertext; the two are intentionally not reported as distinguishable.
Logs contain a field name and a failure code, never a key, plaintext credential, or ciphertext.

## Inventory before key changes or plaintext migration

The `DATA_ENCRYPTION_KEY_<keyId>` registry is shared by these application fields:

| Storage | Encrypted value | Recorded key ID |
| --- | --- | --- |
| `mail_config` | `smtp_pass`, `imap_pass`, `resend_api_key`, `inbound_secret` when prefixed `era-mail-secret:v1:` | `keyId` inside each JSON envelope |
| `fpc_subject_input` | `ciphertext` JSONB (birth input) | `key_id` column |
| `hzn_personal_foundation` | `payload_enc` JSONB (personal foundation input) | `key_id` column |
| `mp_secrets` | `envelope` JSONB for `purpose = 'dkim-private-key'` | `keyId` inside each JSON envelope |

`crypto_keys` stores key IDs and lifecycle metadata only; it does not store key material and its rows
do not by themselves prove which IDs are still referenced by data. Before rotation or migration, run
the following read-only inventory in the Production database. These queries return only field names,
storage classifications, key IDs, and row counts. Never select or export a secret/ciphertext value.

```sql
SELECT key_id, purpose, state
FROM crypto_keys
ORDER BY key_id;

WITH mail_values AS (
  SELECT 'smtp_pass' AS field, smtp_pass AS value FROM mail_config WHERE id = 1
  UNION ALL SELECT 'imap_pass', imap_pass FROM mail_config WHERE id = 1
  UNION ALL SELECT 'resend_api_key', resend_api_key FROM mail_config WHERE id = 1
  UNION ALL SELECT 'inbound_secret', inbound_secret FROM mail_config WHERE id = 1
), mail_inventory AS (
  SELECT field,
    CASE
      WHEN value IS NULL OR btrim(value) = '' THEN 'empty'
      WHEN value LIKE 'era-mail-secret:v1:%' THEN 'envelope'
      ELSE 'legacy_plaintext'
    END AS storage,
    CASE WHEN value LIKE 'era-mail-secret:v1:%'
      THEN substring(value FROM '"keyId"[[:space:]]*:[[:space:]]*"([A-Za-z0-9._-]{1,64})"')
      ELSE NULL
    END AS key_id
  FROM mail_values
)
SELECT field, storage, key_id, count(*) AS rows
FROM mail_inventory
GROUP BY field, storage, key_id
ORDER BY field;

SELECT key_id, count(*) AS rows
FROM fpc_subject_input
GROUP BY key_id
ORDER BY key_id;

SELECT key_id, count(*) AS rows
FROM hzn_personal_foundation
WHERE payload_enc IS NOT NULL
GROUP BY key_id
ORDER BY key_id;

SELECT envelope->>'keyId' AS key_id, count(*) AS rows
FROM mp_secrets
WHERE purpose = 'dkim-private-key'
GROUP BY envelope->>'keyId'
ORDER BY key_id;
```

Run each statement only where its table exists. A missing optional table is not evidence that it has no
encrypted rows. Preserve the sanitized output and compare every referenced ID with the configured key
IDs before changing `ACTIVE_DATA_KEY_ID` or retiring any key.

Other encryption systems in the repository are separate from this registry: `mailint_credentials`
uses `MAILINT_VAULT_KEY` / `MAILINT_VAULT_KEY_PREVIOUS` and its own `env:v1` / `env:v0` IDs;
`activity_events` uses `ACTIVITY_ENC_KEY` (falling back to `SESSION_SECRET`) and records no key ID.
Do not rotate those keys as part of a `DATA_ENCRYPTION_KEY` change. The portal messenger also uses
client-side WebCrypto keys and is outside this server key registry.

For a plaintext mail-field migration, first pass the no-save SMTP and IMAP verification checks. Then
use a reviewed server-side migration that reads and encrypts each non-empty plaintext field with its
field-bound AAD, and updates only that field using compare-and-swap against the exact value read. The
operation must not return, log, or export plaintext or ciphertext; it should report only per-field
counts and outcomes. Keep empty fields empty. Stop on a key, encoding, database, or compare-and-swap
failure and leave that field unchanged. Do not run this migration until the complete key-ID inventory
has been reviewed and an approved active key is available. This is separate from routine rotation and
does not restore ciphertext encrypted under a lost key.

## Generate and escrow a key

For a **new key ID only**, use an approved password manager or secrets vault that can generate 256
random bits and encode the 32 bytes as Base64. Store the value directly in that vault and restrict
access to the production operators. Do not put it in source control, a ticket, a shell transcript,
application logs, or chat. Do not create a replacement value for an existing key ID.

Back up the key at the same time it is introduced. Keep an encrypted, access-controlled escrow copy
separate from the Vercel project and from database backups. Record the key ID, creation date, intended
environment, and a tested restore procedure as non-secret metadata. Do not export environment values
to an unencrypted local file as part of routine recovery.

## Routine rotation

Rotation preserves old keys so existing ciphertext stays readable:

1. Generate and escrow a fresh key under a new ID, such as `k2`.
2. Add `DATA_ENCRYPTION_KEY_k2` to the required environment and set `ACTIVE_DATA_KEY_ID=k2`.
3. Deploy only after the environment change is approved. Confirm new writes carry `k2` and old
   ciphertext can still be read with the retained old key.
4. Re-encrypt old records through a reviewed, tested migration. Keep every old key until the
   migration is verified against a backup and no stored envelope references that ID.
5. Retire an old key only after that verification. A metadata row marked retired does not itself
   make old ciphertext readable.

Rotation means both keys are available. It is different from losing a key.

## Restore a missing key

If an error names `DATA_ENCRYPTION_KEY_k1`, first recover the exact original value from an approved
secret vault or encrypted escrow. A format-valid key is not proof that it is the right key.

In Vercel, open the EduRankAI project, then **Settings -> Environment Variables**. Add the original
value under the exact name `DATA_ENCRYPTION_KEY_k1`, choose the **Secret** value type, select
**Production**, and save. Leave the active key ID unchanged unless a separate reviewed rotation
requires it. After approval, create a new Production deployment so the runtime receives the restored
variable. In the authenticated admin screens, verify the key format and open Mail Settings;
the affected secret-field errors must clear before changing credentials. Then verify SMTP and IMAP
connections without saving new values. Do not paste the value into a terminal command, support ticket,
or log.

Do not use an already-created older deployment as an automatic rollback after changing this variable:
Vercel environment changes are applied to deployments created afterward, and an older deployment may
still run without the restored key. If rollback is needed, redeploy the last known-good source after
confirming the Production variable is present, then verify the affected fields again. Keep the exact
original key configured throughout the rollback.

## Recovery after confirmed key loss

A new key does not recover ciphertext written with the lost key. Preserve the database and ciphertext
for any future recovery attempt. Do not clear mail settings or overwrite fields through the normal
save form.

If all approved key backups have been checked and the original is irretrievable:

1. Generate and escrow a new key ID (for example, `k2`). Do not reuse the `k1` ID.
2. With separate approval, add `DATA_ENCRYPTION_KEY_k2` and `ACTIVE_DATA_KEY_ID=k2` to Vercel
   Production, then deploy. This lets the app encrypt replacement credentials under `k2`; it does
   not make `k1` ciphertext readable.
3. Open **Admin -> Mail -> Settings**. The page identifies any affected fields without displaying
   their values. The explicit replacement form is enabled only for an existing encrypted value
   whose recorded key material is missing. Invalid key configuration, malformed envelopes, and
   authentication failures require investigation first.
4. For each listed field that truly needs replacement, obtain a fresh credential from its provider,
   submit only that field through its authenticated replacement form, and check the confirmation
   that the original key cannot be recovered. The server encrypts the new value with the active key,
   compares the stored value before updating, and changes only that column. Verify SMTP/IMAP and any
   inbound webhook integration afterward; update a provider-side credential only through its own
   approved process.
5. Keep the old ciphertext and record which fields were re-entered. Never describe those old values
   as recovered.

If rollback is needed after any field has been re-entered under `k2`, keep `DATA_ENCRYPTION_KEY_k2`
and `ACTIVE_DATA_KEY_ID=k2` configured. A previous deployment that lacks `k2` cannot read those
replacement values. Redeploy a known-good source with both applicable key IDs available, then check
the affected fields before enabling mail traffic. Do not restore a database snapshot over the recovery
updates unless its impact on mail records has been reviewed and approved.

The candidate columns are `smtp_pass`, `imap_pass`, `resend_api_key`, and `inbound_secret`; a missing
key alone does not prove which columns contain ciphertext using it. The authenticated settings page
reports the exact fields that fail at runtime. A password reset or re-entry is separate from restoring
the encryption key.

## Production checks and limits

The admin diagnostics page validates only the active key's presence and encoding; it cannot establish
that the key matches historical ciphertext. Reading each saved field is the compatibility check.
On Mail Settings, use **Verify connection** and **Verify IMAP** after reloading the page. Leave the
password inputs blank so each authenticated endpoint reads the saved credential, and do not click a
Save button; both verification requests test connectivity without persisting settings. Production
environment changes and deployments require explicit approval. No database mutation is needed to
restore a key; field replacement is an explicit, per-field operation available only after confirmed
key loss.
