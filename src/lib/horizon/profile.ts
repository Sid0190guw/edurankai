// src/lib/horizon/profile.ts — THE SUPER ADMIN EMPLOYEE PROFILE, COMPOSED IN THE RIGHT ORDER.
//
// =================================================================================================
// THE ORDER, AND WHY EACH STEP IS WHERE IT IS
// =================================================================================================
//
//   1. RESOLVE THE PERSON. The id graph only — which login, which application, which employee record
//      are the same human. This runs first because the authorization question is asked ABOUT those
//      rows and cannot be asked before we know which rows they are. It reads no name, no employee
//      code and no status: src/lib/digital-twin.ts already refuses fetch-then-hide and this
//      composer does not undo that.
//
//   2. DECIDE EVERY TAB. Pure, synchronous, no database. Twelve decisions, each with a sentence.
//
//   3. WRITE THE ACCESS LOG FOR EVERY SENSITIVE TAB, AND CHECK IT LANDED. Before any read. A
//      sensitive section whose access record could not be written is DOWNGRADED to withheld and
//      says so. This is the rule src/lib/legal-hold.ts already enforces on this project: where the
//      audit row is the control, the control has to have happened.
//
//   4. READ, ONCE. One digital twin for the four twin-backed tabs rather than four. One evidence
//      call. One audit query. A page that opened the same person four times would be paying the
//      ~177ms Mumbai-to-function round trip four times over for one screen.
//
//   5. ROLL UP. The Signals tab is assembled from what the granted tabs surfaced, sorted so that
//      demonstrated work sits above anything inferred. Rule 22, applied at the only place a reader
//      sees the signals side by side.
//
// =================================================================================================
// A PROVIDER ALWAYS BEATS AN ADAPTER
// =================================================================================================
//
// Five tabs have a local adapter in this patch because the records already exist here. If the patch
// that OWNS one of those concepts later registers a provider for it, the provider is used and the
// adapter is not called. That decision is made in `fillSection()` below, in one place, so no future
// agent has to hunt for where their registration is being ignored.
// =================================================================================================

import { resolvePerson, buildDigitalTwin, type DigitalTwin } from '@/lib/digital-twin';
import { resolvePerfViewer, type PerfViewer } from '@/lib/performance-scope';
import {
  sortSignalsByWeight,
  HORIZON_SECTION_KEYS,
  type HorizonSectionKey,
  type MeirSubject,
  type ProviderContext,
  type SectionPayload,
  type Signal,
} from './contracts';
import {
  HORIZON_SECTIONS,
  reachableDepth,
  depthSentence,
  sectionDef,
  type DrillRung,
} from './sections';
import {
  resolveHorizonAccess,
  grantOf,
  logProfileOpen,
  logSensitiveSectionAccess,
  type HorizonAccess,
  type HorizonViewer,
  type SectionGrant,
} from './access';
import { fetchSection, providerFor, registrationConflicts, type RegistrationConflict } from './registry';
import {
  bridgeMeirSections,
  BRIDGED_SECTIONS,
  type BridgeOutcome,
  type MeirSectionData,
} from './meir-bridge';
import {
  overviewSection,
  professionalProfileSection,
  performanceSection,
  evidenceSection,
  auditTrailSection,
} from './adapters';

// -------------------------------------------------------------------------------------------------
// TYPES
// -------------------------------------------------------------------------------------------------

export interface SectionView {
  key: HorizonSectionKey;
  label: string;
  blurb: string;
  grant: SectionGrant;
  payload: SectionPayload<unknown>;
  /** How far down the ladder a reader can actually walk from this tab. */
  depth: DrillRung;
  depthSentence: string;
  /** True when a producing patch answered; false when this patch's own adapter did. */
  fromProvider: boolean;
}

export interface SuperAdminProfile {
  subject: MeirSubject;
  access: HorizonAccess;
  sections: SectionView[];
  /** The roll-up, already sorted by weight. Also lives on the `signals` section payload. */
  signals: Signal[];
  /** Whether the record of this viewer opening the page was written. Printed. */
  openLogged: boolean;
  openLogNote: string | null;
  /** Two patches claiming one tab. Surfaced rather than silently resolved. */
  conflicts: RegistrationConflict[];
  /**
   * The patch ids registered with the shared Master Employee Intelligence Record right now.
   *
   * Printed in the footer. A tab reading "no patch contributed" next to a list of eight registered
   * patches is a different problem from the same tab next to an empty list, and an operator should
   * not have to open a console to tell them apart.
   */
  registeredPatches: string[];
  /** Set when the master record could not be composed at all. Distinct from a section being empty. */
  recordRefusal: string | null;
  /** One clock for the whole page. */
  asOf: string;
  /** Set when the person could not be resolved at all. The page renders this and nothing else. */
  refusal: string | null;
}

