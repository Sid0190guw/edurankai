# SAMARTH payment architecture

## What is charged
1. **Consultation booking fee** (every applicant). Configured at `/admin/samarth/fees` per (applicant category, currency), several currencies per submission, with tax mode (none, exclusive, inclusive), tax name and rate, an optional processing charge passed on (0 to 10%), a statement of how payment charges are handled, and payment terms. Draft until approved with a note. No amount is preset.
2. **Engagements** (later, separate): each quotation carries its own currency, amount, tax and terms, approved internally and accepted by the client before payment.
SAMARTH X and partner registration are never charged.

## Order to confirmation
```
applicant accepts fee + terms  ->  applications.fee_snapshot (what they agreed to)
POST /api/samarth/pay           ->  cookie access check, rate limit, amount READ FROM DB,
                                    earlier order reconciled first, live FX for non-INR,
                                    Razorpay order, payments row (purpose samarth_booking_fee
                                    or samarth_engagement, notes: priced currency, total, rate, keyMode)
Razorpay checkout (browser)     ->  POST /api/payments/verify  (HMAC + server-side fetch)
                                    and/or POST /api/payments/webhook (signed)
                                    and/or reconcileOrder() backstop
applyPaidEffects()              ->  applySamarthPaid(): FEE_PENDING -> FEE_PAID (idempotent),
                                    email with receipt link, admin alert;
                                    a second capture on a paid fee is flagged for refund
```
A browser redirect never marks anything paid. A failed effect on a captured payment is recorded on the payment row and alerted (`runEffect`).

## Idempotency
- Status writes use `WHERE status = 'FEE_PENDING'` (fee) and `payment_state <> 'paid'` (engagement).
- Before a new order, an existing order is checked and reconciled; a possibly-captured order blocks a second charge.
- Retired fee: an accepted snapshot whose fee row was retired before payment is refused; the applicant reviews the current fee.

## Offline payments and invoices
Staff record a payment received outside the gateway with its reference (`recordOfflineFeePayment`, `recordEngagementPayment`), audited. `raiseInvoice()` creates a receivable draft in `src/lib/invoices.ts` (party, reference, currency, terms, one line at the pre-tax amount); finance applies the matching tax component and sends it from `/admin/finance/invoices`.

## Refunds
Unchanged platform path: `/api/admin/payments/refund` and the refund webhook. SAMARTH screens read the live payment row, so a refund shows there.

## Status reporting
`/admin/samarth` reports separately: gateway connected (test or live key), webhook secret set, sandbox-tested (a captured SAMARTH payment with a test key), production-verified (with a live key), each checkout flag.

## Known limits
- Native multi-currency charging: deferred (D-005).
- Partial payments and milestone billing: Module 10, pending.
- Revenue for offline payments is shown on `/admin/samarth`, not in `/admin/finance` (which lists gateway payments only).
