// src/lib/mailint/router.ts — THE EVENT ROUTER, at runtime.
//
// One entry point, emitEvent(), and it does four things in this order:
//
//   1. VALIDATE against the catalogue (events.ts). An unknown type or a missing required field is
//      refused with a message naming the field — never stored, never routed.
//   2. DEDUPLICATE by inserting with ON CONFLICT DO NOTHING on (org, environment, idempotency_key).
//      Section 9 of the brief — "duplicate events must not create duplicate emails" — is kept HERE,
//      by the database, before any action runs. A duplicate returns ok with `duplicate: true` and
//      the id of the original, and causes nothing.
//   3. PLAN, with the pure functions in routing.ts.
//   4. ACT, recording every action in mailint_route_runs whether it succeeded or not.
//
// STEP 2 BEFORE STEP 4 IS THE WHOLE DESIGN. Any other order — check after acting, or check in
// application code with a SELECT — leaves a window where two concurrent deliveries of the same
// webhook both send the candidate the same rejection.
//
// AN ACTION THAT FAILS DOES NOT FAIL THE EVENT. The fact happened; it is stored; the failing action
// is recorded with its reason and the others still run. The alternative — one bad template rolls
// back an event that a webhook consumer has already been told about — is not recoverable.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ensureMailIntSchema, rows, dbReason } from './schema';
import {
  validateEvent,
  webhookBody,
  type CanonicalEvent,
} from './events';
import { planRoutes, resolveConfigPaths, type EventRoute } from './routing';
import { fanoutEvent } from './fanout';
import { stepOutcome } from './policy';
import { renderHtml, renderSubject, renderText, type MergeVars } from '@/lib/mail-personalize';

export type Environment = 'development' | 'production';

export interface EmitOptions {
  environment: Environment;
  integrationId?: string | null;
  /** Skip the actions and only record the fact. Used by the import path for backfills. */
  recordOnly?: boolean;
  now?: number;
}

export interface EmitResult {
  ok: boolean;
  eventId?: string;
  duplicate?: boolean;
  errors?: string[];
  actions?: { route: string; action: string; status: string; detail: string }[];
  skipped?: { routeName: string; reason: string }[];
}

// ---------------------------------------------------------------------------------------------
// Organisations
// ---------------------------------------------------------------------------------------------

export interface OrgRow { id: string; slug: string; name: string; isActive: boolean }

/**
 * The organisation an integration belongs to.
 *
 * An "organisation" here is a SENDING PRODUCT — Careers, AquinTutor, the university systems — not a
 * customer account. It exists so a key, a route, an endpoint and an event all have one owner, and
 * so one product's bad afternoon cannot spend another product's rate limit.
 */
export async function getOrCreateOrg(slug: string, name?: string): Promise<OrgRow | null> {
  await ensureMailIntSchema();
  const s = String(slug || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 60);
  if (!s) return null;
  try {
    const r = await db.execute(sql`
      INSERT INTO mailapi_orgs (slug, name) VALUES (${s}, ${String(name || s)})
      ON CONFLICT (slug) DO UPDATE SET updated_at = now()
      RETURNING id, slug, name, is_active
    `);
    const row = rows(r)[0];
    return row ? { id: String(row.id), slug: String(row.slug), name: String(row.name), isActive: !!row.is_active } : null;
  } catch (e: any) {
    console.error('[mailint/router] org resolve failed:', dbReason(e));
    return null;
  }
}

export async function listOrgs(): Promise<OrgRow[]> {
  await ensureMailIntSchema();
  try {
    const r = await db.execute(sql`SELECT id, slug, name, is_active FROM mailapi_orgs ORDER BY created_at ASC LIMIT 100`);
    return rows(r).map((row) => ({ id: String(row.id), slug: String(row.slug), name: String(row.name), isActive: !!row.is_active }));
  } catch (e: any) {
    console.error('[mailint/router] org list failed:', dbReason(e));
    return [];
  }
}