// -------------------------------------------------------------------------------------------------
// THE COMPOSER
// -------------------------------------------------------------------------------------------------

/**
 * Build the whole profile for one viewer.
 *
 * `holds` is the console's own capability test — `(k) => can(user, k)`. This module resolves no
 * role and reads no grant table; passing the test in is what keeps Authorization one layer.
 */
export async function buildSuperAdminProfile(input: {
  employeeId?: string | null;
  userId?: string | null;
  applicationId?: string | null;
  viewer: HorizonViewer;
  holds: (key: string) => boolean;
  ipAddress?: string | null;
}): Promise<SuperAdminProfile> {
  const asOf = new Date().toISOString();

  // ---- 1. THE PERSON -----------------------------------------------------------------------------
  const person = await resolvePerson({
    employeeId: input.employeeId || null,
    userId: input.userId || null,
    applicationId: input.applicationId || null,
  });

  const subject: MeirSubject = {
    personKey: person.key,
    userId: person.userId,
    employeeId: person.employeeId,
    applicationIds: person.applicationIds || [],
  };

  if (!person.key) {
    return {
      subject,
      access: resolveHorizonAccess(input.viewer, subject, () => false),
      sections: [],
      signals: [],
      openLogged: false,
      openLogNote: null,
      conflicts: registrationConflicts(),
      registeredPatches: [],
      recordRefusal: null,
      asOf,
      refusal: person.readFailed
        ? 'We could not read the identity records just now, so this page shows nothing rather than guessing. This is not a statement that the person does not exist.'
        : person.sentence || 'No person could be resolved from what was asked for.',
    };
  }

  // ---- 2. THE DECISIONS, BEFORE ANY READ ---------------------------------------------------------
  const access = resolveHorizonAccess(input.viewer, subject, input.holds);

  // ---- 3. THE ACCESS LOG, BEFORE ANY READ --------------------------------------------------------
  const openLog = await logProfileOpen({
    viewer: input.viewer,
    subject,
    grantedSections: access.granted,
    ipAddress: input.ipAddress || null,
  });

  // Sensitive tabs are logged individually, and a failed write REVOKES the grant for that tab.
  const sensitiveGranted = access.grants.filter((g) => g.granted && g.sensitive);
  await Promise.all(
    sensitiveGranted.map(async (g) => {
      const outcome = await logSensitiveSectionAccess({
        viewer: input.viewer,
        subject,
        section: g.section,
        capability: g.capability,
        ipAddress: input.ipAddress || null,
      });
      g.accessLogged = outcome.logged;
      g.accessLogNote = outcome.note;
      if (!outcome.logged) {
        g.granted = false;
        g.outcome = 'withheld';
        g.because = outcome.note || 'The record of you opening this section could not be written, so it was not opened.';
      }
    }),
  );

  // The grant list changed under us, so the summary lists are recomputed rather than left stale.
  access.granted = access.grants.filter((g) => g.granted).map((g) => g.section);
  access.withheld = access.grants.filter((g) => g.outcome === 'withheld').map((g) => g.section);
  access.anyGranted = access.granted.length > 0;

  // ---- 4. THE READS ------------------------------------------------------------------------------
  const ctx: ProviderContext = {
    viewerUserId: input.viewer.userId,
    viewerEmployeeId: input.viewer.employeeId,
    grantedOn: null,
    asOf,
  };

  // The twin is built at most once, and only when a twin-backed tab was actually granted.
  const twinBacked: HorizonSectionKey[] = ['overview', 'professional_profile', 'performance_work_records'];
  const needTwin = twinBacked.some((k) => access.granted.indexOf(k) >= 0);
  let twin: DigitalTwin | null = null;
  let twinError: string | null = null;
  if (needTwin) {
    try {
      const perfViewer: PerfViewer = await resolvePerfViewer(input.viewer.userId, input.holds);
      twin = await buildDigitalTwin(
        { employeeId: subject.employeeId, userId: subject.userId },
        perfViewer,
        input.holds,
      );
    } catch (e: any) {
      twinError = e?.cause?.message || e?.message || String(e);
    }
  }

  // THE MASTER EMPLOYEE INTELLIGENCE RECORD, COMPOSED ONCE, FOR THE GRANTED TABS ONLY.
  //
  // src/lib/horizon/record.ts owns it; this patch consumes it and does not keep a copy. The grant
  // list is passed in so a provider whose dimensions belong to a withheld tab is never asked — a
  // withheld section is not read and then dropped, it is not read.
  const bridge: BridgeOutcome = await bridgeMeirSections(subject, {
    granted: access.granted,
    requestId: undefined,
  });

  const sections: SectionView[] = [];
  for (const def of HORIZON_SECTIONS) {
    const grant = grantOf(access, def.key);
    const view = await fillSection(def.key, grant, subject, ctx, twin, twinError, bridge);
    sections.push(view);
  }

  // ---- 5. THE ROLL-UP ----------------------------------------------------------------------------
  const signals = rollUpSignals(sections);
  const signalsIndex = sections.findIndex((s) => s.key === 'signals');
  if (signalsIndex >= 0 && sections[signalsIndex].grant.granted) {
    const sv = sections[signalsIndex];
    sv.payload.signals = signals;
    sv.payload.status = signals.length ? 'ok' : 'empty';
    sv.payload.sentence = signals.length
      ? signals.length + ' signal' + (signals.length === 1 ? '' : 's') + ' across the sections you were granted, '
        + 'strongest kind of evidence first. Nothing inferred is allowed above anything demonstrated.'
      : 'The sections you were granted surfaced no signals. That is not the same as this person having none — '
        + 'the tabs that carry most of them are the ones you do not hold.';
    sv.depth = reachableDepth({
      hasSignals: signals.length > 0,
      hasPatterns: signals.some((s) => s.patternIds.length > 0),
      hasEvidence: signals.some((s) => s.evidence.length > 0),
      hasRecordLink: signals.some((s) => s.evidence.some((e) => !!e.href || !!e.documentUrl)),
    });
    sv.depthSentence = depthSentence(sv.depth);
  }

  return {
    subject,
    access,
    sections,
    signals,
    openLogged: openLog.logged,
    openLogNote: openLog.note,
    conflicts: registrationConflicts(),
    registeredPatches: bridge.registeredPatches,
    recordRefusal: bridge.refusal,
    asOf,
    refusal: null,
  };
}

