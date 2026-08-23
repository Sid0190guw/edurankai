// src/lib/horizon/record.ts — THE MASTER EMPLOYEE INTELLIGENCE RECORD.
//
// Spec: docs/horizon/HORIZON_CONTRACTS.md sections 1 and 10.
//
// =================================================================================================
// THE ARCHITECTURE, AND THE ARCHITECTURE IT IS NOT
// =================================================================================================
//
// "One master record" reads, to most people, as one enormous table with a column per thing anybody
// ever wanted to know about a person. That design fails here for three separate reasons, each of
// which this repository has already paid for:
//
//   IT DUPLICATES DATA THAT ALREADY HAS AN OWNER. Attendance lives in hr_attendance. Skills live in
//   hr_employee_skills, and src/lib/skills.ts is its only writer precisely because two tables holding
//   a person's skill level is how this project already lost a year. A master table would be a third.
//
//   IT MAKES EVERY PATCH WRITE TO ONE PLACE. Eight agents writing columns into one table is eight
//   agents in one merge conflict, and the multi-agent rules forbid exactly that.
//
//   IT DESTROYS THE LAYER SEPARATION. Once "hours worked" and "the system thinks this person is
//   disengaged" are two columns of one row, nothing in the storage distinguishes a fact from an
//   inference, and every screen downstream is free to render them identically.
//
// SO THE MASTER RECORD IS A COMPOSITION, NOT A TABLE.
//
//   hzn_profile is a HEADER: one row per (organisation, subject), holding an identity anchor, when
//   the record was last recomputed, and nothing else about the person at all.
//
//   The CONTENT is assembled at read time from PROVIDERS. A provider is registered by the patch that
//   owns a domain, declares which dimensions it contributes, and returns IntelligenceResults from
//   its own tables under its own access rules. HORIZON never reaches into another patch's schema.
//
// That is what makes the record "dynamic and continuously updated as evidence changes" (rule 28)
// without a synchronisation job: there is no copy to fall out of date.
//
// =================================================================================================
// FAILURE ISOLATION, WHICH IS THE WHOLE REASON THIS IS NOT A JOIN
// =================================================================================================
//
// One provider throwing must not take the record down, and must not silently shrink it either. Both
// halves matter. src/lib/events.ts records the lesson in its own header: a shared try block in the
// catalog import meant one failing write silently skipped two others. So each provider runs
// isolated, and a failure becomes a SECTION MARKED UNREADABLE with the reason attached — never an
// absent section, because an absent section reads as "this person has nothing here" and that is a
// statement about a human being made by a failed query.
//
// PURE, except that providers are async. No database import in this file.

import type { OrganisationId, ProfileId, SubjectRef } from './ids';
import { subjectKey } from './ids';
import type {
  DimensionFamily, DimensionRef, IntelligenceResult, Signal,
} from './types';
import { DIMENSION_FAMILIES } from './types';

// -------------------------------------------------------------------------------------------------
// CONSTANTS. Declared before anything that reads them.
// -------------------------------------------------------------------------------------------------

/**
 * How long one provider gets before the composition gives up on it.
 *
 * A record made of twelve providers is only as fast as its slowest, and this platform's functions
 * and its database sit in different regions at roughly 177ms per round trip. A provider that hangs
 * would otherwise hold the whole page to the gateway timeout — and the page would then show nothing
 * at all rather than eleven good sections and one marked unreadable.
 */
export const PROVIDER_TIMEOUT_MS = 4000;

/** How many providers run at once. Above this they queue. */
export const PROVIDER_CONCURRENCY = 6;

// -------------------------------------------------------------------------------------------------
// THE PROFILE HEADER
// -------------------------------------------------------------------------------------------------

/**
 * The anchor row. Deliberately almost empty.
 *
 * Every field here is about the RECORD, not about the person. The moment somebody adds
 * `current_rating` to this interface, the composition above has been abandoned and this is a master
 * table again.
 */
export interface ProfileHeader {
  profileId: ProfileId;
  subject: SubjectRef;
  organisationId: OrganisationId;
  createdAt: string;
  /** When any provider last reported new content. Advisory: providers may be lazy. */
  lastComposedAt: string | null;
  /** When a recompute was last requested, and by whom, so a stale record can be explained. */
  recomputeRequestedAt: string | null;
  /** False after an employee leaves. The record is retained and closed, never deleted. */
  active: boolean;
}

/**
 * Reading and creating profile headers. Implemented against hzn_profile in schema-backed code; an
 * interface here so this module stays pure and testable.
 */
export interface ProfileStore {
  /** Find or create the header for a subject. Idempotent. */
  ensure(subject: SubjectRef): Promise<ProfileHeader>;
  get(subject: SubjectRef): Promise<ProfileHeader | null>;
  markComposed(profileId: ProfileId, at: string): Promise<void>;
}

// -------------------------------------------------------------------------------------------------
// PROVIDERS — THE INTEGRATION BOUNDARY EVERY LATER PATCH USES
// -------------------------------------------------------------------------------------------------