/**
 * The organisation's slug, cached per process.
 *
 * The webhook envelope carries `organization: <slug>` (buildEnvelope in the transactional API
 * layer), so every fan-out needs it. Reading it per event would be a second query on the hot path
 * for a value that changes approximately never.
 */
const SLUG_CACHE = new Map<string, string>();

export async function orgSlug(orgId: string): Promise<string> {
  const hit = SLUG_CACHE.get(orgId);
  if (hit) return hit;
  try {
    const r = await db.execute(sql`SELECT slug FROM mailapi_orgs WHERE id = ${orgId}::uuid LIMIT 1`);
    const slug = String(rows(r)[0]?.slug || '');
    if (slug) SLUG_CACHE.set(orgId, slug);
    return slug;
  } catch (e: any) {
    console.error('[mailint/router] org slug read failed:', dbReason(e));
    return '';
  }
}

// ---------------------------------------------------------------------------------------------
// Emit
// ---------------------------------------------------------------------------------------------

export async function emitEvent(input: Partial<CanonicalEvent>, opts: EmitOptions): Promise<EmitResult> {
  const now = opts.now ?? Date.now();
  const validation = validateEvent(input, now);
  if (!validation.ok || !validation.normalized) {
    return { ok: false, errors: validation.errors };
  }
  const event = validation.normalized;
  await ensureMailIntSchema();

  // ---- 2. store, or discover that we already had it ------------------------------------------
  let eventId = '';
  let duplicate = false;
  try {
    const r = await db.execute(sql`
      INSERT INTO mailint_events
        (org_id, environment, event_type, source, integration_id, entity_type, entity_id, actor_type, actor_id, payload, idempotency_key, external_event_id, occurred_at)
      VALUES (
        ${event.orgId}::uuid, ${opts.environment}, ${event.type}, ${String(event.source)},
        ${opts.integrationId || null}::uuid, ${event.entityType || null}, ${event.entityId || null},
        ${event.actorType || 'system'}, ${event.actorId || null},
        ${JSON.stringify(event.payload)}::jsonb, ${event.idempotencyKey}, ${event.externalEventId || null},
        ${event.occurredAt}::timestamptz
      )
      ON CONFLICT (org_id, environment, idempotency_key) DO NOTHING
      RETURNING id
    `);
    const inserted = rows(r)[0];
    if (inserted) {
      eventId = String(inserted.id);
    } else {
      duplicate = true;
      const existing = rows(await db.execute(sql`
        SELECT id FROM mailint_events
        WHERE org_id = ${event.orgId}::uuid AND environment = ${opts.environment} AND idempotency_key = ${event.idempotencyKey}
        LIMIT 1
      `))[0];
      eventId = existing ? String(existing.id) : '';
    }
  } catch (e: any) {
    console.error('[mailint/router] event insert failed:', dbReason(e));
    return { ok: false, errors: ['The event could not be stored: ' + dbReason(e)] };
  }

  // A duplicate is a SUCCESS with nothing done. The caller retried; we already have the fact; no
  // action runs a second time. Reporting this as an error would make well-behaved senders — the
  // ones that retry on a timeout — look broken.
  if (duplicate) return { ok: true, eventId, duplicate: true, actions: [] };
  if (opts.recordOnly) return { ok: true, eventId, duplicate: false, actions: [] };

  // ---- 3. plan --------------------------------------------------------------------------------
  const routes = await loadRoutes(event.orgId, opts.environment);
  const stored: CanonicalEvent & { id: string } = { ...event, id: eventId };
  const plan = planRoutes(stored, routes);

  // ---- 4. act ---------------------------------------------------------------------------------
  const actions: NonNullable<EmitResult['actions']> = [];

  // The webhook channel fans out even with no route configured: an endpoint subscribes to an event
  // type directly, which is what a developer expects after creating one in the console. A `webhook`
  // ROUTE exists for the narrower case of sending to one specific endpoint.
  const hasWebhookRoute = plan.actions.some((a) => a.action === 'webhook');
  const slug = await orgSlug(event.orgId);
  if (!hasWebhookRoute) {
    const fan = await fanoutEvent(stored, { environment: opts.environment, orgSlug: slug });
    if (fan.queued || fan.skipped.length) {
      const detail = 'queued for ' + fan.queued + ' endpoint' + (fan.queued === 1 ? '' : 's')
        + (fan.redacted.length ? '; ' + fan.redacted.length + ' received a redacted payload' : '');
      actions.push({ route: '(subscriptions)', action: 'webhook', status: 'ok', detail });
      await recordRun(stored, opts.environment, null, '(subscriptions)', 'webhook', 'ok', detail, { queued: fan.queued, redacted: fan.redacted, skipped: fan.skipped });
    }
  }

  for (const a of plan.actions) {
    const started = Date.now();
    let status = 'ok';
    let detail = '';
    let result: Record<string, unknown> = {};
    try {
      const out = await executeAction(a.action, a.config, { ...stored, payload: a.payload }, { ...opts, orgSlug: slug });
      status = out.ok ? 'ok' : 'failed';
      detail = out.detail;
      result = out.result || {};
    } catch (e: any) {
      // An action that throws is a bug in an action, not a reason to lose the event.
      status = 'failed';
      detail = String(e?.cause?.message || e?.message || e).slice(0, 300);
      console.error('[mailint/router] action', a.action, 'threw:', detail);
    }
    actions.push({ route: a.routeName, action: a.action, status, detail });
    await recordRun(stored, opts.environment, a.routeId, a.routeName, a.action, status, detail, result, Date.now() - started);
  }

  return {
    ok: true,
    eventId,
    duplicate: false,
    actions,
    skipped: plan.skipped.map((s) => ({ routeName: s.routeName, reason: s.reason })),
  };
}

