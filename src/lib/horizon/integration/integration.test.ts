// src/lib/horizon/integration/integration.test.ts — PATCH 20.
//
// THE POINT OF THESE TESTS IS THAT THE CHECKER CAN SAY NO.
//
// A readiness checker that only ever runs against the real tree can be tested into agreeing with
// whatever the tree happens to contain. Every test below feeds FABRICATED evidence, including
// evidence that says everything is finished, and asserts on what the assessor concludes. That is the
// only way to know it would report a failure rather than a green tick — which matters here because
// the brief's closing instruction is "Do not claim completion unless the complete integrated system
// actually works", and the most likely way to violate it is a checker nobody checked.

import { describe, it, expect } from 'vitest';
import {
  assessModules,
  blockingFindings,
  buildReport,
  definitionOfDone,
  stateOf,
  type Evidence,
  type ModuleEvidence,
} from './assess';
import { INTEGRATION_MAP, misplacedModules, declaredTables } from './map';
import {
  CANONICAL_CONCEPTS,
  TABLE_CONCEPT,
  conceptHealthSentence,
  duplicateFindings,
  unclassifiedTables,
} from './concepts';
import {
  collectEvidence,
  exactSpecifiersFor,
  hasRuntimeCode,
  importSpecifiersOf,
  scanUnterminatedStrings,
  tablesDeclaredIn,
  unreadableEvidence,
  type SourceReader,
} from './collect';

const NOW = '2026-08-23T12:00:00.000Z';

function moduleEvidence(patch: number, over: Partial<ModuleEvidence> = {}): ModuleEvidence {
  return {
    patch,
    filesPresent: [],
    declaresTables: [],
    hasRuntimeCode: false,
    surfaceImporters: [],
    testFiles: [],
    ...over,
  };
}

function evidence(over: Partial<Evidence> = {}): Evidence {
  return {
    treeReadable: true,
    whyUnreadable: null,
    modules: [],
    observedTables: [],
    horizonRoutes: [],
    parseFailures: [],
    collectedAt: NOW,
    ...over,
  };
}

describe('the map itself', () => {
  it('covers patches 0 to 20 with no gap and no duplicate', () => {
    const patches = INTEGRATION_MAP.map((m) => m.patch);
    expect(patches).toEqual(Array.from({ length: 21 }, (_, i) => i));
  });

  it('never lets patch 20 declare a table, because an integrator that owns data is a 22nd patch', () => {
    const p20 = INTEGRATION_MAP.find((m) => m.patch === 20)!;
    expect(p20.tables).toEqual([]);
  });

  it('reports modules placed outside src/lib/horizon rather than pretending they are not', () => {
    const misplaced = misplacedModules().map((m) => m.patch);
    // Recorded as observed, not corrected: moving another agent's directory is the overwrite the
    // multi-agent rules forbid.
    expect(misplaced.length).toBeGreaterThan(0);
    expect(misplaced).toContain(2);
  });

  it('declaredTables returns a sorted table-to-patch index', () => {
    const t = declaredTables();
    const names = t.map((x) => x.table);
    expect([...names].sort()).toEqual(names);
  });
});

describe('state of a module', () => {
  it('is absent when no file exists', () => {
    expect(stateOf(moduleEvidence(16), true)).toBe('absent');
  });

  it('is contract_only for types with nothing that runs', () => {
    expect(stateOf(moduleEvidence(6, { filesPresent: ['src/lib/fusion/types.ts'] }), true))
      .toBe('contract_only');
  });

  it('is implemented when code runs but no page imports it', () => {
    expect(stateOf(
      moduleEvidence(17, { filesPresent: ['a.ts'], hasRuntimeCode: true }),
      true,
    )).toBe('implemented');
  });

  it('is reachable only when a page imports it', () => {
    expect(stateOf(
      moduleEvidence(17, {
        filesPresent: ['a.ts'], hasRuntimeCode: true,
        surfaceImporters: ['src/pages/admin/horizon/index.astro'],
      }),
      true,
    )).toBe('reachable');
  });

  it('NEVER reports absent when the tree could not be read', () => {
    // The whole point. A serverless bundle ships no src/, and "I could not look" must never render
    // as "twenty-one patches do not exist".
    expect(stateOf(moduleEvidence(0), false)).toBe('unreadable');
    expect(stateOf(moduleEvidence(0, { filesPresent: ['x.ts'] }), false)).toBe('unreadable');
  });
});

