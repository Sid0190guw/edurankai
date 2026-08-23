// src/lib/horizon/integration/assess.ts — THE STATUS IS COMPUTED, NOT DECLARED.
//
// =================================================================================================
// WHY NOTHING HERE READS A FILE
// =================================================================================================
//
// Every function in this module is pure: evidence in, assessment out. collect.ts does the reading.
//
// That split is not tidiness. The Definition of Done in the brief is thirty checkboxes, and the only
// thing worse than an unfinished system is an unfinished system with thirty ticked boxes. A pure
// assessor can be unit-tested against fabricated evidence — including evidence that says everything
// is fine — which is the only way to prove the assessor would actually report a failure. An assessor
// wired directly to the filesystem can only ever be tested against whatever the tree happens to
// contain today, which on this project changed forty times in one hour.
//
// =================================================================================================
// UNREADABLE IS NOT ABSENT, AND THIS IS WHERE THAT IS ENFORCED
// =================================================================================================
//
// A serverless bundle does not ship src/ as readable files. So the same code that reports honestly
// in CI would, in production, find nothing and conclude that twenty-one patches do not exist — a
// report that is not merely wrong but confidently wrong about other people's work.
//
// `treeReadable: false` therefore short-circuits every state to `unreadable` and every Definition of
// Done item to `null`. The precedent is src/lib/evidence-graph.ts, which prints EVIDENCE UNREADABLE
// rather than a chain it could not read: an empty result rendered from a failed read is a lie.

import { INTEGRATION_MAP, MODULE_STATE_LABELS, type ModuleEntry, type ModuleState } from './map';
import {
  CANONICAL_CONCEPTS,
  conceptHealthSentence,
  conceptsWithNoStore,
  duplicateFindings,
  patchesOwingMigration,
  unclassifiedTables,
  type DuplicateFinding,
} from './concepts';

// -------------------------------------------------------------------------------------------------
// EVIDENCE
// -------------------------------------------------------------------------------------------------

/** What collect.ts establishes about one patch by reading the repository. */
export interface ModuleEvidence {
  patch: number;
  /** Source files found under the patch's `owns` paths, repo-relative. */
  filesPresent: readonly string[];
  /** Tables these files declare DDL for, as found by scanning for CREATE TABLE IF NOT EXISTS. */
  declaresTables: readonly string[];
  /**
   * True when at least one owned file contains something that runs: DDL, a query, or an exported
   * async function. A directory of `types.ts` alone is a specification, not a module.
   */
  hasRuntimeCode: boolean;
  /** Files under src/pages that import an owned file DIRECTLY. The only reach a person can open. */
  surfaceImporters: readonly string[];
  /** Test files under the patch's own paths. */
  testFiles: readonly string[];
}

export interface Evidence {
  /** False when the source tree could not be read. Everything downstream degrades honestly. */
  treeReadable: boolean;
  whyUnreadable: string | null;
  modules: readonly ModuleEvidence[];
  /** Every table any HORIZON module declares, across the whole tree. */
  observedTables: readonly string[];
  /** Files under src/pages whose path contains a HORIZON surface segment. */
  horizonRoutes: readonly string[];
  /** Source files that fail to parse. A build-breaking defect anybody can verify. */
  parseFailures: readonly { file: string; line: number; detail: string }[];
  collectedAt: string;
}

// -------------------------------------------------------------------------------------------------
// PER-MODULE ASSESSMENT
// -------------------------------------------------------------------------------------------------

export interface ModuleAssessment {
  entry: ModuleEntry;
  state: ModuleState;
  stateLabel: string;
  /** The sentence a screen prints under the state. Never a placeholder. */
  sentence: string;
  fileCount: number;
  tables: readonly string[];
  /** Tables the map expected that the tree does not declare, and the reverse. */
  tableDrift: { expectedMissing: string[]; declaredUnexpected: string[] };
  surfaceImporters: readonly string[];
  hasTests: boolean;
  /** True when the module lives outside src/lib/horizon/. Reported, never corrected. */
  misplaced: boolean;
}

/**
 * The state of one module, from evidence alone.
 *
 * The ladder is deliberate and each rung is a different kind of work:
 *   absent         -> somebody must write it
 *   contract_only  -> somebody must implement it
 *   implemented    -> somebody must WIRE it, and this is where every patch in this build sits
 *   reachable      -> a person can open it
 */
export function stateOf(e: ModuleEvidence, treeReadable: boolean): ModuleState {
  if (!treeReadable) return 'unreadable';
  if (e.filesPresent.length === 0) return 'absent';
  if (e.surfaceImporters.length > 0) return 'reachable';
  if (e.hasRuntimeCode || e.declaresTables.length > 0) return 'implemented';
  return 'contract_only';
}

