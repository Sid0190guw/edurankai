// src/lib/mailplatform/triggers.ts — THE EVENT VOCABULARY. Pure.
//
// An event is a fact that has already happened, named in past tense, with a stable dotted type and
// a durable id. Everything that can start a workflow is one of these; the engine has no other way
// in. That is deliberate — a trigger that could also be "when a query returns rows" would need the
// engine to poll, and a poll cannot tell you WHEN something happened, only that it is true now.
//
// CUSTOM EVENTS ARE FIRST-CLASS, NOT AN ESCAPE HATCH. The recruitment events this platform actually
// runs on (application.stage.changed, assessment.completed, …) are declared below beside the mail
// ones and go through exactly the same router, filter and authorization. There is no second path.
import type { ConditionNode, Facts } from './conditions';
import { evaluateCondition } from './conditions';

export interface TriggerType {
  /** The dotted event type. Stored on the event row and matched against a trigger node. */
  id: string;
  label: string;
  group: 'contact' | 'campaign' | 'delivery' | 'integration' | 'schedule' | 'application';
  /** What the router expects in the payload, so a builder can offer the right fields. */
  facts: string[];
  /** True when a contact is required. An event with no contact cannot start a per-contact run. */
  needsContact: boolean;
}

export const TRIGGER_TYPES: ReadonlyArray<TriggerType> = [
  { id: 'contact.created', label: 'Contact created', group: 'contact', facts: ['contact.email', 'contact.first_name', 'contact.organization'], needsContact: true },
  { id: 'contact.updated', label: 'Contact updated', group: 'contact', facts: ['contact.email', 'event.changed_fields'], needsContact: true },
  { id: 'contact.list.added', label: 'Contact added to list', group: 'contact', facts: ['event.list_key', 'event.list_name'], needsContact: true },
  { id: 'contact.tag.added', label: 'Tag added', group: 'contact', facts: ['event.tag'], needsContact: true },
  { id: 'contact.tag.removed', label: 'Tag removed', group: 'contact', facts: ['event.tag'], needsContact: true },

  { id: 'campaign.sent', label: 'Campaign sent', group: 'campaign', facts: ['event.campaign_id', 'event.subject'], needsContact: true },

  { id: 'email.delivered', label: 'Email delivered', group: 'delivery', facts: ['event.message_id'], needsContact: true },
  { id: 'email.opened', label: 'Email opened', group: 'delivery', facts: ['event.message_id'], needsContact: true },
  { id: 'email.clicked', label: 'Email clicked', group: 'delivery', facts: ['event.message_id', 'event.url'], needsContact: true },
  { id: 'email.bounced', label: 'Email bounced', group: 'delivery', facts: ['event.message_id', 'event.bounce_type', 'event.reason'], needsContact: true },
  { id: 'email.unsubscribed', label: 'Email unsubscribed', group: 'delivery', facts: ['event.message_id'], needsContact: true },

  { id: 'api.event', label: 'API event', group: 'integration', facts: ['event.name', 'event.payload'], needsContact: true },
  { id: 'webhook.event', label: 'Webhook event', group: 'integration', facts: ['event.name', 'event.payload'], needsContact: true },

  // A scheduled trigger is still an EVENT — emitted by the scheduler when the date arrives, not
  // discovered by the engine looking at a clock. Same row in the same log as everything else, so a
  // date-driven start is as auditable and as replay-safe as a click.
  { id: 'schedule.date', label: 'Scheduled date', group: 'schedule', facts: ['event.scheduled_for'], needsContact: true },
  { id: 'schedule.time', label: 'Scheduled time', group: 'schedule', facts: ['event.scheduled_for'], needsContact: true },

  { id: 'application.submitted', label: 'Application submitted', group: 'application', facts: ['event.application_number', 'event.role'], needsContact: true },
  { id: 'application.stage.changed', label: 'Application stage changed', group: 'application', facts: ['event.stage', 'event.previous_stage', 'event.application_number'], needsContact: true },
  { id: 'assessment.assigned', label: 'Assessment assigned', group: 'application', facts: ['event.assessment_id', 'event.deadline_at'], needsContact: true },
  { id: 'assessment.completed', label: 'Assessment completed', group: 'application', facts: ['event.assessment_id', 'event.score', 'event.passed'], needsContact: true },
  { id: 'interview.scheduled', label: 'Interview scheduled', group: 'application', facts: ['event.interview_at', 'event.mode'], needsContact: true },
  { id: 'internship.selected', label: 'Internship selected', group: 'application', facts: ['event.role', 'event.start_date'], needsContact: true },
  { id: 'internship.rejected', label: 'Internship rejected', group: 'application', facts: ['event.role', 'event.reason'], needsContact: true },
];

