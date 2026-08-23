// src/lib/foundational/horizon-bridge.ts — WHERE THIS ENGINE MEETS THE REST OF HORIZON.
//
// =================================================================================================
// WHY THIS FILE EXISTS: TWO STORES OF THE SAME PERSONAL DATA IS ONE TOO MANY
// =================================================================================================
//
// HORIZON patch 01 (src/lib/horizon/intake) already owns the birth co-ordinates. Its storage
// boundary is explicit — "nothing outside this module reads hzn_personal_foundation.payload_enc,
// and nothing outside it writes one" — and it already provides encryption at rest, a consent gate, a
// purpose list with `intelligence-computation` on it, and an access log written before a value is
// returned. Every one of those is a thing this engine would otherwise have built a second copy of.
//
// A second copy is not redundancy, it is a second answer. Two consent stores means one of them says
// a person agreed and the other says they withdrew, and no rule for which is right. Two encrypted
// copies of a date of birth means two places to erase and one of them will be missed.
//
// So this engine's DEFAULTS now point at patch 01, and its own tables are the fallback for a
// deployment that runs the engine without the intake patch. That is a real deployment shape — the
// computation layer is useful on its own — so the fallback is kept and it is honest about which of
// the two answered.
//
// =================================================================================================
// THE ONE PLACE A GUESS WOULD BE FATAL, AND WHAT IS DONE INSTEAD
// =================================================================================================
//
// Patch 01's SubjectRef carries `idScheme` and `organisationId`; this engine's does not, because
// patch 03 (the interpretation layer) already calls this module with the two-field shape and that
// contract may not be broken. Translating between them therefore requires supplying an idScheme, and
// getting it wrong reads the wrong table and returns nothing — an empty answer that looks exactly
// like an innocent person with no record.
//
// It is therefore NOT guessed silently. The mapping is declared below, it is overridable through
// configureHorizonBridge(), and the one combination that has no coherent answer — an `external`
// subject, which belongs to no HORIZON identity space at all — is REFUSED rather than mapped.
//
// =================================================================================================
// STALE CONSENT IS NOT CONSENT, FOR THIS PURPOSE
// =================================================================================================
//
// Patch 01 distinguishes a withdrawn grant from a live grant recorded against a superseded notice.
// It refuses the second for `intelligence-computation` while still allowing the person their own
// access, and this bridge mirrors that exactly rather than softening it: new processing under new
// terms needs the person to have been asked again.
import type { BirthInput, SubjectRef as EngineSubject, TimePrecision as EngineTimePrecision } from './types';
import type { ConsentGate, ConsentState } from './consent';
import { reasonOf } from './types';

const MOD = 'foundational-horizon-bridge';

// -------------------------------------------------------------------------------------------------
// CONFIGURATION. Declared before use: `const` is not hoisted.
// -------------------------------------------------------------------------------------------------

/** The id space each engine subject kind is anchored on when talking to patch 01. */
export interface BridgeConfig {
  /**
   * `employee` has only one coherent scheme, so it is not a choice. The other two are, and a
   * deployment whose applicants are anchored elsewhere overrides them here rather than discovering
   * the mismatch as an empty read.
   */
  candidateIdScheme: 'tal_person' | 'application' | 'user';
  personIdScheme: 'tal_person' | 'application' | 'user';
  /** Null means "whatever patch 01 defaults to", which is the single-organisation case. */
  organisationId: string | null;
}

const defaultConfig: BridgeConfig = {
  candidateIdScheme: 'tal_person',
  personIdScheme: 'user',
  organisationId: null,
};

let config: BridgeConfig = { ...defaultConfig };

export function configureHorizonBridge(next: Partial<BridgeConfig>): void {
  config = { ...config, ...next };
}

export function horizonBridgeConfig(): BridgeConfig {
  return { ...config };
}

/**
 * Translate an engine subject into a patch 01 SubjectRef.
 *
 * Returns null for `external`, which has no HORIZON identity space. A null here means the caller
 * falls back to this engine's own storage rather than reading somebody else's row by accident.
 */
export async function toHorizonSubject(subject: EngineSubject): Promise<any | null> {
  if (subject.kind === 'external') return null;
  const ids: any = await import('@/lib/horizon/ids');
  const organisationId = config.organisationId || ids.DEFAULT_ORGANISATION_ID;
  if (subject.kind === 'employee') {
    return { kind: 'employee', id: subject.id, idScheme: 'hr_employee', organisationId };
  }
  const idScheme = subject.kind === 'candidate' ? config.candidateIdScheme : config.personIdScheme;
  return { kind: 'applicant', id: subject.id, idScheme, organisationId };
}

