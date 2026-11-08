# SAMARTH system architecture

SAMARTH is built **inside** the EduRankAI Astro application, on its existing infrastructure, not beside it. This document records the Module 00 repository audit and the resulting architecture.

## 1. Repository audit (2026-11-08): what SAMARTH reuses

| Need | Existing infrastructure reused | Notes |
|---|---|---|
| Framework | Astro 5, server output, Vercel serverless adapter (node adapter locally) | Pages render on the server; minimal client script |
| Database | Postgres through Drizzle (`src/lib/db`), postgres-js | Rows normalised with `Array.isArray(r) ? r : r.rows`; real errors read from `e.cause` |
| Schema changes | `ensureBatch()` bootstrap + hand-run `db/*.sql` | **Bootstrap is off in production** (`src/lib/ensure-once.ts`); tables are created at `/admin/setup` or with `psql -f db/samarth-schema.sql` |
| Health | `BOOTSTRAP_MODULES` in `src/lib/observability-health.ts`, list in `src/lib/bootstrap-modules.ts` | `/api/health` reports missing SAMARTH tables |
| Admin auth and RBAC | Sessions, `canAccessSection()`, `ADMIN_SECTION_GROUPS`, middleware `PATH_SECTION` | Two new sections: `samarth`, `samarth_x`. Super admin only by default |
| Payments | `src/lib/razorpay.ts`, `payments` table, `/api/payments/verify`, signed `/api/payments/webhook`, `applyPaidEffects()` + `reconcileOrder()`, `/api/admin/payments/refund`, `/receipt/<order>`, `/admin/finance` | SAMARTH adds two purposes and one effect branch; it does not duplicate verification |
| FX | `src/lib/fx.ts` (ECB reference rates, 1 h cache, bounded fetch) | SAMARTH refuses a non-live rate for a non-INR charge |
| Invoices | `src/lib/invoices.ts` (series, lines, tax components, payments, print) | `raiseInvoice()` creates a receivable draft for finance to complete and send |
| Feature flags | `src/lib/feature-flags.ts`, `/admin/feature-flags` | `samarthFeeCheckout`, `samarthEngagementCheckout`, default off |
| Email | `src/lib/email.ts` (own SMTP), `brandedEmail()` | Every emailed fact is also on screen |
| Admin alerts | `sendPushToAdmins()`, `NOTIFICATION_TYPES`, `NOTIFICATION_AUDIENCE` | Four SAMARTH types, super admin only |
| Audit | `logAudit()` into `audit_log` | Every SAMARTH write is audited, plus the record's own timeline |
| Rate limiting | `overPublicFormLimit()` (`src/lib/public-form-limit.ts`) | Every public SAMARTH form and the pay endpoint; refuses when the counter is down where mail or payment is involved |
| AI gateway | `src/lib/llm/gateway.ts` `complete()` (self-hosted model first, optional external connector) | For Module 05; nothing in SAMARTH depends on an AI provider |
| Search | SQL over SAMARTH tables | `searchAll()` queries every record kind the admin may see |
| Documents | Platform rule: documents are shared as links, never uploaded | SAMARTH stores document links only |

## 2. Code layout

```
src/lib/samarth/
  categories.ts   applicant categories, government levels, procurement routes (pure, browser-safe)
  pricing.ts      consultancy packages, eligibility estimate (pure, browser-safe)
  currency.ts     supported currencies, formatting, booking-fee breakdown, settlement conversion (pure)
  workflow.ts     four state machines and canTransition() (pure)
  pathways.ts     ten discovery pathways and common requirement questions (pure)
  catalog.ts      service architecture and the fourteen capability pages (pure data)
  validate.ts     input cleaning, references, tokens, time zones (server)
  x-scoring.ts    SAMARTH X criteria, aggregation, advisory ranking (pure)
  registry.ts     module register (pure data)
  schema.ts       DDL + ensureSamarthSchema()
  store-core.ts   read/write wrappers, timeline events, audit
  fees.ts         booking-fee schedule
  applications.ts consultation requests
  engagements.ts  quotations and engagements
  partners.ts     partner registry
  x.ts            SAMARTH X pipeline
  payments.ts     orders, paid effect, invoices, readiness
  notify.ts       email and admin alerts
  access.ts       private-link access (token to HttpOnly cookie)
  stats.ts        analytics and cross-record search
  samarth.test.ts unit tests of every pure rule
src/components/samarth/  SamarthShell, PathwayFields, AdminFrame
src/pages/samarth/       public site and private applicant pages
src/pages/admin/samarth/ admin desks
src/pages/api/samarth/pay.ts
db/samarth-schema.sql
```

## 3. Flows

**Consultation request:** `/samarth/register` creates a request (DRAFT) and a private link. In `/samarth/r/<ref>` the applicant completes details (official bodies add level, jurisdiction, department, authorised representative and procurement), then requirements (pathway questions, document links), then sees the approved booking fee for their category and currency with tax, payment charge, terms and confirmation process, and accepts it (FEE_PENDING). Payment online (`/api/samarth/pay`, then the gateway, then `/api/payments/verify` or the webhook) or against an invoice (staff record it). FEE_PAID opens call booking; staff assign a consultant and schedule; the call is recorded; any further work becomes an engagement.

**Engagement:** drafted from a request, edited only as a draft, submitted, approved with a note, sent, accepted or declined by the client (or accepted offline with evidence), paid online or invoiced, delivered only against a payment or a recorded contract reference, completed.

**Access model:** applicants have no account. A random token is issued once, only its SHA-256 hash is stored, it moves from the link into an HttpOnly cookie on first use, and a lost link is replaced, never recovered. Staff use their EduRankAI admin session; every page checks its section first and every write re-checks edit rights.

## 4. Environments

Development: local `astro dev` (bootstrap creates tables). Staging: Vercel preview deployments of a branch (use Razorpay **test** keys there). Production: `main` on Vercel. CI/CD is the existing Vercel pipeline plus the repository gates (`npm test`, `astro build`, `typecheck-ratchet`, `lint-mail`).
