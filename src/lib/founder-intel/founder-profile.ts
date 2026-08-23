// src/lib/founder-intel/founder-profile.ts — PATCH 12. THE FOUNDER READING OF THE ASSEMBLED RECORD.
//
// =================================================================================================
// ONE COMPOSER ALREADY EXISTS. THIS IS NOT A SECOND ONE.
// =================================================================================================
//
// `buildSuperAdminProfile()` in src/lib/horizon/profile.ts resolves the person, resolves the grants,
// writes the access row, fetches twelve sections through the provider registry and rolls the signals
// up. Every one of those is a decision another patch made, and re-making any of them here would
// produce a founder profile that could disagree with the admin profile about the same human.
//
// So this module CALLS it, once, and then does the three things Patch 12 was actually asked for:
//
//   1. ARRANGES the twelve payloads as the eighteen founder sections the brief names.
//   2. ADDS the two readings that live outside those twelve — the temporal engine's stored horizons
//      and the role comparison — through the read paths those modules already expose.
//   3. COLLECTS the decisions and interventions once, so questions.ts can answer "what action was
//      taken" and "what was the outcome" about any signal on the page.
//
// =================================================================================================
// WHAT IT DOES NOT DO, DELIBERATELY
// =================================================================================================
//
// IT DOES NOT WIDEN A GRANT. `holds` is passed in from the page and handed straight to Patch 11.
// Three of the twelve sections sit behind capabilities that exist in no Permission union, so they
// answer false for everybody including the founder and render as awaiting ratification. This view
// does not make an exception for the founder — an exception is exactly what the ratification gate
// exists to prevent, and the founder is the last person who should be outside it.
//
// IT DOES NOT FILL AN UNREGISTERED SECTION. Where a producing patch has not registered a provider,
// the section says which patch owes it. That sentence is more useful to a founder than a panel this
// patch invented, and it is the only version of the answer that stays true tomorrow.
//
// IT DOES NOT RUN THE ROLE COMPARISON ON PAGE LOAD. The comparison is a fusion across the twin, the
// evidence graph and the requirement tables; running it for every profile open would put seconds on
// the deepest page in the product for a question the founder has not asked yet. It runs when the
// founder asks for it, and until then the section says exactly which roles it would compare. A cap
// that is not stated reads as a complete answer.

import type {
  DecisionRecord, InterventionRecord, Pattern, SectionStatus, Signal,
} from '@/lib/horizon/contracts';
import { sortSignalsByWeight } from '@/lib/horizon/contracts';
import { buildSuperAdminProfile } from '@/lib/horizon/profile';
import type { SuperAdminProfile, SectionView } from '@/lib/horizon/profile';
import type { DrillRung } from '@/lib/horizon/sections';
import {
  FOUNDER_SECTIONS, NEVER_ON_THIS_SCREEN, horizonViewerOf, isFounder, horizonKeysRead,
} from './founder-access';
import type { FounderSectionDef, FounderSectionKey, Viewer } from './founder-access';
import type { LinkedActions } from './questions';

const MOD = 'founder-intel/founder-profile';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

/** Every optional read carries its own failure. One dead module degrades one section, never the page. */
async function safe<T>(label: string, fn: () => Promise<T>): Promise<{ value: T | null; error: string | null }> {
  try {
    return { value: await fn(), error: null };
  } catch (e: any) {
    const why = e?.cause?.message || e?.message || 'unknown error';
    console.error('[' + MOD + '] ' + label + ': ' + why);
    return { value: null, error: why };
  }
}

// =================================================================================================
// THE FOUNDER SECTION
// =================================================================================================

