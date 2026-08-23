// src/lib/horizon/interpretation/foundational-adapter.ts — PATCH 02, TRANSLATED, ON THIS SIDE.
//
// =================================================================================================
// WHY THE TRANSLATION LIVES HERE AND NOT THERE
// =================================================================================================
//
// src/lib/foundational is HORIZON patch 02 and it is another patch's owned contract. This patch does
// not edit it, does not extend its types and does not ask it to know that an interpretation layer
// exists. Everything that knows about both shapes is in this one file, on this side of the boundary,
// where it can change without touching a file this patch does not own.
//
// It is also why `contract.ts` declares its own `FoundationalFactor` rather than importing theirs: a
// direct structural dependency would make every future edit to their contract a compile error here,
// which is exactly the coupling the patch rules exist to prevent.
//
// =================================================================================================
// THE ADAPTER ASKS FOR THE NEUTRAL PROJECTION AND NOTHING MORE
// =================================================================================================
//
// Patch 02 gates its technical layer — the traditional vocabulary and the raw computed positions —
// behind `intelligence.foundational.technical`. This adapter requests `intelligence.foundational.read`
// AND NEVER THE TECHNICAL CAPABILITY, so `factor.technical` comes back null and the framework
// vocabulary never enters this process at all.
//
// That is stronger than filtering it out afterwards. There is no line in this file that could
// accidentally forward a term it never received, and the separation between the traditional
// computation and the professional interpretation is enforced by the upstream's own gate rather than
// by this module's good intentions.
//
// =================================================================================================
// WHAT THIS ADAPTER DELIBERATELY DOES NOT DO: DECIDE WHAT A FACTOR MEANS
// =================================================================================================
//
// Patch 02 publishes structural codes — a point in a sector, a relationship between two points, a
// composite strength. Deciding that one of those relates to "analytical orientation" IS the
// interpretive claim, and it is precisely the claim that must never be smuggled in as a default by
// anybody's code, including this file's.
//
// So this adapter ships NO mapping. It translates shape, it resolves consent, it carries the method
// version, and it hands every factor over with the mapping key it would be looked up under. Until a
// named human authors and registers that mapping, every factor is reported as unmapped, the count is
// printed on the surface, and no dimension is produced. That is the honest state, and it is the one
// the layer is designed to sit in indefinitely.
//
// listFoundationalMappingKeys() exists to make authoring possible from real data rather than from
// guesswork: it returns the distinct keys actually present for a subject, with their neutral labels.
import {
  registerFoundationalProvider,
  foundationalProviderName,
  type FoundationalFactor,
  type FoundationalProviderResult,
  type HorizonSubject,
  type UpstreamContext,
} from './contract';

/** The name this adapter registers under. Printed on the admin surface. */
export const FOUNDATIONAL_ADAPTER_NAME = 'foundational (HORIZON patch 02)';

/** How this layer identifies the upstream in stored records. */
export const FOUNDATIONAL_SOURCE_MODULE = 'src/lib/foundational';

/**
 * The three subject kinds this layer knows, mapped onto the four patch 02 knows.
 *
 * `learner` becomes `person`, because patch 02 has no learner space and `person` is its generic one.
 * The two id spaces are NOT merged by this mapping and nothing here claims they are the same record:
 * a learner id is passed through unchanged and patch 02 stores it against `person`, which is where a
 * later reader must look for it.
 */
const SUBJECT_KIND_MAP: Record<HorizonSubject['kind'], 'person' | 'employee' | 'candidate'> = {
  employee: 'employee',
  candidate: 'candidate',
  learner: 'person',
};

/**
 * The key a factor is looked up under in a registered mapping.
 *
 * `code` ALONE IS TOO COARSE. Patch 02's code is the SHAPE of a factor ('indicator.point.sector'),
 * not the particular one — every point-in-sector factor shares it, and a mapping keyed on it would
 * say the same thing about all of them. The neutral `value` ('B02 in S04') is what distinguishes
 * them, so the key is both, joined.
 *
 * Both halves are structural codes. Neither is framework vocabulary, and neither is ever rendered.
 */
