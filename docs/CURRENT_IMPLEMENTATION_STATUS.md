# Current implementation status

Project memory. Update at the end of every session. Do not restate history in chat.

## Shipped and deployed

| Capability | Surface | Notes |
|---|---|---|
| Authorization | `src/lib/auth/admin-access.ts`, `src/middleware.ts` | Deny by default across `/admin/*`, `/admin/login` exempt by exact match. Fails closed. |
| Permission registry | `src/lib/auth/registry.ts` | Permissions are data. Custom roles can hold `admin.access`; every sensitive grant is audited and rolls back if the audit write fails. |
| Access preview | `/admin/access-preview` | Role x permission matrix derived from `PERMS_BY_ROLE`; flags admin-capable holders with an internship record. |
| Role interfaces | `/portal/workspace`, `/portal/team`, `/admin/hr` | Intern is self-scoped; team lead is department-scoped from their own record. |
| Task engine | `src/lib/employee-tasks.ts` | Explicit transition map, collaborator roles with distinct rights, visibility resolved in SQL. |
| Task board + detail | `/portal/tasks`, `/portal/tasks/[id]` | Forms are the mechanism; drag is enhancement. Server re-validates every transition. |
| Design system | `src/styles/workforce.css`, `src/components/workforce/*` | 11 components. Status carries shape as well as hue. Density/focus modes are CSS-only. |
| BottomNav | all three portal pages | One component, variant-based. Migration complete. |
| Command Center | `/portal/employee` | Built from six verified data sources only. |
| Approvals | `/portal/approvals` | Leave and withdrawals waiting on this person. Reporting managers included, not only HR. Page shows; `decideLeave`/`decideWithdrawal` re-check authority at the write. |
| Wellness (phase 1) | `/portal/wellness`, `/admin/wellness`, `/founder/admin/wellness` | Women-only gate server-side; oversight aggregate-only, groups under `MIN_GROUP` suppressed. |
| Legal hold | `/founder/admin/held-records`, `/portal/my-record-access` | `logAccess()` before render; subject can see their own access history. |

## Verification standing

`astro check` clean for touched files. Compilation passes. **Prerender cannot run locally** — `DATABASE_URL` in `.env` is empty; the value lives in `.env.production`. Runtime, accessibility and responsive are unverified for everything above: no browser available in this environment.
