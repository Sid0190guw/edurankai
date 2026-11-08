# SAMARTH testing register

## Run on 2026-11-08, branch `feat/samarth-foundation`

| Gate | Result |
|---|---|
| `npx vitest run src/lib/samarth/samarth.test.ts` | **41 / 41 pass** (37 at launch; 4 added with the setup and fee-entry change) |
| `npm test`, Vitest half | **218 files, 5,308 tests pass** (whole repository) |
| `npm test`, shim half | 80 / 81 suites pass. `src/lib/vod.test.ts` fails 3 assertions. **Pre-existing:** the same 3 fail on clean `origin/main` (checked in a separate worktree). Not touched by SAMARTH. |
| `node scripts/audit-wiring.mjs` | Pass: every link, form action and fetch resolves; every page reachable |
| `node scripts/lint-mail.mjs` | Clean |
| `node scripts/typecheck-ratchet.mjs` | 0 errors, no new type errors |
| `npx astro build` | Pass |
| Rendering check | Built server started from a directory with **no** `.env` and no `DATABASE_URL` (so it could not reach any database): all 15 public SAMARTH URLs answer 200, an unknown capability slug answers 404, `/admin/samarth` redirects to sign-in, register validation errors render, content pages carry the edge-cache header and form pages do not, structured data present, sitemap lists 25 SAMARTH URLs |

## What the unit tests cover (and the production failure each prevents)
Package prices and labels; exclusions; no stacking; confirmed-amount rules; eligibility for every category; fee breakdown (exclusive, inclusive, processing); zero-decimal currencies; INR conversion; every workflow guard (no clickable "paid", order of the six steps, reasons, approval notes, validity, payment or contract before delivery, due diligence before approval, six incubation places, agreement before incubation); reachability of every status; pathway coverage, unique fields, option validation; references, token hashing, time-zone conversion across daylight-saving zones; link-only documents; advisory X scoring; copy rules (no emoji, arrows, company names or unverified claims; regulated-work notice; X free; global reach); fourteen substantive capability pages; SQL file identical to the bootstrap DDL; module register honesty.

## Not yet tested (honest gaps)
- **Database-backed behaviour** (writes, guards at the SQL level, payment effects) against a real Postgres. The project rule forbids connecting to the production database; an end-to-end run on the local PGlite harness is Module 12 work.
- **A real gateway payment.** Needs Razorpay test keys on a preview deployment (operator step, NEXT_ACTIONS.md).
- **Email delivery.**
- **Browser interaction** (the estimator and checkout scripts) beyond server rendering.
- **Accessibility audit and load testing.**