export function foundationalMappingKey(f: { code: string; value: string }): string {
  return String(f.code || '') + '|' + String(f.value || '');
}

/** Patch 02's refusal codes, mapped onto this layer's states. The distinctions are preserved on
 *  purpose: "nobody has entered any input" and "consent was withdrawn" need different sentences. */
function stateForRefusal(code: string): FoundationalProviderResult['state'] {
  if (code === 'not_permitted' || code === 'no_consent' || code === 'input_unprotected') return 'refused';
  if (code === 'input_missing' || code === 'not_found') return 'not_configured';
  return 'unreadable';
}

/**
 * Translate one patch 02 factor into this layer's shape.
 *
 * WHAT IS DROPPED, AND WHY EACH ONE:
 *   technical      never requested (see the header), and never forwarded even if it somehow arrived.
 *   evidence       pointers into patch 02's own raw block. They belong to the module that owns the
 *                  values and are followed there; copying them here would put a second, unowned copy
 *                  of a person's computed positions in a table with a different read population.
 *   components     published parts of a composite strength. Same reasoning.
 *   label / value  structural, but they are the upstream's rendering of its own result, and nothing
 *                  in this layer renders an upstream string. `value` survives only inside the mapping
 *                  key, which is looked up and never displayed.
 *
 * POLARITY IS ZERO, AND THAT IS THE HONEST VALUE. A patch 02 strength is a magnitude with no sign.
 * Direction comes from the mapping entry, where a human recorded it; a factor with no mapping and no
 * direction contributes nothing, which is correct.
 */
function translateFactor(f: any): FoundationalFactor | null {
  const id = String(f?.factor_id || '');
  if (!id) return null;
  const strength = Number(f?.strength);
  if (!Number.isFinite(strength) || strength <= 0) return null;
  return {
    id,
    code: foundationalMappingKey({ code: String(f.code || ''), value: String(f.value || '') }),
    weight: Math.max(0, Math.min(1, strength)),
    polarity: 0,
    confidence: Math.max(0, Math.min(1, Number(f?.confidence) || 0)),
    method: String(f?.category || 'foundational'),
    methodVersion: String(f?.calculation_method_version || ''),
    // No `note`. There is no upstream commentary this layer has any business carrying.
  };
}

/**
 * Ask patch 02 for a subject's factors.
 *
 * CONSENT IS RESOLVED FIRST, for its reference rather than for its verdict — patch 02 checks consent
 * on every read of its own and refuses without one. What this call adds is the evidence reference,
 * which becomes the interpretation's `consentRef` and is what makes a stored interpretation say
 * WHICH agreement it was performed under rather than merely that one existed.
 */
async function readFoundational(
  subject: HorizonSubject,
  ctx?: UpstreamContext,
): Promise<FoundationalProviderResult> {
  // Imported lazily so that merely importing this adapter — in a test, or in a module that only
  // wants the mapping-key helper — does not pull patch 02's engine and its database access in.
  const mod: any = await import('@/lib/foundational');
  const theirSubject = { kind: SUBJECT_KIND_MAP[subject.kind], id: subject.id };

  const consent = await mod.checkConsent(theirSubject, mod.CONSENT_PURPOSE);
  if (!consent?.granted) {
    return {
      state: 'refused',
      reason:
        'There is no active consent for this processing' +
        (consent?.revokedAt ? ' (it was withdrawn).' : '.') +
        ' Nothing was read and nothing was interpreted.',
    };
  }

  const view = await mod.getComputationByVersion({
    subject: theirSubject,
    // THE NEUTRAL PROJECTION ONLY. `intelligence.foundational.technical` is deliberately absent.
    viewer: { userId: ctx?.actorUserId ?? null, capabilities: [mod.FOUNDATIONAL_CAPABILITIES.read] },
    includePeriods: false,
  });

  if (!view?.ok) {
    return { state: stateForRefusal(String(view?.code || '')), reason: String(view?.reason || 'The foundational computation could not be read.') };
  }

  const factors = (view.factors || []).map(translateFactor).filter(Boolean) as FoundationalFactor[];
  const computation = view.computation || {};

  return {
    state: 'ok',
    set: {
      subject,
      factors,
      computedAt: String(computation.computed_at || ''),
      sourceModule: FOUNDATIONAL_SOURCE_MODULE,
      sourceVersion: String(computation.calculation_method_version || ''),
      // Patch 02 publishes a per-factor confidence reflecting how exact the inputs were, and it
      // refuses outright rather than returning a partial computation — so a returned computation is
      // complete by its own account. Thin inputs still lower confidence, factor by factor, which is
      // the more precise signal and the one that actually reaches the output.
      complete: true,
      consentRef: consent.evidenceRef || null,
    },
  };
}