export interface FounderSection {
  key: FounderSectionKey;
  title: string;
  blurb: string;
  /** Patch 11's five statuses, plus 'withheld' for a grant this viewer does not hold. */
  status: SectionStatus | 'withheld';
  /** Why it is in that state. Always populated, including when it is fine. */
  sentence: string;
  owedBy: string;
  signals: Signal[];
  patterns: Pattern[];
  /** How far down the ladder a reader can walk from here, as Patch 11 computed it. */
  depth: DrillRung | null;
  depthSentence: string | null;
  /** True when a producing patch answered, false when Patch 11's own adapter did. */
  fromProvider: boolean;
  requiredCapability: string | null;
  accessLogged: boolean;
  accessLogNote: string | null;
  /** The producing patch's own payload. */
  data: unknown;
  openByDefault: boolean;
}

export interface RoleReadout {
  /** Roles that could be compared, with how many mapped requirements each carries. */
  comparable: { id: string; title: string; requirementCount: number; isOpen: boolean }[];
  /** Present only when the founder asked for the comparison to be run. */
  comparison: unknown | null;
  ran: boolean;
  sentence: string;
  error: string | null;
}

export interface TemporalReadout {
  /** One stored reading per horizon, as the temporal patch last computed and versioned it. */
  horizons: { horizon: string; computedAt: string; confidenceBand: string; summary: string; stale: boolean }[];
  sentence: string;
  error: string | null;
}

export interface FounderProfile {
  ok: boolean;
  employeeId: string;
  displayName: string | null;
  /** Patch 11's whole result, carried so the page can print its access sentence and conflicts. */
  base: SuperAdminProfile | null;
  sections: FounderSection[];
  /** The roll-up, sorted by weight: demonstrated work above anything derived. */
  signals: Signal[];
  linked: LinkedActions;
  temporal: TemporalReadout;
  roles: RoleReadout;
  notShown: typeof NEVER_ON_THIS_SCREEN;
  asOf: string;
  /** The whole page in one line, including what could not be read. */
  sentence: string;
  /** Set when nothing may render at all. The page prints this and nothing else. */
  refusal: string | null;
}

// =================================================================================================
// THE COMPOSER
// =================================================================================================

