# EduRankAI Mail — Database

**Source of truth:** `src/lib/mailplatform/schema.ts`.
**Generated migration:** `db/mail-platform-schema.sql` (`npm run mail:schema` regenerates it).
**Schema version:** 1 · **47 tables** · **151 statements**.

---

## 1. Applying it

```bash
psql "$DATABASE_URL" -f db/mail-platform-schema.sql
```

**Run this yourself.** No agent on this project opens a database connection — `CLAUDE.md` forbids it,
and the established practice here is that migrations are handed to the operator. The file is
idempotent (every statement is `IF NOT EXISTS` / `OR REPLACE`) and additive (nothing drops, renames
or retypes an existing column), so re-running it is safe.

`ensureMailPlatformSchema()` applies the same statements in dev and test. In production it probes
`mp_schema_migrations` first and returns after one indexed row read, so a serverless cold start does
not re-issue 151 DDL statements.

## 2. Naming: why every table is `mp_`-prefixed

This database has ~539 tables. The brief asked for tables called `roles`, `workflows`, `events` and
`templates` — **three of those names are already live here** (`roles` and `events` in the permissions
and analytics systems, plus `workflow_instances`/`workflow_steps` in HR). Creating them unprefixed
would have collided with a working HR system on the first migration.

`src/lib/mailplatform/mailplatform-schema.test.ts` asserts the prefix and asserts non-collision
against the known table list. It fails if either is broken.

## 3. The tables

### Identity and tenancy
`mp_organizations` · `mp_organization_members` · `mp_roles` · `mp_role_permissions` · `mp_audit_logs`

Sessions and users are **not** duplicated — the existing `users` and `sessions` tables are used
directly. `api_keys` is **extended** with `org_id`, `scopes[]` and `expires_at` rather than shadowed
by an `mp_api_keys`.

### Mail
`mp_mailboxes` · `mp_mailbox_members` · `mp_email_addresses` · `mp_aliases` · `mp_folders` ·
`mp_labels` · `mp_message_labels` · `mp_threads` · `mp_message_headers`

Message bodies, recipients, mailbox copies and attachments stay in the **existing** `mail_messages`,
`mail_recipients`, `mail_box` and `mail_attachments`. See §5.

### Domains and sending
`mp_domains` · `mp_domain_verifications` · `mp_dns_records` · `mp_dkim_keys` · `mp_domain_settings` ·
`mp_sending_domains` · `mp_sending_identities`

### Delivery
`mp_delivery_attempts` · `mp_delivery_events` · `mp_delivery_status` · `mp_bounce_events` ·
`mp_suppression_entries`

Three tables, three different questions, separate on purpose:

| Table | Answers | Shape |
| --- | --- | --- |
| `mp_delivery_attempts` | what did we try, and what did the server say? | one row per attempt |
| `mp_delivery_events` | what happened? | append-only facts |
| `mp_delivery_status` | where is this recipient right now? | one row, updated |

Collapsing them means either losing history to an `UPDATE`, or answering "is this delivered?" with a
sort over every event ever recorded.

### Contacts
`mp_contacts` · `mp_contact_lists` · `mp_contact_list_members` · `mp_contact_tags` ·
`mp_contact_tag_members` · `mp_custom_fields` · `mp_contact_events`

### Marketing
`mp_templates` · `mp_template_versions` · `mp_campaigns` · `mp_campaign_recipients` · `mp_campaign_events`

### Automation
`mp_workflows` · `mp_workflow_nodes` · `mp_workflow_edges` · `mp_workflow_runs` · `mp_workflow_events`

### Platform
`mp_events` · `mp_webhook_endpoints` · `mp_webhook_deliveries` · `mp_schema_migrations`

## 4. Invariants (each enforced by an index, and each has a failure attached)

| Invariant | Mechanism | What it prevents |
| --- | --- | --- |
| One send per recipient per campaign | `mp_cr_campaign_addr_uk` unique on `(campaign_id, lower(address))` | A resumed campaign mailing the first half twice. |
| One default sending identity per org | partial unique `WHERE is_default` | Two defaults and an unpredictable From. |
| One open run per contact per workflow | partial unique `WHERE status IN ('running','waiting')` | A trigger firing twice starting the sequence twice. |
| A provider event counts once | unique on `provider_event_id` | A redelivered webhook double-counting an open. |
| One suppression row per address per scope | unique on `(org_id, lower(address), scope, scope_ref)` | Duplicate rows and an ambiguous reason. |
| `updated_at` is always true | `mp_touch_updated_at()` BEFORE UPDATE trigger on every `mp_*` table with the column | A column only some writers remember to set, reading "unchanged since 2026". |

## 5. Deviations from the brief, and why

**`message_bodies` was not created.** Bodies stay inline on `mail_messages` (`body_html`,
`body_text`). That table already stores them that way and a live webmail client reads it; splitting
would have rewritten every existing reader for no measured gain. The RFC-complete original is
preserved out of band via `raw_object_key` → object storage. Full headers **are** captured, in
`mp_message_headers`.

**`sending_domains` is not a duplicate of `domains`.** `mp_domains` is the *ownership* record;
`mp_sending_domains` is the *sending authorisation* (pool, quota, reputation). A domain can be
verified for receiving and still barred from sending — which is the correct state for a domain being
warmed.

**`delivery_status` is one row per (message, recipient)**, not a lookup table of status names.

## 6. What is added to existing tables (all `ADD COLUMN IF NOT EXISTS`)

| Table | Added |
| --- | --- |
| `mail_messages` | `org_id`, `mailbox_id`, `references_header`, `reply_to`, `sent_at`, `received_at`, `spam_score`, `spam_verdict`, `raw_object_key`, `raw_storage_backend`, `size_bytes`, `campaign_id`, `metadata`, `updated_at`, `deleted_at` + 4 indexes incl. a GIN full-text index |
| `mail_attachments` | `storage_key`, `storage_backend`, `content_id`, `is_inline`, `created_at` |
| `mail_box` | `mailbox_id`, `org_id`, `updated_at`, `deleted_at` + index |
| `api_keys` | `org_id`, `scopes[]`, `expires_at`, `updated_at` + index |

Every one is nullable or defaulted, so existing inserts keep working untouched.

## 7. Designed for scale

- **Keyset pagination everywhere.** No `OFFSET`. An offset of 10,000 reads and discards 10,000 rows
  on every page.
- **GIN indexes** for message and contact search, and on `mp_contacts.attributes` for segmentation.
- **Partial indexes** on the hot paths (`WHERE deleted_at IS NULL`, `WHERE status = 'pending'`), so
  the index covers the rows queries actually touch.
- **Batched inserts** in campaign expansion and event publishing — one statement per 500 rows, not
  one per row.
- **Append-only event tables use `BIGSERIAL`**: the id *is* the cursor, so paging needs no sort.

Partition candidates when volume demands it: `mp_events`, `mp_delivery_events`,
`mp_delivery_attempts`, `mp_campaign_events` — all by `occurred_at`/`created_at` month.

## 8. Security properties in the schema itself

- **No DKIM private key column.** `mp_dkim_keys` holds the public key and `private_key_ref` (an env
  var name, KMS id or mounted path). A signing key in a queryable column is one injection away from
  letting anyone sign mail as the domain — the exact thing DKIM exists to prevent. Asserted by a test.
- **No webhook secret in plaintext.** `secret_hash` only; the secret is shown once at creation.
- **`org_id` on every tenant-owned table**, asserted by a test. It is the mechanical reason one
  tenant cannot read another's data.
- **Soft delete** (`deleted_at`) on every entity, so an accidental delete is recoverable and a legal
  hold still finds the row.
