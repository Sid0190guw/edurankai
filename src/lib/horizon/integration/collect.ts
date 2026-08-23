// src/lib/horizon/integration/collect.ts — READ THE REPOSITORY. DECIDE NOTHING.
//
// =================================================================================================
// THE DIVISION OF LABOUR, AND WHY IT MATTERS MORE THAN IT LOOKS
// =================================================================================================
//
// This file reads. assess.ts decides. Nothing here forms a judgement about a patch, and nothing in
// assess.ts touches the filesystem. The split is what makes the assessor testable against fabricated
// evidence — including evidence that says everything is fine, which is the only way to prove the
// assessor would report a failure if there were one.
//
// =================================================================================================
// IT DOES NOT OPEN A DATABASE, AND THAT IS A RULE RATHER THAN AN OMISSION
// =================================================================================================
//
// The obvious way to check "does hgov_consent exist" is to query information_schema. This project's
// working rules forbid it: a subagent asked to survey source files opened production instead and read
// staff data out of hr_employees. So table existence is established the other way — by reading the
// module that DECLARES the DDL. That is weaker than asking the database and it is stated as weaker
// wherever it is used. It answers "which tables does this codebase intend to exist", which is the
// question a duplicate-concept check actually needs.
//
// =================================================================================================
// PATCH 19'S PROBE IS IMPORTED, NOT REIMPLEMENTED
// =================================================================================================
//
// sourceFilesUnder(), readSource(), reachOf() and fileExists() belong to src/lib/horizon/probe.ts.
// A second copy of "which specifiers reach this file" is precisely the drift both patches exist to
// catch, and writing one here would have made this module the twenty-second patch instead of the
// integrator.

import { INTEGRATION_MAP } from './map';
import type { Evidence, ModuleEvidence } from './assess';

// -------------------------------------------------------------------------------------------------
// SCANNING PRIMITIVES
// -------------------------------------------------------------------------------------------------

// The trailing `(` is not decoration. Without it this matched the PROSE in
// src/lib/interview-intelligence.ts:394 — "a CREATE TABLE IF NOT EXISTS written from memory is a
// SECOND SHAPE" — and duly reported a table called `written`. A checker that invents a table is
// worse than one that misses a real one, because somebody then goes looking for it.
const CREATE_TABLE = /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+([a-z_][a-z0-9_]*)\s*\(/gi;

/** Every table a source file declares DDL for. */
export function tablesDeclaredIn(src: string): string[] {
  const out = new Set<string>();
  CREATE_TABLE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CREATE_TABLE.exec(src)) !== null) out.add(m[1].toLowerCase());
  return [...out];
}

/**
 * Does this file contain anything that RUNS, as opposed to anything that merely describes?
 *
 * The test is deliberately generous — a database call, a schema bootstrap, or an exported async
 * function all count. A generous test errs towards calling a module `implemented`, which is the
 * safer direction: over-reporting a patch as contract-only would be this checker making somebody
 * else's careful work look like less than it is.
 */
export function hasRuntimeCode(src: string): boolean {
  return /db\.execute|ensureBatch|ensureOnce|CREATE\s+TABLE|export\s+async\s+function|await\s+sql/i
    .test(src);
}

const BACKSLASH = String.fromCharCode(92);

/**
 * Lines where a quoted string opens and never closes.
 *
 * A HEURISTIC, AND NAMED AS ONE. It tracks block comments and template literals across lines but it
 * does not understand regular-expression literals, so a regex containing an apostrophe is reported
 * and is not a defect. It exists because this exact defect — an unescaped apostrophe inside a
 * single-quoted string, as in 'this person's work' — broke the parse of three separate patches'
 * files in one afternoon, and the authors could not see it because each was working in their own
 * subtree while the build was failing in somebody else's.
 *
 * The authority on syntax is the TypeScript compiler. This is the cheap check that runs everywhere,
 * including inside a page render where tsc cannot.
 */
