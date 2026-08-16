// src/lib/mailint/emit.ts — THE ONE LINE A PRODUCT WRITES.
//
// Everything else in this directory is machinery. This is the surface the rest of the repository
// touches: state a fact, in one call, from inside an existing transaction-free code path, and never
// think about mail again.
//
//     await emitProductEvent('careers', 'application.stage.changed', {
//       application_id: id, stage: 'assessment', email: candidate.email,
//     });
//
// THREE PROPERTIES, ALL DELIBERATE:
//
// 1. IT NEVER THROWS. A stage advance must not fail because a mail route was misconfigured. The
//    same rule advanceStage() already applies to its candidate notification, for the same reason.
//    Failures are logged with the real Postgres reason (e.cause), never swallowed silently — that
//    distinction is what src/lib/ensure-once.ts was rewritten for.
//
// 2. IT NEVER BLOCKS ON DELIVERY. emitEvent() stores the fact and queues the work; webhook posts
//    and delayed steps are performed by the dispatcher. So the cost to the caller is two inserts,
//    not a customer's endpoint timing out inside a hiring desk's page load.
//
// 3. THE ENVIRONMENT IS DECIDED HERE, ONCE. A development deployment publishes into the development
//    environment, where the email action renders and reports instead of sending. Nothing about a
//    call site changes between the two, so nobody has to remember.
import { emitEvent, getOrCreateOrg, type Environment } from './router';
import type { EventSource } from './events';

/** Product key -> the organisation record its events belong to. Cached per process, not per call. */
const ORG_CACHE = new Map<string, string>();

const PRODUCT_NAMES: Record<string, string> = {
  careers: 'EduRankAI Careers',
  aquintutor: 'AquinTutor',
  talent: 'EduRankAI Talent',
  recruitment: 'EduRankAI recruitment',
  university: 'EduRankAI university systems',
  mail: 'EduRankAI Mail',
};

/**
 * Which environment this deployment publishes into.
 *
 * Vercel's own signal first (VERCEL_ENV is `production` only on the production deployment), then
 * NODE_ENV, and development if neither says otherwise. FAILS TOWARDS DEVELOPMENT on purpose: the
 * cost of a preview deployment not sending mail is a confused developer, and the cost of it sending
 * is a real candidate receiving a test message.
 */
export function currentEnvironment(): Environment {
  const explicit = String(process.env.MAILINT_ENVIRONMENT || '').trim().toLowerCase();
  if (explicit === 'production' || explicit === 'development') return explicit;
  if (String(process.env.VERCEL_ENV || '').toLowerCase() === 'production') return 'production';
  if (!process.env.VERCEL_ENV && String(process.env.NODE_ENV || '') === 'production') return 'production';
  return 'development';
}

async function orgIdFor(source: string): Promise<string | null> {
  const key = String(source || '').toLowerCase();
  const cached = ORG_CACHE.get(key);
  if (cached) return cached;
  const org = await getOrCreateOrg(key, PRODUCT_NAMES[key] || key);
  if (!org) return null;
  ORG_CACHE.set(key, org.id);
  return org.id;
}

export interface ProductEmitResult {
  ok: boolean;
  eventId?: string;
  duplicate?: boolean;
  /** Present when the fact was refused. Already logged; returned for callers that want to react. */
  error?: string;
}

/**
 * Publish a fact from an EduRankAI product.
 *
 * `idempotencyKey` is worth supplying whenever the caller has a natural one — a state transition id,
 * a row version — because without it two calls in the same second about the same entity and the
 * same stage are indistinguishable and the second is treated as a duplicate. That default is
 * correct far more often than it is wrong, which is why it is the default.
 */
export async function emitProductEvent(
  source: EventSource | string,
  type: string,
  payload: Record<string, unknown>,
  opts: {
    entityId?: string | null;
    actorType?: 'user' | 'api_key' | 'system' | 'connector';
    actorId?: string | null;
    occurredAt?: string;
    idempotencyKey?: string;
    environment?: Environment;
  } = {},
): Promise<ProductEmitResult> {
  try {
    const orgId = await orgIdFor(String(source));
    if (!orgId) {
      console.error('[mailint/emit] no organisation could be resolved for source', source, '— event', type, 'was not published');
      return { ok: false, error: 'no organisation for source ' + source };
    }
    const r = await emitEvent(
      {
        orgId,
        type,
        source: source as EventSource,
        entityId: opts.entityId ?? null,
        actorType: opts.actorType ?? 'system',
        actorId: opts.actorId ?? null,
        payload,
        occurredAt: opts.occurredAt || new Date().toISOString(),
        idempotencyKey: opts.idempotencyKey,
      },
      { environment: opts.environment || currentEnvironment() },
    );
    if (!r.ok) {
      // Loud, with the reason. A refused event is nearly always a payload the catalogue rejected,
      // and the message names the field.
      console.error('[mailint/emit] ' + type + ' was refused:', (r.errors || []).join('; '));
      return { ok: false, error: (r.errors || []).join('; ') };
    }
    return { ok: true, eventId: r.eventId, duplicate: r.duplicate };
  } catch (e: any) {
    console.error('[mailint/emit] ' + type + ' failed:', e?.cause?.message || e?.message || e);
    return { ok: false, error: String(e?.cause?.message || e?.message || e) };
  }
}

/**
 * Fire and forget, for call sites that must not wait at all.
 *
 * Returns immediately; the promise is handled here so an unhandled rejection can never take a
 * process down. Prefer awaiting emitProductEvent() where the caller can afford two inserts — the
 * await is what makes the event visible in the console before the user's next page load, which is
 * what makes a test of a new route possible.
 */
export function emitProductEventDetached(
  source: EventSource | string,
  type: string,
  payload: Record<string, unknown>,
  opts: Parameters<typeof emitProductEvent>[3] = {},
): void {
  emitProductEvent(source, type, payload, opts).catch((e: any) => {
    console.error('[mailint/emit] detached ' + type + ' failed:', e?.cause?.message || e?.message || e);
  });
}
