// src/lib/mailint/events.ts — THE EVENT VOCABULARY. Pure; no database, no network.
//
// This file is the contract between every EduRankAI product and the mail platform. A product does
// not call "send email"; it states a FACT ("this application moved to assessment") and the router
// decides what that fact causes. That indirection is the whole reason the integration layer exists:
// when the assessment-invitation copy changes, or a second thing has to happen on the same fact, no
// product code is touched.
//
// WHY A CLOSED CATALOGUE RATHER THAN FREE STRINGS. An event type is written by one team and matched
// by another (`application.*` in a webhook filter, a route, a customer's endpoint). A typo in a
// free-string world is silent: the emitter believes it published, every consumer's filter misses,
// and nothing happens anywhere. `isKnownEventType()` is checked at emit time and an unknown type is
// REFUSED with the near-miss suggested — the same direction advanceStage() took when it stopped
// writing unknown stage keys into applications.stage.
//
// ADDING an event is additive and cheap. RENAMING one is a breaking change for every stored webhook
// filter and every route row, so renames go through DEPRECATED_ALIASES below rather than an edit.

/** The five things a fact can cause. Section 3 of the integration brief: "map them to". */
export type EventChannel = 'email' | 'campaign' | 'workflow' | 'webhook' | 'analytics';

export const EVENT_CHANNELS: readonly EventChannel[] = ['email', 'campaign', 'workflow', 'webhook', 'analytics'] as const;

/** Which EduRankAI system a fact originates in. Also the key a connector registers under. */
export type EventSource =
  | 'careers'
  | 'aquintutor'
  | 'talent'
  | 'recruitment'
  | 'university'
  | 'mail'
  | 'external';

export interface EventDescriptor {
  /** `domain.entity.action` — lowercase, dot-separated, stable forever. */
  type: string;
  /** The system that normally publishes it. Informational: any authorised source may publish. */
  source: EventSource;
  /** One sentence, written for the developer reading the webhook picker. */
  description: string;
  /** The thing the event is about; pairs with `entityId` on the envelope. */
  entityType: string;
  /**
   * Payload keys a consumer may rely on. Enforced by validateEvent() as REQUIRED — a webhook
   * consumer that branches on `payload.stage` must never receive an event without one.
   */
  required: readonly string[];
  /** Documented but optional keys. Not enforced; listed so the console can show the full shape. */
  optional?: readonly string[];
  /** Channels this fact is allowed to drive. A route asking for another channel is refused. */
  channels: readonly EventChannel[];
  /**
   * True when the payload can carry personal data beyond a name and address (a score, a reason for
   * a rejection). Those events are never fanned out to a webhook endpoint that has not been
   * explicitly granted them — see routing.ts `redactForChannel`.
   */
  sensitive?: boolean;
}

// ---------------------------------------------------------------------------------------------
// The catalogue
// ---------------------------------------------------------------------------------------------
//
// Order is by domain, and the domains are the ones the brief names: applications and candidates
// (EduRankAI Careers / recruitment), assessments and interviews (Talent), learning (AquinTutor),
// people (university systems), and the mail platform's own delivery facts.

