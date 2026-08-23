// src/lib/orphan-detect.ts — find library modules nothing imports.
//
// WHY THIS IS CODE AND NOT A ONE-OFF SCRIPT. An orphan audit performed by hand is accurate for
// exactly as long as it takes somebody to merge the next branch. Twelve orphaned modules were found
// by a manual sweep; without a gate, the thirteenth arrives silently and the audit has to be redone
// from scratch. This module powers a TEST, so the count can only go down.
//
// WHAT COUNTS AS AN ORPHAN. A file under src/lib that exports something and is imported by nothing
// in src/, scripts/ or mail-engine/. Deliberately narrow:
//
//   - Only src/lib. Pages and API routes are ENTRY POINTS — the framework imports them by
//     convention, so "nothing imports it" is the normal state and would drown the signal.
//   - Test files are excluded as candidates (a test is not a product capability) but DO count as
//     importers, with a caveat below.
//   - A module imported ONLY by its own test is still an orphan, and is reported as such. A tested
//     module nothing uses is the most convincing kind of dead code: it looks maintained.
//
// WHAT THIS DELIBERATELY DOES NOT DO. It does not resolve TypeScript symbols or build a real module
// graph. It matches import specifiers textually, which is coarse and occasionally generous — a
// dynamic `import(someVariable)` is invisible to it. Generous is the right direction: a false
// "this is used" costs nothing, while a false "this is dead" invites somebody to delete working
// code. Anything it flags still needs a human to decide between wire / merge / migrate / remove.

export interface ModuleRef {
  /** Repo-relative, forward slashes: 'src/lib/attendance-lapse.ts'. */
  path: string;
  /** Every specifier that could import it, lower-cased. */
  specifiers: string[];
  hasExports: boolean;
}

export interface OrphanFinding {
  path: string;
  /** Files that import it. Empty for a true orphan. */
  importers: string[];
  /** True when the only importers are that module's own tests. */
  testOnly: boolean;
}

/** Normalise to forward slashes so Windows and CI agree. */
export function normalisePath(p: string): string {
  return p.split('\\').join('/');
}

/**
 * Every import specifier that could reach this module.
 *
 * A module at src/lib/hr/sync.ts is reachable as '@/lib/hr/sync', './sync' from a sibling, '../hr/sync'
 * from a cousin, and with a '.js' extension because mail-engine and NodeNext-style code write it
 * that way. An index file is additionally reachable by its directory name. Missing any of these
 * forms produces a false orphan, which is the expensive direction.
 */
