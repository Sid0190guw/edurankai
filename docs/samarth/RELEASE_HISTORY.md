# SAMARTH release history

| Date | Release | Branch / commit | Contents | Deployed |
|---|---|---|---|---|
| 2026-11-08 | Release 1 and parts of 2, 3, 4, 6 (part), 7 (part), 8, 9 (part), 10 (part), 11 (part) | `feat/samarth-foundation` | Foundation, public site, consultation workflow with booking fee per category and currency, quotations, partners, SAMARTH X, admin desks, governance docs | **No.** Not merged or deployed at the time of writing; production tables not yet created; no fee approved; checkout flags off |
| 2026-11-08 | Release 1 merged | PR #7 (squash `a6db8560`) | As above | Merged to `main`; production deploy triggered. Tables still to be created at `/admin/setup`; no fee approved yet |
| 2026-11-08 | Discovery | `feat/samarth-ecosystem` | SAMARTH listed on /ecosystem (venture row seeded, status editable at /admin/products), /ecosystem/samarth, a homepage section, footer, About, FAQ and Contact | Pending merge |

Rollback: every change is additive. Reverting the merge removes the routes and the sidebar group; the `samarth_*` tables can stay (nothing else reads them). The one shared-path change, the SAMARTH branch in `applyPaidEffects()`, only matches SAMARTH purposes.
