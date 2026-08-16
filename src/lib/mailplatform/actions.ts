// src/lib/mailplatform/actions.ts — WHAT A WORKFLOW CAN DO, and which of those things cannot be undone.
//
// Every action is a registry entry with a declared `irreversible` flag, and that flag is not
// decoration: it is what the engine reads to decide whether a step abandoned by a dead worker may be
// re-run automatically (a tag can be added twice with no consequence) or must stop and wait for a
// person (an email cannot be un-sent). Getting that wrong in either direction is the failure mode
// this whole patch is about, so the property lives on the action, next to the code that performs it.
//
// An action reports failure by THROWING one of the three typed errors in errors.ts. Returning
// {ok:false} was rejected: it makes "it failed" an easily-ignored return value, and the one thing
// this engine must never do is record a step as done when the effect did not happen.
import type { AutomationStore, ContactRecord, RunRecord, WorkflowRecord } from './store';
import { normalizeKey, normalizeTag } from './store';
import type { WorkflowNode } from './graph';
import type { Facts } from './conditions';
import { BusinessRuleFailure, PermanentFailure, TemporaryFailure } from './errors';
// TemporaryFailure is still used by the webhook action, where a 5xx from the far end genuinely is
// "try again" and there is no SMTP code to read.
import { mergeVarsForContact, renderHtml, renderSubject, renderText } from '@/lib/mail-personalize';
import type { ChannelAdapter } from './adapters';
import { isUsableEventType } from './triggers';
import { assertSafeOutboundUrl } from './security';

export interface EmittedEvent {
  type: string;
  contactId: string | null;
  payload: Record<string, unknown>;
}

export interface ActionContext {
  store: AutomationStore;
  orgId: string;
  run: RunRecord;
  workflow: WorkflowRecord;
  node: WorkflowNode;
  /** The contact as it is RIGHT NOW, re-read at this step. Not the copy frozen at trigger time. */
  contact: ContactRecord | null;
  facts: Facts;
  now: Date;
  /** Stable per (run, node). The same key on a retry, a different key on a different run. */
  idempotencyKey: string;
  /** Follow-on events. Collected and published by the engine AFTER the step is recorded done, so a
   *  crash cannot emit "tag added" for a tag that was never added. */
  publish: (e: EmittedEvent) => void;
  /**
   * How a channel id becomes an adapter. Injected rather than imported so a test can supply a
   * recording channel and assert what would have been sent — WITHOUT a global switch in production
   * code that could be left flipped. The default is the real registry.
   */
  resolveChannel: (id: string) => ChannelAdapter | null;
}

export interface ActionResult {
  /** One line for the run timeline. Written for a person reading a failure at 2am. */
  summary: string;
  data?: Record<string, unknown>;
  externalRef?: string | null;
  /** The end_workflow action. The run completes here, successfully. */
  endWorkflow?: boolean;
  /** The wait action. The run goes WAITING until this instant, then continues to the next node. */
  waitUntil?: Date;
}

export type ActionHandler = (ctx: ActionContext) => Promise<ActionResult>;

export interface ActionParam {
  name: string;
  label: string;
  type: 'text' | 'html' | 'number' | 'select' | 'json';
  required: boolean;
  options?: string[];
  help?: string;
}

export interface ActionDefinition {
  type: string;
  label: string;
  group: 'messaging' | 'audience' | 'flow' | 'integration';
  /**
   * TRUE when performing it twice is visible to somebody outside this system. The engine will never
   * silently retry one of these after a worker crash. See engine.ts.
   */
  irreversible: boolean;
  params: ActionParam[];
  handler: ActionHandler;
}

const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));

function requireContact(ctx: ActionContext): ContactRecord {
  if (!ctx.contact) {
    throw new BusinessRuleFailure('This step needs a contact and the run has none — the event that started it named nobody.');
  }
  return ctx.contact;
}

/**
 * The merge values for this send. Patch 5's pure mapper, plus the event payload under `event.*` so
 * copy can say "your interview is on {{event.interview_at}}" without the contact record having to
 * carry it.
 */
function varsFor(ctx: ActionContext, contact: ContactRecord) {
  const extra: Record<string, string> = {};
  const ev = (ctx.run.context as any)?.event;
  for (const [k, v] of Object.entries((ev && typeof ev === 'object' ? ev : {}) as Record<string, unknown>)) {
    if (v === null || v === undefined || typeof v === 'object') continue;
    extra['event.' + k] = String(v);
  }
  return mergeVarsForContact(
    {
      email: contact.email,
      first_name: contact.firstName,
      last_name: contact.lastName,
      organization: contact.organization,
      phone: contact.phone,
      role_title: contact.roleTitle,
      custom: contact.custom,
      application_stage: contact.applicationStage,
      application_number: contact.applicationNumber,
    },
    extra,
  );
}

