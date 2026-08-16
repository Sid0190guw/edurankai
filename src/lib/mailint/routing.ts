// src/lib/mailint/routing.ts — THE EVENT ROUTER'S DECISIONS. Pure; no database, no network.
//
// One fact arrives. This file answers, without touching anything: which routes claim it, what each
// one is asking for, and exactly what payload each destination is allowed to see. The runtime half
// (src/lib/mailint/router.ts) then performs those actions and records what happened.
//
// THE SPLIT IS THE POINT. A router that decides and acts in the same function can only be tested
// against a live database and a live SMTP server, which means in practice it is tested by sending
// real mail to real candidates. Every decision here is a pure function over data, so "a rejected
// candidate's reason must never reach a third-party endpoint" is an assertion in a test file rather
// than a hope in a code review.

import {
  eventDescriptor,
  matchesAnyPattern,
  matchesPattern,
  type CanonicalEvent,
  type EventChannel,
} from './events';
import { getPath, matchRuleHolds, type MatchRule } from './mapping';

// ---------------------------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------------------------

/** What a route does when it matches. One route, one action — fan-out is several routes. */
export interface EventRoute {
  id: string;
  orgId: string;
  name: string;
  /** Event filter, in the pattern language of events.ts. */
  eventPattern: string;
  action: EventChannel;
  /**
   * Action configuration. Validated per action by validateRoute():
   *   email      { template: string, to?: string (payload path), from?: string, subject?: string }
   *   campaign   { campaignId?: string, listId?: string, addToList?: string }
   *   workflow   { workflowKey: string, input?: Record<string,string> (payload paths) }
   *   webhook    { endpointId?: string }   omitted = every endpoint subscribed to this event
   *   analytics  { metric: string, by?: string[] }
   */
  config: Record<string, unknown>;
  /** Extra conditions on the payload, ANDed. Same rule shape the mappings use. */
  conditions?: MatchRule[];
  isActive: boolean;
  /** Lower runs first. */
  priority: number;
  /** When true, no later route of the SAME action runs for this event. */
  stopOnMatch?: boolean;
}

export interface PlannedAction {
  routeId: string;
  routeName: string;
  action: EventChannel;
  config: Record<string, unknown>;
  /** The payload this destination is allowed to see, already redacted. */
  payload: Record<string, unknown>;
}

export interface RoutePlan {
  actions: PlannedAction[];
  /** Routes that matched the pattern but were held back, and why. For the console's event view. */
  skipped: { routeId: string; routeName: string; reason: string }[];
}

/**
 * Decide what an event causes.
 *
 * Order is priority then name so two admins reading the console see the same list. `stopOnMatch`
 * is scoped to the action, not global: an email route that stops later email routes must not also
 * silence the webhook fan-out, because the two are answering different questions.
 */
export function planRoutes(event: CanonicalEvent, routes: EventRoute[]): RoutePlan {
  const actions: PlannedAction[] = [];
  const skipped: RoutePlan['skipped'] = [];
  const stopped = new Set<EventChannel>();
  const desc = eventDescriptor(event.type);

  const ordered = [...routes].sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100) || String(a.name).localeCompare(String(b.name)));

  for (const r of ordered) {
    if (!r.isActive) continue;

    // TENANCY IS CHECKED HERE TOO, not only in the query that loaded the routes. Defence in depth
    // is cheap and the failure it prevents — one organisation's route firing on another
    // organisation's event — is not recoverable by apology.
    if (r.orgId !== event.orgId) {
      skipped.push({ routeId: r.id, routeName: r.name, reason: 'belongs to a different organisation' });
      continue;
    }

    if (!matchesPattern(event.type, r.eventPattern)) continue;

    if (stopped.has(r.action)) {
      skipped.push({ routeId: r.id, routeName: r.name, reason: 'an earlier ' + r.action + ' route stopped the chain' });
      continue;
    }

    // A route may not ask an event to do something the catalogue says it cannot. This is what stops
    // "send an email about message.delivered" — a rule that would mail a candidate every time a
    // server acknowledged a byte.
    if (desc && !desc.channels.includes(r.action)) {
      skipped.push({ routeId: r.id, routeName: r.name, reason: event.type + ' cannot drive the ' + r.action + ' channel' });
      continue;
    }

    const failing = (r.conditions || []).find((c) => !matchRuleHolds(c, event.payload));
    if (failing) {
      skipped.push({ routeId: r.id, routeName: r.name, reason: 'condition on ' + failing.path + ' did not hold' });
      continue;
    }

    actions.push({
      routeId: r.id,
      routeName: r.name,
      action: r.action,
      config: r.config || {},
      payload: redactForChannel(event, r.action),
    });
    if (r.stopOnMatch) stopped.add(r.action);
  }

  return { actions, skipped };
}

