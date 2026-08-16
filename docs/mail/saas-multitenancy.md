# EduRankAI Mail — multi-tenancy, plans, entitlements and billing

The commercial layer: `src/lib/mailplatform/saas/`.

It answers one question for the rest of the platform — **may this tenant do this, right now?** — and
records what they did so it can be billed for. Everything else in the mail platform (SMTP, webmail,
campaigns, automation, the transactional API) asks that question through two functions and never
decides for itself.

```ts
import { checkCapability, meter, usageKey } from '@/lib/mailplatform/saas';

// BEFORE the work
const decision = await checkCapability(orgId, userId, 'campaign.send', { amount: recipients });
if (!decision.allowed) return refuse(decision.message);   // a sentence written for a person

// AFTER it
await meter(orgId, {
  metric: 'emails_sent',
  quantity: recipients,
  source: 'campaign-worker',
  idempotencyKey: usageKey('campaign.sent', campaignId),  // identifies the FACT, not the attempt
});
```

---

## 1. The shape

```
Organization (tenant)
├── OrgProfile          type, billing email, currency, country
├── Members             nine team roles, on top of the platform contract's five
├── Teams               scope membership; never grant capability on their own
├── Subscription        plan, status, period, custom limits, provider
├── Usage events        append-only, idempotent, the only source of a usage number
├── Usage counters      a CACHE of the above, rebuildable at any time
├── Quota notices       one warning per threshold per period
├── Billing events      provider and platform facts, unique per (provider, eventId)
├── Invoices            integers in minor units
└── EnterpriseTerms     SLA, dedicated infrastructure, retention, contract reference
```

| Layer | Files | Database? |
|---|---|---|
| Domain model | `types.ts` | no |
| Roles and permissions | `roles.ts` | no |
| Plan catalog and limits | `plans.ts` | no |
| Prices | `pricing.ts` | no |
| Period maths and rollup | `usage.ts` | no |
| Quota decisions | `quota.ts` | no |
| Entitlement engine | `entitlements.ts` | no |
| Billing seam and reducer | `billing.ts` | no |
| Persistence interface + memory store | `store.ts` | no |
| Postgres store | `pg-store.ts` | yes |
| Orchestration | `service.ts` | through the store |

Everything above `pg-store.ts` is pure. That is what lets 155 tests cover the layer without a
database — which matters here, because this repository forbids connecting to the production one.

---

## 2. Tenant isolation

Four mechanisms, deliberately overlapping.

1. **The signature.** Every store method takes `orgId` as its first positional argument. Not a field
   on an options object that can be omitted — an argument the compiler insists on.
2. **The engine.** `checkEntitlement()` refuses `org_mismatch` at step two, before it reads a single
   number belonging to the tenant. A refusal for an outsider carries no usage figures at all.
3. **Resolution from membership.** `resolveTenantForUser(userId, requestedOrgId)` returns `null`
   unless a live membership row says the user belongs there. A user with no membership gets `null`,
   never a default tenant.
4. **A test that reads the SQL.** `saas-tenancy.test.ts` parses `pg-store.ts`, finds every statement
   against a tenant-scoped table, and fails if one has no `org_id` in its predicate — including
   `WHERE id = $1` on a table whose ids are unique, because a unique id still belongs to somebody.

One query is deliberately cross-tenant: the lookup that discovers which tenants a user belongs to.
It is exempted by a `-- CROSS-TENANT BY DESIGN:` marker **inside the SQL**, so the exemption is
visible to anybody reading the query rather than parked in a list somewhere else.

---

## 3. Roles

Nine team roles, in `mp_organization_members.team_role` — an **additive** column beside the platform
contract's five-value `role`, which other subsystems compile against and this patch must not widen.
`platformRoleFor()` maps the nine down to the five, always **narrowing**: `viewer` becomes `analyst`,
not `member`, because the contract's `member` can send mail and a Viewer must not.