export async function buildFounderProfile(input: {
  employeeId: string;
  viewer: Viewer | null | undefined;
  holds: (key: string) => boolean;
  ipAddress?: string | null;
  /** True when the founder asked for the role comparison. It is not run on an ordinary page open. */
  runRoleComparison?: boolean;
}): Promise<FounderProfile> {
  const employeeId = String(input.employeeId || '');
  const viewer = input.viewer ?? null;
  const asOf = new Date().toISOString();

  const empty = (refusal: string): FounderProfile => ({
    ok: false,
    employeeId,
    displayName: null,
    base: null,
    sections: [],
    signals: [],
    linked: { decisions: [], interventions: [] },
    temporal: { horizons: [], sentence: 'Nothing was read.', error: null },
    roles: { comparable: [], comparison: null, ran: false, sentence: 'Nothing was read.', error: null },
    notShown: NEVER_ON_THIS_SCREEN,
    asOf,
    sentence: refusal,
    refusal,
  });

  if (!isFounder(viewer)) {
    return empty(
      'This is the founder view. It is not reachable by any other role, including super admins, and nothing was read.',
    );
  }
  if (!isUuid(employeeId)) {
    return empty('That is not a valid person reference, so nothing was looked up.');
  }

  // ---- 1. THE ASSEMBLED RECORD -------------------------------------------------------------------
  // Patch 11 resolves the person, the grants and the audit row. If its access log write failed, it
  // says so on the result and this view prints that rather than pretending the read was recorded.
  const baseRead = await safe('buildSuperAdminProfile', () => buildSuperAdminProfile({
    employeeId,
    viewer: horizonViewerOf(viewer!),
    holds: input.holds,
    ipAddress: input.ipAddress ?? null,
  }));

  if (!baseRead.value) {
    return empty(
      'The assembled record could not be built (' + (baseRead.error || 'unknown reason') +
      '), so nothing about this person was composed. An empty profile rendered from a failed read ' +
      'would be a lie about them.',
    );
  }

  const base = baseRead.value;
  if (base.refusal) return empty(base.refusal);

  const byKey = new Map<string, SectionView>();
  for (const s of base.sections) byKey.set(s.key, s);

  // ---- 2. THE TWO READINGS OUTSIDE THE TWELVE ----------------------------------------------------
  const [temporalRead, rolesRead] = await Promise.all([
    safe('temporal', async () => {
      const { activeResults } = await import('@/lib/horizon/temporal/store');
      return await activeResults(employeeId);
    }),
    safe('comparableRoles', async () => {
      const { comparableRoles } = await import('@/lib/horizon/role-compare');
      return await comparableRoles(300);
    }),
  ]);

  const temporal = readTemporal(temporalRead, asOf);
  const roles = await readRoles(rolesRead, {
    employeeId,
    viewer: viewer!,
    holds: input.holds,
    run: input.runRoleComparison === true,
  });

  // ---- 3. DECISIONS AND INTERVENTIONS, ONCE ------------------------------------------------------
  const linked = collectLinked(byKey.get('decisions_interventions'));

  // ---- 4. THE EIGHTEEN ---------------------------------------------------------------------------
  const sections: FounderSection[] = FOUNDER_SECTIONS.map((def) => arrange(def, byKey, temporal, roles));

  const signals = sortSignalsByWeight(base.signals || []);

  const notReady = sections.filter((s) => s.status !== 'ok');
  const unreadable = sections.filter((s) => s.status === 'unreadable');
  const notSupplied = sections.filter((s) => s.status === 'not_supplied');
  const withheld = sections.filter((s) => s.status === 'withheld');

  const sentence =
    'This record composes ' + sections.length + ' founder sections over ' +
    horizonKeysRead().length + ' assembled-record sections. ' +
    signals.length + ' signal(s) are on the page, ordered so demonstrated work sits above anything derived. ' +
    (notReady.length
      ? notReady.length + ' section(s) are not showing data: ' +
        withheld.length + ' withheld from this viewer, ' +
        notSupplied.length + ' with no producing patch registered, ' +
        unreadable.length + ' that failed to read. Each says which it is, because they are different ' +
        'facts and only some of them are about this person.'
      : 'Every section read successfully.') +
    (base.openLogged
      ? ' This page view was recorded against this person and appears in their access history.'
      : ' WARNING: the record of this page view was NOT written (' + (base.openLogNote || 'no reason given') + ').');

  return {
    ok: true,
    employeeId,
    displayName: displayNameOf(byKey.get('overview')),
    base,
    sections,
    signals,
    linked,
    temporal,
    roles,
    notShown: NEVER_ON_THIS_SCREEN,
    asOf: base.asOf || asOf,
    sentence,
    refusal: null,
  };
}

// =================================================================================================
// ARRANGING TWELVE INTO EIGHTEEN
// =================================================================================================

