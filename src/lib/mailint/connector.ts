// src/lib/mailint/connector.ts — THE CONNECTOR SDK. Pure; no database, no network, no vendor.
//
// Section 11 of the brief asks for one internal interface:
//
//     Connector
//      ├── authenticate()   is this caller who they claim to be?
//      ├── validate()       is this payload the shape we agreed?
//      ├── receive()        pull the individual external events out of it
//      ├── normalize()      turn each into a canonical EduRankAI Mail event
//      ├── emit()           publish onto the bus
//      └── health()         connected / degraded / failed / expired / disabled
//
// A CONNECTOR NEVER TOUCHES THE DATABASE, THE VAULT OR THE TRANSPORT. Everything it needs arrives
// on a ConnectorContext: a function to read a decrypted credential, a function to publish an event,
// and the mappings configured for the integration. That is what makes the whole set testable
// without a connection, and it is also the boundary that keeps a future third-party connector —
// written against an API we do not control — from being able to read anything but its own secrets.
//
// THE PIPELINE IS RUN BY runConnectorPipeline(), NOT BY EACH CONNECTOR. Every connector that
// implemented its own ordering would eventually implement it differently: one would normalize
// before validating, one would emit before deduplicating. One runner, six overridable steps.

import type { CanonicalEvent } from './events';
import { applyMapping, selectMapping, type EventMapping } from './mapping';
import { credentialState, type CredentialState } from './policy';

// ---------------------------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------------------------

export type ConnectorDirection = 'inbound' | 'outbound' | 'bidirectional';

/**
 * `available` — implemented, tested, usable today.
 * `planned`   — the framework supports it, nothing is implemented. The console says so in those
 *               words and offers no connect button, because a connector that looks connectable and
 *               is not is worse than one that is honestly absent.
 */
export type ConnectorAvailability = 'available' | 'planned';

export type CredentialKind = 'api_key' | 'oauth_token' | 'webhook_secret' | 'smtp' | 'basic';

export interface ConnectorMeta {
  /** Stable machine key. Stored on every integration row; renaming one orphans its integrations. */
  key: string;
  name: string;
  /** One paragraph the console shows. Written for the person deciding whether to connect it. */
  description: string;
  direction: ConnectorDirection;
  availability: ConnectorAvailability;
  /** Which EduRankAI product or external family this belongs to. Groups the console list. */
  family: 'edurankai' | 'messaging' | 'productivity' | 'crm' | 'ats' | 'sis' | 'government' | 'erp';
  /** Canonical events this connector can produce. Empty for a purely outbound connector. */
  produces: readonly string[];
  /** Canonical events this connector can deliver outwards. Empty for a purely inbound one. */
  consumes?: readonly string[];
  /** Credentials it needs to work at all. Health is `expired` when any of them is. */
  requires: readonly CredentialKind[];
  /**
   * For `planned` connectors: the specific thing that is missing. Never "coming soon" — a sentence
   * that names the actual blocker, so the person reading it can judge how far away it is.
   */
  blockedOn?: string;
  /** Documentation anchor in docs/mail/INTEGRATIONS.md. */
  docs?: string;
}

// ---------------------------------------------------------------------------------------------
// Context and results
// ---------------------------------------------------------------------------------------------

export interface InboundRequest {
  /** Lowercased header names. */
  headers: Record<string, string>;
  /** The EXACT bytes received, as text. Signature verification must not see a re-serialised body. */
  rawBody: string;
  /** Already-parsed body, when the caller has one. Connectors should prefer this over re-parsing. */
  json?: unknown;
  method: string;
  ip?: string | null;
}

export interface PublishResult {
  ok: boolean;
  eventId?: string;
  /** True when this exact event had already been published; NOT an error. */
  duplicate?: boolean;
  error?: string;
}