function sentenceFor(entry: ModuleEntry, e: ModuleEvidence, state: ModuleState): string {
  const n = e.filesPresent.length;
  switch (state) {
    case 'unreadable':
      return 'The source tree could not be read here, so this patch\'s state is unknown. That is not '
        + 'the same as it being absent.';
    case 'absent':
      return 'No file exists for this patch. ' + entry.note;
    case 'contract_only':
      return n + ' file' + (n === 1 ? '' : 's') + ' of types, unions and pure functions. Nothing '
        + 'stores anything and nothing runs. This is a specification written in TypeScript.';
    case 'implemented':
      return n + ' file' + (n === 1 ? '' : 's') + ', '
        + (e.declaresTables.length
          ? e.declaresTables.length + ' table' + (e.declaresTables.length === 1 ? '' : 's') + ' declared, '
          : '')
        + 'and NOTHING under src/pages imports it. The code is written and no person can reach it.';
    case 'reachable':
      return 'Reachable from ' + e.surfaceImporters.length + ' surface'
        + (e.surfaceImporters.length === 1 ? '' : 's') + ': ' + e.surfaceImporters.join(', ') + '.';
  }
}

export function assessModules(ev: Evidence): ModuleAssessment[] {
  const byPatch = new Map<number, ModuleEvidence>();
  for (const m of ev.modules) byPatch.set(m.patch, m);

  return INTEGRATION_MAP.map((entry) => {
    const e = byPatch.get(entry.patch)
      || { patch: entry.patch, filesPresent: [], declaresTables: [], hasRuntimeCode: false, surfaceImporters: [], testFiles: [] };
    const state = stateOf(e, ev.treeReadable);
    const expected = new Set(entry.tables);
    const declared = new Set(e.declaresTables);
    return {
      entry,
      state,
      stateLabel: MODULE_STATE_LABELS[state],
      sentence: sentenceFor(entry, e, state),
      fileCount: e.filesPresent.length,
      tables: [...declared].sort(),
      tableDrift: {
        expectedMissing: [...expected].filter((t) => !declared.has(t)).sort(),
        declaredUnexpected: [...declared].filter((t) => !expected.has(t)).sort(),
      },
      surfaceImporters: e.surfaceImporters,
      hasTests: e.testFiles.length > 0,
      misplaced: entry.owns.some((p) => !p.startsWith('src/lib/horizon/')) && entry.owns.length > 0,
    };
  });
}

// -------------------------------------------------------------------------------------------------
// DEFINITION OF DONE
// -------------------------------------------------------------------------------------------------

/**
 * `met` is a THREE-valued answer and the third value is the important one.
 *
 * true  — proven by evidence in this run.
 * false — disproven by evidence in this run.
 * null  — NOT CHECKABLE by a static read of the source. A live end-to-end run is required, and this
 *         module refuses to guess. The brief's own instruction is "Do not claim completion unless the
 *         complete integrated system actually works", and a tick placed by a checker that cannot see
 *         the system working is exactly the claim it forbids.
 */
export interface DoDItem {
  key: string;
  label: string;
  met: boolean | null;
  detail: string;
}

const NOT_STATICALLY_CHECKABLE =
  'Not checkable by reading source. Proving this needs the deployed surface with a database behind '
  + 'it, and this checker deliberately opens no connection.';