| Role | Holds | Notably does not |
|---|---|---|
| Owner | everything, including `billing.manage` | — |
| Admin | everything except changing the plan | `billing.manage` |
| Mail Admin | mailboxes, domains, deliverability | send a campaign |
| Campaign Manager | campaigns, contacts, templates, automation | mailbox or domain administration |
| Developer | API keys, webhooks, `mail.send` | `mail.read` |
| Analyst | reports and aggregates | `mail.read` |
| Support Agent | reads and replies in a shared mailbox, edits contacts | campaigns, configuration |
| Member | own mailbox, shared templates | administration |
| Viewer | read-only reports, campaigns, templates | `mail.read` — anything at all in a mailbox |

**Viewer and Analyst deliberately do not hold `mail.read`.** It sounds like the safest role in the
product; if it carried `mail.read` it would be the most dangerous one, because an organization hands
it to a contractor expecting dashboards and the contractor can read the founder's inbox.

Two rules are enforced in `roles.ts` and cannot be bypassed by any screen:

- **Nobody grants what they do not hold.** Only an Owner makes an Owner; everybody else assigns
  strictly below their own rank, so an Admin cannot mint another Admin.
- **The last Owner cannot be removed or demoted.** An organization with no owner is one nobody can
  pay for, change or close — a support ticket that needs a database write to resolve.

---

## 4. Usage metering

Twelve metrics from the brief, plus `users`, `teams` and `automations` — because the plan limits name
them, and a limit with no metric behind it cannot be enforced.

**Counters accumulate over a period and reset at the boundary. Gauges are levels that carry forward.**

```
COUNTER  emails_sent, emails_received, attachments, api_calls, webhook_deliveries,
         automation_runs, ai_units, campaign_recipients
GAUGE    contacts, mailboxes, domains, storage_bytes, users, teams, automations
```

Rolling a gauge up like a counter is the classic metering bug: it makes a tenant who created and
deleted one mailbox each week look like they hold four, and it always errs in the vendor's favour.
The distinction is in the type system (`MetricDescriptor.kind`), and both `rollup()` and the quota
engine read it.

### Durable events, not counters

`mp_usage_events` is append-only and is the record. `mp_usage_counters` is a cache of it, and
`reconcile()` rebuilds the cache from the events and reports every difference it found. A number
that cannot be traced back to the events that produced it cannot be defended in a billing dispute,
and in a billing dispute the customer is right by default.

### Idempotency

`usageKey('message.sent', messageId)` — the key identifies the **fact**. Never put a timestamp or a
random value in it: a key that differs between retries is not an idempotency key, it is a slower way
of writing two rows, and it looks like it works because both writes succeed. A partial unique index
on `(org_id, idempotency_key)` makes the database decide the duplicate, not a read-then-write in
application code that two concurrent workers both pass.

### Drift

A mailbox deleted by a subsystem that forgot to emit an event leaves the gauge one too high forever.
A reconciler counts the rows and emits `{ mode: 'set', quantity: 42 }`, and the meter is correct
again — without anybody editing a counter by hand in production.

### Periods

Monthly, anchored on the subscription start, half-open `[start, end)`. A month-end anchor clamps
(31 January → 28 February) rather than rolling over, which is what JavaScript's default would do and
would make two periods overlap.

**Boundaries are UTC for every tenant.** `OrgProfile.timezone` is recorded and displayed but does not
move the boundary. Doing it per-tenant properly needs a timezone database at the edge of every quota
check; half-doing it produces a boundary that is wrong twice a year for exactly the tenants who send
the most. The admin screens say "UTC" next to the period so nobody is surprised.

---

## 5. Plans

Five catalog plans (`free`, `starter`, `professional`, `business`, `enterprise`) plus per-tenant
custom plans in `mp_plans` for negotiated contracts.

**A plan is data.** Nothing in the layer says `if (plan === 'professional')`. Everything a plan
changes is a limit number or a feature flag, so a new plan is a new row and no engine changes.

**`null` means unlimited. `0` means not included.** They look alike in a truthiness test and mean
opposite things; every read goes through an explicit `=== null` check, and `saas-plans.test.ts`
asserts both directions.

**Prices live in `pricing.ts` and no engine imports it** — asserted by a test that reads the engines'
source. The moment a quota check can read a price, the two become impossible to change apart, and
prices vary by market, currency and negotiated contract while limits do not. Amounts are integers in
minor units; floating-point money is how `1199.99` becomes `1199.9899999999998` on a legal document.