async function recordRun(
  event: CanonicalEvent & { id: string },
  environment: string,
  routeId: string | null,
  routeName: string,
  action: string,
  status: string,
  detail: string,
  result: Record<string, unknown> = {},
  durationMs?: number,
): Promise<void> {
  try {
    await db.execute(sql`
      INSERT INTO mailint_route_runs (org_id, environment, event_id, route_id, route_name, action, status, detail, result, duration_ms)
      VALUES (
        ${event.orgId}::uuid, ${environment}, ${event.id}::uuid, ${routeId ? routeId : null}::uuid, ${routeName},
        ${action}, ${status}, ${String(detail || '').slice(0, 500)}, ${JSON.stringify(result)}::jsonb, ${durationMs ?? null}
      )
    `);
  } catch (e: any) {
    // The run log failing must not fail the run it is describing, but it is never silent: an event
    // whose effects are invisible is the state this table exists to prevent.
    console.error('[mailint/router] route run not recorded:', dbReason(e));
  }
}

export async function loadRoutes(orgId: string, environment: string): Promise<EventRoute[]> {
  try {
    const r = await db.execute(sql`
      SELECT * FROM mailint_routes
      WHERE org_id = ${orgId}::uuid AND environment = ${environment} AND is_active = true
      ORDER BY priority ASC, name ASC
    `);
    return rows(r).map((row) => ({
      id: String(row.id),
      orgId: String(row.org_id),
      name: String(row.name),
      eventPattern: String(row.event_pattern),
      action: String(row.action) as EventRoute['action'],
      config: parseJson(row.config, {}),
      conditions: parseJson(row.conditions, []),
      isActive: !!row.is_active,
      priority: Number(row.priority || 100),
      stopOnMatch: !!row.stop_on_match,
    }));
  } catch (e: any) {
    console.error('[mailint/router] route load failed:', dbReason(e));
    return [];
  }
}

function parseJson<T>(v: any, fallback: T): T {
  if (v === null || v === undefined) return fallback;
  if (typeof v === 'object') return v as T;
  try { return JSON.parse(String(v)) as T; } catch { return fallback; }
}

// ---------------------------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------------------------

interface ActionOutcome { ok: boolean; detail: string; result?: Record<string, unknown> }

/** EmitOptions plus the resolved slug, so an action never re-reads it. */
interface ActionOptions extends EmitOptions { orgSlug?: string }