export const CANONICAL_EVENTS: readonly EventDescriptor[] = [
  // ---- applications ------------------------------------------------------------------------
  {
    type: 'application.created',
    source: 'careers',
    description: 'A candidate submitted an application for a role.',
    entityType: 'application',
    required: ['application_id', 'email'],
    optional: ['role_key', 'role_title', 'name', 'source', 'submitted_at'],
    channels: ['email', 'workflow', 'webhook', 'analytics'],
  },
  {
    type: 'application.updated',
    source: 'careers',
    description: 'A field on an existing application changed (not the funnel stage).',
    entityType: 'application',
    required: ['application_id'],
    optional: ['email', 'changed', 'previous'],
    channels: ['workflow', 'webhook', 'analytics'],
  },
  {
    type: 'application.stage.changed',
    source: 'careers',
    description: 'The application moved to a different stage of the recruitment funnel.',
    entityType: 'application',
    required: ['application_id', 'stage'],
    optional: ['previous_stage', 'stage_index', 'stage_label', 'email', 'actor_name', 'note'],
    channels: ['email', 'campaign', 'workflow', 'webhook', 'analytics'],
  },
  {
    type: 'application.withdrawn',
    source: 'careers',
    description: 'The candidate withdrew their own application.',
    entityType: 'application',
    required: ['application_id'],
    optional: ['email', 'reason'],
    channels: ['email', 'workflow', 'webhook', 'analytics'],
  },

  // ---- candidate decisions -----------------------------------------------------------------
  //
  // SENSITIVE, BOTH OF THEM. A rejection reason is written for the candidate and for an appeal, not
  // for an analytics warehouse or a third-party endpoint. The payload is redacted per channel.
  {
    type: 'candidate.selected',
    source: 'recruitment',
    description: 'A hiring decision went in the candidate’s favour.',
    entityType: 'application',
    required: ['application_id', 'email'],
    optional: ['role_key', 'role_title', 'name', 'decided_by', 'decided_at'],
    channels: ['email', 'workflow', 'webhook', 'analytics'],
    sensitive: true,
  },
  {
    type: 'candidate.rejected',
    source: 'recruitment',
    description: 'A hiring decision closed the application. Decisions here are appealable.',
    entityType: 'application',
    required: ['application_id', 'email'],
    optional: ['role_key', 'role_title', 'name', 'reason', 'decided_by', 'decided_at'],
    channels: ['email', 'workflow', 'webhook', 'analytics'],
    sensitive: true,
  },

  // ---- assessments -------------------------------------------------------------------------
  {
    type: 'assessment.created',
    source: 'talent',
    description: 'An assessment was assigned to a candidate or learner.',
    entityType: 'assessment',
    required: ['assessment_id', 'email'],
    optional: ['title', 'due_at', 'application_id', 'duration_minutes'],
    channels: ['email', 'workflow', 'webhook', 'analytics'],
  },
  {
    type: 'assessment.completed',
    source: 'talent',
    description: 'A candidate or learner finished an assessment attempt.',
    entityType: 'assessment',
    required: ['assessment_id', 'email'],
    optional: ['attempt_id', 'score', 'passed', 'submitted_at', 'application_id'],
    channels: ['email', 'workflow', 'webhook', 'analytics'],
    // A score is a result about a person. It reaches the workflow that decides what to say next; it
    // does not reach a third-party endpoint unless that endpoint is explicitly granted it.
    sensitive: true,
  },

  // ---- interviews --------------------------------------------------------------------------
  {
    type: 'interview.scheduled',
    source: 'talent',
    description: 'An interview slot was booked with a candidate.',
    entityType: 'interview',
    required: ['interview_id', 'email', 'starts_at'],
    optional: ['application_id', 'mode', 'location', 'join_url', 'interviewer_name', 'duration_minutes'],
    channels: ['email', 'workflow', 'webhook', 'analytics'],
  },
  {
    type: 'interview.rescheduled',
    source: 'talent',
    description: 'A booked interview moved to a different time.',
    entityType: 'interview',
    required: ['interview_id', 'starts_at'],
    optional: ['previous_starts_at', 'email', 'reason'],
    channels: ['email', 'workflow', 'webhook', 'analytics'],
  },
  {
    type: 'interview.cancelled',
    source: 'talent',
    description: 'A booked interview was cancelled.',
    entityType: 'interview',
    required: ['interview_id'],
    optional: ['email', 'reason', 'cancelled_by'],
    channels: ['email', 'workflow', 'webhook', 'analytics'],
  },
  {
    type: 'interview.completed',
    source: 'talent',
    description: 'An interview took place and was marked complete.',
    entityType: 'interview',
    required: ['interview_id'],
    optional: ['email', 'application_id', 'outcome'],
    channels: ['workflow', 'webhook', 'analytics'],
    sensitive: true,
  },

  // ---- people ------------------------------------------------------------------------------
  {
    type: 'user.created',
    source: 'university',
    description: 'A platform account was created.',
    entityType: 'user',
    required: ['user_id', 'email'],
    optional: ['name', 'role', 'product'],
    channels: ['email', 'workflow', 'webhook', 'analytics'],
  },
  {
    type: 'user.invited',
    source: 'university',
    description: 'Somebody was invited to create an account.',
    entityType: 'user',
    required: ['email'],
    optional: ['invited_by', 'role', 'invite_url', 'expires_at', 'product'],
    channels: ['email', 'workflow', 'webhook', 'analytics'],
  },

  // ---- learning (AquinTutor) ---------------------------------------------------------------
  {
    type: 'course.enrolled',
    source: 'aquintutor',
    description: 'A learner was enrolled on a course.',
    entityType: 'course',
    required: ['course_id', 'email'],
    optional: ['user_id', 'course_title', 'cohort', 'starts_at'],
    channels: ['email', 'campaign', 'workflow', 'webhook', 'analytics'],
  },
  {
    type: 'course.completed',
    source: 'aquintutor',
    description: 'A learner completed a course.',
    entityType: 'course',
    required: ['course_id', 'email'],
    optional: ['user_id', 'course_title', 'completed_at'],
    channels: ['email', 'workflow', 'webhook', 'analytics'],
  },
  {
    type: 'credential.issued',
    source: 'university',
    description: 'An accredited partner issued a credential. EduRankAI is the platform, never the awarding body.',
    entityType: 'credential',
    required: ['credential_id', 'email'],
    optional: ['user_id', 'title', 'partner', 'verify_url', 'issued_at'],
    channels: ['email', 'workflow', 'webhook', 'analytics'],
  },

  // ---- contacts (the mail platform's own audience) ------------------------------------------
  {
    type: 'contact.created',
    source: 'mail',
    description: 'A contact was added to the mail platform.',
    entityType: 'contact',
    required: ['contact_id', 'email'],
    optional: ['source', 'list_id'],
    channels: ['campaign', 'workflow', 'webhook', 'analytics'],
  },
  {
    type: 'contact.updated',
    source: 'mail',
    description: 'A stored contact record changed.',
    entityType: 'contact',
    required: ['contact_id'],
    optional: ['email', 'changed'],
    channels: ['workflow', 'webhook', 'analytics'],
  },
  {
    type: 'contact.unsubscribed',
    source: 'mail',
    description: 'A contact opted out. Nothing may re-subscribe them but the contact themselves.',
    entityType: 'contact',
    required: ['email'],
    optional: ['contact_id', 'list_id', 'reason'],
    channels: ['workflow', 'webhook', 'analytics'],
  },

  // ---- delivery (published by the mail platform itself) ------------------------------------
  {
    type: 'message.sent',
    source: 'mail',
    description: 'A message was accepted by a transport for delivery.',
    entityType: 'message',
    required: ['message_id'],
    optional: ['to', 'subject', 'template_key', 'campaign_id'],
    channels: ['webhook', 'analytics'],
  },
  {
    type: 'message.delivered',
    source: 'mail',
    description: 'A receiving server confirmed delivery.',
    entityType: 'message',
    required: ['message_id'],
    optional: ['to', 'smtp_code'],
    channels: ['webhook', 'analytics'],
  },
  {
    type: 'message.bounced',
    source: 'mail',
    description: 'Delivery failed permanently or was refused.',
    entityType: 'message',
    required: ['message_id'],
    optional: ['to', 'bounce_type', 'smtp_code', 'diagnostic'],
    channels: ['workflow', 'webhook', 'analytics'],
  },
  {
    type: 'message.opened',
    source: 'mail',
    description: 'An open was recorded. Advisory: image proxies and previews inflate this.',
    entityType: 'message',
    required: ['message_id'],
    optional: ['to', 'user_agent'],
    channels: ['workflow', 'webhook', 'analytics'],
  },
  {
    type: 'message.clicked',
    source: 'mail',
    description: 'A tracked link in a message was followed.',
    entityType: 'message',
    required: ['message_id'],
    optional: ['to', 'url'],
    channels: ['workflow', 'webhook', 'analytics'],
  },
  {
    type: 'campaign.started',
    source: 'mail',
    description: 'A campaign began sending.',
    entityType: 'campaign',
    required: ['campaign_id'],
    optional: ['name', 'recipients'],
    channels: ['webhook', 'analytics'],
  },
  {
    type: 'campaign.finished',
    source: 'mail',
    description: 'A campaign finished sending to its audience.',
    entityType: 'campaign',
    required: ['campaign_id'],
    optional: ['name', 'sent', 'failed'],
    channels: ['webhook', 'analytics'],
  },
] as const;

