# SAMARTH next actions

Ordered. The first three are operator steps nobody else can do; the rest is the next build work.

## Operator (owner) steps to go live
1. **Merge and deploy** the `feat/samarth-foundation` branch.
2. **Create the tables in production:** open `/admin/samarth` and press **Set up SAMARTH now** (or "Create module tables" at `/admin/setup`, or paste `db/samarth-schema.sql` into the database SQL editor). The banner disappears once all eight tables exist.
3. **Approve booking fees** at `/admin/samarth/fees`: for each applicant category (or one all-categories row) and each currency you accept, enter the amount, tax treatment, payment-charge statement and the payment terms (have the terms reviewed), then approve with a note. Until then applicants can register but cannot book.
4. **Sandbox-test checkout** on a preview deployment with Razorpay **test** keys: register, accept a fee with online payment, pay with a test card, confirm the request moves to "Fee paid" through the webhook and `/api/payments/verify`. `/admin/samarth` then shows "Sandbox-tested: Yes".
5. Online checkout is **on by default** (D-021). Make one real low-value test payment after approving the first fee, and check `/admin/samarth` shows the payment confirmed. Switch the flags off at `/admin/feature-flags` to fall back to invoices.
6. **Grant desk access** (optional): give a custom role the `samarth` or `samarth_x` section at `/admin/team/roles`, and decide who else receives SAMARTH alerts (currently super admin only, `src/lib/notify-audience.ts`).

## Build work, in dependency order
1. **Module 05 AI assistant** on `/samarth/r/<ref>` requirements step: chat over `complete()` (`src/lib/llm/gateway.ts`), browser speech input with text fallback, optional speech output, structured extraction into the form as clearly labelled suggestions (stored apart from applicant answers), shared-link and pasted-text documents treated as data, consent for storing the transcript.
2. **Module 06 delivery tracking:** milestones and delivery stages on engagements (infrastructure fifteen-stage and government sixteen-stage lifecycles), commissioning and handover records.
3. **Module 07 completion:** partner quotations and evaluations per engagement, shortlist then select, consortium records for government bids, performance from completed engagements.
4. **Module 10 completion:** contract document generation from approved quotations, milestone billing, legal templates once drafted by counsel.
5. **Module 11:** translated pages with `hreflang`, search-console verification, permitted publications and case studies.
6. **Module 12:** end-to-end tests on the local PGlite harness (`.dev-scripts/pgserver` pattern), accessibility audit, load test of public forms, retention policy.

## Resuming in a new session
Read `MODULE_REGISTER.md`, `IMPLEMENTATION_STATUS.md` and this file; the code is in `src/lib/samarth/`, `src/pages/samarth/`, `src/pages/admin/samarth/`; run `npx vitest run src/lib/samarth`.
