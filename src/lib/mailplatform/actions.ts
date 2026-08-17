// src/lib/mailplatform/actions.ts — WHAT EACH NODE KIND DOES, and which of those cannot be undone.
//
// The kinds are the canvas's own (src/lib/mail-product/automations.ts NODE_CATALOGUE): send_email,
// update_contact, add_tag, remove_tag, webhook. This file gives each of them an effect. It adds no
// new kind, because a kind the canvas cannot draw is a step nobody can author.
//
// EVERY HANDLER DECLARES WHETHER IT IS IRREVERSIBLE, and that flag is not decoration: the engine
// reads it to decide whether a step abandoned by a dead worker may be re-run automatically (a tag
// can be re-applied with no consequence) or must stop and wait for a person (an email cannot be
// un-sent). Getting it wrong in either direction is the failure this whole engine is about, so the
// property lives on the action, next to the code that performs it.
//
// A handler reports failure by THROWING one of the three typed errors in errors.ts. Returning
// {ok:false} was rejected: it makes "it failed" an easily-ignored return value, and the one thing
// this engine must never do is record a step as done when the effect did not happen.
import type { AutomationRecord, AutomationStore, ContactRecord, RunRecord } from './store';
import { applicationNumberOf, mayReceive, normalizeTag, stageOf } from './store';
import type { AutomationNode, NodeKind } from './graph';
import type { Facts } from './conditions';
import { BusinessRuleFailure, PermanentFailure, TemporaryFailure } from './errors';
import { mergeVarsForContact, renderHtml, renderSubject, renderText } from '@/lib/mail-personalize';
import type { ChannelAdapter } from './adapters';
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
  automation: AutomationRecord;
  node: AutomationNode;
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
   * recording channel and assert what would have been sent — without a global switch in production
   * code that could be left flipped. The default is the real registry.
   */
  resolveChannel: (id: string) => ChannelAdapter | null;
}

export interface ActionResult {
  /** One line for the run timeline. Written for a person reading a failure at 2am. */
  summary: string;
  data?: Record<string, unknown>;
  externalRef?: string | null;
  /** The run goes waiting until this instant, then continues to the next node. */
  waitUntil?: Date;
}

export type ActionHandler = (ctx: ActionContext) => Promise<ActionResult>;

export interface ActionDefinition {
  kind: NodeKind;
  label: string;
  /**
   * TRUE when performing it twice is visible to somebody outside this system. The engine will never
   * silently retry one of these after a worker crash. See engine.ts.
   */
  irreversible: boolean;
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
 * The merge values for this send. mail-personalize.ts's pure mapper, plus the event payload under
 * `event.*` so copy can say "your interview is on {{event.interview_at}}" without the contact record
 * having to carry it.
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
      custom: contact.fields,
      application_stage: stageOf(contact),
      application_number: applicationNumberOf(contact),
    },
    extra,
  );
}

/**
 * The one send path. Suppression, the subscription status and the merge all happen here, once, so
 * they cannot be present on one send node and missing from another.
 */