export interface ConnectorContext {
  orgId: string;
  integrationId: string | null;
  environment: string;
  /** Decrypted credential material, fetched on demand. Never held on the connector object. */
  credential(kind: CredentialKind): Promise<string | null>;
  /** State of each required credential, for health(). No plaintext involved. */
  credentialStates?: Partial<Record<CredentialKind, CredentialState>>;
  /** The ONLY way an event leaves a connector. */
  publish(event: Partial<CanonicalEvent>): Promise<PublishResult>;
  /** Mappings configured for this integration, already ordered by the caller. */
  mappings: EventMapping[];
  /** Counters the health report reads. */
  stats?: { consecutiveFailures?: number; lastSuccessAt?: string | null; lastFailureAt?: string | null; lastEventAt?: string | null };
  disabled?: boolean;
  now?: number;
}

export interface StepResult<T = unknown> {
  ok: boolean;
  data?: T;
  /** Machine-readable failure reason. The HTTP layer maps these to status codes. */
  code?: 'unauthorized' | 'invalid_signature' | 'invalid_payload' | 'unsupported' | 'not_implemented' | 'mapping_failed' | 'publish_failed' | 'internal';
  error?: string;
}

/** One event as the external system phrased it, before mapping. */
export interface ExternalEvent {
  /** The sender's own id for it, when present. This is what makes their retry our duplicate. */
  externalId?: string | null;
  /** The sender's own type string, for logs and for the mapping's value table. */
  externalType?: string | null;
  body: unknown;
}

export type HealthStatus = 'connected' | 'degraded' | 'failed' | 'expired' | 'disabled';

export interface HealthReport {
  status: HealthStatus;
  /** One sentence an operator can act on. Never "not configured" alone. */
  detail: string;
  checkedAt: string;
  latencyMs?: number | null;
  /** Facts the console shows under the status chip. */
  facts?: Record<string, string | number | null>;
}

// ---------------------------------------------------------------------------------------------
// The interface
// ---------------------------------------------------------------------------------------------

export interface Connector {
  meta: ConnectorMeta;
  /** Prove the caller is the external system. Signature, shared secret, or the API key alone. */
  authenticate(req: InboundRequest, ctx: ConnectorContext): Promise<StepResult<{ detail: string }>>;
  /** Structural check. Cheap, and before anything is stored. */
  validate(req: InboundRequest, ctx: ConnectorContext): Promise<StepResult<unknown>>;
  /** Split the payload into individual external events. A batch endpoint returns several. */
  receive(parsed: unknown, ctx: ConnectorContext): Promise<StepResult<ExternalEvent[]>>;
  /** External shape to canonical events. Usually the mapping engine; a connector may override. */
  normalize(events: ExternalEvent[], ctx: ConnectorContext): Promise<StepResult<Partial<CanonicalEvent>[]>>;
  /** Publish. The default hands each event to ctx.publish() and reports duplicates as duplicates. */
  emit(events: Partial<CanonicalEvent>[], ctx: ConnectorContext): Promise<StepResult<{ published: number; duplicates: number; failed: number; eventIds: string[] }>>;
  /** Never throws. A health check that throws reads as "unknown", and unknown reads as fine. */
  health(ctx: ConnectorContext): Promise<HealthReport>;
}

// ---------------------------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------------------------

/** Consecutive failures at which an integration stops being "degraded" and starts being "failed". */
export const FAILURE_THRESHOLD = 5;

/**
 * The five states of section 12, decided in one place.
 *
 * ORDER IS THE DESIGN. `disabled` beats everything (a switched-off integration is not failing, and
 * paging somebody about it is how alerts get muted). `expired` beats `failed` because an expired
 * credential explains the failures and names the fix. `failed` beats `degraded`. Everything else,
 * including an integration that has simply never been used, is `connected` — and the detail line
 * says which, because "connected, no events yet" and "connected, last event 4 minutes ago" are
 * different situations that must not render identically.
 */