async function executeAction(
  action: string,
  config: Record<string, unknown>,
  event: CanonicalEvent & { id: string },
  opts: ActionOptions,
): Promise<ActionOutcome> {
  switch (action) {
    case 'webhook': return webhookAction(config, event, opts);
    case 'email': return emailAction(config, event, opts);
    case 'campaign': return campaignAction(config, event, opts);
    case 'workflow': return workflowAction(config, event, opts);
    case 'analytics': return analyticsAction(config, event, opts);
    default: return { ok: false, detail: '"' + action + '" is not an action this router knows.' };
  }
}

async function webhookAction(config: Record<string, unknown>, event: CanonicalEvent & { id: string }, opts: ActionOptions): Promise<ActionOutcome> {
  const fan = await fanoutEvent(event, { environment: opts.environment, orgSlug: opts.orgSlug || (await orgSlug(event.orgId)) });
  const target = config.endpointId ? String(config.endpointId) : null;
  if (target) {
    // A route naming one endpoint still goes through the same fan-out — the endpoint must still be
    // subscribed to the event. A route cannot override a subscription; that is the endpoint owner's
    // decision, not the routing admin's.
    return { ok: true, detail: 'queued through the subscription fan-out (' + fan.queued + ')', result: { queued: fan.queued, endpointId: target } };
  }
  return { ok: true, detail: 'queued for ' + fan.queued + ' endpoint' + (fan.queued === 1 ? '' : 's'), result: { queued: fan.queued, skipped: fan.skipped } };
}

/**
 * Send one message because of one event.
 *
 * Template resolution, in order: a published version of a template key in mailapi_templates, then
 * the inline `subject` + `html` on the route. Inline exists because the first useful route somebody
 * writes is usually two lines of copy, and forcing a template round trip to get there is how the
 * feature goes unused.
 */
async function emailAction(config: Record<string, unknown>, event: CanonicalEvent & { id: string }, opts: ActionOptions): Promise<ActionOutcome> {
  const resolved = resolveConfigPaths(config, ['to', 'from', 'replyTo'], event.payload);
  const to = resolved.to || String(event.payload.email || '');
  if (!to || !/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(to)) {
    return { ok: false, detail: 'No usable recipient. The route reads `to` from ' + String(config.to || '$.email') + ', which produced ' + JSON.stringify(resolved.to) + '.' };
  }

  const vars = mergeVarsFor(event);
  let subject = '';
  let html = '';
  let text: string | undefined;

  const templateKey = config.template ? String(config.template) : '';
  if (templateKey) {
    const tpl = await loadTemplate(event.orgId, opts.environment, templateKey);
    if (!tpl) return { ok: false, detail: 'Template "' + templateKey + '" has no published version in the ' + opts.environment + ' environment.' };
    subject = renderSubject(tpl.subject, vars);
    html = renderHtml(tpl.html, vars);
    text = tpl.text ? renderText(tpl.text, vars) : undefined;
  } else {
    if (!config.subject || !config.html) {
      return { ok: false, detail: 'This route has neither a template key nor an inline subject and body.' };
    }
    subject = renderSubject(String(config.subject), vars);
    html = renderHtml(String(config.html), vars);
  }

  // DEVELOPMENT KEYS DO NOT SEND MAIL. A sandbox that quietly delivers to a real address is not a
  // sandbox, and this is the exact place that mistake would be made.
  if (opts.environment !== 'production') {
    return {
      ok: true,
      detail: 'Rendered but not sent: this is the development environment. Subject: "' + subject.slice(0, 80) + '" to ' + to,
      result: { simulated: true, to, subject },
    };
  }

  try {
    const { sendExternal } = await import('@/lib/mail-transport');
    const { getMailConfig, MAIL_DOMAIN } = await import('@/lib/mail');
    const cfg = await getMailConfig();
    const fromAddress = resolved.from || cfg.fromAddress || ('no-reply@' + MAIL_DOMAIN);
    const r = await sendExternal({
      from: fromAddress,
      to,
      subject,
      html,
      text,
      replyTo: resolved.replyTo || undefined,
    });
    if (!r.ok) return { ok: false, detail: 'The transport refused it: ' + String(r.error || 'no reason given'), result: { to, subject } };
    return { ok: true, detail: 'Sent to ' + to + ' via ' + r.provider + '.', result: { to, subject, provider: r.provider, id: r.id } };
  } catch (e: any) {
    return { ok: false, detail: 'Send failed: ' + String(e?.cause?.message || e?.message || e).slice(0, 200) };
  }
}