/** The actor this engine presents itself as when reading through patch 01's boundary. */
export function engineActor(userId: string | null): any {
  return userId
    ? { kind: 'user', id: userId, displayName: null }
    : { kind: 'engine', id: 'foundational-personal-computation', displayName: null };
}

// =================================================================================================
// CONSENT — patch 01's ledger, read through this engine's own gate interface
// =================================================================================================

/**
 * The DEFAULT consent gate. Asks patch 01; falls back to this engine's own table only when patch 01
 * is genuinely not present, and says which one answered in `source` either way.
 *
 * A THROWN ERROR IS NOT AN ABSENCE. If patch 01 is installed and its query fails, this returns
 * not-granted rather than falling through to a second store that might say yes — a consent check
 * that cannot reach its register refuses, because failing open on this particular question computes
 * a person's birth data because the database was busy.
 */
export const horizonConsentGate: ConsentGate = {
  name: 'hzn_consent_event (HORIZON patch 01)',

  async check(subject, purpose): Promise<ConsentState> {
    const denied: ConsentState = {
      granted: false, evidenceRef: null, grantedAt: null, revokedAt: null,
      source: 'hzn_consent_event (HORIZON patch 01)',
    };
    let intake: any;
    try {
      intake = await import('@/lib/horizon/intake');
    } catch {
      return { ...denied, source: 'unavailable' };
    }
    try {
      const hSubject = await toHorizonSubject(subject);
      if (!hSubject) return { ...denied, source: 'unavailable' };
      const state = await intake.currentConsent(hSubject, intake.CONSENT_SCOPE_PERSONAL_FOUNDATION);
      // STALE IS NOT GRANTED FOR THIS PURPOSE. Mirrors patch 01's own rule for
      // `intelligence-computation`: a live grant against a superseded notice is still a grant, but
      // new processing under new terms needs the person to be asked again.
      const granted = !!state?.granted && !state?.stale;
      return {
        granted,
        evidenceRef: state?.consentRef ?? null,
        grantedAt: state?.grantedAt ?? null,
        revokedAt: state?.withdrawnAt ?? null,
        source: 'hzn_consent_event (HORIZON patch 01)',
      };
    } catch (e: any) {
      console.error('[' + MOD + '] consent check failed: ' + reasonOf(e));
      return denied;
    }
  },

  // Deliberately no grant() and no revoke(). Consent is RECORDED where a person is asked — on patch
  // 01's intake surface — and an engine that could write its own grant would be a way to manufacture
  // one without anybody being asked at all.
};

// =================================================================================================
// BIRTH INPUT — read through patch 01's storage boundary
// =================================================================================================

/** Where the engine gets a subject's birth co-ordinates from. */
export interface BirthInputSource {
  readonly name: string;
  load(subject: EngineSubject, actorUserId: string | null): Promise<BirthInputResult>;
}

export type BirthInputResult =
  | { ok: true; input: BirthInput; complete: true; source: string }
  | { ok: false; reason: string; code: 'not_available' | 'incomplete' | 'refused'; source: string };

/**
 * How patch 01's declared time precision maps onto this engine's.
 *
 * `approximate` becomes `hour`, NOT `quarter_hour`: "from memory" is the vaguest thing a person can
 * say while still saying something, and widening it is the safe direction. Every confidence this
 * engine reports is derived from this number, so a mapping that flattered the input would flatter
 * every factor downstream.
 */
const PRECISION_MAP: Record<string, EngineTimePrecision> = {
  exact: 'second',
  minute: 'minute',
  hour: 'hour',
  approximate: 'hour',
  unknown: 'unknown',
};

