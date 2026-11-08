# SAMARTH routes and contracts

Pages handle their own form posts (POST to the same URL, then redirect with `?msg=` or `?err=`).

## Public
| Route | Method | Purpose |
|---|---|---|
| `/samarth` | GET | Hub (edge-cached) |
| `/samarth/consultation` | GET | Workflow, published booking fees with tax, charges, terms, confirmation process |
| `/samarth/industry`, `/government`, `/engineering`, `/consultancy`, `/services`, `/services/<slug>`, `/x` | GET | Content (edge-cached) |
| `/samarth/register` | GET, POST | Step 1; creates the request, sets the access cookie, emails the private link |
| `/samarth/r` | GET, POST | New private link by reference and email (same answer either way) |
| `/samarth/r/<ref>` | GET, POST | Applicant workspace; actions `details`, `requirements`, `accept_fee`, `revise_fee`, `booking`, `message`, `withdraw`, `accept_quote`, `decline_quote` |
| `/samarth/partners` | GET, POST | Partner ecosystem and registration |
| `/samarth/partners/status/<ref>` | GET, POST | Partner's private view; message |
| `/samarth/x/apply` | GET, POST | Expression of interest |
| `/samarth/x/status/<ref>` | GET, POST | Candidate's private view; message, withdraw |

### `POST /api/samarth/pay`
Request `{ "ref": "SAM-A-...", "target": "fee" | "engagement", "engagementId"?: uuid }`, with the request's access cookie.
Success `200 { ok: true, orderId, keyId, amountPaise, currency: "INR", displayAmount, fxRate, fxDate, name, email, description }`.
Failure `{ ok: false, error, alreadyPaid? }` with 400, 403, 404, 409 (wrong state, already or possibly paid, flag off), 429 (rate limit), 500, 502 (gateway refused), 503 (not configured, rate unavailable, database unavailable). The amount never comes from the request.

### Reused
`POST /api/payments/verify` (Razorpay HMAC + server fetch), `POST /api/payments/webhook` (signed), reconciliation, `/receipt/<order>`, `/api/admin/payments/refund`.

## Admin (session + section gate, write re-checked per action)
| Route | Section | Actions |
|---|---|---|
| `/admin/samarth` | samarth | Overview, readiness, analytics, module register |
| `/admin/samarth/search` | samarth and/or samarth_x | Search every visible record |
| `/admin/samarth/applications` | samarth (export: samarth export) | List, filters, keyset pages, `?export=csv` |
| `/admin/samarth/applications/<id>` | samarth | `transition`, `assign`, `schedule`, `complete`, `offline_payment`, `invoice` (finance or invoices.manage), `message`, `note`, `archive`, `restore`, `resend_link`, `new_engagement` |
| `/admin/samarth/engagements`, `/<id>` | samarth | `save`, `transition`, `offline_accept`, `award`, `payment`, `invoice`, `note`, `message` |
| `/admin/samarth/fees` | samarth | `draft`, `approve`, `retire` |
| `/admin/samarth/partners`, `/<id>` | samarth | `?compare=`, `dd`, `perf`, `transition`, `message`, `note` |
| `/admin/samarth/x`, `/<id>` | samarth_x | Add nomination or referral, `review`, `programme`, `transition`, `progress`, `progress_state`, `message`, `note` |

## Module contracts (library)
Every write returns `{ ok: true, ... } | { ok: false, error }` with a sentence a person can act on; every read returns `{ ready: true, value } | { ready: false, error }`, where a missing table produces the set-up instruction rather than an empty list.
