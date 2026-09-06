// src/lib/source-scan.ts — read this repository's own source, once.
//
// WHY THIS EXISTS, MEASURED.
//
// Thirteen test files in src/lib walk the source tree and read every file in it, because that is the
// only honest way to assert a repo-wide property: no enqueue() without a handler, no DDL through the
// simple protocol, no bare payment_id selected from payments. The cost of that guarantee is real —
// one full pass over src/ is 2,471 files and 47MB, measured at 3.5s on this machine, of which 3.4s
// is the reading and 0.12s the walking.
//
// Each of those files did its own walk and its own reads, and some did them more than once:
// payments-columns.test.ts read all 2,471 files in its first test and then read all 2,471 again in
// its second. So the suite spent something over 45 seconds of pure IO re-reading the same 47MB, in
// parallel workers competing for the same disk.
//
// That is what made the gate flap. It never showed up as a wrong answer — the scans are correct —
// it showed up as `Test timed out`, on a different file each run depending on what else the machine
// was doing, and a red that moves around is a red people re-run rather than read. vitest.config.ts
// already carries one round of this argument and job-handlers.test.ts carries another; both raised a
// number, because the cost itself had not been looked at.
//
// So: memoise. Within a worker the walk happens once per root and each file is read once, and every
// later caller gets the cached string. Vitest isolates test FILES from each other, so this does not
// share across them — but it does remove every repeat pass inside a file, which is where the
// duplication actually was.
//
// AND IT EXCLUDES WHAT IS NOT SOURCE. `src/pages/aquintutor/labs/` and `src/pages/portal/tools/`
// each contain a `node_modules/` and a `dist/`, left by somebody running a dev server from inside
// them. They are gitignored, so they never reach the repository — but a hand-written walk with no
// exclusions reads them anyway, which is both wasted time and a way for a vendored file to be
// reported as an offender in this codebase's own audit. Two of the scans excluded them and one did
// not; here it is decided once.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The repository root, derived from this file rather than from process.cwd(). */
export const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/**
 * Directory names that are never this project's source.
 *
 * `.astro`, `dist` and `node_modules` appear INSIDE src/pages on a machine where a dev server was
 * started from a subdirectory, so excluding them by name at every level is deliberate and not just
 * a top-level convenience.
 */
const SKIP_DIRS = new Set(['node_modules', 'dist', '.astro', '.git', '.vercel', 'coverage']);

const walkCache = new Map<string, string[]>();
const textCache = new Map<string, string>();

/**
 * Every file under `root`, absolute, with build output and dependencies excluded. Memoised per root.
 *
 * @param root absolute, or relative to the repository root.
 */
export function scanFiles(root = 'src'): string[] {
  const abs = root.startsWith('/') || /^[A-Za-z]:/.test(root) ? root : join(REPO_ROOT, root);
  const cached = walkCache.get(abs);
  if (cached) return cached;

  const out: string[] = [];
  (function walk(dir: string) {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (SKIP_DIRS.has(e.name)) continue;
      const p = join(dir, e.name);
      // A symlink reports neither isDirectory() nor isFile() from a Dirent, so resolve it.
      let isDir = e.isDirectory();
      if (!isDir && !e.isFile()) {
        try { isDir = statSync(p).isDirectory(); } catch { continue; }
      }
      if (isDir) walk(p);
      else out.push(p);
    }
  })(abs);

  out.sort();
  walkCache.set(abs, out);
  return out;
}

/** The same list, filtered — the shape most scans want. Extensions are given without the dot. */
export function scanSources(
  opts: { root?: string; ext?: string[]; includeTests?: boolean } = {},
): string[] {
  const ext = opts.ext ?? ['ts', 'tsx', 'astro', 'js', 'jsx', 'mjs'];
  const extRe = new RegExp('\\.(' + ext.join('|') + ')$');
  return scanFiles(opts.root ?? 'src').filter((f) => {
    if (!extRe.test(f)) return false;
    if (!opts.includeTests && /\.test\.[tj]sx?$/.test(f)) return false;
    return true;
  });
}

/** The file's text, read at most once per process. Unreadable files read as ''. */
export function scanText(file: string): string {
  const cached = textCache.get(file);
  if (cached !== undefined) return cached;
  let text = '';
  try { text = readFileSync(file, 'utf8'); } catch { /* unreadable is empty, not fatal */ }
  textCache.set(file, text);
  return text;
}

/** `[path, text]` for each matching source, with every read memoised. */
export function scanEntries(
  opts: { root?: string; ext?: string[]; includeTests?: boolean } = {},
): Array<[string, string]> {
  return scanSources(opts).map((f) => [f, scanText(f)]);
}

/** Repo-relative, forward-slashed — what a finding should name, on any platform. */
export function repoPath(file: string): string {
  return relative(REPO_ROOT, file).split(sep).join('/');
}