**Organization type supplies defaults only.** A university on Free gets exactly what a startup on
Free gets. `saas-quota.test.ts` asserts the engine returns identical answers across all seven types
with the plan held constant.

### Custom limits

`mp_subscriptions.custom_limits` is merged over the plan's. A field **absent** means "use the plan's
number"; a field set to **`null`** means "negotiated to unlimited". `resolveLimits()` walks the keys
rather than spreading, because a spread collapses `undefined` and `null` together and the tenant
loses the limit entirely.

---

## 6. Entitlements

One function, one order, every caller:

```
1. Is there a caller at all?                    -> no_principal
2. Is the caller inside this tenant?            -> org_mismatch     (isolation, before any read)
3. Is the organization active?                  -> org_suspended
4. Is the subscription serviceable?             -> subscription_inactive
5. Does this person hold the permission?        -> permission
6. Does the plan include it?                    -> plan   (+ upgradeToPlanKey)
7. Is there quota left?                         -> limit  (+ metric, + upgradeToPlanKey)
```

**Permission is checked before plan, deliberately.** An Analyst asking to send a campaign is told
they are not allowed to — not offered an upgrade. Quoting a price at somebody who lacks the
permission sends them to their Admin asking to spend money that would not have helped.

`explainAll()` decides every capability at once. That is what the admin billing screen renders: a
matrix of every premium capability, whether this tenant has it, and the reason when they do not.

---

## 7. Quota, overage and suspension

| State | Meaning |
|---|---|
| `ok` | below every warning threshold |
| `warning` | past 80% or 95% of the limit |
| `soft_exceeded` | past the limit, inside the burst ceiling — allowed, recorded as overage |
| `hard_exceeded` | past the ceiling (or the limit, for a hard metric) — refused |

Soft metrics: sending, API calls, webhook deliveries, campaign recipients, AI units, with a 10%
ceiling. Everything else is hard. The Free plan has no burst room at all.

**Strictly greater than, not `>=`.** A limit of 10,000 means the ten-thousandth message is allowed
and the ten-thousand-and-first is not. Reading `>=` here withholds the last unit of every allowance
the customer bought, which reads as deliberate.

**The check projects forward.** `canConsume(metric, used, ..., { amount })` decides on `used +
amount`, so a campaign to 200,000 recipients cannot start because the tenant happened to be at 99%
when it began — a campaign, once started, cannot be taken back out of people's inboxes.

### Critical transactional mail is never silently blocked

Section 8 of the brief, and the strongest rule in this layer. Out of quota, a **critical**
transactional send is **allowed**, marked as overage, and reported with a sentence saying so. A
password reset that silently fails to send is somebody else's user locked out of their account, and
they cannot upgrade the plan to fix it.

It can be blocked only when a tenant has explicitly set `blockTransactionalOnHardLimit` — a
deliberate, recorded, per-tenant decision — and even then the refusal says why.

**Only `mail.send` and `api.send` may claim the carve-out** (`criticalEligible` in the capability
registry). Without that, `critical: true` on a campaign send would be a one-line bypass of every
sending limit in the product.

### Warnings and suspension

Thresholds fire on the **transition** (`crossedThresholds(before, after, ...)`), recorded through a
unique index so the same warning cannot be sent twice in a period. Without that, a tenant sitting at
96% is told "you have used 95%" for every message they send for the rest of the month, which trains
them to filter the one message that mattered.

`past_due` **is serviceable**. A failed card is a card problem, not a decision to stop being a
customer. `suspensionAdvice()` counts down through a seven-day grace window and returns advice with
a reason in words; it never suspends anything itself. A suspended tenant keeps `mail.read`,
`analytics.view`, `billing.manage`, `org.manage` and `team.manage` — the actions that FIX a
suspension are billing and administration, and locking those behind it leaves no way out except a
support ticket.

---

## 8. Billing

### The seam

`BillingProvider` — `createCheckout`, `changePlan`, `cancelSubscription`, `listInvoices`,
`verifyWebhook`. Every method returns an `OperationResult` rather than throwing: a declined card and
an unreachable provider are ordinary Tuesdays, and turning them into exceptions is how they end up
in somebody's `catch {}`.