/**
 * Renames, expressed as forwarding rather than as an edit.
 *
 * A stored webhook filter or route row holds a STRING. Renaming an event type in the catalogue
 * would silently stop matching those rows — the integration keeps returning 200 and nothing
 * arrives. An alias keeps the old spelling working and is resolved at emit time, so the fact is
 * published once under the canonical name and every existing subscription still matches.
 */
export const DEPRECATED_ALIASES: ReadonlyArray<readonly [string, string]> = [
  ['application.stage_changed', 'application.stage.changed'],
  ['candidate.hired', 'candidate.selected'],
];

const TYPE_INDEX = new Map(CANONICAL_EVENTS.map((e) => [e.type, e]));
const ALIAS_INDEX = new Map(DEPRECATED_ALIASES.map(([from, to]) => [from, to]));

/** The canonical spelling of a type, following one alias hop. Unknown types come back unchanged. */
export function canonicalEventType(type: string): string {
  const t = String(type || '').trim().toLowerCase();
  return ALIAS_INDEX.get(t) || t;
}

export function eventDescriptor(type: string): EventDescriptor | null {
  return TYPE_INDEX.get(canonicalEventType(type)) || null;
}

export function isKnownEventType(type: string): boolean {
  return TYPE_INDEX.has(canonicalEventType(type));
}

