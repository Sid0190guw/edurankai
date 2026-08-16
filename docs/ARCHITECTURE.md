# EduRankAI Mail — Architecture

**Owner:** Patch 1 (core platform, database, API, contracts).
**Status:** foundation shipped. Read `INTEGRATION-CONTRACTS.md` before building against it.

---

## 1. What was found, and what that changed

The brief proposed Next.js, Supabase Auth and a fresh set of tables. The repository it landed in is
none of those, and the instruction that governs the difference is the brief's own: *"DO NOT replace
existing architecture simply because you prefer another architecture. Extend the existing system
wherever practical."*

| Brief proposed | This repository actually runs | Decision |
| --- | --- | --- |
| Next.js | **Astro 5**, `output: 'server'`, Vercel + Node adapters, ~500 routes | Extend Astro. A framework migration is a rewrite of every page. |
| Supabase Auth | **Self-built auth**: `sessions` table, password + WebAuthn passkey + face + TOTP, `locals.user` from `src/middleware.ts` | Keep it. Wrapped behind `AuthenticationProvider` so Supabase/OIDC remains a drop-in. |
| Supabase client SDK | **postgres-js + Drizzle** over a Supabase-hosted Postgres (txn pooler :6543) | Keep. Supabase is the *host*, not a dependency — moving to self-hosted Postgres is a connection-string change. |
| New `messages` tables | **`mail_messages` / `mail_box` / `mail_recipients` / `mail_attachments`** already live, read by a working webmail client | Extend additively. A parallel store would have forked the mailbox. |
| New `roles`, `workflows`, `events`, `templates` | All four names **already taken** by the HR system and the permissions registry (~539 tables) | Prefix everything `mp_`. Asserted by a test. |
| Supabase Storage | **`src/lib/storage.ts`** already speaks S3 (SigV4, no vendor SDK) with a Vercel Blob fallback | Reuse. The sovereign default already exists. |
| "Queue abstraction" | **`src/lib/job-queue.ts`** already a real Postgres queue (atomic claim, backoff, dedup key) | Reuse behind `QueueProvider`. |

Everything below follows from those seven decisions.

---

## 2. The layers

```
   EduRankAI products            Admin screens           Partner integrations
   (Careers, AquinTutor, …)      (/admin/mail/*)         (API key holders)
            │                          │                         │
            └──────────────┬───────────┴─────────────────────────┘
                           ▼
              HTTP surface   src/pages/api/v1/platform/*
                           ▼
              Services      src/lib/mailplatform/{send,contacts,campaigns,domains,
                            templates,delivery,suppression,automation,webhooks,orgs}.ts
                           ▼
              Interfaces    src/lib/mailplatform/interfaces.ts     ◄── the only thing services import
                           ▼
              Adapters      src/lib/mailplatform/adapters/*        ◄── the only thing that names a vendor
                           ▼
   local SMTP · IMAP poll · Postgres · S3/Blob · node:dns · session cookies
```

**The rule:** nothing above `interfaces.ts` knows which mail server, object store, queue or identity
system is in use. Moving from local SMTP to an EduRankAI MTA cluster is a new adapter file and one
line in `providers.ts`.

## 3. The nine swap points

| Interface | Today | Env var | Migrates to |
| --- | --- | --- | --- |
| `MailTransport` | local/relay SMTP via nodemailer | `MAIL_TRANSPORT` | EduRankAI MTA cluster |
| `InboundMailTransport` | IMAP poll (cron) | `MAIL_INBOUND` | MTA push to `/api/mail/inbound` |
| `MessageStore` | Postgres over existing `mail_*` | `MAIL_MESSAGE_STORE` | dedicated message store |
| `AttachmentStore` | S3-compatible → Vercel Blob → memory | `MAIL_ATTACHMENT_STORE` | any S3 (MinIO, R2, Ceph) |
| `QueueProvider` | Postgres `edu_jobs` | `MAIL_QUEUE` | Kafka / SQS |
| `EventBus` | append-only `mp_events` | `MAIL_EVENT_BUS` | Kafka topic |
| `AuthenticationProvider` | own sessions + hashed API keys | `MAIL_AUTH` | Supabase Auth / OIDC |
| `AnalyticsProvider` | aggregates over `mp_events` | `MAIL_ANALYTICS` | ClickHouse |
| `DomainProvider` | system resolver | `MAIL_DNS` | registrar API |