/** One send path for both send_email and send_template, so suppression and the unsubscribe check
 *  cannot be present on one and missing from the other. */
async function deliver(ctx: ActionContext, subjectTpl: string, htmlTpl: string, textTpl: string, channelId: string, sourceLabel: string): Promise<ActionResult> {
  const contact = requireContact(ctx);

  // SUPPRESSION IS CHECKED HERE, NOT IN THE BUILDER. An author cannot be relied on to add "and is
  // not unsubscribed" to every workflow, and a person who has asked not to be mailed has asked the
  // platform, not one workflow. It is a BUSINESS failure: the run ends, quietly and correctly, and
  // nothing anywhere counts it as an error.
  if (contact.unsubscribed) {
    throw new BusinessRuleFailure(contact.email + ' has unsubscribed, so nothing was sent and this run ends here.');
  }
  if (!contact.email) throw new BusinessRuleFailure('This contact has no email address.');

  const adapter = ctx.resolveChannel(channelId);
  if (!adapter) throw new PermanentFailure('There is no "' + channelId + '" channel.');
  if (!(await adapter.available())) throw new PermanentFailure(await adapter.unavailableReason());

  const vars = varsFor(ctx, contact);
  const subject = renderSubject(subjectTpl, vars);
  const html = htmlTpl ? renderHtml(htmlTpl, vars) : '';
  const text = textTpl ? renderText(textTpl, vars) : '';
  if (!subject.trim()) throw new PermanentFailure('The message has no subject after the variables were filled in.');
  if (!html.trim() && !text.trim()) throw new PermanentFailure('The message has no body after the variables were filled in.');

  const res = await adapter.send({ to: contact.email, subject, html, text, idempotencyKey: ctx.idempotencyKey, meta: { runId: ctx.run.runId, nodeId: ctx.node.id } });
  if (!res.ok) {
    // A PLAIN Error, deliberately, and this line was wrong once. Wrapping it in TemporaryFailure
    // makes it a TYPED failure, and classifyError() honours a type over any pattern — so a hard
    // "550 5.1.1 no such user" was being retried five times over an hour against an address that
    // will never exist. Left untyped, the classifier reads the SMTP code: 4.x.x is temporary, 5.x.x
    // is permanent, and only the first is tried again.
    throw new Error(res.error || 'the message was not accepted');
  }
  return {
    summary: sourceLabel + ' sent to ' + contact.email + ' — "' + subject.slice(0, 80) + '"',
    externalRef: res.ref || null,
    data: { to: contact.email, subject, channel: channelId },
  };
}

