// src/lib/horizon/probe.ts — PATCH 19. READ THE REPOSITORY, DO NOT ASK IT.
//
// =================================================================================================
// WHY A STATIC PROBE AND NOT A RUNNING SYSTEM
// =================================================================================================
//
// An integration test that proves flow 8 works by calling attachEvidence() needs a database, and
// this project's working rules forbid opening one — a subagent asked to survey source files opened
// production instead and read staff data out of hr_employees, which is exactly the failure the rule
// now prevents. So the seams that live in SQL are proven the other way: by reading the source that
// declares them. That is weaker than an end-to-end run and it is stated as weaker everywhere it is
// used, rather than dressed up as a passing integration test.
//
// WHAT A STATIC PROBE CAN ACTUALLY PROVE, and it is more than it sounds:
//   - the module named in the contract exists (a renamed file breaks the seam and nothing else says so)
//   - the symbol the seam runs through is still exported (a rename is a silent break at the seam)
//   - somebody imports it (an orphan is a flow that cannot be reached, which is a real failure)
//   - a forbidden import edge is absent (person-360 must never import wellness; that is checkable)
//
// WHAT IT CANNOT PROVE, said plainly so nobody reads a green run as more than it is: that the SQL
// behind a gate returns the right rows, that a migration ran, or that the deployed build contains
// this code. Those need the live surface, and the handoff says so.
//
// =================================================================================================
// NOTHING HERE IS NEW MACHINERY
// =================================================================================================
//
// The reachability primitives already exist in src/lib/orphan-detect.ts and are imported rather than
// rewritten: specifiersFor(), importSpecifiers(), specifierMatches() and normalisePath() are that
// module's, and a second copy of the "which specifiers reach this file" rule is precisely the kind
// of drift this patch exists to catch in other people's code.
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  normalisePath,
  specifiersFor,
  importSpecifiers,
  specifierMatches,
} from '@/lib/orphan-detect';

/** The repository root, resolved from this file rather than from process.cwd(). */
export function repoRoot(): string {
  // src/lib/horizon/probe.ts -> three levels up.
  return resolve(new URL('../../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
}

function abs(repoRelPath: string): string {
  return join(repoRoot(), normalisePath(repoRelPath));
}

export function fileExists(repoRelPath: string): boolean {
  try {
    return existsSync(abs(repoRelPath)) && statSync(abs(repoRelPath)).isFile();
  } catch {
    return false;
  }
}

/** The file's text, or null when it cannot be read. Null is never treated as "empty". */
export function readSource(repoRelPath: string): string | null {
  try {
    return readFileSync(abs(repoRelPath), 'utf8');
  } catch {
    return null;
  }
}

/**
 * Does this module still export this symbol?
 *
 * Deliberately textual. A rename is what breaks a seam, and a rename changes the text. It accepts
 * every export form this codebase actually uses — `export function x`, `export const x`,
 * `export async function x`, `export interface x`, `export type x` and a named re-export list.
 */
export function exportsSymbol(repoRelPath: string, symbol: string): boolean {
  const src = readSource(repoRelPath);
  if (!src) return false;
  const s = symbol.replace(/[^A-Za-z0-9_$]/g, '');
  if (!s) return false;
  const direct = new RegExp(
    '^export\\s+(?:declare\\s+)?(?:async\\s+)?(?:function|const|let|var|class|interface|type|enum)\\s+' + s + '\\b',
    'm',
  );
  if (direct.test(src)) return true;
  // `export { a, b as c }` — the symbol may be either side of an `as`.
  const listRe = /^export\s*\{([^}]*)\}/gm;
  let m: RegExpExecArray | null;
  while ((m = listRe.exec(src)) !== null) {
    const names = m[1]
      .split(',')
      .map((part) => part.trim().split(/\s+as\s+/).map((x) => x.trim()))
      .flat();
    if (names.includes(s)) return true;
  }
  return false;
}

const SOURCE_EXT = /\.(ts|tsx|astro|mjs|js)$/;
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.astro', '.vercel', 'downloads']);

/** Every source file under a repo-relative directory, repo-relative and forward-slashed. */
export function sourceFilesUnder(repoRelDir: string): string[] {
  const out: string[] = [];
  const root = repoRoot();
  const walk = (dirAbs: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dirAbs);
    } catch {
      return;
    }
    for (const name of entries) {
      if (SKIP_DIRS.has(name)) continue;
      const full = join(dirAbs, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(full);
      else if (SOURCE_EXT.test(name)) out.push(normalisePath(full.slice(root.length + 1)));
    }
  };
  walk(join(root, normalisePath(repoRelDir)));
  return out;
}