export function specifiersFor(repoRelPath: string): string[] {
  const p = normalisePath(repoRelPath);
  const noExt = p.replace(/\.tsx?$/, '');
  const withoutSrc = noExt.replace(/^src\//, '');
  const base = noExt.split('/').pop() || noExt;

  const out = new Set<string>();
  out.add('@/' + withoutSrc);            // @/lib/foo
  out.add('@/' + withoutSrc + '.js');
  out.add('/' + withoutSrc);             // absolute-ish forms seen in a few places
  out.add(noExt);                        // src/lib/foo, used by scripts
  out.add(noExt + '.js');

  // Relative forms. Matched on the tail, so './foo' and '../../lib/foo' both hit.
  out.add('/' + base);
  out.add('/' + base + '.js');

  if (base === 'index') {
    const dir = noExt.replace(/\/index$/, '');
    const dirNoSrc = dir.replace(/^src\//, '');
    out.add('@/' + dirNoSrc);
    out.add('@/' + dirNoSrc + '.js');
    const dirBase = dir.split('/').pop() || dir;
    out.add('/' + dirBase);
  }
  return [...out].map((x) => x.toLowerCase());
}

const IMPORT_RE = /(?:import|export)\s[^;]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

/** Pull every import specifier out of a source file. Handles static, dynamic and require forms. */
export function importSpecifiers(source: string): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  IMPORT_RE.lastIndex = 0;
  while ((m = IMPORT_RE.exec(source)) !== null) {
    const spec = m[1] || m[2] || m[3];
    if (spec) out.push(spec.toLowerCase());
  }
  return out;
}

/** Does this file export anything at all. A pure side-effect module is not an orphan candidate. */
export function hasExports(source: string): boolean {
  return /^\s*export\s/m.test(source);
}

/**
 * Match an imported specifier against a module's known forms.
 *
 * Relative specifiers are compared on their tail, because './sync' and '../hr/sync' both name the
 * same file from different directories and resolving them properly would mean building the module
 * graph this function is explicitly avoiding.
 */
export function specifierMatches(imported: string, moduleSpecifiers: readonly string[]): boolean {
  const spec = imported.toLowerCase().replace(/\.tsx?$/, '');
  const specJs = spec.replace(/\.js$/, '');
  for (const s of moduleSpecifiers) {
    const bare = s.replace(/\.js$/, '');
    if (spec === s || spec === bare || specJs === bare) return true;
    // Tail match for relative imports: '../../lib/foo' and './foo' both end with '/foo'.
    //
    // THE LEADING SLASH IS THE BOUNDARY, and it is sufficient on its own. An earlier version added a
    // second check on the preceding character to stop '/mail' matching '@/lib/gmail' — but that can
    // never match anyway ('gmail' does not end with '/mail'), and the extra guard rejected the
    // perfectly ordinary '../hr/sync', quietly under-reporting real usage.
    //
    // It remains generous in one direction: a module 'src/lib/mail.ts' is considered used by an
    // import of '@/lib/hr/mail'. That is the safe error — a false "used" costs nothing, a false
    // "dead" invites somebody to delete working code.
    if (bare.startsWith('/') && (specJs.endsWith(bare) || spec.endsWith(bare))) return true;
  }
  return false;
}

/**
 * Work out which modules nothing imports.
 *
 * `files` is every candidate module; `sources` is every file that might import one, keyed by path.
 * Kept pure and injectable so the test can drive it with a fixture and the real scan can drive it
 * with the filesystem.
 */
export function findOrphans(
  modules: readonly ModuleRef[],
  sources: ReadonlyMap<string, string>,
): OrphanFinding[] {
  // Index every source file's imports once. Doing it per module is O(files x modules) string work
  // and turns a two-second test into a two-minute one.
  const importsByFile = new Map<string, string[]>();
  for (const [file, src] of sources) importsByFile.set(file, importSpecifiers(src));

  const findings: OrphanFinding[] = [];
  for (const mod of modules) {
    if (!mod.hasExports) continue;
    const importers: string[] = [];
    for (const [file, specs] of importsByFile) {
      if (normalisePath(file) === normalisePath(mod.path)) continue;   // a file importing itself
      if (specs.some((s) => specifierMatches(s, mod.specifiers))) importers.push(normalisePath(file));
    }
    if (!importers.length) {
      findings.push({ path: normalisePath(mod.path), importers: [], testOnly: false });
      continue;
    }
    // Imported only by its own tests: still dead, and more convincingly so — it looks maintained.
    // A test file is identified by its FILENAME, not by living in a directory called "tests".
    // src/pages/api/tests/ is the assessment product, not a test suite, and treating it as one made
    // three live routes look like test-only importers — which would have marked a module every
    // candidate assessment depends on as dead code.
    const nonTest = importers.filter((f) => !/\.test\.tsx?$/.test(f) && !/^mail-engine\/test\//.test(f));
    if (!nonTest.length) findings.push({ path: normalisePath(mod.path), importers, testOnly: true });
  }
  return findings.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * The gate. `current ⊆ approved`, and nothing else.
 *
 * Note what it does NOT check: that every approved orphan is still an orphan. Wiring one up should
 * not fail the build — it should just make the allowlist shrink at leisure. The asymmetry is
 * deliberate: the gate exists to stop new dead code, not to punish cleanup.
 */
export function orphanGate(
  current: readonly OrphanFinding[],
  approved: readonly string[],
): { ok: boolean; unapproved: OrphanFinding[]; resolved: string[] } {
  const approvedSet = new Set(approved.map(normalisePath));
  const currentSet = new Set(current.map((c) => normalisePath(c.path)));
  const unapproved = current.filter((c) => !approvedSet.has(normalisePath(c.path)));
  const resolved = [...approvedSet].filter((a) => !currentSet.has(a)).sort();
  return { ok: unapproved.length === 0, unapproved, resolved };
}
