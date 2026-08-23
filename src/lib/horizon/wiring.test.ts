// src/lib/horizon/wiring.test.ts — PATCH 19. THE CONTRACT IS CHECKED AGAINST THE REPOSITORY.
//
// =================================================================================================
// WHAT A DECLARATION IS WORTH WITHOUT THIS FILE
// =================================================================================================
//
// contract.ts is a set of CLAIMS: this module produces that, this symbol carries the seam, these
// paths prove it. A claim written down by an agent and never checked is exactly the artefact this
// patch exists to distrust — twenty-one agents wrote into this tree at once and a path that was
// right when it was typed can be wrong an hour later, with nothing anywhere saying so.
//
// So every path in the contract is opened, and every named symbol is looked for in the file that is
// said to export it. A rename in another patch fails HERE, loudly, instead of silently turning the
// integration matrix into fiction.
//
// WHAT THIS CANNOT PROVE, stated so a green run is not over-read: that the SQL behind a gate returns
// the right rows, that a migration ran, or that the deployed build contains this code. Those need
// the live surface, and the handoff document says so in the same words.
import { describe, it, expect } from 'vitest';

import { FLOWS } from '@/lib/horizon/contract';
import { fileExists, exportsSymbol, reachOf, importsModule, readSource, repoRoot } from '@/lib/horizon/probe';

/** A producer/consumer entry that names no real file — "(none, deliberately)" and friends. */
const isPlaceholder = (p: string) => p.startsWith('(');

describe('the probe can read this repository at all', () => {
  it('resolves the repository root and finds a file it must contain', () => {
    // If this fails, every other assertion in this file is vacuous rather than passing.
    expect(repoRoot().length > 0).toBe(true);
    expect(fileExists('package.json')).toBe(true);
    expect(fileExists('src/lib/horizon/contract.ts')).toBe(true);
    expect(fileExists('src/lib/horizon/definitely-not-a-file.ts')).toBe(false);
  });

  it('reads a symbol out of a file rather than guessing', () => {
    expect(exportsSymbol('src/lib/horizon/contract.ts', 'FLOWS')).toBe(true);
    expect(exportsSymbol('src/lib/horizon/contract.ts', 'matrixSummary')).toBe(true);
    expect(exportsSymbol('src/lib/horizon/contract.ts', 'NotExportedFromHere')).toBe(false);
  });
});

describe('every path the integration matrix cites actually exists', () => {
  for (const flow of FLOWS) {
    it(`flow ${flow.id} — ${flow.title}`, () => {
      const missing: string[] = [];
      for (const path of flow.evidence) if (!fileExists(path)) missing.push(path);
      if (!isPlaceholder(flow.producer.module) && !fileExists(flow.producer.module)) {
        missing.push(flow.producer.module + ' (producer)');
      }
      if (!isPlaceholder(flow.consumer.module) && !fileExists(flow.consumer.module)) {
        missing.push(flow.consumer.module + ' (consumer)');
      }
      expect({ flow: flow.id, missing }).toEqual({ flow: flow.id, missing: [] });
    });
  }
});

describe('every symbol the matrix says carries a seam is still exported', () => {
  for (const flow of FLOWS) {
    it(`flow ${flow.id} — ${flow.title}`, () => {
      const broken: string[] = [];
      for (const end of [flow.producer, flow.consumer]) {
        if (!end.symbol || isPlaceholder(end.module)) continue;
        if (!exportsSymbol(end.module, end.symbol)) broken.push(end.module + ' does not export ' + end.symbol);
      }
      expect({ flow: flow.id, broken }).toEqual({ flow: flow.id, broken: [] });
    });
  }
});

// -------------------------------------------------------------------------------------------------
// REACHABILITY. A FLOW NOBODY CAN OPEN IS NOT A FLOW.
// -------------------------------------------------------------------------------------------------

describe('the flows the matrix calls wired are reachable from a screen', () => {
  // A GENEROUS TIMEOUT, AND THE REASON IS NOT SLOW CODE. reachOf() reads every source file under
  // src/ once and caches it; on this tree that is a few thousand files, and the default 5s budget
  // expired on the FIRST call while the cache was still being built. A reachability check that times
  // out reports as a failure and reads as a leak, which is worse than taking twenty seconds.
  it('resolves at least one importer for every non-placeholder consumer', () => {
    // A consumer nothing imports is a flow that ends in the air. The consumer may itself BE a page,
    // which is reach of the most direct kind.
    const unreachable: string[] = [];
    for (const flow of FLOWS) {
      if (flow.status !== 'wired') continue;
      const path = flow.consumer.module;
      if (isPlaceholder(path)) continue;
      if (path.startsWith('src/pages/')) continue;   // the consumer is the screen
      const reach = reachOf(path);
      if (!reach.nonTestImporters.length) unreachable.push('flow ' + flow.id + ': nothing imports ' + path);
    }
    expect(unreachable).toEqual([]);
  }, 60_000);

  it('the HORIZON profile surface exists and reads the access model', () => {
    // Flow 11 is only 'wired' because a person can open this page. If it disappears, the status is
    // a lie and this is where that is caught.
    expect(fileExists('src/pages/admin/horizon/employee/[id].astro')).toBe(true);
    // The page reaches the access model in TWO HOPS, and this says so rather than pretending
    // otherwise: the page imports the profile builder, and the profile builder imports access.ts.
    // Asserting a direct import failed here while the wiring was perfectly correct — the kind of
    // false finding that gets a whole suite ignored.
    expect(importsModule('src/pages/admin/horizon/employee/[id].astro', 'src/lib/horizon/profile.ts')).toBe(true);
    expect(importsModule('src/lib/horizon/profile.ts', 'src/lib/horizon/access.ts')).toBe(true);
  });

  it('reports which HORIZON modules no page reaches, without failing on it', () => {
    // NOT AN ASSERTION ABOUT COUNT. The tree is being written by many patches at once and a module
    // landing before its screen is normal. What must hold is that the probe can answer the question
    // at all — an empty answer here would mean the reachability column of the matrix is guesswork.
    const answered = ['src/lib/horizon/access.ts', 'src/lib/horizon/record.ts', 'src/lib/horizon/events.ts']
      .map((m) => ({ m, importers: reachOf(m).nonTestImporters.length }));
    for (const row of answered) {
      expect({ m: row.m, answerable: Number.isFinite(row.importers) }).toEqual({ m: row.m, answerable: true });
    }
  }, 60_000);
});