export function computeHealth(input: {
  disabled?: boolean;
  credentialStates?: Partial<Record<CredentialKind, CredentialState>>;
  required?: readonly CredentialKind[];
  consecutiveFailures?: number;
  lastSuccessAt?: string | null;
  lastFailureAt?: string | null;
  lastEventAt?: string | null;
  /** When set, an integration that has published nothing for this long is degraded (a heartbeat). */
  expectedIntervalMs?: number | null;
  now?: number;
}): HealthReport {
  const now = input.now ?? Date.now();
  const checkedAt = new Date(now).toISOString();
  const facts: Record<string, string | number | null> = {
    consecutive_failures: input.consecutiveFailures ?? 0,
    last_event_at: input.lastEventAt ?? null,
    last_success_at: input.lastSuccessAt ?? null,
    last_failure_at: input.lastFailureAt ?? null,
  };

  if (input.disabled) {
    return { status: 'disabled', detail: 'Switched off in the console. Nothing is sent or received.', checkedAt, facts };
  }

  const states = input.credentialStates || {};
  const required = input.required || [];
  const dead = required.filter((k) => states[k] === 'expired' || states[k] === 'revoked');
  if (dead.length) {
    return {
      status: 'expired',
      detail: dead.map((k) => k.replace(/_/g, ' ')).join(' and ') + ' ' + (dead.length > 1 ? 'have' : 'has') + ' expired or been revoked. Re-authorise the integration; nothing will flow until you do.',
      checkedAt,
      facts,
    };
  }
  const missing = required.filter((k) => !(k in states));
  if (missing.length) {
    return {
      status: 'failed',
      detail: 'No ' + missing.map((k) => k.replace(/_/g, ' ')).join(' or ') + ' is stored for this integration, and it cannot authenticate without one.',
      checkedAt,
      facts,
    };
  }

  const failures = input.consecutiveFailures ?? 0;
  if (failures >= FAILURE_THRESHOLD) {
    return {
      status: 'failed',
      detail: failures + ' consecutive failures. The last one was ' + (input.lastFailureAt ? describeAge(input.lastFailureAt, now) : 'not recorded') + '.',
      checkedAt,
      facts,
    };
  }

  const expiring = required.filter((k) => states[k] === 'expiring');
  if (expiring.length) {
    return {
      status: 'degraded',
      detail: expiring.map((k) => k.replace(/_/g, ' ')).join(' and ') + ' expires within a week. Renew it before it stops working.',
      checkedAt,
      facts,
    };
  }

  if (failures > 0) {
    return {
      status: 'degraded',
      detail: failures + ' recent ' + (failures === 1 ? 'failure' : 'failures') + ', last ' + (input.lastFailureAt ? describeAge(input.lastFailureAt, now) : 'recently') + '. Still delivering.',
      checkedAt,
      facts,
    };
  }

  if (input.expectedIntervalMs && input.lastEventAt) {
    const age = now - Date.parse(String(input.lastEventAt));
    if (Number.isFinite(age) && age > input.expectedIntervalMs) {
      return {
        status: 'degraded',
        detail: 'Nothing received for ' + describeAge(input.lastEventAt, now) + ', which is longer than this integration’s expected interval. Silence here is not proof of a quiet week.',
        checkedAt,
        facts,
      };
    }
  }

  return {
    status: 'connected',
    detail: input.lastEventAt
      ? 'Last event ' + describeAge(input.lastEventAt, now) + '.'
      : 'Credentials are in place. No event has been received yet.',
    checkedAt,
    facts,
  };
}

function describeAge(iso: string, now: number): string {
  const t = Date.parse(String(iso));
  if (!Number.isFinite(t)) return 'at an unrecorded time';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return s + ' seconds ago';
  if (s < 3600) return Math.round(s / 60) + ' minutes ago';
  if (s < 86400) return Math.round(s / 3600) + ' hours ago';
  return Math.round(s / 86400) + ' days ago';
}

/** Turn stored credential rows into the state map computeHealth() wants. */
export function credentialStatesOf(
  creds: { kind: CredentialKind; expiresAt?: string | null; revokedAt?: string | null }[],
  now: number = Date.now(),
): Partial<Record<CredentialKind, CredentialState>> {
  const out: Partial<Record<CredentialKind, CredentialState>> = {};
  for (const c of creds) {
    const s = credentialState(c, now);
    const existing = out[c.kind];
    // Worst state wins: two API keys where one has expired is not a healthy integration if the
    // expired one is the one in use, and we cannot tell from here which that is.
    if (!existing || rank(s) > rank(existing)) out[c.kind] = s;
  }
  return out;
}