**`ManualBillingProvider` is the only implementation shipped, and it is not a placeholder.** An
enterprise customer on thirty-day terms, a university paying by purchase order, a partner settling
quarterly — none of those touch a card gateway, and all are real customers of a product shaped like
this one. It reports `enabled: true` because it genuinely works.

**No Razorpay or Stripe adapter is written.** The brief says not to implement provider-specific code
unless it fits the abstraction, and writing one now would mean guessing at which account, which keys
and which webhook secret — while this repository already holds live Razorpay credentials for a
different product that a guessed adapter would happily have charged against. `billingProviderStatus()`
reports both as `enabled: false` with the reason. `/api/v1/billing/webhook` answers **501** for an
unregistered provider rather than accepting an unverifiable event.

### The reducer

`applyBillingEvent(subscription, event)` is pure and has two properties, both tested:

- **Idempotent.** The same event applied twice produces the same subscription. Providers retry; a
  retry that cancels a subscription twice is a customer-visible error of our own making.
- **Ordered.** Staleness is decided against `subscription.lastBillingEventAt` — the **provider's**
  timestamp on the last event applied. Comparing against `updatedAt` would put the platform's clock
  on one side and the provider's on the other, and every event would look older than the row it is
  about to change.

An event naming another tenant is refused. Tenant isolation reaches billing too, however well the
webhook was signed.

### Upgrades and downgrades

**Upgrades apply immediately. Downgrades apply at period end.** The asymmetry is not indecision: an
upgrade is somebody choosing to pay for more and they should have it within the second; a downgrade
mid-period would confiscate capacity already paid for, and the customer would meet it as a failed
send rather than as a billing change. A scheduled downgrade is cancelled by selecting the current
plan again.

### Events

`subscription.created` · `subscription.updated` · `subscription.cancelled` · `payment.succeeded` ·
`payment.failed` · `plan.changed` · `usage.threshold_reached`

Unique on `(provider, event_id)`. A duplicate is reported as `duplicate: true` and answered **200** —
a provider retrying is correct behaviour, and answering an error to a correctly-delivered repeat
causes a retry storm over an event already applied. An event that cannot be applied is **stored with
its reason** and answered 202; it is never dropped.

---

## 9. Enterprise

- Custom plans in `mp_plans`, per tenant, resolved ahead of the catalog plan with the same key.
- Custom limits and custom overage policy on the subscription.
- `mp_enterprise_terms`: SLA uptime and response, dedicated infrastructure, dedicated IPs, custom
  SMTP host, retention days, data region, contract reference and end date.

All of it is descriptive — no engine branches on enterprise terms. They are contract text, shown on
the billing screen so support can read them out.

---

## 10. Surfaces

### Admin (operator console)

| URL | What it does |
|---|---|
| `/admin/mail/tenants` | Every organization, create one, manage its team and roles, see the role matrix |
| `/admin/mail/billing` | Plan, usage against limits, sending trend, capability matrix, invoices, providers, billing history, change the plan |

Both are gated by the repository's own `can(user, 'mail.manage')` and both state on screen that the
viewer is acting as **platform staff, not as a member**. Decisions there run through `asOperator:
true` — a deliberate widening, kept in its own function (`operatorActor()`) so it cannot be reached
by accident, and anything changed is recorded as `actorKind: 'operator'` in the tenant's history.

### API

| Route | Purpose |
|---|---|
| `GET/POST /api/v1/organizations` | The tenants you belong to; create one |
| `GET/POST/PATCH/DELETE /api/v1/organizations/members` | The team and its roles |
| `GET/POST /api/v1/billing` | The whole billing picture; change the plan |
| `GET/POST /api/v1/billing/entitlements` | The capability matrix; ask about one capability |
| `POST /api/v1/billing/webhook?provider=…` | Verified provider events only |

The organization list is **only the tenants the caller belongs to**. A complete tenant list is a
customer list, and handing one to any authenticated caller is the cheapest possible
competitive-intelligence exercise.

Asking is not consuming: neither entitlement verb records usage, so a UI can re-render freely.

---

## 11. Schema