export function allEventTypes(): string[] {
  return CANONICAL_EVENTS.map((e) => e.type);
}

/** Group the catalogue for a picker. Domain is the first dot-segment. */
export function eventsByDomain(): { domain: string; events: EventDescriptor[] }[] {
  const out = new Map<string, EventDescriptor[]>();
  for (const e of CANONICAL_EVENTS) {
    const domain = e.type.split('.')[0];
    const list = out.get(domain) || [];
    list.push(e);
    out.set(domain, list);
  }
  return [...out.entries()].map(([domain, events]) => ({ domain, events }));
}

/**
 * The nearest known type to a misspelling, for the error message.
 *
 * "application.stage.change is not an event type" is a bad message; "did you mean
 * application.stage.changed?" is the one that ends the incident. Edit distance over a 26-entry
 * catalogue is free.
 */
export function suggestEventType(type: string): string | null {
  const t = String(type || '').toLowerCase();
  if (!t) return null;
  let best: string | null = null;
  let bestD = Infinity;
  for (const known of TYPE_INDEX.keys()) {
    const d = editDistance(t, known);
    if (d < bestD) { bestD = d; best = known; }
  }
  // A suggestion that is more than a third wrong is noise, not help.
  return best && bestD <= Math.max(3, Math.floor(best.length / 3)) ? best : null;
}