function rank(s: CredentialState): number {
  return s === 'revoked' ? 4 : s === 'expired' ? 3 : s === 'expiring' ? 2 : 1;
}

// ---------------------------------------------------------------------------------------------
// The base connector
// ---------------------------------------------------------------------------------------------

/**
 * Sensible defaults for every step, so a first-party connector is usually just metadata plus a
 * `receive()`. Each method is overridable; none of them throws.
 */
export abstract class BaseConnector implements Connector {
  abstract meta: ConnectorMeta;

  /**
   * Default: the API key that reached this route already authenticated the caller.
   *
   * Deliberately explicit rather than absent. An inbound route for a THIRD-PARTY system must
   * override this with a signature check — a shared bearer token in a URL that a customer's
   * webhook configuration screen logs is not authentication, and the default returning `ok` would
   * quietly become the answer for connectors that need more.
   */
  async authenticate(_req: InboundRequest, _ctx: ConnectorContext): Promise<StepResult<{ detail: string }>> {
    return { ok: true, data: { detail: 'Authenticated by the platform API key on the request.' } };
  }

  async validate(req: InboundRequest, _ctx: ConnectorContext): Promise<StepResult<unknown>> {
    if (req.method !== 'POST') return { ok: false, code: 'invalid_payload', error: 'Events are posted, not ' + req.method + '.' };
    let parsed: unknown = req.json;
    if (parsed === undefined) {
      if (!req.rawBody || !req.rawBody.trim()) return { ok: false, code: 'invalid_payload', error: 'The request body is empty.' };
      try { parsed = JSON.parse(req.rawBody); } catch (e: any) {
        return { ok: false, code: 'invalid_payload', error: 'The body is not valid JSON: ' + String(e?.message || 'parse error').slice(0, 120) };
      }
    }
    if (!parsed || typeof parsed !== 'object') return { ok: false, code: 'invalid_payload', error: 'The body must be a JSON object or array.' };
    return { ok: true, data: parsed };
  }

  /** Default: one object is one event; an array, or `{ events: [...] }`, is a batch. */
  async receive(parsed: unknown, _ctx: ConnectorContext): Promise<StepResult<ExternalEvent[]>> {
    const list = Array.isArray(parsed)
      ? parsed
      : (parsed && typeof parsed === 'object' && Array.isArray((parsed as any).events))
        ? (parsed as any).events
        : [parsed];
    if (!list.length) return { ok: true, data: [] };
    if (list.length > MAX_BATCH) {
      return { ok: false, code: 'invalid_payload', error: 'A batch may carry at most ' + MAX_BATCH + ' events; this one carried ' + list.length + '.' };
    }
    return {
      ok: true,
      data: list.map((body: any) => ({
        externalId: body?.event_id ?? body?.id ?? null,
        externalType: body?.event ?? body?.type ?? null,
        body,
      })),
    };
  }

  /** Default: the configured mappings decide. An unmapped event is SKIPPED, not failed. */
  async normalize(events: ExternalEvent[], ctx: ConnectorContext): Promise<StepResult<Partial<CanonicalEvent>[]>> {
    const out: Partial<CanonicalEvent>[] = [];
    const problems: string[] = [];
    for (const ext of events) {
      const mapping = selectMapping(ctx.mappings || [], ext.body);
      if (!mapping) continue; // nothing claims it; acknowledged and dropped, see the pipeline note
      const r = applyMapping(mapping, ext.body, { receivedAt: new Date(ctx.now ?? Date.now()).toISOString() });
      if (r.skipped) continue;
      if (!r.ok || !r.event) { problems.push(mapping.name + ': ' + r.errors.join('; ')); continue; }
      const evt = r.event;
      // The sender's id wins over anything the mapping produced — it is the identity of their fact.
      if (ext.externalId && !evt.externalEventId) evt.externalEventId = String(ext.externalId);
      evt.orgId = ctx.orgId; // NEVER from the payload
      out.push(evt);
    }
    if (!out.length && problems.length) return { ok: false, code: 'mapping_failed', error: problems.join(' | ') };
    return { ok: true, data: out };
  }