Eleven tables, all `mp_`-prefixed, plus one additive column (`team_role`) on the core agent's
`mp_organization_members`.

```
mp_org_profiles  mp_teams  mp_team_members  mp_plans  mp_subscriptions
mp_enterprise_terms  mp_usage_events  mp_usage_counters  mp_quota_notices
mp_billing_events  mp_invoices
```

`mp_organizations` and `mp_organization_members` belong to `src/lib/mailplatform/schema.ts` and are
**not** redefined here — `ensureSaasSchema()` calls `ensureMailPlatformSchema()` first and then adds
only what is missing. Two `IF NOT EXISTS` definitions of one table means whichever runs first wins
silently and the other's constraints never exist; theirs enforces membership uniqueness with a
partial index, which a duplicate definition would have quietly replaced.

Organization creation, member add and member remove are **delegated** to `../orgs.ts` rather than
reimplemented, so slug rules, soft-delete restore and the store-level last-owner refusal have one
home.

### Applying it

**You do not have to.** `ensureSaasSchema()` runs on first use, so deploying the code is enough —
the first request that touches a SaaS table creates all eleven.

To apply it ahead of time instead, use the runner. It needs no `psql` and nothing installed;
everything it uses is already in `node_modules`:

```powershell
npx tsx .dev-scripts/apply-mail-schema.mjs --dry-run   # connect, report, write nothing
npx tsx .dev-scripts/apply-mail-schema.mjs             # platform schema, then SaaS
```

It applies the TypeScript arrays (`MP_DDL`, `MP_TRIGGERS`, `SAAS_DDL`) rather than the generated
`.sql` files, so what it does and what the running application does cannot differ — and nothing has
to be split, which matters because `db/mail-platform-schema.sql` carries `$mp$ … $mp$` trigger
bodies whose inner semicolons a naive split on `;` shatters. Afterwards it reads `information_schema`
back and prints what actually changed, rather than reporting success because nothing threw.

If you do have `psql`, note that `$DATABASE_URL` is bash — PowerShell wants `$env:DATABASE_URL`:

```powershell
npm run mail:saas-schema                                   # regenerate the .sql from SAAS_DDL
psql $env:DATABASE_URL -f db/mail-platform-schema.sql      # first
psql $env:DATABASE_URL -f db/mail-saas-schema.sql          # then this
```

Neither this documentation nor the generator connects to a database. The runner does, when you run
it.

---

## 12. Tests

`npx vitest run src/lib/mailplatform/saas/` — 155 tests, no database.

| File | Covers |
|---|---|
| `saas-plans.test.ts` | metric registry, null-vs-zero, limit resolution, upgrade ladder, role matrix, assignment authority, last-owner, the no-prices-in-engines assertion |
| `saas-usage.test.ts` | month clamping, half-open periods, counter/gauge rollup, drift correction, idempotency keys, threshold transitions, trends |
| `saas-quota.test.ts` | soft/hard/warn states, forward projection, the transactional carve-out and its anti-abuse rule, rate limits, suspension advice, entitlement order, org-type invariance |
| `saas-tenancy.test.ts` | isolation through the real service, plan restrictions, usage from events, quota enforcement, seat limits, membership rules, upgrade/downgrade/renewal, payment failure, concurrent metering, webhook idempotency, and the SQL source scan |

`saas-tenancy.test.ts` runs the **real** functions from `service.ts` with `MemorySaasStore` swapped
in. Nothing re-implements the logic it is testing — a test that does passes when the real code is
broken, which is worse than no test at all.

---

## 13. What is deliberately not here

- **No payment-provider adapter.** The seam is finished; choosing an account and a webhook secret is
  a decision with a person's name on it, not something a patch takes on its own initiative.
- **No per-tenant timezone billing boundaries.** UTC, documented, stated on screen.
- **No automatic suspension.** `suspensionAdvice()` returns advice; a caller acts and records it.
- **No invoice generation or tax calculation.** `invoiceTotals()` takes tax as an input rather than
  guessing at a rate that depends on the customer's country, registration and what is being sold.
- **No changes to the platform contract** in `src/lib/mailplatform/types.ts`, and no second
  definition of any table another agent owns.