function editDistance(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev: number[] = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    const cur: number[] = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

// ---------------------------------------------------------------------------------------------
// Pattern matching — what a webhook filter and a route both use
// ---------------------------------------------------------------------------------------------

/**
 * Does `type` match `pattern`?
 *
 * The rules, deliberately small enough to print in the console next to the input box:
 *   `*`                     every event
 *   `application.*`         every event whose first segment is `application`, however deep
 *   `application.stage.*`   every event under that prefix
 *   `*.completed`           a `*` in a non-final position matches EXACTLY ONE segment
 *   `application.created`   exact
 *
 * The trailing `*` matching one-or-more segments is the deviation from strict glob semantics, and
 * it is deliberate: everybody who types `application.*` in a filter box means "everything about
 * applications", and under strict single-segment rules that silently excludes
 * `application.stage.changed` — the single most-subscribed event in this catalogue.
 */
export function matchesPattern(type: string, pattern: string): boolean {
  const t = canonicalEventType(type);
  const p = String(pattern || '').trim().toLowerCase();
  if (!t || !p) return false;
  if (p === '*' || p === '**') return true;
  if (p === t) return true;

  const ps = p.split('.');
  const ts = t.split('.');
  for (let i = 0; i < ps.length; i++) {
    const seg = ps[i];
    const last = i === ps.length - 1;
    if (seg === '*' && last) return ts.length > i;      // trailing star: one or more remaining
    if (i >= ts.length) return false;
    if (seg === '*') continue;                          // interior star: exactly one segment
    if (seg !== ts[i]) return false;
  }
  return ps.length === ts.length;
}

/** True when ANY pattern in the list matches. An empty list means "no subscription", never "all". */
export function matchesAnyPattern(type: string, patterns: readonly string[] | null | undefined): boolean {
  if (!patterns || !patterns.length) return false;
  return patterns.some((p) => matchesPattern(type, p));
}

/**
 * Is this a pattern the platform can store?
 *
 * Refused at write time rather than at match time, because a filter that matches nothing looks
 * exactly like an endpoint that is never called.
 */
export function validatePattern(pattern: string): { ok: boolean; error?: string } {
  const p = String(pattern || '').trim();
  if (!p) return { ok: false, error: 'An event filter cannot be empty. Use * to subscribe to everything.' };
  if (!/^[a-z0-9_.*]+$/.test(p)) return { ok: false, error: 'Event filters use lowercase letters, digits, underscore, dot and *.' };
  if (p === '*' || p === '**') return { ok: true };
  if (allEventTypes().some((t) => matchesPattern(t, p))) return { ok: true };
  return { ok: false, error: '"' + p + '" matches no event in the catalogue, so an endpoint subscribed to it would never be called.' };
}

// ---------------------------------------------------------------------------------------------
// The envelope
// ---------------------------------------------------------------------------------------------

/** Wire version stamped on every published event and every webhook body. */
export const EVENT_ENVELOPE_VERSION = '2026-08-16';

export interface CanonicalEvent {
  /** Our id for the fact. Assigned at emit; echoed in the webhook body as `id`. */
  id?: string;
  orgId: string;
  type: string;
  source: EventSource | string;
  entityType?: string | null;
  entityId?: string | null;
  actorType?: 'user' | 'api_key' | 'system' | 'connector' | null;
  actorId?: string | null;
  payload: Record<string, unknown>;
  /** When the fact happened in the SOURCE system — not when we heard about it. */
  occurredAt: string;
  /**
   * The duplicate suppressor. Supplied by the caller when it has a natural key; derived otherwise.
   * Section 9 of the brief: "duplicate events must not create duplicate emails."
   */
  idempotencyKey?: string;
  /** The id the external system knows this event by, when there is one. */
  externalEventId?: string | null;
}

export interface EventValidation {
  ok: boolean;
  errors: string[];
  /** The event with type canonicalised, timestamp normalised and idempotency key filled in. */
  normalized?: CanonicalEvent;
}

const FUTURE_SKEW_MS = 25 * 60 * 60 * 1000;      // a day plus an hour of clock slop
const PAST_LIMIT_MS = 365 * 24 * 60 * 60 * 1000; // a year

/**
 * Validate and normalise an event before it is allowed onto the bus.
 *
 * Everything here is a REFUSAL, not a repair, except the three normalisations that cannot change
 * meaning: lowercasing the type, resolving an alias, and turning a timestamp into ISO. A platform
 * that quietly repairs a malformed event teaches its callers to send malformed events.
 */
export function validateEvent(input: Partial<CanonicalEvent>, now: number = Date.now()): EventValidation {
  const errors: string[] = [];
  const type = canonicalEventType(String(input.type || ''));
  const desc = TYPE_INDEX.get(type);

  if (!type) {
    errors.push('type is required.');
  } else if (!desc) {
    const hint = suggestEventType(type);
    errors.push('"' + type + '" is not an event in the catalogue' + (hint ? ' — did you mean "' + hint + '"?' : '.'));
  }
  if (!input.orgId) errors.push('orgId is required — every event belongs to exactly one organisation.');
  if (!input.source) errors.push('source is required — name the system the fact came from.');

  const payload = (input.payload && typeof input.payload === 'object' && !Array.isArray(input.payload))
    ? (input.payload as Record<string, unknown>)
    : null;
  if (!payload) errors.push('payload must be a JSON object.');

  if (desc && payload) {
    for (const key of desc.required) {
      const v = payload[key];
      if (v === undefined || v === null || v === '') {
        errors.push('payload.' + key + ' is required for ' + desc.type + '.');
      }
    }
  }

  // A timestamp is a claim about the source's clock, and a wrong one silently reorders an audit
  // trail. Out of range is refused rather than clamped.
  let occurredAt = String(input.occurredAt || '');
  if (!occurredAt) {
    occurredAt = new Date(now).toISOString();
  } else {
    const t = Date.parse(occurredAt);
    if (!Number.isFinite(t)) {
      errors.push('occurredAt is not a parseable timestamp. Send RFC 3339, e.g. 2026-08-16T09:30:00Z.');
    } else if (t > now + FUTURE_SKEW_MS) {
      errors.push('occurredAt is more than a day in the future. Check the sending system’s clock.');
    } else if (t < now - PAST_LIMIT_MS) {
      errors.push('occurredAt is more than a year old. Backfills go through the import API, not the event bus.');
    } else {
      occurredAt = new Date(t).toISOString();
    }
  }

  if (errors.length) return { ok: false, errors };

  const normalized: CanonicalEvent = {
    orgId: String(input.orgId),
    type,
    source: String(input.source) as EventSource,
    entityType: input.entityType ?? desc?.entityType ?? null,
    entityId: input.entityId ?? entityIdFromPayload(desc, payload!),
    actorType: input.actorType ?? 'system',
    actorId: input.actorId ?? null,
    payload: payload!,
    occurredAt,
    externalEventId: input.externalEventId ?? null,
  };
  normalized.idempotencyKey = input.idempotencyKey || deriveIdempotencyKey(normalized);
  return { ok: true, errors: [], normalized };
}

/** `application_id` for an application event, and so on. Saves every caller repeating it. */
function entityIdFromPayload(desc: EventDescriptor | undefined, payload: Record<string, unknown>): string | null {
  if (!desc) return null;
  const key = desc.entityType + '_id';
  const v = payload[key];
  return v === undefined || v === null ? null : String(v);
}

/**
 * The duplicate key.
 *
 * PREFERENCE ORDER MATTERS. When the source gave us its own event id, that id IS the identity of
 * the fact and nothing else may be mixed in — the same delivery retried by the sender carries the
 * same id with a fresh timestamp, and hashing the timestamp in would make the retry look new.
 *
 * Without one, the natural key is (source, type, entity, occurred-at-the-second, PAYLOAD). The
 * payload is in there because leaving it out was wrong in a way a test caught: an earlier version
 * keyed on (source, type, entity, second) alone, so an application advanced twice inside one second
 * — which a scripted bulk advance does routinely — produced one key, and the second stage change was
 * swallowed as a duplicate. The candidate would then never be told about the stage they actually
 * reached. With the payload included, a retry of the identical fact still collapses (identical bytes
 * hash identically) and two genuinely different facts stay separate.
 *
 * A FNV-1a hash, not sha256, because this file must stay importable without node:crypto — the
 * console and the tests both load it — and the value is a dedupe key, not a security token.
 */
export function deriveIdempotencyKey(
  e: Pick<CanonicalEvent, 'type' | 'source' | 'entityId' | 'occurredAt' | 'externalEventId' | 'payload'>,
): string {
  const parts = e.externalEventId
    ? ['ext', String(e.source), String(e.externalEventId)]
    : [
        'nat',
        String(e.source),
        canonicalEventType(e.type),
        String(e.entityId || '-'),
        String(e.occurredAt || '').slice(0, 19), // second precision
        stableFingerprint(e.payload || {}),
      ];
  return 'idem_' + fnv1a(parts.join('|'));
}

/** A stable short digest of a payload, for events with no entity id of their own. */
export function stableFingerprint(payload: Record<string, unknown>): string {
  return fnv1a(stableStringify(payload));
}

/** JSON with sorted keys, so two equal payloads always produce the same string. */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  const keys = Object.keys(v as Record<string, unknown>).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify((v as any)[k])).join(',') + '}';
}