Live status at **`GET /api/v1/platform/status`** — it reports each slot's own `info()`, including
`enabled: false` and the sentence saying what is missing.

## 4. Why the event stream is the spine

Every meaningful fact is appended to `mp_events` **once**. Webhooks and analytics *read* that stream
rather than being called at each site where something happens.

- A new consumer never requires a new call site.
- A webhook that was down is a **replay**, not a lost fact.
- The table shape (append-only, wide `jsonb` payload, time-ordered, never updated) is what a column
  store ingests unchanged — so the ClickHouse move is a copy pipeline, not a remodel.

## 5. Tenancy from day one

Every mail-platform row carries `org_id`, though there is one tenant today. Retrofitting that column
onto twenty tables holding millions of rows — and then finding every query that forgot to filter on
it — is one of the most expensive and dangerous migrations there is, and the brief names multi-tenant
SaaS as an explicit destination. EduRankAI itself is org `edurankai`, created on first use.

An EduRankAI employee is **not** automatically a member of another tenant: `resolveOrgRole()` falls
back to an internal role *only* for the default organization.

## 6. Scaling path

| Volume | Change |
| --- | --- |
| now → ~100k msg/month | nothing. Postgres queue and store are genuinely adequate. |
| ~1M/month | move `MailTransport` to a dedicated MTA; add read replicas. |
| ~10M/month | `QueueProvider` → Kafka; `EventBus` → Kafka; partition `mp_events` and `mp_delivery_events` by month. |
| analytics-heavy | `AnalyticsProvider` → ClickHouse, ingesting `mp_events` unchanged. |
| sovereignty | `DATABASE_URL` → self-hosted Postgres; `S3_*` → MinIO. No code change. |

## 7. Known limits, stated plainly

- **No inbound MTA.** Mail arrives by IMAP poll. Browser/server → platform SMTP ingest does not
  exist yet; that is the SMTP/MTA agent's work, and `InboundMailTransport` is the seam.
- **The Postgres queue is not a broker.** It is reliable, not sub-second at high fan-out.
- **`applyRecord` is unsupported.** DNS is configured by a human at the registrar; the adapter says
  so rather than pretending.
- **Webhook delivery needs `WEBHOOK_SIGNING_KEY`.** Without it, deliveries are refused rather than
  sent unsigned.
- **Automation ships the model and the validator, not a builder UI.** See `DOMAIN-MODEL.md §7`.
- **Pre-bridge developer-API messages are not back-filled.** Rows written before the unification have
  `platform_message_id IS NULL` and are readable through the developer API only. Back-filling is a
  one-off script for the operator — nothing here connects to production. See §8.

## 8. Concurrent work — resolved

Other agents built a developer-facing API during the same session (`src/lib/mailapi/`,
`src/lib/mail-product/`, `src/lib/mailgov/`, `src/lib/mailint/`, `src/lib/mailops/`, `mail-engine/`,
routes at `/api/v1/{messages,templates,webhooks,domains,events,suppressions,email}`). It kept its
messages in `mailapi_messages`, separate from both this patch's tables and the live `mail_messages`.

**That fork is closed.** `mailapi_messages` is now the *send job* and `mail_messages` is the
*message*, linked by `platform_message_id`. A message sent through the developer API appears in the
webmail client, and its delivery outcome lands on the shared delivery tables. The developer API keeps
every one of its own contracts — scoped keys, live/test environments, idempotency, rate-limit
headers, error envelope — because none of those are storage concerns.

The mapping is in `src/lib/mailplatform/mailapi-bridge.ts`, a file this patch owns. The change to the
other agent's files is two edits in `messages.ts` and five lines in `send.ts`; no signature, response
shape or route was altered. Details and the rules the bridge follows: `DEVELOPMENT-RULES.md §6`.

This patch's HTTP surface stays at `/api/v1/platform/*` — the brief's paths were already occupied
under a different auth model, and two auth models at sibling paths is worse than one namespace.