export function definitionOfDone(ev: Evidence, modules: readonly ModuleAssessment[]): DoDItem[] {
  if (!ev.treeReadable) {
    return DOD_KEYS.map((k) => ({
      key: k.key, label: k.label, met: null,
      detail: 'The source tree could not be read: ' + (ev.whyUnreadable || 'reason not recorded') + '.',
    }));
  }

  const reachable = modules.filter((m) => m.state === 'reachable');
  const absent = modules.filter((m) => m.state === 'absent');
  const contractOnly = modules.filter((m) => m.state === 'contract_only');
  const implemented = modules.filter((m) => m.state === 'implemented');
  const dupes = duplicateFindings(ev.observedTables);
  const defects = dupes.filter((d) => d.severity === 'defect');
  const unclassified = unclassifiedTables(ev.observedTables);
  const noStore = conceptsWithNoStore(ev.observedTables);
  const withTests = modules.filter((m) => m.hasTests);

  const items: DoDItem[] = [
    {
      key: 'patches_integrated',
      label: 'All patches are integrated',
      met: absent.length === 0 && contractOnly.length === 0 && implemented.length === 0,
      detail: absent.length + ' not started, ' + contractOnly.length + ' contract only, '
        + implemented.length + ' implemented but unreachable, ' + reachable.length + ' reachable.',
    },
    {
      key: 'no_duplicate_models',
      label: 'No duplicate canonical models remain',
      met: defects.length === 0,
      detail: conceptHealthSentence(ev.observedTables)
        + (unclassified.length
          ? ' ' + unclassified.length + ' table(s) are not classified against any concept: '
            + unclassified.join(', ') + '.'
          : ''),
    },
    {
      key: 'contracts_consistent',
      label: 'Shared contracts are consistent',
      met: ev.parseFailures.length === 0 ? null : false,
      detail: ev.parseFailures.length
        ? ev.parseFailures.length + ' file(s) do not parse, so no consumer of their contracts can '
          + 'build: ' + ev.parseFailures.map((p) => p.file + ':' + p.line).join(', ') + '.'
        : 'Every HORIZON source file parses. Whether the shapes AGREE across patches needs the type '
          + 'checker over the whole project, not this probe.',
    },
    {
      key: 'concepts_have_stores',
      label: 'Every canonical concept has a store',
      met: noStore.length === 0,
      detail: noStore.length
        ? noStore.length + ' concept(s) name a canonical table no DDL declares: '
          + noStore.map((c) => c.label + ' (' + c.ownerTable + ')').join(', ') + '.'
        : 'Every canonical concept resolves to a table some module declares.',
    },
    {
      key: 'surfaces_exist',
      label: 'Every role view is reachable',
      met: reachable.length > 0 && absent.length === 0 ? null : false,
      detail: ev.horizonRoutes.length
        ? ev.horizonRoutes.length + ' HORIZON route(s) exist: ' + ev.horizonRoutes.join(', ') + '.'
        : 'NO ROUTE UNDER src/pages RENDERS ANY HORIZON MODULE. Every patch in this build is library '
          + 'code that no person can open.',
    },
    {
      key: 'tests_present',
      label: 'Modules carry tests',
      met: withTests.length === modules.filter((m) => m.state !== 'absent').length,
      detail: withTests.length + ' of ' + modules.filter((m) => m.state !== 'absent').length
        + ' present modules have a test file alongside them.',
    },
    { key: 'events_work', label: 'All required events work', met: null, detail: NOT_STATICALLY_CHECKABLE },
    { key: 'applicant_flow', label: 'Applicant flow works end to end', met: null, detail: NOT_STATICALLY_CHECKABLE },
    { key: 'interview_flow', label: 'Interview flow works end to end', met: null, detail: NOT_STATICALLY_CHECKABLE },
    { key: 'hiring_support', label: 'Hiring decision support works', met: null, detail: NOT_STATICALLY_CHECKABLE },
    { key: 'human_decision', label: 'The final decision is a human decision', met: null, detail: NOT_STATICALLY_CHECKABLE },
    { key: 'applicant_to_employee', label: 'Applicant to employee transition works', met: null, detail: NOT_STATICALLY_CHECKABLE },
    { key: 'fusion', label: 'Multi-source fusion works', met: null, detail: NOT_STATICALLY_CHECKABLE },
    { key: 'temporal', label: 'Time intelligence works', met: null, detail: NOT_STATICALLY_CHECKABLE },
    { key: 'signal_dedup', label: 'Signal deduplication works', met: null, detail: NOT_STATICALLY_CHECKABLE },
    { key: 'permissions_server_side', label: 'Permissions enforced server-side', met: null, detail: NOT_STATICALLY_CHECKABLE },
    { key: 'audit_history', label: 'Audit history works', met: null, detail: NOT_STATICALLY_CHECKABLE },
    { key: 'regression', label: 'Full regression testing passes', met: null, detail: NOT_STATICALLY_CHECKABLE },
  ];
  return items;
}

const DOD_KEYS: { key: string; label: string }[] = [
  { key: 'patches_integrated', label: 'All patches are integrated' },
  { key: 'no_duplicate_models', label: 'No duplicate canonical models remain' },
  { key: 'contracts_consistent', label: 'Shared contracts are consistent' },
  { key: 'concepts_have_stores', label: 'Every canonical concept has a store' },
  { key: 'surfaces_exist', label: 'Every role view is reachable' },
  { key: 'tests_present', label: 'Modules carry tests' },
  { key: 'events_work', label: 'All required events work' },
  { key: 'applicant_flow', label: 'Applicant flow works end to end' },
  { key: 'interview_flow', label: 'Interview flow works end to end' },
  { key: 'hiring_support', label: 'Hiring decision support works' },
  { key: 'human_decision', label: 'The final decision is a human decision' },
  { key: 'applicant_to_employee', label: 'Applicant to employee transition works' },
  { key: 'fusion', label: 'Multi-source fusion works' },
  { key: 'temporal', label: 'Time intelligence works' },
  { key: 'signal_dedup', label: 'Signal deduplication works' },
  { key: 'permissions_server_side', label: 'Permissions enforced server-side' },
  { key: 'audit_history', label: 'Audit history works' },
  { key: 'regression', label: 'Full regression testing passes' },
];

