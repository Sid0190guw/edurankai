# SAMARTH implementation status

**As of 2026-11-08.** Branch `feat/samarth-foundation`. Merged and deployed (PRs #7, #8). Production tables not yet created at the time of writing (one-click setup now on /admin/samarth); no booking fee approved yet; online checkout on by default (D-021). Module-level status: [MODULE_REGISTER.md](MODULE_REGISTER.md). Evidence: [TESTING_REGISTER.md](TESTING_REGISTER.md).

## What works in the code
- **Public site:** hub, consultation and fees, industry, government, engineering, consultancy packages with estimator, fourteen capability pages, partner ecosystem and registration, SAMARTH X and its expression of interest. Global wording; every country selectable; 31 currencies.
- **Consultation workflow (amendment):** Registration, Applicant details (official bodies: level, jurisdiction, department, office, authorised representative, authorisation reference, procurement route, tender reference, proposal and invoice requirements, language), Project requirements (ten pathways plus common questions, document links), Booking fee (approved fee for the category and currency, with tax, charges, terms and confirmation process shown before acceptance; online or against an invoice), Call booking (up to three times in the applicant's zone), Consultant assignment and scheduling, call record.
- **Private access:** reference plus emailed private link, cookie after first use, resend by reference and email.
- **Payments:** gateway order with amount from the database, existing verify/webhook/reconcile path, idempotent effect, duplicate-capture alert, offline payment records, invoices through the invoice module, receipts, readiness panel distinguishing connected, sandbox-tested and production-verified.
- **Engagements:** separate quotations for packages, engineering, government, infrastructure, transfer, implementation, research, support; draft-only editing; internal approval with a note; send; client accept (typed name) or decline; offline acceptance with evidence; award or contract reference; delivery only against payment or contract; partners and responsibility shown to the client.
- **Partners:** registration, due-diligence checklist, approval workflow, comparison, performance notes.
- **SAMARTH X:** three channels into one pipeline, reviews, advisory ranking, selection and best-six incubation guards, agreement reference, milestones, resources, demonstrations, showcase. No fee.
- **Administration:** overview with pipeline, revenue, distribution and readiness; search across every record; filters, keyset paging, CSV export (audited); timelines; module register.
- **Platform integration:** two admin sections and sidebar group, middleware gate, bootstrap and health registration, four alert types (super admin), site navigation, sitemap, finance purpose filter, two feature flags.

## Not built (see NEXT_ACTIONS.md)
Module 05 AI assistant; Module 06 milestones and delivery stages; Module 07 partner quotations and consortiums; Module 10 contract documents and milestone billing; Module 11 translations and webmaster verification; Module 12 end-to-end, accessibility and load testing; Module 13 production go-live steps.

## Outstanding defects
None known in SAMARTH. Pre-existing, unrelated: `src/lib/vod.test.ts` fails 3 assertions on `main` as well.

## Deployment state
Nothing deployed. The separate hotfix branch `fix/interview-id-doc-upload` (interview ID and profile photo uploads) is also committed and awaiting push.
