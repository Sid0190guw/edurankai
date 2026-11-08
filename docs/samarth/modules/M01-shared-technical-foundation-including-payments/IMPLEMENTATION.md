# Module 01 implementation

**Status:** partial

## Built
- samarth_* schema with self-bootstrap and a hand-run SQL file
- Registered with /admin/setup bootstrap and /api/health
- Access control: two admin sections (samarth, samarth_x), fail-closed to super admin
- Booking-fee schedule configurable by category and currency, with approval
- Payment orders, server-side verification, webhook and reconciliation through the existing gateway path
- Idempotent paid effects, offline payment records, refund visibility
- Invoices through the existing invoice module
- Email and admin notifications
- Audit log on every write
- Feature flags for online checkout
- State machines with guards

## Pending
- Native multi-currency charging (blocked on currency-aware finance totals)
- Automated backup verification specific to SAMARTH tables (relies on platform backups)

## Surfaces
- `/admin/samarth`
- `/admin/samarth/fees`