function arrange(
  def: FounderSectionDef,
  byKey: Map<string, SectionView>,
  temporal: TemporalReadout,
  roles: RoleReadout,
): FounderSection {
  // The two sections with no Patch 11 key behind them.
  if (def.from === null) {
    const isSuitability = def.key === 'role_suitability';
    return {
      key: def.key,
      title: def.title,
      blurb: def.blurb,
      status: roles.error ? 'unreadable' : (roles.comparable.length ? 'ok' : 'empty'),
      sentence: roles.error
        ? 'The role catalogue could not be read (' + roles.error + '), so nothing was compared.'
        : roles.sentence + (isSuitability
          ? ' Suitability is reported requirement by requirement, with no overall score.'
          : ' Mobility is reported per role, with no ranking between roles and no recommendation to move.'),
      owedBy: def.owedBy,
      signals: [],
      patterns: [],
      depth: null,
      depthSentence: null,
      fromProvider: true,
      requiredCapability: 'match.run',
      accessLogged: true,
      accessLogNote: null,
      data: roles,
      openByDefault: def.openByDefault,
    };
  }

  const view = byKey.get(def.from);
  if (!view) {
    return {
      key: def.key,
      title: def.title,
      blurb: def.blurb,
      status: 'not_supplied',
      sentence:
        'The assembled record returned no section under the key this reading is built from (' + def.from +
        '). Nothing was read and nothing is assumed. ' + def.owedBy + ' owes it.',
      owedBy: def.owedBy,
      signals: [],
      patterns: [],
      depth: null,
      depthSentence: null,
      fromProvider: false,
      requiredCapability: null,
      accessLogged: false,
      accessLogNote: null,
      data: null,
      openByDefault: def.openByDefault,
    };
  }

  const payload = view.payload;
  const withheldHere = !view.grant.granted;

  // Time intelligence is the one reading where a Patch 11 section AND an outside module both have
  // something to say. The stored horizons are attached as the data; the section's own signals and
  // status are left exactly as the producing patch reported them.
  const data = def.key === 'time_intelligence'
    ? { section: payload.data ?? null, horizons: temporal }
    : (payload.data ?? null);

  return {
    key: def.key,
    title: def.title,
    blurb: def.blurb,
    status: withheldHere ? 'withheld' : payload.status,
    sentence: withheldHere
      ? view.grant.because
      : (def.key === 'time_intelligence' && payload.status !== 'ok'
        ? payload.sentence + ' ' + temporal.sentence
        : payload.sentence),
    owedBy: payload.owedBy || def.owedBy,
    signals: withheldHere ? [] : (payload.signals || []),
    patterns: withheldHere ? [] : (payload.patterns || []),
    depth: view.depth ?? null,
    depthSentence: view.depthSentence ?? null,
    fromProvider: view.fromProvider,
    requiredCapability: payload.requiredCapability ?? view.grant.capability ?? null,
    accessLogged: payload.accessLogged ?? view.grant.accessLogged ?? false,
    accessLogNote: payload.accessLogNote ?? view.grant.accessLogNote ?? null,
    data: withheldHere ? null : data,
    openByDefault: def.openByDefault,
  };
}

function displayNameOf(overview: SectionView | undefined): string | null {
  const d: any = overview && overview.payload ? overview.payload.data : null;
  if (!d) return null;
  const candidate = d.displayName || d.fullName || d.name || (d.person && d.person.fullName);
  return candidate ? String(candidate) : null;
}

/**
 * Decisions and interventions, read defensively.
 *
 * The producing patch has not been read from here before, so nothing assumes its payload shape. What
 * is not an array of the expected shape is treated as absent rather than coerced — a half-understood
 * decision record rendered as a decision is worse than no decision panel at all.
 */
function collectLinked(view: SectionView | undefined): LinkedActions {
  const out: LinkedActions = { decisions: [], interventions: [] };
  const d: any = view && view.payload && view.grant.granted ? view.payload.data : null;
  if (!d) return out;
  if (Array.isArray(d.decisions)) {
    out.decisions = d.decisions.filter((x: any) => x && typeof x.decision === 'string') as DecisionRecord[];
  }
  if (Array.isArray(d.interventions)) {
    out.interventions = d.interventions.filter((x: any) => x && typeof x.summary === 'string') as InterventionRecord[];
  }
  return out;
}

// =================================================================================================
// THE TWO OUTSIDE READINGS
// =================================================================================================

function readTemporal(read: { value: any; error: string | null }, nowIso: string): TemporalReadout {
  if (read.error) {
    return {
      horizons: [],
      sentence: 'The stored time readings could not be read (' + read.error + '). That is not the same as this person having none.',
      error: read.error,
    };
  }
  const results = (read.value || {}) as Record<string, any>;
  const keys = Object.keys(results);
  const nowMs = Date.parse(nowIso);
  const horizons = keys.map((h) => {
    const r = results[h] || {};
    const staleAt = r.staleAt ? Date.parse(String(r.staleAt)) : NaN;
    return {
      horizon: h,
      computedAt: String(r.computedAt || ''),
      confidenceBand: String(r.confidenceBand || 'none'),
      summary: String(r.summary || ''),
      stale: Number.isFinite(staleAt) && Number.isFinite(nowMs) ? staleAt < nowMs : false,
    };
  });
  const stale = horizons.filter((h) => h.stale).length;
  return {
    horizons,
    sentence: horizons.length
      ? horizons.length + ' stored time reading(s) on record. These are READ, not recomputed on this ' +
        'page: a horizon is versioned so that what this system said in March can still be produced in ' +
        'August. ' + (stale ? stale + ' of them are past their staleness date and are marked as such.' : 'None is stale.')
      : 'No time reading has been computed and stored for this person yet. The temporal patch computes ' +
        'these on its own schedule; this view reads them and never triggers one, because a page open ' +
        'is not a reason to produce a new statement about somebody.',
    error: null,
  };
}