async function loadTemplate(orgId: string, environment: string, key: string): Promise<{ subject: string; html: string; text: string | null } | null> {
  try {
    const r = await db.execute(sql`
      SELECT v.subject, v.html, v.text
      FROM mailapi_templates t
      JOIN mailapi_template_versions v ON v.template_id = t.id
      WHERE t.org_id = ${orgId}::uuid AND t.environment = ${environment} AND t.template_key = ${key}
        AND t.is_archived = false AND v.state = 'published'
      ORDER BY v.version DESC LIMIT 1
    `);
    const row = rows(r)[0];
    return row ? { subject: String(row.subject || ''), html: String(row.html || ''), text: row.text ?? null } : null;
  } catch (e: any) {
    console.error('[mailint/router] template read failed:', dbReason(e));
    return null;
  }
}

/** Flatten an event payload into merge variables. Nested objects are addressable with dots. */
export function mergeVarsFor(event: CanonicalEvent & { id?: string }): MergeVars {
  const out: MergeVars = {
    event_type: event.type,
    event_id: event.id || '',
    occurred_at: event.occurredAt,
    entity_id: event.entityId || '',
  };
  flatten(event.payload, '', out, 0);
  return out;
}

function flatten(v: unknown, prefix: string, out: MergeVars, depth: number): void {
  if (depth > 3 || v === null || v === undefined) return;
  if (typeof v !== 'object') { if (prefix) out[prefix] = v as any; return; }
  if (Array.isArray(v)) { if (prefix) out[prefix] = v.map((x) => String(x)).join(', '); return; }
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    const key = prefix ? prefix + '.' + k : k;
    if (val !== null && typeof val === 'object') flatten(val, key, out, depth + 1);
    else out[key] = val as any;
  }
}

/**
 * The campaign channel: put this person into the audience.
 *
 * It upserts the contact, applies a tag and optionally joins a list. It deliberately does NOT start
 * a broadcast — a campaign send is a decision a human makes about a list, and an event that could
 * start one would mean a misconfigured route could mail an entire audience from a single webhook.
 *
 * THE CONTACT BOOK IS NOT WRITTEN TO DIRECTLY. createContact/setTags/addToList in
 * src/lib/mail-contacts.ts own it: they normalise the address, refuse an invalid one, keep the
 * suppression list and the contact status in agreement, and write the contact-event history that
 * /admin/mail/contacts renders. An INSERT here would have quietly bypassed all four.
 */