export const horizonBirthInputSource: BirthInputSource = {
  name: 'hzn_personal_foundation (HORIZON patch 01)',

  async load(subject, actorUserId): Promise<BirthInputResult> {
    const source = 'hzn_personal_foundation (HORIZON patch 01)';
    let intake: any;
    try {
      intake = await import('@/lib/horizon/intake');
    } catch {
      return { ok: false, code: 'not_available', reason: 'HORIZON intake is not installed', source };
    }
    try {
      const hSubject = await toHorizonSubject(subject);
      if (!hSubject) {
        return { ok: false, code: 'not_available', reason: 'subject kind has no HORIZON identity space', source };
      }
      const res = await intake.readPersonalFoundation({
        subject: hSubject,
        actor: engineActor(actorUserId),
        purpose: 'intelligence-computation',
      });
      if (!res?.ok) {
        const code = res?.reason === 'not-found' ? 'not_available' : 'refused';
        return { ok: false, code, reason: String(res?.message || res?.reason || 'read refused'), source };
      }

      const v = res.value;

      // THE THREE THINGS THIS ENGINE CANNOT WORK WITHOUT, refused one at a time so the caller is told
      // WHICH one is missing rather than being handed a generic failure.
      //
      // Patch 01 stores a record with no time and no coordinates quite deliberately — a person may
      // legitimately not know either — and this engine cannot place an ascending direction or a
      // house without both. Refusing is the honest outcome. Fabricating a midday or a city centre
      // would produce a full set of factors that look exactly like real ones and are not.
      if (!v.timeOfBirth) {
        return { ok: false, code: 'incomplete', reason: 'no time of birth is recorded; the ascending direction and every house placement are undefined without one', source };
      }
      if (!v.coordinates) {
        return { ok: false, code: 'incomplete', reason: 'no coordinates are recorded; this engine does not geocode a place name and will not invent one', source };
      }
      if (!v.derived) {
        return { ok: false, code: 'incomplete', reason: 'the birth instant has not been derived; a local time without a resolved zone is not an instant', source };
      }

      return {
        ok: true,
        complete: true,
        source,
        input: {
          date: v.dateOfBirth,
          time: v.timeOfBirth,
          // The offset patch 01 ALREADY RESOLVED, not the zone id. A stored computation must not be
          // able to change its answer because a time zone database shipped a correction.
          utcOffsetMinutes: v.derived.utcOffsetMinutes,
          timeZone: v.timezoneId ?? null,
          location: {
            latitude: v.coordinates.latitude,
            longitude: v.coordinates.longitude,
            placeLabel: v.place?.city || v.place?.raw || null,
          },
          timePrecision: PRECISION_MAP[v.timePrecision] || 'unknown',
        },
      };
    } catch (e: any) {
      const reason = reasonOf(e);
      console.error('[' + MOD + '] birth input read failed: ' + reason);
      return { ok: false, code: 'refused', reason, source };
    }
  },
};

// =================================================================================================
// THE EVENT — emitted on HORIZON's own bus, in HORIZON's own envelope
// =================================================================================================

/**
 * Publish `intelligence.computation_completed`.
 *
 * ON PATCH 01's DURABLE SINK, not the in-process bus. src/lib/events.ts cannot survive the process,
 * and on a serverless function the instant the response is written the work can be killed — so an
 * engine that computed, stored and then emitted in memory has a window where the computation exists
 * and no subscriber ever hears about it. The HORIZON outbox records the envelope next to the fact
 * that caused it and delivers separately.
 *
 * A REFUSAL IS A REAL OUTCOME AND IS PUBLISHED AS ONE. `outcome: 'refused'` with a reason is how a
 * subscriber learns that a person's computation did not happen because consent was withdrawn, which
 * is information it needs and would otherwise have to infer from silence.
 *
 * NO VALUES TRAVEL. Identifiers, a version and a count. An event is fanned out to every subscriber,
 * some of which log it, and a payload carrying a position or a factor would leak precisely what the
 * storage boundary exists to protect.
 */
export async function emitComputationCompleted(args: {
  subject: EngineSubject;
  computationId: string;
  engineId: string;
  engineVersion: string;
  outcome: 'succeeded' | 'failed' | 'refused';
  detail?: string | null;
  durationMs?: number | null;
  actorUserId: string | null;
}): Promise<{ ok: boolean; recorded: boolean; errors: string[] }> {
  try {
    const events: any = await import('@/lib/horizon/events');
    const hSubject = await toHorizonSubject(args.subject);
    const out = await events.emitHorizonEvent({
      type: events.HORIZON_EVENTS.INTELLIGENCE_COMPUTATION_COMPLETED,
      subject: hSubject,
      actor: engineActor(args.actorUserId),
      payload: {
        computationId: args.computationId,
        engineId: args.engineId,
        engineVersion: args.engineVersion,
        outcome: args.outcome,
        // ONE RESULT ID: the computation record. The alternative — every factor id — is ninety
        // strings in a payload capped at eight thousand characters, and a subscriber that wants the
        // factors must go through getComputationByVersion() where the capability check is anyway.
        resultIds: [args.computationId],
        detail: args.detail ?? null,
        durationMs: args.durationMs ?? null,
      },
    });
    return { ok: !!out?.ok, recorded: !!out?.recorded, errors: out?.errors || [] };
  } catch (e: any) {
    // The computation already committed and is the durable record; a missed event is recoverable by
    // querying for computations a subscriber has not processed. So this is logged, never thrown.
    const reason = reasonOf(e);
    console.error('[' + MOD + '] emit intelligence.computation_completed failed: ' + reason);
    return { ok: false, recorded: false, errors: [reason] };
  }
}