async function deliver(ctx: ActionContext, subjectTpl: string, htmlTpl: string, textTpl: string, channelId: string, sourceLabel: string): Promise<ActionResult> {
  const contact = requireContact(ctx);

  // SUPPRESSION AND STATUS ARE CHECKED HERE, NOT IN THE BUILDER. An author cannot be relied on to
  // add "and has not unsubscribed" to every automation, and a person who asked not to be mailed
  // asked the PLATFORM, not one automation. Both are BUSINESS failures: the run ends, quietly and
  // correctly, and nothing anywhere counts it as an error.
  if (!mayReceive(contact)) {
    throw new BusinessRuleFailure(contact.email + ' is "' + contact.status + '", not subscribed, so nothing was sent and this run ends here.');
  }
  if (await ctx.store.isSuppressed(contact.email)) {
    throw new BusinessRuleFailure(contact.email + ' is on the suppression list, so nothing was sent and this run ends here.');
  }

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
    // A PLAIN Error, deliberately. Wrapping it in TemporaryFailure would make it a TYPED failure, and
    // classifyError() honours a type over any pattern — so a hard "550 5.1.1 no such user" would be
    // retried five times over an hour against an address that will never exist. Left untyped, the
    // classifier reads the SMTP code: 4.x.x is temporary, 5.x.x is permanent.
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
    kind: 'send_email',
    label: 'Send email',
    irreversible: true,
    async handler(ctx) {
      const c = (ctx.node.config || {}) as Record<string, unknown>;
      const templateId = str(c.templateId).trim();
      if (!templateId) throw new PermanentFailure('This step names no template.');
      // email_templates is the catalogue /admin/mail/templates and the campaign builder already
      // write. Reading it here is what finally gives that screen's {{variable}} promise a per-person
      // send path that honours it.
      const tpl = await ctx.store.getTemplate(templateId);
      if (!tpl) throw new PermanentFailure('That template does not exist, or it is switched off, so nothing was sent.');
      return deliver(ctx, tpl.subject, tpl.html, tpl.text, str(c.channel) || 'email', 'Template "' + (tpl.name || tpl.id) + '"');
    },
  },
  {
    kind: 'add_tag',
    label: 'Add tag',
    irreversible: false,
    async handler(ctx) {
      const contact = requireContact(ctx);
      const tag = normalizeTag(str((ctx.node.config || {}).tag));
      if (!tag) throw new PermanentFailure('This step names no tag.');
      const changed = await ctx.store.addTag(contact.id, tag);
      // The event fires only on a REAL change, so an automation triggered by "tag added" cannot be
      // re-entered by a re-run that added nothing.
      if (changed) ctx.publish({ type: 'contact.tag.added', contactId: contact.id, payload: { tag } });
      return { summary: changed ? 'Tagged "' + tag + '"' : 'Already tagged "' + tag + '" — nothing changed', data: { tag, changed } };
    },
  },
  {
    kind: 'remove_tag',
    label: 'Remove tag',
    irreversible: false,
    async handler(ctx) {
      const contact = requireContact(ctx);
      const tag = normalizeTag(str((ctx.node.config || {}).tag));
      if (!tag) throw new PermanentFailure('This step names no tag.');
      const changed = await ctx.store.removeTag(contact.id, tag);
      if (changed) ctx.publish({ type: 'contact.tag.removed', contactId: contact.id, payload: { tag } });
      return { summary: changed ? 'Removed tag "' + tag + '"' : 'Did not have "' + tag + '" — nothing changed', data: { tag, changed } };
    },
  },
  {
    kind: 'update_contact',
    label: 'Update contact',
    irreversible: false,
    async handler(ctx) {
      const contact = requireContact(ctx);
      const c = (ctx.node.config || {}) as Record<string, unknown>;
      const key = str(c.key).trim();
      if (!key) throw new PermanentFailure('This step does not say which field to set.');
      const before = stageOf(contact);
      const after = await ctx.store.updateContactFields(contact.id, { [key]: str(c.value) });
      if (!after) throw new PermanentFailure('That contact no longer exists.');
      ctx.publish({ type: 'contact.updated', contactId: contact.id, payload: { changed_fields: [key], previous_stage: before } });
      return { summary: 'Set ' + key + ' to "' + str(c.value).slice(0, 60) + '"', data: { key } };
    },
  },
  {
    kind: 'webhook',
    label: 'Webhook',
    // Irreversible: the far end may create an order, charge a card or start another automation. We
    // have no idea, so we never repeat one on our own initiative.
    irreversible: true,
    async handler(ctx) {
      const c = (ctx.node.config || {}) as Record<string, unknown>;
      const url = str(c.url).trim();
      // SSRF. Without this, anybody who can author an automation can make the SERVER fetch an
      // internal address — a metadata endpoint, an admin port — and read the answer off the run page.
      const guard = assertSafeOutboundUrl(url);
      if (!guard.ok) throw new PermanentFailure(guard.error);
      const method = str(c.method).toUpperCase() === 'PUT' ? 'PUT' : 'POST';
      const body = typeof c.body === 'string' ? safeJson(c.body) : c.body;
      const payload = {
        run_id: ctx.run.runId,
        automation_id: ctx.automation.id,
        node_id: ctx.node.id,
        contact: ctx.contact ? { id: ctx.contact.id, email: ctx.contact.email } : null,
        data: body ?? {},
      };
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
      return { summary: 'Webhook ' + method + ' answered ' + res.status, externalRef: String(res.headers.get('x-request-id') || ''), data: { status: res.status, response: text } };
    },
  },
];

function safeJson(s: string): any {
  try { return JSON.parse(s); } catch { return null; }
}

const BY_KIND = new Map(ACTIONS.map((a) => [a.kind, a]));

export function actionDefinition(kind: string): ActionDefinition | null {
  return BY_KIND.get(String(kind || '') as NodeKind) || null;
}

/** Names a node kind whose effect is visible outside this system. Read by the engine before it
 *  decides whether an abandoned step may be retried without a human. */
export function isIrreversible(kind: string): boolean {
  return !!actionDefinition(kind)?.irreversible;
}

/** The catalogue a builder renders from. No page lists these by hand. */
export function actionCatalogue() {
  return ACTIONS.map((a) => ({ kind: a.kind, label: a.label, irreversible: a.irreversible }));
}

/**
 * TWO ACTIONS THE CANVAS DOES NOT YET DRAW, AND WHY THEY ARE NOT REGISTERED HERE.
 *
 * "Add to list" and "remove from list" are in the specification, and the store implements both
 * (addToList / removeFromList, against mail_lists / mail_list_members). They are NOT node kinds
 * because a kind mail-product/automations.ts does not know is one its validator rejects and its
 * canvas cannot place — an author could never create one, so registering a handler for it would add
 * a step nobody can use and a second, disagreeing node catalogue.
 *
 * Adding them is one entry in that file's NODE_CATALOGUE plus one handler here; the store side is
 * already written and tested. Stated rather than half-built, because a step that silently does
 * nothing is worse than a step that does not exist.
 */
export const NOT_YET_DRAWABLE = ['add_to_list', 'remove_from_list'] as const;
