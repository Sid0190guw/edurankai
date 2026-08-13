# AquinTutor on its own domain

The instruction: aquintutor.com is live, all control moves there, it gets its own system. It shares
this Supabase for a while and later it will not. **User accounts, admin and full access stay
independent throughout.**

This document is the plan and, more importantly, the exit route — written now, while the separation
is cheap, rather than discovered on the day of the move.

## The boundary, and where it is drawn

Sharing a database is survivable. Sharing an **identity** is not.

Both products currently resolve a caller from one `sessions`/`users` pair through one cookie. If
aquintutor.com kept doing that:

- an EduRankAI super admin would silently be an AquinTutor super admin, and the reverse;
- revoking somebody on one domain would leave them signed in on the other;
- and the eventual split would not be a migration but an unpicking, because no row anywhere would
  record which product a person belonged to.

So the boundary is drawn at the front door, on the **host**, before any lookup happens.

| Question | Decided by | Why |
|---|---|---|
| Which identity domain? | the `Host` header | a host cannot be forged by a link |
| Which layout and nav? | the path (`/aquintutor/*`) | cosmetic, and must keep working during transition |

`edurankai.in/aquintutor/*` therefore stays an **EduRankAI** request. If the path chose the identity,
that URL would be an AquinTutor admin reachable with an EduRankAI session.

Unknown hosts (previews, bare IPs) resolve to EduRankAI. The direction of that mistake matters:
wrongly EduRankAI shows a login page, wrongly AquinTutor would hand a brand-new identity domain to
whatever host happened to resolve.

## What is built

| File | Role |
|---|---|
| `src/lib/aquin/tenant.ts` | host to tenant; separate cookie names; separate login paths |
| `src/lib/aquin/schema.ts` | the `aq_*` tables and the seeded role roster |
| `src/lib/aquin/store.ts` | the **seam** — the interface everything goes through, plus an in-memory implementation |
| `src/lib/aquin/store-postgres.ts` | the only file in AquinTutor identity that writes SQL |
| `src/lib/aquin/identity.ts` | accounts, sessions, roles, authorization — no SQL, no EduRankAI import |

27 tests hold the boundary.

## Why every table is prefixed `aq_`

Whether the eventual separation is a weekend or a quarter is decided now, by whether the data is
identifiable as its own. With the prefix the move is:

```
pg_dump --table='aq_*'  ->  restore into the new database  ->  repoint one env var
```

Without it, somebody reads 258 tables trying to work out which rows belong to which product, and the
answer for `users` is "both, and we cannot tell which".

**Nothing in AquinTutor identity references an EduRankAI table** — not by foreign key, not by join. A
foreign key from `aq_users` to `users` would make that restore fail, and the failure would arrive on
migration day rather than today.

## What is duplicated, and what is not

**Duplicated on purpose:** identity. A person who works for EduRankAI and teaches on AquinTutor has
two accounts, because they are two organisations. That is the point of the separation, not a
shortcoming of it.

**Not duplicated:** course content, lessons, enrolments. These live in `training_*` and `kernel_*`,
are shared while the database is shared, and move with AquinTutor at the split. That is a data
migration, not an identity one, and mixing the two makes both harder.

## The rule that will be hardest to keep

**No bridge.** No "if they are a super admin over there". No fallback to `Astro.locals.user`.

The temptation peaks during the transition, when the founder has to sign in twice. It has to be
resisted: a bridge added for convenience is indistinguishable, in code and in consequence, from the
coupling this separation exists to remove.

`resolveAquinUser()` takes a **token**, not a user object. There is deliberately no overload that
accepts an EduRankAI principal, because that is what a bridge would look like on the day somebody
adds one.

## Authority inside AquinTutor

- `super_admin` — full control, **including who else may administer**. Only this role grants
  admin-surface roles.
- `admin` — runs the platform; cannot appoint administrators. Otherwise `admin` is `super_admin`
  under another name and the distinction lasts until the first person notices.
- `teacher`, `partner`, `moderator` — admin surface, scoped.
- `learner`, `guest` — main surface, never reach the admin.

Account creation may set **main-surface roles only**. The first draft refused only `super_admin`;
its own test caught that `admin` was equally self-grantable. Administration is granted by an existing
super admin through `assignRole()`, the only path that records who granted it.

The **last super admin cannot be removed**, including by themselves — an AquinTutor with nobody able
to grant a role needs a database console to recover.

## Still to do

1. **Bootstrap the first super admin** — a one-time, guarded route; nobody can sign in until it runs.
2. **Wire the middleware** to resolve `Astro.locals.aquin` on AquinTutor hosts.
3. **`/aquintutor/login`** and its own session cookie handling.
4. **The admin shell** — its own layout and nav, not `AdminLayout`.
5. **Port the 10 existing admin pages** off `Astro.locals.user` onto the AquinTutor principal.
6. **Point aquintutor.com at the Vercel project** and confirm the host resolves.

Steps 1 to 3 are the gate: until they exist, aquintutor.com has an identity domain with no way in.