/**
 * Connect patch 02 as this layer's foundational input source.
 *
 * IDEMPOTENT, AND IT WILL NOT DISPLACE ANOTHER PROVIDER. If something has already registered — a
 * different upstream, a test double — this does nothing and says so. Two modules quietly fighting
 * over one slot is how a person's interpretation ends up depending on whichever one loaded last.
 */
export function connectFoundationalEngine(): { connected: boolean; provider: string } {
  const existing = foundationalProviderName();
  if (existing) return { connected: false, provider: existing };
  registerFoundationalProvider(FOUNDATIONAL_ADAPTER_NAME, readFoundational);
  return { connected: true, provider: FOUNDATIONAL_ADAPTER_NAME };
}

export interface MappingKeyRow {
  /** The key to write in a mapping table. */
  key: string;
  /** Patch 02's neutral label for it, so a human authoring the mapping can see what they are
   *  mapping. Structural, never framework vocabulary — the technical layer was never requested. */
  label: string;
  category: string;
  /** How strong this factor is for this person. Shown to make an authoring decision informed, not
   *  to be stored: a mapping is a claim about a structure, not about this individual. */
  strength: number;
}

/**
 * The distinct mapping keys actually present for one subject, for authoring a mapping from real data.
 *
 * This is a READ OF A PERSON'S COMPUTATION and is gated and logged by patch 02 exactly like any
 * other. It is offered because the alternative — authoring a mapping from imagination — is how a
 * mapping ends up describing structures the engine never produces.
 */
export async function listFoundationalMappingKeys(
  subject: HorizonSubject,
  ctx?: UpstreamContext,
): Promise<{ ok: boolean; keys: MappingKeyRow[]; reason?: string }> {
  try {
    const mod: any = await import('@/lib/foundational');
    const theirSubject = { kind: SUBJECT_KIND_MAP[subject.kind], id: subject.id };
    const view = await mod.getComputationByVersion({
      subject: theirSubject,
      viewer: { userId: ctx?.actorUserId ?? null, capabilities: [mod.FOUNDATIONAL_CAPABILITIES.read] },
      includePeriods: false,
    });
    if (!view?.ok) return { ok: false, keys: [], reason: String(view?.reason || 'The computation could not be read.') };

    const seen = new Map<string, MappingKeyRow>();
    for (const f of view.factors || []) {
      const key = foundationalMappingKey({ code: String(f.code || ''), value: String(f.value || '') });
      if (seen.has(key)) continue;
      seen.set(key, {
        key,
        label: String(f.label || ''),
        category: String(f.category || ''),
        strength: Number(f.strength) || 0,
      });
    }
    return { ok: true, keys: [...seen.values()].sort((a, b) => b.strength - a.strength) };
  } catch (e: any) {
    console.error('[horizon-interpretation] listFoundationalMappingKeys', e?.cause?.message || e?.message);
    return { ok: false, keys: [], reason: 'The foundational computation could not be read.' };
  }
}

/** Exported for the tests: the pure half of the adapter, exercised without patch 02 or a database. */
export const __adapterInternals = { translateFactor, stateForRefusal, SUBJECT_KIND_MAP };