const BY_ID = new Map(TRIGGER_TYPES.map((t) => [t.id, t]));

export function triggerType(id: string): TriggerType | null {
  return BY_ID.get(canonicalEventType(id)) || null;
}

/**
 * THE SIX KEYS THE EXISTING CANVAS ALREADY WROTE, MAPPED TO THEIR CANONICAL EVENT NAMES.
 *
 * src/lib/mail-product/automations.ts shipped its trigger picker with underscored keys before this
 * engine existed, and automations drawn against them are already stored in `graph`. Renaming them
 * would silently stop every one of those automations from ever starting again — a data migration
 * dressed as a tidy-up. So both spellings resolve to one event type, here, in one table, and
 * everything downstream (the event log, the webhook door, the API) only ever sees the dotted name.
 *
 * New trigger keys are dotted from the start; only these six need translating, for ever.
 */
const CANVAS_ALIASES: Record<string, string> = {
  application_stage_changed: 'application.stage.changed',
  contact_created: 'contact.created',
  tag_added: 'contact.tag.added',
  list_joined: 'contact.list.added',
  campaign_opened: 'email.opened',
  campaign_clicked: 'email.clicked',
};

/** The one event name for a trigger, whichever spelling the graph holds. */
export function canonicalEventType(keyOrType: string): string {
  const k = String(keyOrType || '').trim();
  return CANVAS_ALIASES[k] || k;
}

/** Dotted, lower case, 3-80 characters. The shape a custom application event must take. */
export const EVENT_TYPE_RE = /^[a-z][a-z0-9]*(\.[a-z0-9_]+){1,5}$/;

/**
 * Is this a usable event type?
 *
 * A declared type is always fine. An UNDECLARED one is accepted if it is well-formed, because the
 * point of "custom application event" is that a part of this platform that does not exist yet can
 * emit into the engine without a code change here. What is NOT accepted is a free-form string: the
 * event log is queried by type and joined to trigger nodes by exact match, so "Stage Changed!!" and
 * "stage changed" would be two silently different triggers that both look right on a screen.
 */
export function isUsableEventType(type: string): boolean {
  const t = canonicalEventType(type);
  if (BY_ID.has(t)) return true;
  return t.length >= 3 && t.length <= 80 && EVENT_TYPE_RE.test(t);
}

export interface IncomingEvent {
  /** Idempotency key for the event itself. Two deliveries carrying one id are one event. */
  eventId: string;
  type: string;
  orgId: string;
  contactId: string | null;
  payload: Record<string, unknown>;
  source: 'internal' | 'api' | 'webhook' | 'scheduler';
  occurredAt: Date;
}

/**
 * The facts a condition sees. Flattened to two namespaces on purpose: `contact.` is who it happened
 * to and `event.` is what happened. A payload key that collides with nothing is ALSO copied to the
 * bare name, so a filter written as `stage` works as well as `event.stage` — builders write the
 * short form and are right to.
 */
export function factsFor(event: IncomingEvent, contact: Record<string, unknown> | null): Facts {
  const facts: Facts = {};
  facts['event.type'] = event.type;
  facts['event.source'] = event.source;
  facts['event.occurred_at'] = event.occurredAt instanceof Date ? event.occurredAt.toISOString() : String(event.occurredAt);
  facts['event'] = { type: event.type, source: event.source, ...(event.payload || {}) };
  for (const [k, v] of Object.entries(event.payload || {})) {
    facts['event.' + k] = v;
    if (!(k in facts)) facts[k] = v;
  }
  if (contact) {
    facts['contact'] = contact;
    for (const [k, v] of Object.entries(contact)) {
      facts['contact.' + k] = v;
      if (!(k in facts)) facts[k] = v;
    }
  }
  return facts;
}

/** Does this event start this trigger? Type must match exactly; the filter then narrows. */
export function eventMatchesTrigger(
  event: IncomingEvent,
  trigger: { event: string; filter?: ConditionNode } | null | undefined,
  facts: Facts,
): { matches: boolean; reason: string } {
  if (!trigger || !trigger.event) return { matches: false, reason: 'the automation has no trigger event' };
  const listensFor = canonicalEventType(trigger.event);
  if (listensFor !== canonicalEventType(event.type)) {
    return { matches: false, reason: 'the event is ' + event.type + ', the trigger listens for ' + listensFor };
  }
  if (!trigger.filter) return { matches: true, reason: 'the trigger has no filter' };
  const r = evaluateCondition(trigger.filter, facts);
  return { matches: r.result, reason: r.result ? 'the filter matched' : 'the filter did not match' };
}