describe('the definition of done', () => {
  it('marks every item unknown when the tree is unreadable, and never true', () => {
    const ev = unreadableEvidence('bundled function, no source files', NOW);
    const dod = definitionOfDone(ev, assessModules(ev));
    expect(dod.length).toBeGreaterThan(0);
    expect(dod.every((d) => d.met === null)).toBe(true);
  });

  it('fails "no duplicate canonical models" when an unjustified second store is present', () => {
    const ev = evidence({ observedTables: ['hgov_consent', 'emp_intel_consent'] });
    const item = definitionOfDone(ev, assessModules(ev)).find((d) => d.key === 'no_duplicate_models')!;
    expect(item.met).toBe(false);
    expect(item.detail).toMatch(/Consent/);
  });

  it('passes "no duplicate canonical models" when only justified second stores are present', () => {
    const ev = evidence({ observedTables: ['hgov_consent', 'hgov_consent_events', 'hr_feedback_dimensions'] });
    const item = definitionOfDone(ev, assessModules(ev)).find((d) => d.key === 'no_duplicate_models')!;
    expect(item.met).toBe(true);
  });

  it('fails "every role view is reachable" when nothing under src/pages renders a patch', () => {
    const ev = evidence({ modules: [moduleEvidence(0, { filesPresent: ['src/lib/horizon/ids.ts'] })] });
    const item = definitionOfDone(ev, assessModules(ev)).find((d) => d.key === 'surfaces_exist')!;
    expect(item.met).toBe(false);
    expect(item.detail).toMatch(/NO ROUTE/);
  });

  it('leaves items a static read cannot prove as null rather than ticking them', () => {
    const ev = evidence();
    const dod = definitionOfDone(ev, assessModules(ev));
    for (const key of ['events_work', 'applicant_flow', 'permissions_server_side', 'regression']) {
      expect(dod.find((d) => d.key === key)!.met).toBeNull();
    }
  });

  it('fails "shared contracts are consistent" when a file does not parse', () => {
    const ev = evidence({ parseFailures: [{ file: 'src/lib/horizon/x.ts', line: 12, detail: 'unterminated' }] });
    const item = definitionOfDone(ev, assessModules(ev)).find((d) => d.key === 'contracts_consistent')!;
    expect(item.met).toBe(false);
  });
});

describe('duplicate concept detection', () => {
  it('names the consent fork as a defect and points at the canonical owner', () => {
    const found = duplicateFindings(['hgov_consent', 'hzn_consent_event', 'emp_intel_consent']);
    const defects = found.filter((f) => f.severity === 'defect');
    expect(defects.map((d) => d.duplicateTable).sort())
      .toEqual(['emp_intel_consent', 'hzn_consent_event']);
    expect(defects.every((d) => d.canonicalTable === 'hgov_consent')).toBe(true);
  });

  it('does not report a second store that states why it exists', () => {
    const found = duplicateFindings(['hr_feedback_dimensions', 'hr_feedback_examples', 'hzn_evidence']);
    expect(found.every((f) => f.severity === 'by_design')).toBe(true);
  });

  it('reports nothing for a table the tree does not actually declare', () => {
    expect(duplicateFindings([])).toEqual([]);
  });

  it('flags a table nobody has classified instead of silently ignoring it', () => {
    expect(unclassifiedTables(['hgov_consent', 'hzn_brand_new_table']))
      .toEqual(['hzn_brand_new_table']);
  });

  it('every classified table names a concept that exists', () => {
    const keys = new Set(CANONICAL_CONCEPTS.map((c) => c.key));
    for (const [table, cls] of Object.entries(TABLE_CONCEPT)) {
      expect(keys.has(cls.concept), table + ' -> ' + cls.concept).toBe(true);
    }
  });

  it('summarises cleanly when there is nothing to report', () => {
    expect(conceptHealthSentence(['hgov_consent'])).toMatch(/one owner/);
  });
});

describe('source scanning', () => {
  it('finds every table a module declares', () => {
    expect(tablesDeclaredIn('CREATE TABLE IF NOT EXISTS hzn_profile (id UUID); CREATE TABLE IF NOT EXISTS hzn_event (id UUID);'))
      .toEqual(['hzn_profile', 'hzn_event']);
  });

  it('separates a module that runs from one that only describes', () => {
    expect(hasRuntimeCode('export interface Thing { a: string }')).toBe(false);
    expect(hasRuntimeCode('export async function load() { return db.execute(sql`SELECT 1`); }')).toBe(true);
  });

  it('catches the unescaped apostrophe that broke three patches in one afternoon', () => {
    const bad = "const s = 'this person's own year of service';";
    expect(scanUnterminatedStrings(bad).length).toBe(1);
  });

  it('does not flag a correctly escaped apostrophe', () => {
    const good = "const s = 'this person" + String.fromCharCode(92) + "'s own year';";
    expect(scanUnterminatedStrings(good)).toEqual([]);
  });

  it('does not flag an apostrophe inside a comment or a template literal', () => {
    expect(scanUnterminatedStrings("// this person's work")).toEqual([]);
    expect(scanUnterminatedStrings('const s = `this person\'s work`;')).toEqual([]);
  });
});