// -------------------------------------------------------------------------------------------------
// ONE SECTION
// -------------------------------------------------------------------------------------------------

/**
 * The tabs this patch fills from records that already exist in this tree. They still receive any
 * signals the master record contributed to them; see fillSection().
 */
const LOCALLY_ADAPTED: readonly HorizonSectionKey[] = [
  'overview', 'professional_profile', 'performance_work_records', 'evidence_records', 'audit_trail',
];

async function fillSection(
  key: HorizonSectionKey,
  grant: SectionGrant,
  subject: MeirSubject,
  ctx: ProviderContext,
  twin: DigitalTwin | null,
  twinError: string | null,
  bridge: BridgeOutcome,
): Promise<SectionView> {
  const def = sectionDef(key);
  const base = {
    key,
    label: def.label,
    blurb: def.blurb,
    grant,
  };

  // Withheld and awaiting-ratification tabs read NOTHING. Not read then hidden — not read.
  if (!grant.granted) {
    return {
      ...base,
      payload: {
        key,
        status: 'withheld',
        sentence: grant.because,
        owedBy: def.owedBy,
        signals: [],
        patterns: [],
        requiredCapability: def.capability,
        accessLogged: grant.accessLogged,
        accessLogNote: grant.accessLogNote,
      },
      depth: 'summary',
      depthSentence: 'Nothing was read, so there is nothing to walk down to.',
      fromProvider: false,
    };
  }

  // A registered provider always wins over this patch's own adapter.
  const provider = providerFor(key);
  if (provider) {
    const payload = await fetchSection(key, subject, { ...ctx, grantedOn: grant.capability }, def.owedBy);
    const p = payload || notSupplied(key, def.owedBy, def.capability);
    return { ...base, payload: p, ...depthOf(p), fromProvider: true };
  }

  // This patch's own adapters, for the sections whose records already exist in this tree.
  let payload: SectionPayload<unknown>;
  switch (key) {
    case 'overview':
      payload = twin ? overviewSection(twin) : twinUnavailable(key, def.owedBy, twinError);
      break;
    case 'professional_profile':
      payload = twin ? professionalProfileSection(twin) : twinUnavailable(key, def.owedBy, twinError);
      break;
    case 'performance_work_records':
      payload = twin ? performanceSection(twin) : twinUnavailable(key, def.owedBy, twinError);
      break;
    case 'evidence_records':
      payload = await evidenceSection(subject);
      break;
    case 'audit_trail':
      payload = await auditTrailSection(subject);
      break;
    case 'signals':
      // Filled by the roll-up in the caller. An empty shell here keeps the shape uniform.
      payload = {
        key,
        status: 'empty',
        sentence: '',
        owedBy: def.owedBy,
        signals: [],
        patterns: [],
        requiredCapability: null,
        accessLogged: grant.accessLogged,
        accessLogNote: grant.accessLogNote,
      };
      break;
    default:
      // EVERY REMAINING TAB IS THE MASTER RECORD'S. Behaviour, the personal summary, sustainability,
      // time, feedback and decisions are owned by producing patches, and this patch reads them
      // through src/lib/horizon/record.ts rather than reimplementing any of them. A tab with no
      // contributing patch renders `not_supplied` and names what is registered.
      payload = bridge.payloads.get(key) || notSupplied(key, def.owedBy, def.capability);
      break;
  }

  // A locally-adapted tab still shows what the master record contributed to it. The adapter owns the
  // PANEL (it is a re-presentation of rows that already exist here); the record contributes SIGNALS,
  // and dropping them because a local adapter answered first would hide a producing patch's work.
  if (LOCALLY_ADAPTED.indexOf(key) >= 0) {
    const extra = bridge.payloads.get(key);
    if (extra && extra.signals.length) {
      payload.signals = (payload.signals || []).concat(extra.signals);
    }
  }

  payload.accessLogged = grant.accessLogged;
  payload.accessLogNote = grant.accessLogNote;
  payload.requiredCapability = def.capability;

  return { ...base, payload, ...depthOf(payload), fromProvider: false };
}