export function scanUnterminatedStrings(src: string): { line: number; detail: string }[] {
  const out: { line: number; detail: string }[] = [];
  const lines = src.split(/\r?\n/);
  let inBlock = false;
  let inTemplate = false;
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n];
    let i = 0;
    let quote: string | null = null;
    while (i < line.length) {
      const c = line[i];
      const c2 = line[i + 1];
      if (inBlock) {
        if (c === '*' && c2 === '/') { inBlock = false; i += 2; continue; }
        i++; continue;
      }
      if (inTemplate) {
        if (c === BACKSLASH) { i += 2; continue; }
        if (c === '`') { inTemplate = false; i++; continue; }
        i++; continue;
      }
      if (quote) {
        if (c === BACKSLASH) { i += 2; continue; }
        if (c === quote) { quote = null; i++; continue; }
        i++; continue;
      }
      if (c === '/' && c2 === '*') { inBlock = true; i += 2; continue; }
      if (c === '/' && c2 === '/') break;
      if (c === '`') { inTemplate = true; i++; continue; }
      if (c === "'" || c === '"') { quote = c; i++; continue; }
      i++;
    }
    if (quote) {
      out.push({
        line: n + 1,
        detail: 'A ' + (quote === "'" ? 'single' : 'double') + '-quoted string opens on this line and '
          + 'does not close. The usual cause is an unescaped apostrophe inside it.',
      });
    }
  }
  return out;
}

// -------------------------------------------------------------------------------------------------
// COLLECTION
// -------------------------------------------------------------------------------------------------

/**
 * The probe functions this module needs, as an interface rather than a hard import.
 *
 * Rule 8 of the build brief: where a dependency may be missing, publish a typed boundary. Patch 19's
 * probe exists today, but it reads the filesystem, and the filesystem is exactly what a serverless
 * bundle does not have. Taking it as a parameter means the page can pass a reader that fails
 * honestly, and the test can pass a fabricated tree, without either of them monkey-patching node:fs.
 */
export interface SourceReader {
  filesUnder(repoRelDir: string): string[];
  read(repoRelPath: string): string | null;
}

/** The reader backed by Patch 19's probe. Server and test only — it needs node:fs. */
export async function nodeSourceReader(): Promise<SourceReader> {
  const probe = await import('@/lib/horizon/probe');
  return {
    filesUnder: (dir) => probe.sourceFilesUnder(dir),
    read: (p) => probe.readSource(p),
  };
}

// -------------------------------------------------------------------------------------------------
// REACH, MATCHED STRICTLY
// -------------------------------------------------------------------------------------------------
//
// PATCH 19'S reachOf() IS NOT USED HERE, AND THE REASON IS THE ONLY REASON THAT WOULD JUSTIFY IT.
//
// src/lib/orphan-detect.ts matches a module by the TAIL of an import specifier — '/types', '/api',
// '/events' — and says so in its own header: "a false 'used' costs nothing, a false 'dead' invites
// somebody to delete working code". For orphan detection that error direction is correct.
//
// For THIS question it is exactly backwards. Under tail matching, src/lib/horizon/intake/types.ts is
// "reached" by all 126 files in this repository that import anything ending in `/types`, and the
// first run of this checker duly reported 16 of 21 patches as reachable when the true number was
// zero. An integration report that over-states reach is the one claim Patch 20 must never make: it
// would tell the reader the system is wired when nobody can open a single screen.
//
// So reach is matched EXACTLY, on the '@/...' form this codebase actually uses, plus the directory
// form for an index file. The error direction is now the safe one — a module reached by some exotic
// relative path is under-reported, which produces a report that says "wire this up" about something
// already wired, rather than one that says "done" about something nobody can open.

const IMPORT_RE =
  /(?:import|export)\s[^;]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

/** Every import specifier in a source file: static, dynamic and require forms. */
export function importSpecifiersOf(src: string): string[] {
  const out: string[] = [];
  IMPORT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = IMPORT_RE.exec(src)) !== null) out.push(m[1] || m[2] || m[3]);
  return out;
}

