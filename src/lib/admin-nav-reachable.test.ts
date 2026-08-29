// src/lib/admin-nav-reachable.test.ts — run: npx tsx src/lib/admin-nav-reachable.test.ts
//
// EVERY LINK IN THE ADMIN SIDEBAR MUST RESOLVE TO A ROUTE THAT EXISTS.
//
// This is a source-level gate, not a behavioural one. It reads ADMIN_NAV and asks the file system
// the same question Astro's router asks: is there a file under src/pages that this path resolves to.
//
// WHY IT EXISTS. On 2026-08-29 "HR intelligence" in the sidebar pointed at /admin/hr/intelligence,
// a directory whose only file was [employeeId].astro. There was no index, so the link 404ed on the
// live site — and had done since the feature shipped. Nothing caught it: the page it links to is
// behind an admin session, so a build is green, a type-check is green, and the only way to find it
// is to be logged in and click the link. Two more paths inside the feature led to the same missing
// page, including the sentence that tells an operator to "go back to the people list".
//
// A missing page is the cheapest possible defect to detect and one of the more expensive to ship: a
// sidebar entry is a promise that something is there, and an operator who finds a 404 behind it has
// no way to tell a broken link from a feature that was taken away.
//
// WHAT COUNTS AS RESOLVING. The same rules Astro uses, and no more:
//   /a/b       -> src/pages/a/b.astro | .ts | .js | .md | .mdx
//   /a/b       -> src/pages/a/b/index.astro | index.ts | index.js
//   any segment may be matched by a [param] file or directory
//   a [...rest] file absorbs that segment and every one after it
//
// WHAT IT DELIBERATELY DOES NOT CHECK. Whether the page renders, whether the viewer may open it, or
// whether a [param] route accepts the specific value in the href — /admin/analytics/domains/executive
// resolves through [domain].astro, and whether 'executive' is a real domain is that page's business.
// This gate answers one question, and answers it with certainty.
//
// IT DOES NOT ASSERT THAT TWO ENTRIES NEVER SHARE A PATH OR AN ID, and that is on purpose.
// /admin/hr/bgv is cross-listed under recruitment and under HR with different labels, and the two
// 'visvambhara-access' entries share an id under a comment saying so and calling the collapse a
// product decision rather than a permissions one. Both are choices somebody made; neither is a
// broken link, and a gate that fails on them would be a gate people learn to ignore.
//
// IF THIS FAILS, there are exactly two honest fixes: build the page, or remove the link. An
// allowlist here would be the third, and it is the one that recreates the defect.
import { readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADMIN_NAV, flattenNav } from './admin-nav';

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, extra?: unknown) => {
  console.log((c ? '  ok  ' : 'FAIL  ') + n + (extra != null ? '  ' + JSON.stringify(extra) : ''));
  c ? pass++ : fail++;
};

const PAGES = join(fileURLToPath(new URL('../..', import.meta.url)), 'src', 'pages');

const PAGE_EXT = ['.astro', '.ts', '.js', '.md', '.mdx'];
const isRest = (name: string) => /^\[\.\.\..+\]$/.test(name);
const isParam = (name: string) => /^\[[^.\]]+\]$/.test(name);

/** The basename with any route extension stripped. Leaves a directory name untouched. */
function stem(name: string): string {
  for (const ext of PAGE_EXT) if (name.endsWith(ext)) return name.slice(0, -ext.length);
  return name;
}

function isDir(p: string): boolean {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

function hasIndex(dir: string): boolean {
  return PAGE_EXT.some((ext) => existsSync(join(dir, 'index' + ext)));
}

/**
 * Does `segments` resolve to a route file under `dir`?
 *
 * Recursive, and tries EVERY candidate at each level rather than the first one that looks right: a
 * literal directory and a [param] directory can both exist beside each other, and only one of them
 * may contain the rest of the path.
 */
function resolves(dir: string, segments: string[]): boolean {
  if (!isDir(dir)) return false;
  if (segments.length === 0) return hasIndex(dir);

  const [head, ...rest] = segments;
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return false; }

  for (const entry of entries) {
    const full = join(dir, entry);
    const name = stem(entry);
    const directory = isDir(full);

    // A catch-all file absorbs this segment and everything after it, whatever they are.
    if (!directory && isRest(name) && PAGE_EXT.some((ext) => entry.endsWith(ext))) return true;

    const matchesHere = name === head || isParam(name);
    if (!matchesHere) continue;

    if (rest.length === 0) {
      if (!directory && PAGE_EXT.some((ext) => entry.endsWith(ext))) return true;
      if (directory && hasIndex(full)) return true;
      continue;
    }
    if (directory && resolves(full, rest)) return true;
  }
  return false;
}

function main() {
  console.log('\n== every ADMIN_NAV href resolves to a file under src/pages ==');

  ok('src/pages is where this test thinks it is', isDir(PAGES), PAGES);

  const items = flattenNav(ADMIN_NAV);
  ok('the navigation is not empty', items.length > 0, items.length);

  const external = items.filter((i) => !String(i.href || '').startsWith('/'));
  ok('every href is a site-relative path', external.length === 0, external.map((i) => i.id + ' -> ' + i.href));

  const broken: { id: string; href: string }[] = [];

  for (const item of items) {
    const href = String(item.href || '');
    if (!href.startsWith('/')) continue;

    const path = href.split('?')[0].split('#')[0].replace(/\/+$/, '');
    const segments = path.split('/').filter(Boolean);

    if (!resolves(PAGES, segments)) broken.push({ id: String(item.id), href });
  }

  // ONE ASSERTION, LISTING ALL OF THEM. A per-link assertion would put two hundred lines of green in
  // front of the one line that matters, and a second broken link would be invisible behind the first.
  ok(
    'no sidebar link points at a route that does not exist',
    broken.length === 0,
    broken.map((b) => b.id + ' -> ' + b.href),
  );

  // The one this test was written for, named so a regression is unmistakable rather than buried in
  // the list above.
  ok('/admin/hr/intelligence has an index, not only [employeeId]', resolves(PAGES, ['admin', 'hr', 'intelligence']));

  // The matcher itself, checked against paths whose answers are known. A gate that silently answers
  // "yes" to everything passes forever and protects nothing.
  console.log('\n== the resolver answers no when it should ==');
  ok('a path with no file anywhere does not resolve', !resolves(PAGES, ['admin', 'definitely-not-a-page-xyz']));
  ok('a directory with no index does not resolve on its own', !resolves(PAGES, ['admin', 'hr', 'intelligence', 'nope', 'deeper']));
  ok('a real page resolves', resolves(PAGES, ['admin', 'hr', 'wallet']));
  ok('a [param] route resolves for any value', resolves(PAGES, ['admin', 'analytics', 'domains', 'executive']));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}

main();
