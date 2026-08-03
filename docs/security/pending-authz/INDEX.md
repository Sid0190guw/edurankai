# Pending authorization changes — parked, UNMERGED and UNVERIFIED

**Status: UNMERGED. UNVERIFIED. Not on any branch. Not deployed. Nothing here has run.**

These eight patches were written during the Phase S0 emergency authentication hotfix
(`security/hotfix-auth-authz`) and then **removed from that branch before it was reviewed**. They
are parked here so the work is not lost, not because they are ready.

## Why they were taken off the branch

Phase S0 exists to close two confirmed critical **authentication** vulnerabilities:

- **F1** — `src/pages/api/auth/forgot-password.ts`
- **F2** — `src/pages/api/auth/verify-by-questions.ts`

Everything in this directory is **authorization** — who may do what once they are already signed in.
That is a different question, a different risk, and a different review. An emergency hotfix that
mixes the two cannot be reasoned about as a unit and cannot be reverted cleanly: if the authz work
causes an incident, rolling it back also rolls back the two critical auth fixes, and vice versa.
So the S0 branch now carries authentication only, and these wait for their own pass.

**Removal from the branch is not a judgement that the changes are wrong.** Several of them
(especially `04`) look like genuine and serious findings. They have simply not been reviewed,
built, or exercised.

## Read this before applying any of it

**Two of these are arguably POLICY changes, not pure security fixes, and need founder approval
rather than a security sign-off:**

- **`01-lib-auth-permissions.patch`** removes bulk `applications` export from the built-in
  `reviewer` role.
- **`06/07/08` (the export audit rows)** are the observable half of that same decision — they begin
  recording who downloads the applicant pipeline, the employee roster (which carries salary), and
  the user directory.

**A tightening that removes access somebody uses every day is not a security win — it is an
outage with a security rationale.** Nobody has checked whether a real reviewer at this company
currently exports applications as part of their job. Until somebody does, `01` is a proposal.
This project has already shipped a lockout twice; that is the specific failure mode to weigh here.

**Nothing below has been verified at runtime.** No browser and no database were used in producing
these patches (per the standing rule of the phase they came from). Every claim about behaviour is
read from source. There is no evidence any of these paths were exercised, and no evidence the
resulting tree builds — the S0 baseline (`npx astro check --minimumSeverity error` = 194) was
measured with these changes *present*, so it does not certify them individually.

## Provenance

| | |
|---|---|
| Base commit | `5f93a9d` — *Employee workspace, and a hire that failed silently for eleven days* |
| Branch they were cut from | `security/hotfix-auth-authz` |
| Captured | 2026-08-03 |
| Applies to | a clean tree at `5f93a9d` |

Patches are per-file and were verified to apply individually with `git apply --check` against a
reverted tree. They are independent of each other **except** where noted in `02`/`03`.

**Re-verified 2026-08-03, after the revert, on the authentication-only tree:** all eight apply
cleanly both individually and as a set (`git apply --check docs/security/pending-authz/*.patch`,
exit 0), and every patch's pre-image blob hash matches the corresponding `HEAD` blob at `5f93a9d`
(`01` 4dd110a, `02` 161e5e4, `03` b2bcabe, `04` 3f561b7, `05` 1b4299f, `06` 9d01a10, `07` 824d87a,
`08` c2b695e). The work in this directory is therefore complete and recoverable — it is the only
copy, as the working tree no longer contains any of it. `npx astro check --minimumSeverity error`
returns **194** with these patches removed, identical to the figure measured with them present, so
removing them introduced no type error and the 194 baseline does not certify them either way.

To restore one:

```
git apply docs/security/pending-authz/03-admin-api-keys.patch
```

To restore all eight:

```
git apply docs/security/pending-authz/*.patch
```

If the base has moved on, use `git apply -3` so conflicts surface as conflicts rather than as a
refusal.

---

## The patches

### 01-lib-auth-permissions.patch — `src/lib/auth/permissions.ts`
**Finding:** built-in roles could bulk-export any section they could view.
**Kind: POLICY — needs founder approval. See the warning above.**

`canAccessSection()` ended in `return action !== 'delete'`, so for a built-in role a granted section
implied view *and* edit *and* export. Adds `EXPORT_DENIED_SECTIONS` (currently
`{ reviewer: ['applications'] }`) and one line consulting it when `action === 'export'`.