describe('collection over a fabricated tree', () => {
  const files: Record<string, string> = {
    'src/lib/horizon/ids.ts': 'export const A = 1;',
    'src/lib/horizon/governance/schema.ts':
      'export async function ensure() { return db.execute(`CREATE TABLE IF NOT EXISTS hgov_consent (id UUID)`); }',
    'src/lib/horizon/governance/types.ts': 'export interface G { a: string }',
    'src/lib/intelligence/schema.ts':
      'export async function e() { return db.execute(`CREATE TABLE IF NOT EXISTS emp_intel_consent (id UUID)`); }',
  };
  const reader: SourceReader = {
    filesUnder: (dir) => Object.keys(files).filter((f) => f.startsWith(dir.replace(/\/$/, ''))),
    read: (p) => (p in files ? files[p] : null),
  };

  it('collects tables from the modules that declare them', () => {
    const ev = collectEvidence(reader, NOW);
    expect(ev.observedTables).toContain('hgov_consent');
    expect(ev.observedTables).toContain('emp_intel_consent');
  });

  it('produces a report that refuses to call an unwired library a system', () => {
    const report = buildReport(collectEvidence(reader, NOW));
    expect(report.verdict).toBe('not_ready');
    expect(report.headline).toMatch(/library, not yet a system/);
    expect(report.counts.reachable).toBe(0);
  });

  it('raises the consent duplicate as a blocking finding', () => {
    const report = buildReport(collectEvidence(reader, NOW));
    const blocking = blockingFindings(report);
    expect(blocking.some((b) => b.startsWith('DUPLICATE:') && b.includes('emp_intel_consent'))).toBe(true);
  });

  it('counts a page as a surface only when it imports the module exactly', () => {
    // THE REGRESSION THIS TEST EXISTS FOR. The first version of the collector used Patch 19's
    // reachOf(), which tail-matches '/types' by design, and reported 16 of 21 patches as reachable
    // when the true number was zero — because 126 unrelated pages import something ending in
    // '/types'. Over-stating reach is the one claim this whole patch must never make.
    const withPages: Record<string, string> = {
      ...files,
      'src/pages/admin/horizon/index.astro': "import { x } from '@/lib/horizon/governance/schema';",
      'src/pages/admin/unrelated.astro': "import { y } from '@/lib/mailplatform/types';",
    };
    const r: SourceReader = {
      filesUnder: (dir) => Object.keys(withPages).filter((f) => f.startsWith(dir.replace(/\/$/, ''))),
      read: (p) => (p in withPages ? withPages[p] : null),
    };
    const ev = collectEvidence(r, NOW);
    const p17 = ev.modules.find((m) => m.patch === 17)!;
    const p01 = ev.modules.find((m) => m.patch === 1)!;
    expect(p17.surfaceImporters).toEqual(['src/pages/admin/horizon/index.astro']);
    expect(p01.surfaceImporters).toEqual([]);
  });

  it('resolves the exact specifiers for a module and nothing looser', () => {
    expect(exactSpecifiersFor('src/lib/horizon/feedback/types.ts'))
      .toContain('@/lib/horizon/feedback/types');
    expect(exactSpecifiersFor('src/lib/horizon/feedback/types.ts')).not.toContain('/types');
    expect(exactSpecifiersFor('src/lib/horizon/integration/index.ts'))
      .toContain('@/lib/horizon/integration');
  });

  it('pulls static, dynamic and require import forms out of a source file', () => {
    const src = "import a from '@/x';\nconst b = await import('@/y');\nconst c = require('@/z');";
    expect(importSpecifiersOf(src)).toEqual(['@/x', '@/y', '@/z']);
  });

  it('says unknown, not not_ready, when it could not read anything', () => {
    const report = buildReport(unreadableEvidence('no filesystem in a bundled function', NOW));
    expect(report.verdict).toBe('unknown');
    expect(report.headline).toMatch(/nothing is being claimed/);
    expect(blockingFindings(report)).toEqual([]);
  });
});