async function campaignAction(config: Record<string, unknown>, event: CanonicalEvent & { id: string }, _opts: ActionOptions): Promise<ActionOutcome> {
  const email = String(event.payload.email || '').trim().toLowerCase();
  if (!email) return { ok: false, detail: 'This event carries no email address, so there is nobody to add to an audience.' };

  const tag = config.addTag ? String(config.addTag) : '';
  const listId = config.addToList ? String(config.addToList) : '';
  const name = String(event.payload.name || '').trim();
  const actor = { userId: null, name: 'event router' };

  try {
    const contacts = await import('@/lib/mail-contacts');
    let contact = await contacts.getContactByEmail(email);
    let created = false;
    if (!contact) {
      const w = await contacts.createContact({
        email,
        first_name: name ? name.split(' ')[0] : null,
        last_name: name && name.includes(' ') ? name.split(' ').slice(1).join(' ') : null,
        organization: event.payload.company ? String(event.payload.company) : null,
        role_title: event.payload.role_title ? String(event.payload.role_title) : null,
        consent_source: 'event:' + event.type,
        tags: tag ? [tag] : [],
      }, actor);
      // createContact() refuses a suppressed or malformed address and SAYS WHY. That refusal is the
      // action's outcome, not something to work around by writing the row anyway.
      if (!w.ok && !w.id) return { ok: false, detail: 'The contact was not created: ' + String(w.error || 'unknown reason') };
      created = w.ok;
      contact = await contacts.getContactByEmail(email);
    } else if (tag) {
      await contacts.addTagToMany([contact.id], tag, actor);
    }
    if (!contact) return { ok: false, detail: 'The contact could not be read back after writing.' };

    if (listId) {
      const added = await contacts.addToList(listId, [contact.id], 'event:' + event.type, actor);
      return {
        ok: true,
        detail: (created ? 'Contact created' : 'Contact found') + (tag ? ', tagged "' + tag + '"' : '') + ', ' + (added ? 'added to the list' : 'already on the list') + '.',
        result: { contactId: contact.id, created, tag: tag || null, listId },
      };
    }
    return {
      ok: true,
      detail: (created ? 'Contact created' : 'Contact found') + (tag ? ' and tagged "' + tag + '"' : '') + '.',
      result: { contactId: contact.id, created, tag: tag || null },
    };
  } catch (e: any) {
    return { ok: false, detail: String(e?.cause?.message || e?.message || e).slice(0, 300) };
  }
}

/**
 * The workflow channel: an ordered sequence of steps caused by one event.
 *
 * A step is `{ delayMinutes, template | subject + html, to }`. Step 0 with no delay runs inline, so
 * "invite immediately, remind in three days" is one route rather than two. Later steps land in
 * mailint_scheduled_actions and are executed by the dispatcher cron.
 *
 * This IS what "trigger the stage 3 email workflow" means on this platform (section 8 of the
 * brief). It is not a general-purpose automation engine and does not pretend to be one: there are
 * no branches, no waits-for-another-event and no loops. What it has instead is that every step is a
 * row you can see, with the event that caused it, the time it will run and the reason the last
 * attempt failed.
 */
async function workflowAction(config: Record<string, unknown>, event: CanonicalEvent & { id: string }, opts: ActionOptions): Promise<ActionOutcome> {
  const key = String(config.workflowKey || 'workflow');
  const steps = Array.isArray(config.steps) ? (config.steps as any[]) : [];
  if (!steps.length) return { ok: false, detail: 'Workflow "' + key + '" has no steps.' };

  let immediate = 0;
  let scheduled = 0;
  const details: string[] = [];

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i] || {};
    const delayMinutes = Math.max(0, Math.floor(Number(step.delayMinutes || 0)));
    if (delayMinutes === 0) {
      const out = await emailAction(step, event, opts);
      immediate++;
      details.push('step ' + (i + 1) + ': ' + out.detail);
      // A failed FIRST step fails the whole workflow: the later steps are usually reminders about
      // something the first step was supposed to have said, and sending a reminder for a message
      // that never arrived is worse than sending nothing.
      if (!out.ok) return { ok: false, detail: details.join(' | ') };
      continue;
    }
    try {
      await db.execute(sql`
        INSERT INTO mailint_scheduled_actions
          (org_id, environment, event_id, route_id, route_name, workflow_key, step_index, action, config, payload, run_at)
        VALUES (
          ${event.orgId}::uuid, ${opts.environment}, ${event.id}::uuid, ${config.routeId ? String(config.routeId) : null}::uuid,
          ${key}, ${key}, ${i}, 'email', ${JSON.stringify(step)}::jsonb, ${JSON.stringify(event.payload)}::jsonb,
          now() + make_interval(mins => ${delayMinutes}::int)
        )
        ON CONFLICT (event_id, route_id, step_index) DO NOTHING
      `);
      scheduled++;
      details.push('step ' + (i + 1) + ': scheduled in ' + delayMinutes + ' minutes');
    } catch (e: any) {
      return { ok: false, detail: 'step ' + (i + 1) + ' could not be scheduled: ' + dbReason(e) };
    }
  }
  return { ok: true, detail: details.join(' | '), result: { workflowKey: key, immediate, scheduled } };
}