export interface ProviderContext {
  subject: SubjectRef;
  organisationId: OrganisationId;
  /**
   * Compose the record as it stood at this moment, rather than now.
   *
   * TIME-BASED INTELLIGENCE IS PART OF THE CORE PRINCIPLE, and it has a specific meaning: a decision
   * taken in March must be reviewable against what the record said in March, not against what it
   * says today. A provider that cannot answer historically should say so with
   * `historicalSupport: false` rather than quietly returning today's answer with an old date on it.
   */
  asOf?: string | null;
  /** Restrict the read to these families. Empty or absent means everything the provider offers. */
  families?: readonly DimensionFamily[];
  requestId: string;
}

/**
 * ONE PATCH'S CONTRIBUTION TO THE RECORD.
 *
 * A provider READS. It has no write path into HORIZON at all, which is what keeps the boundary
 * honest: a patch cannot decide unilaterally that its output belongs in somebody else's section.
 */
export interface MeirProvider {
  /** The patch that owns this provider, e.g. 'horizon-capability'. Unique; used for attribution. */
  patchId: string;
  /** Human label for an ops screen. */
  label: string;
  /** The dimensions this provider contributes. Declared so a record can be planned before it is read. */
  dimensions: readonly DimensionRef[];
  /** True when the provider can honour ProviderContext.asOf. */
  historicalSupport: boolean;
  read(ctx: ProviderContext): Promise<readonly IntelligenceResult[]>;
  /** Optional. Signals this patch raises about the subject. */
  readSignals?(ctx: ProviderContext): Promise<readonly Signal[]>;
}

const providers = new Map<string, MeirProvider>();

/**
 * Register a provider.
 *
 * REFUSES A DUPLICATE patchId rather than overwriting. Rule 6 of the multi-agent brief — never
 * overwrite another agent's implementation — and a silent overwrite here would mean one patch's
 * whole contribution disappearing from every record with nothing anywhere saying so.
 *
 * Returns an unregister function, mainly so tests do not leak providers between cases.
 */
export function registerProvider(p: MeirProvider): () => void {
  if (!p?.patchId?.trim()) throw new Error('a provider must declare a patchId');
  const existing = providers.get(p.patchId);
  if (existing && existing !== p) {
    throw new Error(
      'A provider is already registered for patch "' + p.patchId + '" (' + existing.label + '). '
      + 'Registering a second one would silently replace it. Choose a distinct patchId.',
    );
  }
  for (const d of p.dimensions || []) {
    if (!(DIMENSION_FAMILIES as readonly string[]).includes(d.family)) {
      throw new Error('provider ' + p.patchId + ' declares unknown dimension family: ' + String(d.family));
    }
  }
  providers.set(p.patchId, p);
  return () => { if (providers.get(p.patchId) === p) providers.delete(p.patchId); };
}

export function listProviders(): MeirProvider[] {
  return [...providers.values()].sort((a, b) => a.patchId.localeCompare(b.patchId));
}

/** Which patch claims a dimension key. Lets an ops screen show what is actually wired up. */
export function providerFor(dimensionKey: string): MeirProvider | null {
  for (const p of providers.values()) {
    if (p.dimensions.some((d) => d.key === dimensionKey)) return p;
  }
  return null;
}

/** Test hygiene only. Never call this from application code. */
export function clearProviders(): void { providers.clear(); }

// -------------------------------------------------------------------------------------------------
// THE COMPOSED RECORD
// -------------------------------------------------------------------------------------------------

export interface RecordSection {
  patchId: string;
  label: string;
  results: readonly IntelligenceResult[];
  signals: readonly Signal[];
  /**
   * Present when this section could not be read. THE SECTION IS STILL HERE, carrying the reason.
   *
   * "Nothing on record" and "we could not read it" are different sentences and only one of them is
   * about the person. src/lib/evidence-graph.ts states the same rule for the same reason.
   */
  unreadable?: string | null;
  /** True when the provider could not honour `asOf` and answered with current data instead. */
  asOfUnsupported?: boolean;
}

export interface MasterIntelligenceRecord {
  subject: SubjectRef;
  organisationId: OrganisationId;
  profileId: ProfileId | null;
  composedAt: string;
  /** Echoed back so a reader can see the record is historical rather than current. */
  asOf: string | null;
  sections: readonly RecordSection[];
  /** True when every section read cleanly. A caller may use it to decide whether to cache. */
  complete: boolean;
  /** Patch ids that failed, for an ops screen. Empty when complete. */
  degraded: readonly string[];
}

async function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(label + ' did not answer within ' + ms + 'ms')), ms);
    }),
    // The losing promise keeps running; only the waiting stops. Clearing the timer matters because a
    // pending timeout keeps a serverless instance's event loop alive after the response is sent.
  ]).finally(() => clearTimeout(timer!)) as Promise<T>;
}