Concretely this removes `reviewer`'s access to `GET /api/export/applications` — name, email, phone,
location and status for up to 5000 applicants in one authenticated request. `hr`, `recruiter` and
`department_head` keep theirs, on the reasoning that pipeline reporting is those roles' actual job.

Deliberately a **denylist, not an allowlist**. The file argues that a blind allowlist rewrite would
silently remove a download somebody uses daily. Custom roles are untouched — they resolve through
`rolePermissions.canExport`, which is already a separate column.

**Verification: NOT VERIFIED.** Nobody has confirmed whether a real reviewer exports applications
today. That is the question to answer before this is applied.
**Self-contained.** Nothing in the S0 authentication fix imports this file.

---

### 02-middleware.patch — `src/middleware.ts`
**Finding:** two unmapped admin paths, plus four authorization gates testing an unnormalised path.
**Kind: security fix (the `gpath` half); partly policy (the two new section rows).**

Two independent changes:

1. **Two new `PATH_SECTION` rows.**
   - `['/admin/intl-payments', 'finance']` — that page's `mark_paid` POST writes `status='paid'` and
     calls `materialiseFromIntent()` with no `can()` call anywhere, gated only by `canOpenAdmin`,
     which admits all seven admin-capable roles.
   - `['/admin/api-keys', 'settings']` — had no section entry at all, so the section gate never ran
     against it.
2. **A `gpath = normalisePath(path)` const**, declared at the top of `onRequest` and substituted
   into the applicant bounce, the AquinTutor-scope bounce, the per-section filter, and the face-2FA
   gate. `isAdminPath()` already normalised repeated slashes but those four gates still tested the
   raw string, so `//admin/finance` was recognised by `canOpenAdmin` and **not** by the section
   filter or the 2FA gate. Deliberately left on raw `path`: the circuit breaker, the visvambhara
   block, `isPublicCacheable`, and everything handed to `next()`.

**Note for whoever reviews this:** `isExempt()` is **unchanged**. `/api/` is still exempt from the
session and face gates. That exemption is the precondition of both F1 and F2 and is *correct* for a
recovery endpoint — the S0 fix puts the controls in the routes themselves. Do not "fix" it here
without re-reading those two routes.

**Verification: NOT VERIFIED.** Middleware is the highest-blast-radius file in the app; a mistake
here is a site-wide outage. The two new section rows will refuse people who reach those pages today.
**Pairs with `03`** as defence in depth (either alone is sufficient for `/admin/api-keys`).

---

### 03-admin-api-keys.patch — `src/pages/admin/api-keys.astro`
**Finding:** all seven admin-capable roles could mint and revoke live partner API credentials.
**Kind: security fix. The most clear-cut of the set alongside `04`.**

The in-file gate was `role !== 'applicant'`. The POST handler behind it mints live `erk_live_`
partner credentials and revokes existing ones — revocation being a one-click, unconfirmed denial of
service against every university/LMS integration pulling `/api/v1/*`. The `confirm()` on the revoke
form is client-side and is not a control.

Adds `if (!can(user as any, 'settings.edit')) return Astro.redirect('/admin');` **declared above the
POST handler** (`const` is not hoisted — house rule). Deliberately uses `can('settings.edit')` and
not `canAccessSection('settings','edit')`, which would additionally admit any custom role holding
the section and would be a widening rather than a fix.

Also: `logAudit` on `api_key.create` (**prefix only — never the secret**) and on `api_key.revoke`;
and the catch now reads `e?.cause?.message` first (house rule).

**Verification: NOT VERIFIED.** Behaviour change is intended and narrowing: among built-in roles
`settings.edit` is super_admin-only, so any non-super_admin who legitimately manages integration
keys today will be redirected to `/admin`. Confirm that is nobody before applying.

---

### 04-api-admin-rbac.patch — `src/pages/api/admin/rbac.ts`
**Finding: privilege escalation to full platform control in one authenticated POST.**
**Kind: security fix. Read this one first — on the source reading it is the most serious in the set.**

