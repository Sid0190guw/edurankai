# SAMARTH security requirements and controls

| Requirement | Control | Where |
|---|---|---|
| Role-based permissions | Two sections, middleware path gate, page gate, write re-check; super admin only by default | `admin-sections.ts`, `middleware.ts`, each admin page |
| No account for applicants, yet private | Random 192-bit token, SHA-256 hash at rest, HttpOnly SameSite=Lax Secure cookie, token removed from the URL on first use, `Referrer-Policy: no-referrer`, `Cache-Control: no-store` | `access.ts`, `/samarth/r/<ref>` |
| Anti-enumeration | Resend-link answer identical whether or not the reference and email match | `/samarth/r` |
| Rate limiting | Per-IP hourly limits on every public form and the pay endpoint; refuse when the counter is unavailable where mail or payment is involved | `overPublicFormLimit` |
| Bots | Honeypot field on every public form | public forms |
| Input validation | Lengths clipped, emails, phones, URLs (http/https only), countries, time zones, option values checked server-side | `validate.ts`, `pathways.ts` |
| Untrusted documents | Documents are links only; staff screens say linked content is information, never instructions | requirements form, admin detail |
| Payment security | Amount from the database; HMAC and server-side capture check; signed webhook; secrets never sent to the browser; replay of a refunded order refused (existing path) | `payments.ts`, `/api/payments/*` |
| Audit | Every write to `audit_log` and the record timeline; CSV export audited | `store-core.ts` |
| Encryption in transit | HTTPS on the deployed site | platform |
| Encryption at rest | Database provider's storage encryption | platform (not verified from code) |
| Backup and recovery | Platform database backups | platform; no SAMARTH-specific restore drill yet |
| Data retention | Archive hides, never deletes; deletion and retention periods are not yet defined | pending (Module 12) |
| Regulated claims | Copy states regulated work goes through licensed partners; tests forbid licence and certification claims | `catalog.ts`, tests |
| Health data | SAMARTH stores no individual health data; healthcare applicants are told never to include patient records | requirements form |