/**
 * The analytics channel.
 *
 * There is no separate metrics store, deliberately: mailint_events IS the metrics store — one
 * append-only row per fact with a wide jsonb payload, which is the shape a column store ingests
 * without remodelling. This action records the named metric and its dimensions as a route run, so
 * "how many stage changes reached assessment last week" is a query over rows that already exist
 * rather than a counter somebody has to remember to increment.
 */
async function analyticsAction(config: Record<string, unknown>, event: CanonicalEvent & { id: string }, _opts: ActionOptions): Promise<ActionOutcome> {
  const metric = String(config.metric || '');
  if (!metric) return { ok: false, detail: 'This analytics route names no metric.' };
  const by = Array.isArray(config.by) ? (config.by as string[]) : [];
  const dims: Record<string, unknown> = {};
  for (const k of by) dims[k] = (event.payload as any)[k] ?? null;
  return { ok: true, detail: 'Recorded ' + metric + (by.length ? ' by ' + by.join(', ') : '') + '.', result: { metric, dimensions: dims } };
}

// ---------------------------------------------------------------------------------------------
// Scheduled steps
// ---------------------------------------------------------------------------------------------

/**
 * Run the delayed workflow steps that are due.
 *
 * Same claim pattern as the webhook dispatcher — FOR UPDATE SKIP LOCKED, a claim stamp, and a
 * bounded attempt count — so two dispatchers running at once cannot both send step two.
 */
export async function runScheduledActions(limit = 25): Promise<{ claimed: number; sent: number; failed: number; details: string[] }> {
  await ensureMailIntSchema();
  let claimed: any[] = [];
  try {
    const r = await db.execute(sql`
      WITH due AS (
        SELECT id FROM mailint_scheduled_actions
        WHERE status = 'pending' AND run_at <= now()
          AND (claimed_at IS NULL OR claimed_at < now() - interval '5 minutes')
        ORDER BY run_at ASC
        LIMIT ${Math.max(1, Math.min(200, limit))}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE mailint_scheduled_actions s SET claimed_at = now(), attempts = s.attempts + 1
      FROM due WHERE s.id = due.id
      RETURNING s.*
    `);
    claimed = rows(r);
  } catch (e: any) {
    console.error('[mailint/router] scheduled claim failed:', dbReason(e));
    return { claimed: 0, sent: 0, failed: 0, details: ['claim failed: ' + dbReason(e)] };
  }

  let sent = 0, failed = 0;
  const details: string[] = [];
  for (const row of claimed) {
    const event: CanonicalEvent & { id: string } = {
      id: String(row.event_id),
      orgId: String(row.org_id),
      type: String(row.workflow_key || 'workflow'),
      source: 'mail',
      payload: parseJson(row.payload, {}),
      occurredAt: new Date(row.created_at || Date.now()).toISOString(),
    };
    const config = parseJson<Record<string, unknown>>(row.config, {});
    const out = await emailAction(config, event, { environment: String(row.environment) as Environment });
    try {
      if (out.ok) {
        await db.execute(sql`
          UPDATE mailint_scheduled_actions SET status = 'sent', executed_at = now(), claimed_at = NULL, last_error = NULL
          WHERE id = ${String(row.id)}::uuid
        `);
        sent++;
      } else if (stepOutcome(Number(row.attempts || 0) + 1, Number(row.max_attempts || 4)).outcome === 'dead_letter') {
        await db.execute(sql`
          UPDATE mailint_scheduled_actions SET status = 'failed', claimed_at = NULL, last_error = ${out.detail.slice(0, 400)}
          WHERE id = ${String(row.id)}::uuid
        `);
        await db.execute(sql`
          INSERT INTO mailint_dead_letter (org_id, environment, kind, ref_id, event_id, event_type, payload, attempts, last_error)
          VALUES (${String(row.org_id)}::uuid, ${String(row.environment)}, 'scheduled_action', ${String(row.id)}::uuid,
                  ${String(row.event_id)}::uuid, ${String(row.workflow_key || 'workflow')},
                  ${JSON.stringify({ config, payload: parseJson(row.payload, {}) })}::jsonb,
                  ${Number(row.attempts || 0) + 1}, ${out.detail.slice(0, 400)})
        `);
        failed++;
      } else {
        // Retry on the same exponential shape the webhook deliveries use.
        // The same backoff curve the webhook dispatcher uses, imported rather than re-tuned:
        // 5s, 30s, 2m, 10m, 30m, 2h, 6h, capped at 12h.
        const wait = stepOutcome(Number(row.attempts || 0) + 1, Number(row.max_attempts || 4)).retryInMs;
        await db.execute(sql`
          UPDATE mailint_scheduled_actions
          SET status = 'pending', claimed_at = NULL, last_error = ${out.detail.slice(0, 400)},
              run_at = now() + make_interval(secs => ${Math.round(wait / 1000)}::int)
          WHERE id = ${String(row.id)}::uuid
        `);
        failed++;
      }
    } catch (e: any) {
      console.error('[mailint/router] scheduled state not written:', dbReason(e));
    }
    details.push(String(row.workflow_key || 'workflow') + ' step ' + Number(row.step_index || 0) + ': ' + out.detail);
  }
  return { claimed: claimed.length, sent, failed, details };
}