/**
 * Which of these fields does this route need out of the payload?
 *
 * Used by the email action to resolve `to` and by the workflow action to build its input. Paths,
 * not keys, so `$.candidate.email` works as well as `email`.
 */
export function resolveConfigPaths(
  config: Record<string, unknown>,
  keys: string[],
  payload: Record<string, unknown>,
): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const k of keys) {
    const spec = config[k];
    if (typeof spec !== 'string' || !spec) { out[k] = null; continue; }
    // A literal is anything that is not a path expression; a path is anything starting with `$.`.
    if (spec.startsWith('$.')) {
      const v = getPath(payload, spec);
      out[k] = v === undefined || v === null ? null : String(v);
    } else {
      out[k] = spec;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------------------------

/**
 * Payload keys that never leave the platform on a fan-out channel.
 *
 * These are not secrets; they are FACTS ABOUT A PERSON that the platform holds in order to write
 * one message to that person. A rejection reason exists so the candidate can read it and appeal it.
 * An assessment score exists so a human can make a decision. Neither has a reason to be sitting in
 * a third-party endpoint's log file, and once it has been posted there we cannot take it back.
 *
 * The email and workflow channels DO see them: the email is the message to the person themselves,
 * and the workflow is the thing that decides which message to send.
 */
const SENSITIVE_KEYS: readonly string[] = [
  'reason', 'note', 'score', 'outcome', 'feedback', 'notes', 'decided_by', 'diagnostic',
];

/** Channels that receive a redacted payload for a sensitive event. */
const REDACTED_CHANNELS: readonly EventChannel[] = ['webhook', 'analytics', 'campaign'];

export function redactForChannel(
  event: CanonicalEvent,
  channel: EventChannel,
  opts: { grantSensitive?: boolean } = {},
): Record<string, unknown> {
  const desc = eventDescriptor(event.type);
  const payload = { ...(event.payload || {}) };
  if (!desc?.sensitive) return payload;
  if (!REDACTED_CHANNELS.includes(channel)) return payload;
  // An endpoint MAY be granted the full payload — an internal warehouse, our own analytics — but it
  // is a decision recorded per endpoint, never a default.
  if (opts.grantSensitive) return payload;

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    if (SENSITIVE_KEYS.includes(k)) continue;
    out[k] = v;
  }
  out.redacted = SENSITIVE_KEYS.filter((k) => k in payload);
  return out;
}

/** True when this event/channel pair would lose fields. Shown in the console next to the route. */
export function willRedact(event: CanonicalEvent, channel: EventChannel): boolean {
  const desc = eventDescriptor(event.type);
  if (!desc?.sensitive || !REDACTED_CHANNELS.includes(channel)) return false;
  return Object.keys(event.payload || {}).some((k) => SENSITIVE_KEYS.includes(k));
}

// ---------------------------------------------------------------------------------------------
// Webhook fan-out
// ---------------------------------------------------------------------------------------------

export interface EndpointSubscription {
  id: string;
  orgId: string;
  url: string;
  /** Event patterns this endpoint asked for. Empty means nothing, never everything. */
  eventTypes: string[];
  status: 'pending_verification' | 'active' | 'disabled' | 'failing';
  environment: string;
  /** Explicitly granted the unredacted payload for sensitive events. */
  grantSensitive?: boolean;
}

export interface FanoutTarget {
  endpointId: string;
  url: string;
  payload: Record<string, unknown>;
}

export interface FanoutPlan {
  targets: FanoutTarget[];
  skipped: { endpointId: string; reason: string }[];
}

/**
 * Which endpoints get this event, and what does each of them see?
 *
 * `environment` is part of the answer, not a filter applied afterwards: a development endpoint that
 * receives production events is how a half-built integration ends up mailing real candidates, and it
 * is the single most common way a sandbox stops being one.
 *
 * THE SUBSCRIPTION RULE IS INJECTED, NOT DECIDED HERE. The shipped webhook platform already owns it
 * (`subscribes()` in src/lib/mailapi/webhooks.ts, including its rule that an empty list means
 * everything), and fanout.ts passes that function in. This started out with its own rule, and its
 * own rule DISAGREED — empty meant "nothing" here and "everything" there — which is precisely the
 * kind of split that ends with an endpoint receiving either none of its events or all of them,
 * depending on which code path ran. One rule, injected, and this function keeps what is genuinely
 * its own: tenancy, environment and per-endpoint redaction.
 */
export function planFanout(
  event: CanonicalEvent,
  endpoints: EndpointSubscription[],
  environment: string,
  subscribes: (subscription: readonly string[], type: string) => boolean = (sub, type) => matchesAnyPattern(type, sub),
): FanoutPlan {
  const targets: FanoutTarget[] = [];
  const skipped: FanoutPlan['skipped'] = [];

  for (const ep of endpoints) {
    if (ep.orgId !== event.orgId) { skipped.push({ endpointId: ep.id, reason: 'different organisation' }); continue; }
    if (ep.environment !== environment) { skipped.push({ endpointId: ep.id, reason: 'different environment' }); continue; }
    if (ep.status === 'disabled') { skipped.push({ endpointId: ep.id, reason: 'endpoint disabled' }); continue; }
    if (!subscribes(ep.eventTypes, event.type)) continue; // not subscribed: not a skip worth reporting
    targets.push({
      endpointId: ep.id,
      url: ep.url,
      payload: redactForChannel(event, 'webhook', { grantSensitive: ep.grantSensitive }),
    });
  }
  return { targets, skipped };
}

// ---------------------------------------------------------------------------------------------
// Route validation
// ---------------------------------------------------------------------------------------------

export function validateRoute(r: Partial<EventRoute>): string[] {
  const errors: string[] = [];
  if (!r.name || !String(r.name).trim()) errors.push('name is required.');
  if (!r.eventPattern) errors.push('eventPattern is required.');
  if (!r.action) errors.push('action is required.');

  const cfg = (r.config || {}) as Record<string, unknown>;
  switch (r.action) {
    case 'email':
      if (!cfg.template) errors.push('an email route needs a template key.');
      if (!cfg.to) errors.push('an email route needs `to` — a payload path such as $.email.');
      break;
    case 'campaign':
      if (!cfg.campaignId && !cfg.addToList) errors.push('a campaign route needs either campaignId or addToList.');
      break;
    case 'workflow':
      if (!cfg.workflowKey) errors.push('a workflow route needs workflowKey.');
      break;
    case 'analytics':
      if (!cfg.metric) errors.push('an analytics route needs a metric name.');
      break;
    case 'webhook':
      break; // no endpointId means "every subscribed endpoint", which is the normal case
    default:
      errors.push('"' + String(r.action) + '" is not one of email, campaign, workflow, webhook, analytics.');
  }

  for (const c of r.conditions || []) {
    if (!c.path) errors.push('a condition has no path.');
  }
  return errors;
}