  async emit(events: Partial<CanonicalEvent>[], ctx: ConnectorContext): Promise<StepResult<{ published: number; duplicates: number; failed: number; eventIds: string[] }>> {
    let published = 0, duplicates = 0, failed = 0;
    const eventIds: string[] = [];
    const errors: string[] = [];
    for (const e of events) {
      const r = await ctx.publish(e);
      if (r.ok && r.duplicate) { duplicates++; if (r.eventId) eventIds.push(r.eventId); continue; }
      if (r.ok) { published++; if (r.eventId) eventIds.push(r.eventId); continue; }
      failed++;
      if (r.error) errors.push(r.error);
    }
    // A partial failure is a failure WITH the successes reported, not a 500 that hides them: the
    // sender must be able to see that four of five landed, or it will replay all five.
    return {
      ok: failed === 0,
      code: failed ? 'publish_failed' : undefined,
      error: errors.length ? errors.slice(0, 3).join(' | ') : undefined,
      data: { published, duplicates, failed, eventIds },
    };
  }

  async health(ctx: ConnectorContext): Promise<HealthReport> {
    return computeHealth({
      disabled: ctx.disabled,
      credentialStates: ctx.credentialStates,
      required: this.meta.requires,
      consecutiveFailures: ctx.stats?.consecutiveFailures,
      lastSuccessAt: ctx.stats?.lastSuccessAt ?? null,
      lastFailureAt: ctx.stats?.lastFailureAt ?? null,
      lastEventAt: ctx.stats?.lastEventAt ?? null,
      now: ctx.now,
    });
  }
}

/** A batch bigger than this is a mistake or an attack, and either way it is refused whole. */
export const MAX_BATCH = 500;

// ---------------------------------------------------------------------------------------------
// A connector that exists only as a plan
// ---------------------------------------------------------------------------------------------

/**
 * The honest placeholder for section 13's future connectors.
 *
 * Every step refuses with `not_implemented` and the metadata's `blockedOn` sentence. It is
 * registered, listed and documented — so the framework demonstrably has a place for Slack, Teams,
 * an ATS or a university SIS — and it cannot be switched on, cannot be given credentials, and
 * cannot pretend to deliver. The alternative (leaving them out entirely) loses the architecture;
 * the other alternative (a stub that returns ok) is a lie the console would repeat.
 */
export class PlannedConnector extends BaseConnector {
  constructor(public meta: ConnectorMeta) {
    super();
    if (meta.availability !== 'planned') throw new Error('PlannedConnector requires availability: planned');
  }
  private refuse(): StepResult<any> {
    return { ok: false, code: 'not_implemented', error: this.meta.name + ' is not implemented. ' + (this.meta.blockedOn || '') };
  }
  // The parameters are declared and ignored, deliberately: a planned connector must be callable
  // exactly like a real one, so the pipeline, the console and the tests exercise it through the same
  // interface and discover the refusal rather than a type error.
  async authenticate(_req: InboundRequest, _ctx: ConnectorContext): Promise<StepResult<{ detail: string }>> { return this.refuse(); }
  async validate(_req: InboundRequest, _ctx: ConnectorContext): Promise<StepResult<unknown>> { return this.refuse(); }
  async receive(_parsed: unknown, _ctx: ConnectorContext): Promise<StepResult<ExternalEvent[]>> { return this.refuse(); }
  async normalize(_events: ExternalEvent[], _ctx: ConnectorContext): Promise<StepResult<Partial<CanonicalEvent>[]>> { return this.refuse(); }
  async emit(_events: Partial<CanonicalEvent>[], _ctx: ConnectorContext): Promise<StepResult<any>> { return this.refuse(); }
  async health(ctx: ConnectorContext): Promise<HealthReport> {
    return {
      status: 'disabled',
      detail: 'Planned, not implemented. ' + (this.meta.blockedOn || ''),
      checkedAt: new Date(ctx.now ?? Date.now()).toISOString(),
      facts: { availability: 'planned' },
    };
  }
}

