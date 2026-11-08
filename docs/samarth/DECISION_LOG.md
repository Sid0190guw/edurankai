# SAMARTH decision log

Newest last. Each entry: the decision, why, and what would change it.

**D-001 (2026-11-08) Build inside the existing application.** SAMARTH lives in the EduRankAI Astro app and reuses its database, admin auth, RBAC, payment path, FX, invoices, mail, audit, flags and health. A separate stack would duplicate hardened payment and auth code that has already been through outages here.

**D-002 Amendment over specification.** The global-coverage and booking-fee amendment overrides spec v2.0 where they differ. Consequences: every consultation starts with registration and the booking fee; consultancy packages (spec Part 13.3 "Checkout" step) are no longer bought from a public form, they are separate engagements with their own approved quotations.

**D-003 No fee amount anywhere in code.** The booking fee table starts empty; rows are drafts until approved with a note; only approved rows are quoted. Until a fee is approved for a category and currency, applicants can register and give requirements and are told booking opens when the fee is published. Source: amendment point 8.

**D-004 Fee key = (applicant category, currency), with an all-categories fallback row.** Lets one fee per currency serve everyone while allowing a different government or startup fee. Resolution: the category's own row, else the `*` row; newest approval wins.

**D-005 Charge in INR, price in any supported currency.** Fees and quotations are priced and shown in the applicant's currency; the gateway is charged the INR equivalent at the live ECB reference rate at order time, shown before payment, with the rate recorded on the payment row. Native multi-currency charging is deferred because `/admin/finance` sums `payments.amount_paise` as rupees and would silently mix currencies. A non-live rate is refused for a non-INR charge. Change when finance totals become currency-aware.

**D-006 Supported currencies = INR plus the ECB reference set (31).** A currency the rate feed does not publish could only be converted at a guessed rate. AED, SAR and others are therefore not offered; applicants there choose USD or another listed currency.

**D-007 Online checkout behind two flags, default off.** `samarthFeeCheckout`, `samarthEngagementCheckout`. Spec Part 2.1: activate checkout only after testing. Until then payment is against an invoice, recorded by staff with a reference.

**D-008 Verification reuses `/api/payments/verify` and the signed webhook.** SAMARTH adds an effect branch to `applyPaidEffects()` instead of writing its own verifier, so the refund-replay and failed-after-captured guards already in that path apply. Consequence: the keyless local sandbox cannot complete a SAMARTH payment; testing uses Razorpay test keys in a preview deployment.

**D-009 Documents are links, not uploads.** Standing platform rule (storage cost): documents of any kind are shared as links. Spec Part 12.5 asks for uploads; the rule wins. Document intelligence (Module 05) must read from shared links or pasted text.

**D-010 No applicant accounts; private links.** A random token, stored only as a hash, moved into an HttpOnly cookie on first use; lost links are replaced via `/samarth/r`, never recovered. Avoids creating platform user accounts (and their 2FA and face-enrolment gates) for external clients.

**D-011 Two admin sections, super admin only by default.** `samarth` (commercial desk) and `samarth_x` (venture programme). X reviewers have no reason to see client fees or contracts. Granting either to a custom role is a policy decision made at `/admin/team/roles`.

**D-012 Turnover bands stay in INR with "or the equivalent".** The specification defines them in rupees and USD; converting live would make a band boundary move daily. They are commercial criteria, never statutory classifications.

**D-013 Medium versus large.** The specification gives no turnover boundary between them. Rule: one defined project is the medium package; an enterprise-wide engagement up to USD 1 billion is the large package; above USD 1 billion is a custom quotation (new `custom` package code, a quotation, not a price).

**D-014 Government applicants pay the same fee (amendment), and may pay against an invoice.** "Our rules require an invoice before payment" is recorded in their procurement details and preselects invoice payment.

**D-015 A proposal is never shown as awarded.** `isContracted()` is true only when delivery has started against a recorded payment or a contract, purchase-order or award reference. Delivery cannot start without one of the two.

**D-016 Quotation approval may be by the preparer, but it is flagged.** A single-founder organisation must be able to operate; the screen states plainly when the approver is the preparer.

**D-017 SAMARTH X selection needs one completed review; incubation needs a cohort, a recorded agreement and a free place among six.** One review keeps a small team unblocked; the agreement requirement enforces Part 10.5 (IP, resources and equity in writing, no automatic equity).

**D-018 No named companies in copy.** Spec Part 10.1 names an accelerator as inspiration; project rules forbid naming any company in user-facing copy, so the public pages describe SAMARTH X without comparison.

**D-019 The AI assistant is not built in this pass (Module 05).** The discovery pathways it would drive are built as a deterministic form so the workflow works with no AI provider at all (sovereignty rule: AI is an optional connector, never a dependency).

**D-020 Hand-run SQL is the production schema path.** Bootstrap DDL is disabled in production. `db/samarth-schema.sql` is kept identical to `SAMARTH_DDL` by a test.

**D-021 (2026-11-08) Online checkout on by default, at the owner's request.** After launch the owner asked to "connect the gateway". Both SAMARTH checkout flags now default on (D-007 superseded). Online payment still needs Razorpay keys on the deployment and an approved fee; either flag can be switched off at `/admin/feature-flags`.

**D-022 One-click setup from the SAMARTH desk.** The live `/samarth/consultation` showed "the published fees could not be loaded" because production never creates tables on a page view and nobody had run the setup. Every SAMARTH admin page now detects missing tables and offers **Set up SAMARTH now** (`/api/admin/samarth/setup`, settings.edit), which runs the DDL inside `allowingDdl()` and verifies each table. Public pages say "not published" or "not open yet" instead of "reload", and an attempted registration alerts the owner.

**D-023 Fee entry: several currencies at once, optional publish in the same step, a terms template.** Approval still needs a written note, and terms containing any `[bracketed]` placeholder are refused, so no refund or cancellation policy is published that a person did not decide. Amounts are never pre-filled.

**D-024 (2026-11-08) SAMARTH events reuse the platform's events.** A SAMARTH event is a row in `events` tagged `samarth` (plus `samarth-<kind>`), so registration, the public page, levels, fees and certificates come from the existing events system. `/admin/samarth/events` creates and lists them and nominates chosen registrants into SAMARTH X (channel `event`, consent flag false because a person nominated them). Nomination never admits anyone.

**D-025 Overview charts follow the data-visualisation method.** The pipeline is a column chart in workflow order coloured by phase from a four-step ordinal blue ramp; distributions are segmented bars (six parts at most, tail folded into Other) using the first six categorical slots. Both palettes were run through the validator against the admin panel surface `#0f0f14` and pass every check; ten separate pipeline shades failed the adjacent-step check, which is why stages are grouped into phases. Every chart has hover titles and a screen-reader table.

**D-026 Payment keys never enter the repository.** The owner pasted live Razorpay keys into the conversation on 2026-11-08. They were not written to code, docs, memory or git. Keys belong in the deployment's environment variables only, and a secret shared in a chat must be regenerated.
