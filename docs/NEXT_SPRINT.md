# Next sprint

Dependency order. Build top-down; each item is buildable only after those above it.

1. **Approver inbox query** — `listLeave()` and the withdrawal reader have no by-approver filter, so
   "waiting on me" needs a query joining `hr_leave_request` / `hr_withdrawal` to
   `hr_employees.reporting_manager_id`. Existing tables; no migration. Unblocks a real approvals surface.
2. **Projects table** — migration, then a `project_id` on `employee_tasks`. Unblocks project grouping,
   capacity views and most analytics.
3. **Approval chains** — sequential and parallel steps, date-bounded delegation, overdue escalation.
   Depends on (1) for its read path.
4. **Task comment threading** — add `parent_id`, then switch `CommentThread` replies on.
5. **Regression tests** for the workforce components: layout, routing, permissions, accessibility.
6. **Command palette + saved views** — after the data model settles, not before.

Not scheduled: attendance intelligence, AI layer, per-product tenancy. Each needs schema or
infrastructure that does not exist; see `KNOWN_GAPS.md`.