async function readRoles(
  read: { value: any; error: string | null },
  ctx: { employeeId: string; viewer: Viewer; holds: (k: string) => boolean; run: boolean },
): Promise<RoleReadout> {
  if (read.error) {
    return { comparable: [], comparison: null, ran: false, sentence: 'Nothing was compared.', error: read.error };
  }
  const all = Array.isArray(read.value) ? read.value : [];
  const comparable = all
    .map((r: any) => ({
      id: String(r.id || ''),
      title: String(r.title || 'Untitled role'),
      requirementCount: Number(r.requirementCount ?? r.requirement_count ?? 0) || 0,
      isOpen: r.isOpen !== false && r.is_open !== false,
    }))
    .filter((r) => r.id);

  const withReqs = comparable.filter((r) => r.requirementCount > 0);

  if (!ctx.run) {
    return {
      comparable,
      comparison: null,
      ran: false,
      sentence:
        withReqs.length + ' of ' + comparable.length + ' role(s) in the catalogue have mapped requirements ' +
        'and could be compared against this person. The comparison is NOT run on an ordinary page open: ' +
        'it fuses the assembled record with the requirement tables, and doing that for every profile view ' +
        'would put seconds on this page for a question nobody asked. Ask for it and it runs, and says what it read.',
      error: null,
    };
  }

  if (!withReqs.length) {
    return {
      comparable,
      comparison: null,
      ran: false,
      sentence:
        'No role in the catalogue has mapped requirements, so there is nothing to compare against. That is ' +
        'a gap in the role catalogue, not a finding about this person.',
      error: null,
    };
  }

  const ran = await safe('compareRoles', async () => {
    const { compareRoles } = await import('@/lib/horizon/role-compare');
    const { resolvePerfViewer } = await import('@/lib/performance-scope');
    const perfViewer = await resolvePerfViewer(String(ctx.viewer.id || ''), ctx.holds);
    // A bounded set. The cap is printed below rather than applied quietly.
    const slots = withReqs.slice(0, 3).map((r, i) => ({
      slot: (i === 0 ? 'current' : 'target_' + i) as any,
      jobKind: 'role' as const,
      jobId: r.id,
      chosenBecause: 'Selected by the founder view as one of the roles with mapped requirements.',
    }));
    return await compareRoles({
      person: { employeeId: ctx.employeeId },
      roles: slots,
      viewer: perfViewer,
      holds: ctx.holds,
      mayRun: ctx.holds('match.run'),
    });
  });

  if (ran.error) {
    return { comparable, comparison: null, ran: false, sentence: 'The comparison failed to run.', error: ran.error };
  }

  const skipped = withReqs.length - Math.min(3, withReqs.length);
  return {
    comparable,
    comparison: ran.value,
    ran: true,
    sentence:
      'Compared against ' + Math.min(3, withReqs.length) + ' role(s) with mapped requirements' +
      (skipped > 0
        ? ', and ' + skipped + ' further role(s) were NOT compared on this run. That cap is stated rather ' +
          'than hidden, because a silent top-three reads as a complete answer.'
        : '.') +
      ' The comparison module refuses to rank people and produces no overall score; what it returns is ' +
      'reported requirement by requirement.',
    error: null,
  };
}