// ---------------------------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------------------------

export async function listEvents(opts: {
  orgId: string;
  environment?: string;
  eventType?: string | null;
  entityId?: string | null;
  since?: string | null;
  limit?: number;
}): Promise<any[]> {
  await ensureMailIntSchema();
  try {
    const r = await db.execute(sql`
      SELECT id, event_type, source, entity_type, entity_id, actor_type, payload, idempotency_key,
             external_event_id, occurred_at, created_at, environment
      FROM mailint_events
      WHERE org_id = ${opts.orgId}::uuid
      ${opts.environment ? sql`AND environment = ${opts.environment}` : sql``}
      ${opts.eventType ? sql`AND event_type = ${opts.eventType}` : sql``}
      ${opts.entityId ? sql`AND entity_id = ${opts.entityId}` : sql``}
      ${opts.since ? sql`AND occurred_at >= ${opts.since}::timestamptz` : sql``}
      ORDER BY occurred_at DESC, created_at DESC
      LIMIT ${Math.max(1, Math.min(200, opts.limit || 50))}
    `);
    return rows(r);
  } catch (e: any) {
    console.error('[mailint/router] event list failed:', dbReason(e));
    return [];
  }
}

export async function getEvent(orgId: string, eventId: string): Promise<any | null> {
  await ensureMailIntSchema();
  try {
    const r = await db.execute(sql`SELECT * FROM mailint_events WHERE id = ${eventId}::uuid AND org_id = ${orgId}::uuid LIMIT 1`);
    return rows(r)[0] || null;
  } catch (e: any) {
    console.error('[mailint/router] event read failed:', dbReason(e));
    return null;
  }
}

/** What this event caused. The answer to "why did that candidate get that message?". */
export async function getEventRuns(orgId: string, eventId: string): Promise<any[]> {
  await ensureMailIntSchema();
  try {
    const r = await db.execute(sql`
      SELECT * FROM mailint_route_runs WHERE org_id = ${orgId}::uuid AND event_id = ${eventId}::uuid
      ORDER BY created_at ASC LIMIT 100
    `);
    return rows(r);
  } catch (e: any) {
    console.error('[mailint/router] run list failed:', dbReason(e));
    return [];
  }
}

/** The webhook body for one stored event, exactly as an endpoint would receive it. */
export function bodyForStoredEvent(row: any): Record<string, unknown> {
  return webhookBody({
    id: String(row.id),
    orgId: String(row.org_id || ''),
    type: String(row.event_type),
    source: String(row.source),
    entityType: row.entity_type ?? null,
    entityId: row.entity_id ?? null,
    payload: parseJson(row.payload, {}),
    occurredAt: new Date(row.occurred_at).toISOString(),
    idempotencyKey: row.idempotency_key ?? null,
  } as any);
}