async function readSection(p: MeirProvider, ctx: ProviderContext): Promise<RecordSection> {
  const base = { patchId: p.patchId, label: p.label };
  try {
    const results = await withTimeout(Promise.resolve(p.read(ctx)), PROVIDER_TIMEOUT_MS, p.patchId);
    let signals: readonly Signal[] = [];
    if (p.readSignals) {
      try {
        signals = await withTimeout(Promise.resolve(p.readSignals(ctx)), PROVIDER_TIMEOUT_MS, p.patchId + ' signals');
      } catch (e: any) {
        // A provider whose RESULTS read fine but whose SIGNALS failed still contributes its results.
        // Losing eleven good results because a twelfth query failed is the shared-try-block bug.
        return {
          ...base, results: results || [], signals: [],
          unreadable: 'Results read; signals could not be read: '
            + String(e?.cause?.message || e?.message || e),
          asOfUnsupported: !!ctx.asOf && !p.historicalSupport,
        };
      }
    }
    return {
      ...base,
      results: results || [],
      signals,
      asOfUnsupported: !!ctx.asOf && !p.historicalSupport,
    };
  } catch (e: any) {
    // THE REAL POSTGRES REASON IS ON e.cause. e.message is just the failed statement, and an
    // operator reading a section marked unreadable needs the reason, not the SQL.
    return {
      ...base, results: [], signals: [],
      unreadable: String(e?.cause?.message || e?.message || e),
      asOfUnsupported: !!ctx.asOf && !p.historicalSupport,
    };
  }
}

export interface ComposeOptions {
  organisationId?: OrganisationId;
  asOf?: string | null;
  families?: readonly DimensionFamily[];
  requestId: string;
  /** Restrict to these patches. Absent means every registered provider. */
  patchIds?: readonly string[];
  profileId?: ProfileId | null;
}

/**
 * Assemble the record.
 *
 * Providers run CONCURRENTLY in bounded batches. Sequential composition would multiply the
 * cross-region round-trip cost by the number of providers, which is how a record page reaches a
 * gateway timeout; unbounded concurrency would open more database work than the single pooled
 * connection this platform runs with can serve.
 *
 * NEVER THROWS. A record is always returned; what varies is how much of it is marked unreadable.
 */
export async function composeRecord(
  subject: SubjectRef,
  opts: ComposeOptions,
): Promise<MasterIntelligenceRecord> {
  const organisationId = opts.organisationId || subject.organisationId;
  const ctx: ProviderContext = {
    subject,
    organisationId,
    asOf: opts.asOf ?? null,
    families: opts.families,
    requestId: opts.requestId,
  };

  const selected = listProviders().filter((p) => {
    if (opts.patchIds && !opts.patchIds.includes(p.patchId)) return false;
    if (opts.families && opts.families.length) {
      return p.dimensions.some((d) => opts.families!.includes(d.family));
    }
    return true;
  });

  const sections: RecordSection[] = [];
  for (let i = 0; i < selected.length; i += PROVIDER_CONCURRENCY) {
    const batch = selected.slice(i, i + PROVIDER_CONCURRENCY);
    const done = await Promise.all(batch.map((p) => readSection(p, ctx)));
    sections.push(...done);
  }

  const degraded = sections.filter((s) => s.unreadable).map((s) => s.patchId);
  return {
    subject,
    organisationId,
    profileId: opts.profileId ?? null,
    composedAt: new Date().toISOString(),
    asOf: ctx.asOf ?? null,
    sections,
    complete: degraded.length === 0,
    degraded,
  };
}

// -------------------------------------------------------------------------------------------------
// PLANNING — WHAT A RECORD WOULD CONTAIN, WITHOUT READING ANYTHING
// -------------------------------------------------------------------------------------------------

export interface RecordPlan {
  subjectKey: string;
  /** Every dimension any registered provider offers, with the patch that owns it. */
  dimensions: { dimension: DimensionRef; patchId: string }[];
  /** Families with no provider at all. Honest gaps, surfaced rather than rendered as empty sections. */
  unservedFamilies: DimensionFamily[];
  /** Providers that cannot answer historically. A time-travelled record is incomplete without them. */
  withoutHistory: string[];
}

/**
 * PURE (no provider is called). What a record for this subject WOULD contain.
 *
 * Used by an ops screen to show coverage, and by a caller that wants to say "this family has no
 * engine yet" instead of showing a heading with nothing under it. A dimension nobody serves is a gap
 * in the system, not an absence in the person.
 */
export function planRecord(subject: SubjectRef): RecordPlan {
  const dims: { dimension: DimensionRef; patchId: string }[] = [];
  const served = new Set<string>();
  const withoutHistory: string[] = [];
  for (const p of listProviders()) {
    if (!p.historicalSupport) withoutHistory.push(p.patchId);
    for (const d of p.dimensions) {
      dims.push({ dimension: d, patchId: p.patchId });
      served.add(d.family);
    }
  }
  return {
    subjectKey: subjectKey(subject),
    dimensions: dims,
    unservedFamilies: (DIMENSION_FAMILIES as readonly DimensionFamily[]).filter((f) => !served.has(f)),
    withoutHistory,
  };
}