// ---------------------------------------------------------------------------------------------
// The pipeline
// ---------------------------------------------------------------------------------------------

export interface PipelineTrace {
  step: 'authenticate' | 'validate' | 'receive' | 'normalize' | 'emit';
  ok: boolean;
  detail: string;
  ms: number;
}

export interface PipelineResult {
  ok: boolean;
  code?: StepResult['code'];
  error?: string;
  received: number;
  normalized: number;
  published: number;
  duplicates: number;
  failed: number;
  eventIds: string[];
  trace: PipelineTrace[];
}

/**
 * Integration -> Authentication -> Event Router -> Connector -> EduRankAI Mail, executed.
 *
 * ONE DECISION WORTH STATING: an event that no mapping claims is ACKNOWLEDGED, not rejected. An
 * external system typically sends every event type it has to a single endpoint; refusing the ones
 * we have not mapped would make it retry them forever, and after a day of that its own dead-letter
 * queue is full of our 400s and the integration looks broken to its owner. They are counted, and
 * the count is what the console shows next to "unmapped".
 */
export async function runConnectorPipeline(
  connector: Connector,
  req: InboundRequest,
  ctx: ConnectorContext,
  clock: () => number = () => Date.now(),
): Promise<PipelineResult> {
  const trace: PipelineTrace[] = [];
  const base: PipelineResult = { ok: false, received: 0, normalized: 0, published: 0, duplicates: 0, failed: 0, eventIds: [], trace };

  const step = async <T>(name: PipelineTrace['step'], fn: () => Promise<StepResult<T>>): Promise<StepResult<T>> => {
    const t0 = clock();
    let r: StepResult<T>;
    try {
      r = await fn();
    } catch (e: any) {
      // A connector that throws is a bug in the connector, not a 500 for the whole platform. It is
      // reported as a failed step with the real reason, and the pipeline stops cleanly.
      r = { ok: false, code: 'internal', error: String(e?.cause?.message || e?.message || e).slice(0, 300) };
    }
    trace.push({ step: name, ok: r.ok, detail: r.ok ? 'ok' : String(r.error || r.code || 'failed'), ms: Math.max(0, clock() - t0) });
    return r;
  };

  const auth = await step('authenticate', () => connector.authenticate(req, ctx));
  if (!auth.ok) return { ...base, code: auth.code || 'unauthorized', error: auth.error };

  const valid = await step('validate', () => connector.validate(req, ctx));
  if (!valid.ok) return { ...base, code: valid.code || 'invalid_payload', error: valid.error };

  const received = await step('receive', () => connector.receive(valid.data, ctx));
  if (!received.ok) return { ...base, code: received.code || 'invalid_payload', error: received.error };
  const externals = received.data || [];
  base.received = externals.length;

  const normalized = await step('normalize', () => connector.normalize(externals, ctx));
  if (!normalized.ok) return { ...base, code: normalized.code || 'mapping_failed', error: normalized.error };
  const events = normalized.data || [];
  base.normalized = events.length;

  if (!events.length) {
    trace.push({ step: 'emit', ok: true, detail: 'nothing to publish', ms: 0 });
    return { ...base, ok: true };
  }

  const emitted = await step('emit', () => connector.emit(events, ctx));
  const d = emitted.data || { published: 0, duplicates: 0, failed: 0, eventIds: [] };
  return {
    ...base,
    ok: emitted.ok,
    code: emitted.code,
    error: emitted.error,
    published: d.published,
    duplicates: d.duplicates,
    failed: d.failed,
    eventIds: d.eventIds,
  };
}