The endpoint's single gate asked the kernel engine for `manage` on `{ type: 'rbac' }`. The engine's
Tier 6 is `p.capabilities.has(capability)` and **never consults `resource.type`**, so that call
reduces to "does this principal hold `manage` anywhere". The seeded `registrar` and `dean` roles do.
Either of these then escalated the caller:

```
assignRole { userId: <self>, roleKey: 'superadmin' }
toggleCap  { roleKey: 'registrar', capability: 'administer', on: true }
```

`administer` is the engine's Tier-2 override — every capability on every resource, including
platform backup/restore, credential issue/revoke, and the plugin host. `can()` logged the whole
thing as an ALLOW.

Adds `PRIVILEGED_ACTIONS = {seed, toggleCap, createRole}` and `PRIVILEGED_ROLE_KEYS =
ADMIN_ROLE_KEYS`, both declared at module top, plus a second gate above every write requiring
`administer`. Privilege separation rather than a wider gate: `registrar` keeps `setStage`,
`linkGuardian`/`unlinkGuardian` and the learner-surface role assignments.

Depends on `ADMIN_ROLE_KEYS` from `src/lib/rbac/roles.ts`, which is **unmodified** — the import is
the only coupling.

**Verification: NOT VERIFIED.** The escalation path is read from source; it has not been executed.
If it is real, this is the item in this directory that most deserves its own fast review — being
parked here is a scheduling decision, not a severity one.

---

### 05-api-admin-rbac-tokens.patch — `src/pages/api/admin/rbac/tokens.ts`
**Finding:** a `delegate`-holder could mint a token carrying `administer` or `*`.
**Kind: pre-emptive hardening — authorises nothing real today.**

The endpoint gated only on `delegate` (which the seeded `registrar` holds) and nothing capped what a
minted token could *carry*. Adds `GOD_OPERATIONS = {'administer','*'}` and `carriesGodOperation()`
at module top, plus a gate requiring `administer` before `issue`/`delegate` of such a token.

**The patch is explicit that this is not currently exploitable:** presented tokens are attached to a
Principal in exactly one place today — `src/pages/api/rbac/check.ts`, an advisory endpoint that
performs no action. The cap exists so the hole never opens when somebody wires tokens into a live
guard.

**Verification: NOT VERIFIED.** Lowest urgency in the directory. Should travel with `04`.

---

### 06-api-export-applications.patch — `src/pages/api/export/applications.ts`
### 07-api-export-employees.patch — `src/pages/api/export/employees.ts`
### 08-api-export-users.patch — `src/pages/api/export/users.ts`
**Finding:** bulk exports of PII left no record of who took them.
**Kind: audit only — no gate change in any of the three. See the policy warning above.**

Each adds one `logAudit(...)` call, placed **after** the `canAccessSection` gate so a refusal is
never recorded as an export:

| patch | action | entity |
|---|---|---|
| 06 | `export.applications` | `applications` |
| 07 | `export.employees` | `hr_employees` — *carries salary* |
| 08 | `export.users` | `users` |

Uses a dynamic `import('@/lib/audit')`; `logAudit` swallows its own failure, so an audit-table
problem can never turn a permitted export into a 500.

**These three change no permissions.** The gate change that pairs with them lives in `01`, and it is
`01` that needs the founder decision. Applied without `01`, these are purely additive: the same
people can export the same data, and there is now a record. Applied with `01`, they are how you
would observe the consequences of the tightening.

**Verification: NOT VERIFIED.** In particular nobody has confirmed the `audit` table accepts these
`action` values, or what the write volume looks like on a busy export day.

---

## Not in this directory

Two other **authentication** files were also modified by the same earlier run and were **kept on the
S0 branch**, because the branch's job is authentication:

- `src/pages/api/auth/enroll-face.ts` — `matchDistance` arrived as a number in the request body and
  was trusted; the fix computes it server-side.
- `src/pages/api/auth/identity-setup.ts` — an unauthenticated auto-pass branch could set
  `password_hash` from the request body; the fix puts it behind a flag defaulting **off**.

They are the same family as F1/F2 but are **outside the two files the S0 brief named**, so whoever
reviews that branch should be told they are there and decide whether they belong in the same merge.
`identity-setup.ts` additionally imports `src/lib/auth/recovery.ts`, the new S0 library, so it
cannot be moved to a branch that lacks it.