function depthOf(p: SectionPayload<unknown>): { depth: DrillRung; depthSentence: string } {
  const depth = reachableDepth({
    hasSignals: (p.signals || []).length > 0,
    hasPatterns: (p.patterns || []).length > 0,
    hasEvidence: (p.signals || []).some((s) => (s.evidence || []).length > 0),
    hasRecordLink: (p.signals || []).some((s) => (s.evidence || []).some((e) => !!e.href || !!e.documentUrl)),
  });
  return { depth, depthSentence: depthSentence(depth) };
}

/**
 * The panel a tab renders when the patch that owns it has not registered anything.
 *
 * It names the owner. An absent section with no owner is a dead end for whoever opens the page; an
 * absent section with an owner is a question somebody can go and ask.
 */
function notSupplied(key: HorizonSectionKey, owedBy: string, capability: string | null): SectionPayload<unknown> {
  return {
    key,
    status: 'not_supplied',
    sentence:
      owedBy + ' has not registered a provider for this section yet, so nothing was read and nothing is assumed. '
      + 'This is a wiring state, not a statement about the person: an empty panel here does not mean an empty record.',
    owedBy,
    signals: [],
    patterns: [],
    requiredCapability: capability,
    accessLogged: false,
    accessLogNote: null,
  };
}

function twinUnavailable(key: HorizonSectionKey, owedBy: string, reason: string | null): SectionPayload<unknown> {
  return {
    key,
    status: 'unreadable',
    sentence:
      'The composed person record could not be built just now, so this section is INCOMPLETE rather than empty. '
      + (reason ? '(' + String(reason).slice(0, 200) + ')' : ''),
    owedBy,
    signals: [],
    patterns: [],
    requiredCapability: null,
    accessLogged: false,
    accessLogNote: null,
  };
}

// -------------------------------------------------------------------------------------------------
// THE ROLL-UP — RULE 22 AT THE ONE PLACE A READER COMPARES SIGNALS SIDE BY SIDE
// -------------------------------------------------------------------------------------------------

/**
 * Every signal from every GRANTED section, strongest kind of evidence first.
 *
 * Sorting is by weight class descending, then by observation date descending. There is no total, no
 * average and no composite score anywhere in here, and there is deliberately no code path that
 * could produce one: `compareSignalWeight` orders, it does not add.
 */
export function rollUpSignals(sections: SectionView[]): Signal[] {
  const out: Signal[] = [];
  for (const s of sections) {
    if (s.key === 'signals') continue;
    if (!s.grant.granted) continue;
    for (const sig of s.payload.signals || []) out.push(sig);
  }
  return sortSignalsByWeight(out);
}

/** Every section key, in tab order. Exported so the page and the tests agree about the order. */
export const SECTION_ORDER: readonly HorizonSectionKey[] = HORIZON_SECTION_KEYS;