let _srcCache: Map<string, string> | null = null;

/**
 * Every file under src/, read once per process.
 *
 * Cached because four suites in this directory each want the whole tree and reading ~1800 files four
 * times turns a fast suite into a slow one, which is how a suite stops being run.
 */
export function srcTree(): ReadonlyMap<string, string> {
  if (_srcCache) return _srcCache;
  const map = new Map<string, string>();
  for (const f of sourceFilesUnder('src')) {
    const src = readSource(f);
    if (src !== null) map.set(f, src);
  }
  _srcCache = map;
  return map;
}

export interface Reach {
  /** Every file that imports the module, repo-relative. */
  importers: string[];
  /** Importers that are not the module's own test files. */
  nonTestImporters: string[];
  /** A page or an API route imports it, directly. The only kind of reach a person can open. */
  surfaceImporters: string[];
}

/**
 * WHO IMPORTS THIS MODULE, split three ways.
 *
 * The three-way split is the point. `importers` answers "is this dead"; `nonTestImporters` answers
 * "is it alive outside its own suite"; `surfaceImporters` answers the question this project actually
 * cares about — can a person open a screen that runs it. A module imported only by other library
 * modules that are themselves orphans passes the first two tests and is still unreachable.
 *
 * DIRECT IMPORTERS ONLY: the transitive closure is not walked. A module reached through two hops of
 * library code counts as having no surface importer here, which under-reports reach. That direction
 * is deliberate — this is a report about wiring somebody should look at, and over-reporting reach
 * would let a genuinely unopenable flow read as fine.
 */
export function reachOf(moduleRelPath: string): Reach {
  const specs = specifiersFor(moduleRelPath);
  const self = normalisePath(moduleRelPath);
  const importers: string[] = [];
  for (const [file, src] of srcTree()) {
    if (normalisePath(file) === self) continue;
    if (importSpecifiers(src).some((s) => specifierMatches(s, specs))) importers.push(normalisePath(file));
  }
  const nonTestImporters = importers.filter((f) => !/\.test\.tsx?$/.test(f));
  const surfaceImporters = nonTestImporters.filter((f) => f.startsWith('src/pages/'));
  return { importers: importers.sort(), nonTestImporters: nonTestImporters.sort(), surfaceImporters: surfaceImporters.sort() };
}

/**
 * Does `fromPath` import anything matching `forbiddenModuleRelPath`?
 *
 * Used for the refusals this system enforces by ABSENCE — src/lib/person-360.ts must never import
 * src/lib/wellness.ts, and a comment saying so is not a test. This turns the comment into one.
 */
export function importsModule(fromPath: string, targetModuleRelPath: string): boolean {
  const src = readSource(fromPath);
  if (!src) return false;
  const specs = specifiersFor(targetModuleRelPath);
  return importSpecifiers(src).some((s) => specifierMatches(s, specs));
}

/**
 * Every occurrence of a pattern in a file, with line numbers, so a failure message can point at the
 * line rather than at the file. A finding a reader has to grep for twice is a finding they skip.
 */
export function findLines(repoRelPath: string, re: RegExp): { line: number; text: string }[] {
  const src = readSource(repoRelPath);
  if (!src) return [];
  const out: { line: number; text: string }[] = [];
  const lines = src.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) out.push({ line: i + 1, text: lines[i].trim() });
    re.lastIndex = 0;
  }
  return out;
}