export const ACTIONS: ActionDefinition[] = [
  {
    type: 'send_email',
    label: 'Send email',
    group: 'messaging',
    irreversible: true,
    params: [
      { name: 'subject', label: 'Subject', type: 'text', required: true, help: 'Merge fields such as {{first_name}} are filled per contact.' },
      { name: 'html', label: 'Body (HTML)', type: 'html', required: false },
      { name: 'text', label: 'Body (plain text)', type: 'text', required: false },
      { name: 'channel', label: 'Channel', type: 'select', required: false, options: ['email', 'sms', 'push', 'whatsapp', 'slack'], help: 'Only email is built; the rest refuse rather than send nothing quietly.' },
    ],
    async handler(ctx) {
      const p = ctx.node.action?.params || {};
      return deliver(ctx, str(p.subject), str(p.html), str(p.text), str(p.channel) || 'email', 'Email');
    },
  },
  {
    type: 'send_template',
    label: 'Send template',
    group: 'messaging',
    irreversible: true,
    params: [
      { name: 'template_key', label: 'Template key', type: 'text', required: true, help: 'From /admin/mail/templates. The template must be switched on.' },
      { name: 'channel', label: 'Channel', type: 'select', required: false, options: ['email'] },
    ],
    async handler(ctx) {
      const p = ctx.node.action?.params || {};
      const key = str(p.template_key).trim();
      if (!key) throw new PermanentFailure('This step names no template.');
      // email_templates is the catalogue /admin/mail/templates already writes. Reading it here is
      // what finally gives that screen's {{variable}} promise a send path that honours it.
      const { db } = await import('@/lib/db');
      const { sql } = await import('drizzle-orm');
      const r: any = await db.execute(sql`SELECT template_key, subject, body_html, body_text, is_active FROM email_templates WHERE template_key = ${key} LIMIT 1`);
      const row = (Array.isArray(r) ? r : r?.rows || [])[0];
      if (!row) throw new PermanentFailure('There is no template with the key "' + key + '". Check /admin/mail/templates.');
      if (row.is_active === false) throw new PermanentFailure('The template "' + key + '" is switched off, so nothing was sent.');
      return deliver(ctx, str(row.subject), str(row.body_html), str(row.body_text), str(p.channel) || 'email', 'Template "' + key + '"');
    },
  },
  {
    type: 'add_tag',
    label: 'Add tag',
    group: 'audience',
    irreversible: false,
    params: [{ name: 'tag', label: 'Tag', type: 'text', required: true }],
    async handler(ctx) {
      const contact = requireContact(ctx);
      const tag = normalizeTag(str(ctx.node.action?.params?.tag));
      if (!tag) throw new PermanentFailure('This step names no tag.');
      const changed = await ctx.store.addTag(ctx.orgId, contact.id, tag);
      // The event fires only on a real change, so a workflow triggered by "tag added" cannot be
      // re-entered by a re-run that added nothing.
      if (changed) ctx.publish({ type: 'contact.tag.added', contactId: contact.id, payload: { tag } });
      return { summary: changed ? 'Tagged "' + tag + '"' : 'Already tagged "' + tag + '" — nothing changed', data: { tag, changed } };
    },
  },
  {
    type: 'remove_tag',
    label: 'Remove tag',
    group: 'audience',
    irreversible: false,
    params: [{ name: 'tag', label: 'Tag', type: 'text', required: true }],
    async handler(ctx) {
      const contact = requireContact(ctx);
      const tag = normalizeTag(str(ctx.node.action?.params?.tag));
      if (!tag) throw new PermanentFailure('This step names no tag.');
      const changed = await ctx.store.removeTag(ctx.orgId, contact.id, tag);
      if (changed) ctx.publish({ type: 'contact.tag.removed', contactId: contact.id, payload: { tag } });
      return { summary: changed ? 'Removed tag "' + tag + '"' : 'Did not have "' + tag + '" — nothing changed', data: { tag, changed } };
    },
  },
  {
    type: 'add_to_list',
    label: 'Add to list',
    group: 'audience',
    irreversible: false,
    params: [{ name: 'list', label: 'List key', type: 'text', required: true }],
    async handler(ctx) {
      const contact = requireContact(ctx);
      const list = normalizeKey(str(ctx.node.action?.params?.list));
      if (!list) throw new PermanentFailure('This step names no list.');
      const changed = await ctx.store.addToList(ctx.orgId, contact.id, list);
      if (changed) ctx.publish({ type: 'contact.list.added', contactId: contact.id, payload: { list_key: list } });
      return { summary: changed ? 'Added to list "' + list + '"' : 'Already on list "' + list + '"', data: { list, changed } };
    },
  },
  {
    type: 'remove_from_list',
    label: 'Remove from list',
    group: 'audience',
    irreversible: false,
    params: [{ name: 'list', label: 'List key', type: 'text', required: true }],
    async handler(ctx) {
      const contact = requireContact(ctx);
      const list = normalizeKey(str(ctx.node.action?.params?.list));
      if (!list) throw new PermanentFailure('This step names no list.');
      const changed = await ctx.store.removeFromList(ctx.orgId, contact.id, list);
      return { summary: changed ? 'Removed from list "' + list + '"' : 'Was not on list "' + list + '"', data: { list, changed } };
    },
  },
  {
    type: 'update_contact',
    label: 'Update contact',
    group: 'audience',
    irreversible: false,
    params: [{ name: 'fields', label: 'Fields', type: 'json', required: true, help: 'e.g. {"application_stage":"4"}. Anything not a known column is stored as a custom field.' }],
    async handler(ctx) {
      const contact = requireContact(ctx);
      const raw = ctx.node.action?.params?.fields;
      const fields = typeof raw === 'string' ? safeJson(raw) : (raw as Record<string, unknown>);
      if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw new PermanentFailure('The fields to update are not an object.');
      const before = { ...contact };
      const after = await ctx.store.updateContactFields(ctx.orgId, contact.id, fields);
      if (!after) throw new PermanentFailure('That contact no longer exists.');
      const changed = Object.keys(fields);
      ctx.publish({ type: 'contact.updated', contactId: contact.id, payload: { changed_fields: changed, previous_stage: before.applicationStage } });
      return { summary: 'Updated ' + changed.join(', '), data: { fields: changed } };
    },
  },
  {
    type: 'wait',
    label: 'Wait',
    group: 'flow',
    irreversible: false,
    params: [
      { name: 'unit', label: 'Unit', type: 'select', required: true, options: ['minutes', 'hours', 'days'] },
      { name: 'amount', label: 'Amount', type: 'number', required: true },
    ],
    async handler(ctx) {
      // The same resolver a delay node uses, so "wait" as an action and "wait" as a node cannot
      // drift apart. The engine sees waitUntil and parks the run in the database; no timer exists.
      const { resolveDelay } = await import('./delay');
      const p = ctx.node.action?.params || {};
      const spec = { kind: (str(p.unit) || 'hours') as 'minutes' | 'hours' | 'days', amount: Number(p.amount) };
      const r = resolveDelay(spec as any, ctx.now);
      if (!r.ok) throw new PermanentFailure(r.error);
      return { summary: 'Waiting until ' + r.at.toISOString(), waitUntil: r.at, data: { wait_until: r.at.toISOString() } };
    },
  },
  {
    type: 'webhook',
    label: 'Webhook',
    group: 'integration',
    // Irreversible: the far end may create an order, charge a card or start another workflow. We
    // have no idea, so we never repeat one on our own initiative.
    irreversible: true,
    params: [
      { name: 'url', label: 'URL', type: 'text', required: true, help: 'https only, and not a private address.' },
      { name: 'method', label: 'Method', type: 'select', required: false, options: ['POST', 'PUT'] },
      { name: 'body', label: 'Body (JSON)', type: 'json', required: false },
    ],
    async handler(ctx) {
      const p = ctx.node.action?.params || {};
      const url = str(p.url).trim();
      // SSRF: without this, any admin who can author a workflow can make the SERVER fetch an
      // internal address — a metadata endpoint, a database admin port — and read the result back
      // off the run detail page. See security.ts.
      const guard = assertSafeOutboundUrl(url);
      if (!guard.ok) throw new PermanentFailure(guard.error);
      const method = str(p.method).toUpperCase() === 'PUT' ? 'PUT' : 'POST';
      const bodyRaw = typeof p.body === 'string' ? safeJson(p.body) : p.body;
      const payload = { run_id: ctx.run.runId, workflow_id: ctx.workflow.id, node_id: ctx.node.id, contact: ctx.contact ? { id: ctx.contact.id, email: ctx.contact.email } : null, data: bodyRaw ?? {} };
      let res: Response;
      try {
        res = await fetch(url, {
          method,
          headers: { 'Content-Type': 'application/json', 'Idempotency-Key': ctx.idempotencyKey, 'User-Agent': 'EduRankAI-Automation/1' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(15000),
        });
      } catch (e: any) {
        throw new TemporaryFailure('The webhook could not be reached: ' + String(e?.message || e));
      }
      const text = (await res.text().catch(() => '')).slice(0, 500);
      if (res.status >= 500 || res.status === 429) throw new TemporaryFailure('The webhook answered ' + res.status + ': ' + text);
      if (!res.ok) throw new PermanentFailure('The webhook answered ' + res.status + ': ' + text);
      return { summary: 'Webhook ' + method + ' ' + url + ' answered ' + res.status, externalRef: String(res.headers.get('x-request-id') || ''), data: { status: res.status, response: text } };
    },
  },
  {
    type: 'create_event',
    label: 'Create event',
    group: 'flow',
    irreversible: false,
    params: [
      { name: 'event', label: 'Event type', type: 'text', required: true, help: 'A dotted name, e.g. internship.selected' },
      { name: 'payload', label: 'Payload (JSON)', type: 'json', required: false },
    ],
    async handler(ctx) {
      const p = ctx.node.action?.params || {};
      const type = str(p.event).trim();
      if (!isUsableEventType(type)) throw new PermanentFailure('"' + type + '" is not a usable event type. Use a dotted lower-case name, e.g. internship.selected.');
      const payload = (typeof p.payload === 'string' ? safeJson(p.payload) : p.payload) || {};
      ctx.publish({ type, contactId: ctx.contact?.id || null, payload: payload as Record<string, unknown> });
      return { summary: 'Emitted ' + type, data: { event: type } };
    },
  },
  {
    type: 'end_workflow',
    label: 'End workflow',
    group: 'flow',
    irreversible: false,
    params: [{ name: 'reason', label: 'Reason', type: 'text', required: false }],
    async handler(ctx) {
      const reason = str(ctx.node.action?.params?.reason).trim();
      return { summary: reason ? 'Ended: ' + reason : 'Workflow ended', endWorkflow: true, data: { reason } };
    },
  },
];

function safeJson(s: string): any {
  try { return JSON.parse(s); } catch { return null; }
}

const BY_TYPE = new Map(ACTIONS.map((a) => [a.type, a]));

export function actionDefinition(type: string): ActionDefinition | null {
  return BY_TYPE.get(String(type || '')) || null;
}

/** Names an action whose effect is visible outside this system. Read by the engine before it decides
 *  whether an abandoned step may be retried without a human. */
export function isIrreversible(type: string): boolean {
  return !!actionDefinition(type)?.irreversible;
}

/** The catalogue a visual builder renders its palette from. No action list is hard-coded in a page. */
export function actionCatalogue() {
  return ACTIONS.map((a) => ({ type: a.type, label: a.label, group: a.group, irreversible: a.irreversible, params: a.params }));
}