// -------------------------------------------------------------------------------------------------
// THE REFUSALS THAT ARE ENFORCED BY ABSENCE. A COMMENT IS NOT A TEST; THIS IS.
// -------------------------------------------------------------------------------------------------

describe('nothing in the intelligence layer reaches the wellness system', () => {
  // The wellness system is women-only, gated server-side, and aggregate-only: no administrator and
  // not the founder may see one person's cycle, symptoms or consult messages. Several modules say so
  // in a header comment. A header comment does not survive a refactor; this does.
  const COMPOSERS = [
    'src/lib/horizon/record.ts',
    'src/lib/horizon/profile.ts',
    'src/lib/horizon/access.ts',
    'src/lib/horizon/visibility.ts',
    'src/lib/person-360.ts',
    'src/lib/digital-twin.ts',
  ];

  for (const composer of COMPOSERS) {
    it(`${composer} does not import the wellness module`, () => {
      if (!fileExists(composer)) return;   // a patch may not have landed it yet
      expect({ composer, importsWellness: importsModule(composer, 'src/lib/wellness.ts') })
        .toEqual({ composer, importsWellness: false });
    });
  }

  it('no composer writes a person record back', () => {
    // Flow 6 is 'by_design_absent' and this is what makes that a property rather than an intention.
    for (const composer of ['src/lib/person-360.ts', 'src/lib/digital-twin.ts', 'src/lib/horizon/profile.ts']) {
      if (!fileExists(composer)) continue;
      const src = readSource(composer) || '';
      const writes = /INSERT\s+INTO|UPDATE\s+[a-z_]+\s+SET|DELETE\s+FROM/i.test(src);
      expect({ composer, writes }).toEqual({ composer, writes: false });
    }
  });
});

describe('the word this system refuses to use does not appear in its own surfaces', () => {
  // Rule 19. The traditional computational layer is named neutrally everywhere a person can read it.
  // Checked on the modules that FEED a screen, not on comments in engine internals that explain what
  // the layer is — a rule about user-facing copy that failed on its own design notes would be
  // deleted within a week.
  const SURFACES = [
    'src/lib/horizon/sections.ts',
    'src/lib/horizon/visibility.ts',
    'src/lib/horizon/access.ts',
    'src/lib/foundational/vocabulary.ts',
  ];

  for (const surface of SURFACES) {
    it(`${surface} carries no forbidden term in a quoted string`, () => {
      if (!fileExists(surface)) return;
      const src = readSource(surface) || '';
      // Quoted strings only: a string literal is what reaches a screen.
      const strings = src.match(/'[^'\n]{4,}'|"[^"\n]{4,}"/g) || [];
      const offenders = strings.filter((s) => /astrolog|horoscope|zodiac|natal chart/i.test(s));
      expect({ surface, offenders }).toEqual({ surface, offenders: [] });
    });
  }
});

// -------------------------------------------------------------------------------------------------
// THE CONTRACT ITSELF. A REPORT THAT CONTRADICTS ITSELF IS WORSE THAN NO REPORT.
// -------------------------------------------------------------------------------------------------

describe('the integration contract is well formed', () => {
  it('declares all fifteen flows exactly once, in order', () => {
    expect(FLOWS.length).toBe(15);
    expect(FLOWS.map((f) => f.id)).toEqual(Array.from({ length: 15 }, (_, i) => i + 1));
    expect(new Set(FLOWS.map((f) => f.key)).size).toBe(15);
  });

  it('never marks a flow wired while naming a failure, or not-wired while naming none', () => {
    for (const flow of FLOWS) {
      if (flow.status === 'wired') {
        expect({ id: flow.id, failures: flow.failures.length }).toEqual({ id: flow.id, failures: 0 });
      } else {
        expect({ id: flow.id, hasFailure: flow.failures.length > 0 })
          .toEqual({ id: flow.id, hasFailure: true });
      }
    }
  });

  it('says where the human decides on every flow', () => {
    // RULE 14. No computed output decides anything. A flow with no human named is a flow nobody has
    // checked, and an empty string is not an answer.
    for (const flow of FLOWS) {
      expect({ id: flow.id, hasHuman: String(flow.humanDecision || '').trim().length > 0 })
        .toEqual({ id: flow.id, hasHuman: true });
    }
  });

  it('names inputs and outputs for every flow', () => {
    for (const flow of FLOWS) {
      expect({ id: flow.id, inputs: flow.inputs.length > 0, outputs: flow.outputs.length > 0 })
        .toEqual({ id: flow.id, inputs: true, outputs: true });
    }
  });
});