/** The specifiers that unambiguously mean THIS file, and no other. */
export function exactSpecifiersFor(repoRelPath: string): string[] {
  const noExt = repoRelPath.replace(/\\/g, '/').replace(/\.(tsx?|astro|mjs|js)$/, '');
  const withoutSrc = noExt.replace(/^src\//, '');
  const out = new Set<string>(['@/' + withoutSrc, '/' + withoutSrc, noExt]);
  if (/\/index$/.test(withoutSrc)) out.add('@/' + withoutSrc.replace(/\/index$/, ''));
  return [...out].map((s) => s.toLowerCase());
}

function normaliseSpecifier(s: string): string {
  return s.toLowerCase().replace(/\.(tsx?|js|mjs)$/, '');
}

const HORIZON_ROUTE_HINT = /^src\/pages\/.*(horizon|intelligence)/i;

/**
 * Read the tree and return evidence.
 *
 * `nowIso` is passed in rather than read from the clock, so a test asserts against a fixed value and
 * two runs of the same tree produce the same report.
 */
export function collectEvidence(reader: SourceReader, nowIso: string): Evidence {
  const modules: (Omit<ModuleEvidence, 'surfaceImporters'> & { surfaceImporters: string[] })[] = [];
  const allTables = new Set<string>();
  const parseFailures: { file: string; line: number; detail: string }[] = [];
  const seenFiles = new Set<string>();

  // Every specifier that means a HORIZON file, mapped to the patch that owns it. Built once, then
  // src/pages is scanned once, rather than asking "who imports this" sixty-three times over.
  const specifierOwner = new Map<string, number>();

  for (const entry of INTEGRATION_MAP) {
    const files: string[] = [];
    for (const owned of entry.owns) {
      if (owned.endsWith('.ts') || owned.endsWith('.astro')) {
        if (reader.read(owned) !== null) files.push(owned);
      } else {
        for (const f of reader.filesUnder(owned)) files.push(f);
      }
    }

    const tables = new Set<string>();
    let runtime = false;
    const tests: string[] = [];
    for (const f of files) {
      const src = reader.read(f);
      if (src === null) continue;
      if (/\.test\.tsx?$/.test(f)) tests.push(f);
      for (const t of tablesDeclaredIn(src)) { tables.add(t); allTables.add(t); }
      if (hasRuntimeCode(src)) runtime = true;
      if (!seenFiles.has(f)) {
        seenFiles.add(f);
        for (const p of scanUnterminatedStrings(src)) {
          parseFailures.push({ file: f, line: p.line, detail: p.detail });
        }
      }
    }

    for (const f of files) {
      if (/\.test\.tsx?$/.test(f)) continue;
      for (const spec of exactSpecifiersFor(f)) specifierOwner.set(spec, entry.patch);
    }

    modules.push({
      patch: entry.patch,
      filesPresent: files.sort(),
      declaresTables: [...tables].sort(),
      hasRuntimeCode: runtime,
      surfaceImporters: [],
      testFiles: tests.sort(),
    });
  }

  // ---- ONE PASS OVER src/pages ------------------------------------------------------------------
  const pageFiles = reader.filesUnder('src/pages');
  const importersByPatch = new Map<number, Set<string>>();
  for (const page of pageFiles) {
    const src = reader.read(page);
    if (src === null) continue;
    for (const raw of importSpecifiersOf(src)) {
      const patch = specifierOwner.get(normaliseSpecifier(raw));
      if (patch === undefined) continue;
      if (!importersByPatch.has(patch)) importersByPatch.set(patch, new Set());
      importersByPatch.get(patch)!.add(page);
    }
  }
  for (const m of modules) {
    m.surfaceImporters = [...(importersByPatch.get(m.patch) || [])].sort();
  }

  const horizonRoutes = pageFiles.filter((f) => HORIZON_ROUTE_HINT.test(f));

  return {
    treeReadable: true,
    whyUnreadable: null,
    modules,
    observedTables: [...allTables].sort(),
    horizonRoutes: horizonRoutes.sort(),
    parseFailures,
    collectedAt: nowIso,
  };
}

/**
 * The evidence a caller returns when it could not read the tree at all.
 *
 * Every downstream state becomes `unreadable` and every Definition of Done item becomes null. This
 * is the difference between "twenty-one patches do not exist" and "I could not look", and only one
 * of those is true in a serverless bundle.
 */
export function unreadableEvidence(why: string, nowIso: string): Evidence {
  return {
    treeReadable: false,
    whyUnreadable: why,
    modules: [],
    observedTables: [],
    horizonRoutes: [],
    parseFailures: [],
    collectedAt: nowIso,
  };
}