// -------------------------------------------------------------------------------------------------
// THE REPORT
// -------------------------------------------------------------------------------------------------

export type ReadinessVerdict = 'not_ready' | 'partially_integrated' | 'ready' | 'unknown';

export interface IntegrationReport {
  verdict: ReadinessVerdict;
  /** The sentence that goes at the top. It never says "complete" unless every item is proven. */
  headline: string;
  modules: ModuleAssessment[];
  duplicates: DuplicateFinding[];
  unclassifiedTables: string[];
  parseFailures: readonly { file: string; line: number; detail: string }[];
  dod: DoDItem[];
  counts: {
    total: number;
    absent: number;
    contractOnly: number;
    implemented: number;
    reachable: number;
    unreadable: number;
    tables: number;
    duplicateDefects: number;
  };
  /** Patch numbers that owe a migration because they declared a duplicate store. */
  migrationsOwed: number[];
  concepts: typeof CANONICAL_CONCEPTS;
  collectedAt: string;
}

export function buildReport(ev: Evidence): IntegrationReport {
  const modules = assessModules(ev);
  const dupes = ev.treeReadable ? duplicateFindings(ev.observedTables) : [];
  const dod = definitionOfDone(ev, modules);
  const counts = {
    total: modules.length,
    absent: modules.filter((m) => m.state === 'absent').length,
    contractOnly: modules.filter((m) => m.state === 'contract_only').length,
    implemented: modules.filter((m) => m.state === 'implemented').length,
    reachable: modules.filter((m) => m.state === 'reachable').length,
    unreadable: modules.filter((m) => m.state === 'unreadable').length,
    tables: ev.observedTables.length,
    duplicateDefects: dupes.filter((d) => d.severity === 'defect').length,
  };

  let verdict: ReadinessVerdict;
  let headline: string;
  if (!ev.treeReadable) {
    verdict = 'unknown';
    headline = 'The source tree could not be read here, so nothing is being claimed about it. '
      + (ev.whyUnreadable || '');
  } else if (dod.every((d) => d.met === true)) {
    verdict = 'ready';
    headline = 'Every statically checkable item is proven. The items marked "needs a live run" still '
      + 'need one before this is called complete.';
  } else if (counts.reachable === 0) {
    verdict = 'not_ready';
    headline = counts.total + ' patches, ' + (counts.contractOnly + counts.implemented)
      + ' with code in the tree, ' + counts.tables + ' tables declared, and '
      + (ev.horizonRoutes.length === 0
        ? 'no screen a person can open.'
        : ev.horizonRoutes.length + ' route(s) but none importing a patch module.')
      + ' This is a library, not yet a system.';
  } else {
    verdict = 'partially_integrated';
    headline = counts.reachable + ' of ' + counts.total + ' patches are reachable from a surface; '
      + counts.implemented + ' are written but unwired and ' + counts.absent + ' have not started. '
      + counts.duplicateDefects + ' unjustified duplicate store(s) remain.';
  }

  return {
    verdict,
    headline,
    modules,
    duplicates: dupes,
    unclassifiedTables: ev.treeReadable ? unclassifiedTables(ev.observedTables) : [],
    parseFailures: ev.parseFailures,
    dod,
    counts,
    migrationsOwed: ev.treeReadable ? patchesOwingMigration(ev.observedTables) : [],
    concepts: CANONICAL_CONCEPTS,
    collectedAt: ev.collectedAt,
  };
}

export const VERDICT_LABELS: Record<ReadinessVerdict, string> = {
  not_ready: 'Not ready',
  partially_integrated: 'Partially integrated',
  ready: 'Statically clean',
  unknown: 'Unknown',
};

/**
 * Blocking findings, for a CI gate that must fail rather than print.
 *
 * Deliberately narrow: a parse failure and an unjustified duplicate store. "Not finished" is not a
 * blocking finding — this build is not finished by design at this stage, and a gate that fails on
 * incompleteness is a gate somebody turns off.
 */
export function blockingFindings(report: IntegrationReport): string[] {
  const out: string[] = [];
  for (const p of report.parseFailures) {
    out.push('PARSE: ' + p.file + ':' + p.line + ' — ' + p.detail);
  }
  for (const d of report.duplicates) {
    if (d.severity === 'defect') {
      out.push('DUPLICATE: ' + d.duplicateTable + ' vs canonical ' + d.canonicalTable
        + ' (' + d.conceptLabel + ', ' + d.duplicateModule + ')');
    }
  }
  return out;
}