function fnv1a(s: string): string {
  // Two 32-bit passes with different constants, concatenated. A single 32-bit hash collides at
  // around 77k values by the birthday bound, which here is about a week of events.
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 ^= c; h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 ^= c + i; h2 = Math.imul(h2, 0x85ebca6b) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

/**
 * The body a webhook endpoint receives. Shaped once, here, so the console preview and the real
 * delivery cannot drift — a test console that shows a body the dispatcher does not send is worse
 * than no test console at all.
 */
export function webhookBody(e: CanonicalEvent & { id: string }): Record<string, unknown> {
  return {
    id: e.id,
    type: e.type,
    version: EVENT_ENVELOPE_VERSION,
    source: e.source,
    org_id: e.orgId,
    entity: e.entityType ? { type: e.entityType, id: e.entityId || null } : null,
    occurred_at: e.occurredAt,
    idempotency_key: e.idempotencyKey || null,
    data: e.payload,
  };
}

/**
 * A realistic example payload for one event type. Used by the webhook test console's "send test
 * event" and by the docs. Every value is obviously synthetic — a test event that looks like real
 * candidate data is a test event somebody will act on.
 */
export function sampleEvent(type: string, orgId = 'org_test'): CanonicalEvent | null {
  const desc = eventDescriptor(type);
  if (!desc) return null;
  const payload: Record<string, unknown> = {};
  for (const key of [...desc.required, ...(desc.optional || [])]) {
    payload[key] = samplePayloadValue(key, desc);
  }
  return {
    orgId,
    type: desc.type,
    source: desc.source,
    entityType: desc.entityType,
    entityId: String(payload[desc.entityType + '_id'] || 'test_entity'),
    actorType: 'system',
    actorId: null,
    payload,
    occurredAt: new Date().toISOString(),
  };
}

function samplePayloadValue(key: string, desc: EventDescriptor): unknown {
  if (key === 'email') return 'test.candidate@example.com';
  if (key === 'name' || key === 'interviewer_name' || key === 'actor_name') return 'Test Person';
  if (key.endsWith('_id')) return 'test_' + key.slice(0, -3);
  if (key.endsWith('_at')) return new Date().toISOString();
  if (key === 'stage') return 'assessment';
  if (key === 'previous_stage') return 'review';
  if (key === 'stage_index') return 3;
  if (key === 'stage_label') return 'Assessment';
  if (key === 'score') return 72;
  if (key === 'passed') return true;
  if (key === 'url' || key === 'join_url' || key === 'verify_url' || key === 'invite_url') return 'https://www.edurankai.in/example';
  if (key === 'role_key') return 'test-role';
  if (key === 'role_title' || key === 'title' || key === 'course_title') return 'Example Role';
  if (key === 'reason' || key === 'note' || key === 'detail') return 'This is a test event.';
  if (key === 'sent' || key === 'failed' || key === 'recipients' || key === 'duration_minutes') return 1;
  return 'test_' + desc.entityType + '_' + key;
}
