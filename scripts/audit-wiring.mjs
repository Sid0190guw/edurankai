#!/usr/bin/env node
// scripts/audit-wiring.mjs — does every control on a page reach something that exists?
//
// WHY THIS EXISTS. /admin/governance/retention rendered a complete screen: a retention policy table
// with a per-class edit row, a confirmed "run the sweep for real" button, an erasure request form,
// and Approve / Refuse / Carry-it-out on every request. Seven controls. All seven POSTed to
// /api/admin/governance/retention and /api/admin/governance/erasure, and NEITHER ROUTE EXISTED. The
// library behind them was written, exported and unit-tested; only the seam was missing. Nothing
// caught it, because nothing on this project ever compared what a page POSTs to against what the
// routes directory contains — the type checker cannot see inside an action="" string, and a unit
// test of the library passes whether or not anything calls it.
//
// So this is the check, as code:
//
//   1. BROKEN TARGET   a link, form action or fetch that resolves to no route at all.
//   2. WRONG METHOD    a form or fetch whose target route does not export the method it uses.
//   3. ORPHAN PAGE     a static page that no source file links to.
//
// Check 3 is the mirror of src/lib/admin-nav-reachable.test.ts, which asserts that every sidebar
// link resolves to a page. Nothing asserted the other direction, and that is the more expensive
// half: a dangling sidebar link is a 404 somebody reports, while a page nothing links to is silent
// and the work in it is simply never used. /admin/recruitment/dashboard was 342 lines answering
// "what is the state of hiring", reachable only by typing the URL, and /admin/horizon/interpretation
// carried a header saying it "exists so the layer is reachable rather than a set of files nobody can
// open" — while being unreachable.
//
// WHAT IT DELIBERATELY DOES NOT REPORT. A URL built by concatenation (`'/a/b/' + id`) or by template
// interpolation is a dynamic route and is not checked as a broken literal — the first version of
// this did check them and reported ten findings, every one of them correct code, which is the
// fastest way to make a check unrunnable. For the same reason check 3 asks only about STATIC pages:
// a [param] route is reached by building a string, the ways to build one are unbounded, and asked
// about them this check named twenty-one pages that were all reachable.
//
//   node scripts/audit-wiring.mjs          report; exit non-zero if anything is broken
//   node scripts/audit-wiring.mjs --list   also print the route table size and the checks run
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PAGES = join(ROOT, 'src', 'pages');
const PUBLIC = join(ROOT, 'public');
const VERBOSE = process.argv.includes('--list');

const tty = process.stdout.isTTY;
const paint = (c, s) => (tty ? `\x1b[${c}m${s}\x1b[0m` : s);
const red = (s) => paint('31', s);
const green = (s) => paint('32', s);
const dim = (s) => paint('2', s);

function walk(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const name of entries) {
    // `dist`, `.astro` and a nested `node_modules` appear under src/pages on a machine where
    // somebody ran a dev server from inside a subdirectory. They are not routes.
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
    const full = join(dir, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const rel = (f) => relative(ROOT, f).split('\\').join('/');

// ------------------------------------------------------------------------------------------------
// THE ROUTE TABLE
// ------------------------------------------------------------------------------------------------
const ROUTE_EXT = new Set(['.astro', '.ts', '.js', '.md']);
const routes = [];          // { path, file, methods:Set|null }  methods null = an .astro page
const staticRoutes = new Map();

for (const file of walk(PAGES)) {
  if (!ROUTE_EXT.has(extname(file))) continue;
  if (/\.test\.[tj]s$/.test(file)) continue;
  let r = relative(PAGES, file).split('\\').join('/').replace(/\.(astro|ts|js|md)$/, '');
  if (r.endsWith('/index')) r = r.slice(0, -'/index'.length);
  if (r === 'index') r = '';
  const path = '/' + r;

  let methods = null;
  if (file.endsWith('.ts') || file.endsWith('.js')) {
    const text = readFileSync(file, 'utf8');
    methods = new Set();
    for (const m of text.matchAll(/export\s+(?:const|async\s+function|function)\s+(GET|POST|PUT|PATCH|DELETE|ALL|OPTIONS|HEAD)\b/g)) {
      methods.add(m[1]);
    }
  } else {
    // An .astro page handles a form POST in its frontmatter rather than by exporting POST.
    const text = readFileSync(file, 'utf8');
    methods = /request\.method\s*===?\s*['"]POST['"]/.test(text) ? new Set(['GET', 'POST']) : new Set(['GET']);
  }
  const entry = { path, file: rel(file), methods };
  routes.push(entry);
  if (!path.includes('[') && !staticRoutes.has(path)) staticRoutes.set(path, entry);
}

const dynamic = routes
  .filter((r) => r.path.includes('['))
  .map((r) => ({
    ...r,
    re: new RegExp('^' + r.path.split('/').filter(Boolean).map((s) =>
      /^\[\.\.\..+\]$/.test(s) ? '(?:/.*)?' : /^\[.+\]$/.test(s) ? '/[^/]+' : '/' + s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    ).join('') + '/?$'),
  }));

const publicFiles = new Set(walk(PUBLIC).map((f) => '/' + relative(PUBLIC, f).split('\\').join('/')));

function resolve(url) {
  const clean = url.split('?')[0].split('#')[0];
  const trimmed = clean.replace(/\/$/, '') || '/';
  if (staticRoutes.has(trimmed)) return staticRoutes.get(trimmed);
  if (publicFiles.has(clean) || publicFiles.has(trimmed)) return { path: trimmed, file: '(public)', methods: null };
  for (const d of dynamic) if (d.re.test(trimmed)) return d;
  return null;
}

// ------------------------------------------------------------------------------------------------
// THE CALLERS
// ------------------------------------------------------------------------------------------------
const SRC = join(ROOT, 'src');
const srcFiles = walk(SRC).filter((f) => /\.(astro|ts|tsx|js|jsx)$/.test(f) && !/\.test\.[tj]sx?$/.test(f));

const broken = [];      // target does not exist
const wrongMethod = [];

// For the orphan check: every route-shaped string this codebase mentions, however it builds it.
// A nav registry stores `{ href: '/admin/x' }`, so an href= scan alone misses it; a link is just as
// often `` `/a/${id}/edit` `` or `'/a/' + id + '/edit'`, so the interpolated forms are collected
// separately with each ${...} collapsed to a wildcard.
// The placeholder a collapsed ${...} leaves behind when an interpolated path is normalised.
//
// DECLARED HERE, ABOVE ITS FIRST USE, because `const` is not hoisted — the house trap that has taken
// this site down before. It was first written below the loop that reads it and the gate died on its
// own first line with "Cannot access 'WILDCARD' before initialization".
//
// Printable, rather than the raw NUL byte it started as: a NUL in a source file makes git treat the
// whole file as binary, and `git diff` on this gate reported "Bin 9736 -> 15326 bytes" instead of
// showing the change.
const WILDCARD = '*';

const literalTargets = new Set();
const interpolated = new Set();

for (const file of srcFiles) {
  const text = readFileSync(file, 'utf8');
  const self = '/' + rel(file);
  for (const m of text.matchAll(/["'`](\/[A-Za-z0-9][^"'`\s>){}]*)["'`]/g)) {
    literalTargets.add(m[1].split('?')[0].split('#')[0].replace(/\/$/, '') || '/');
  }
  for (const m of text.matchAll(/`(\/[A-Za-z0-9][^`]*)`/g)) {
    if (!m[1].includes('${')) continue;
    interpolated.add(m[1].replace(/\$\{[^}]*\}/g, WILDCARD).split('?')[0].split('#')[0].replace(/\/$/, ''));
  }
  for (const m of text.matchAll(/["'](\/[A-Za-z0-9][^"']*)["']\s*\+\s*[^+;)\n]+?(?:\s*\+\s*["']([^"']*)["'])?/g)) {
    const head = m[1].replace(/\/$/, '');
    const tailPart = m[2] ? (m[2].startsWith('/') ? m[2] : '/' + m[2]) : '';
    interpolated.add((head + '/' + WILDCARD + tailPart).split('?')[0].split('#')[0].replace(/\/+/g, '/').replace(/\/$/, ''));
  }
  // A file naming its own path is not a link to itself.
  literalTargets.delete(self);
}

const interpolatedSegs = [...interpolated].map((b) => b.split('/').filter(Boolean));
/** A route matches a built path when the segments line up, [param] and * both being wildcards. */
function matchesInterpolated(routePath) {
  const rs = routePath.split('/').filter(Boolean);
  return interpolatedSegs.some((bs) =>
    bs.length === rs.length && rs.every((seg, i) => /^\[.+\]$/.test(seg) || bs[i] === seg || bs[i] === WILDCARD));
}

/** True when the literal is being concatenated onto — a dynamic URL, not a static one. */
const isConcatenated = (line, endIndex) => line.slice(endIndex).trimStart().startsWith('+');

for (const file of srcFiles) {
  const r = rel(file);
  const text = readFileSync(file, 'utf8');
  const lines = text.split(/\r?\n/);

  lines.forEach((line, i) => {
    // --- links, redirects and plain navigations -------------------------------------------------
    for (const re of [
      /href\s*=\s*["'](\/[^"'\s>]*)["']/g,
      /redirect\s*\(\s*["'](\/[^"'\s)]*)["']/g,
      /location(?:\.href)?\s*=\s*["'](\/[^"'\s;]*)["']/g,
      /location\.(?:assign|replace)\s*\(\s*["'](\/[^"'\s)]*)["']/g,
    ]) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(line))) {
        const url = m[1];
        if (url.startsWith('//') || url.includes('${') || isConcatenated(line, m.index + m[0].length)) continue;
        if (!resolve(url)) broken.push({ r, line: i + 1, url, how: 'link' });
      }
    }

    // --- form actions ---------------------------------------------------------------------------
    const formRe = /<form\b[^>]*>/gi;
    let fm;
    while ((fm = formRe.exec(line))) {
      const tag = fm[0];
      const act = /action\s*=\s*["'](\/[^"']*)["']/.exec(tag);
      if (!act || act[1].includes('${') || act[1].includes('{')) continue;
      const url = act[1];
      const method = (/method\s*=\s*["'](\w+)["']/.exec(tag)?.[1] || 'GET').toUpperCase();
      const target = resolve(url);
      if (!target) { broken.push({ r, line: i + 1, url, how: 'form ' + method }); continue; }
      if (target.methods && !target.methods.has(method) && !target.methods.has('ALL')) {
        wrongMethod.push({ r, line: i + 1, url, method, has: [...target.methods].join(',') || '(none)', file: target.file });
      }
    }

    // --- fetch() --------------------------------------------------------------------------------
    const fetchRe = /fetch\s*\(\s*['"`](\/[^'"`\s)]*)['"`]/g;
    let m;
    while ((m = fetchRe.exec(line))) {
      const url = m[1];
      if (url.includes('${') || isConcatenated(line, m.index + m[0].length)) continue;
      // The options object is usually on this line, sometimes on the next two.
      const scope = [line, lines[i + 1] || '', lines[i + 2] || ''].join(' ');
      const method = (/method\s*:\s*['"](\w+)['"]/.exec(scope)?.[1] || 'GET').toUpperCase();
      const target = resolve(url);
      if (!target) { broken.push({ r, line: i + 1, url, how: 'fetch ' + method }); continue; }
      if (target.methods && !target.methods.has(method) && !target.methods.has('ALL')) {
        wrongMethod.push({ r, line: i + 1, url, method, has: [...target.methods].join(',') || '(none)', file: target.file });
      }
    }
  });
}

// ------------------------------------------------------------------------------------------------
// REPORT
// ------------------------------------------------------------------------------------------------
if (VERBOSE) {
  console.log(dim(`  routes: ${routes.length} (${staticRoutes.size} static, ${dynamic.length} dynamic)`));
  console.log(dim(`  files scanned: ${srcFiles.length}`));
  console.log('');
}

for (const b of broken) {
  console.log(`${red('broken')}  ${b.url}`);
  console.log(dim(`          ${b.r}:${b.line}  (${b.how})  — no route answers this`));
}
for (const w of wrongMethod) {
  console.log(`${red('method')}  ${w.method} ${w.url}`);
  console.log(dim(`          ${w.r}:${w.line}  — ${w.file} exports [${w.has}]`));
}

// ------------------------------------------------------------------------------------------------
// 3. ORPHAN PAGES — built, and reachable by nobody.
//
// src/lib/admin-nav-reachable.test.ts already asserts the other direction: every sidebar link
// resolves to a page. Nothing asserted THIS one, and that is the more expensive gap. A dangling
// sidebar link is a 404 somebody reports; a page with no inbound link is silent, and the work in it
// is simply never used. /admin/recruitment/dashboard was 342 lines answering "what is the state of
// hiring", reachable only by typing the URL. /admin/horizon/interpretation had a header saying it
// "exists so the layer is reachable rather than a set of files nobody can open" — and was not.
//
// A page counts as reachable if ANY source file names it: an href, a nav registry entry, a redirect,
// or a template/concatenation that builds it. That is generous on purpose. This gate is for pages
// nothing mentions at all, which is unambiguous.
//
// THE EXEMPTIONS ARE NAMED, WITH A REASON EACH. An unexplained allowlist is how this defect comes
// back; a reason is the difference between a decision and an oversight.
const NEVER_LINKED = new Map([
  ['/', 'The homepage. It is the entry point, not something linked from one.'],
  ['/404', 'Astro renders it on a miss; nothing links to a 404 on purpose.'],
  ['/i/[slug]', 'Short link opened from outside the product — an invitation email, a QR code.'],
  ['/r/[slug]', 'Short link opened from outside the product, same as /i.'],
  ['/portal/activate', 'A deliberately deprecated legacy page. Its whole body is a redirect to /portal, and its header says account creation is free and this prompt must not gate anyone. Linking it would undo that.'],
  ['/admin/test-payment', 'Fires a REAL Razorpay charge from the browser. It has no PATH_SECTION entry either, so its frontmatter guard is the only thing in front of it. A menu entry is exactly what this must not have.'],
  ['/admin/diag', 'A mobile diagnostic opened by hand while debugging a specific device.'],
  ['/admin/era-editor-demo', 'A component demo, not a product surface.'],
  ['/founder/admin/wellness', 'The founder console is deliberately outside the main admin nav and gated to one account. Not being in a menu is the design.'],
]);

// STATIC PAGES ONLY, and that boundary is the difference between a gate people run and one they
// switch off. A [param] route is reached by BUILDING a URL out of data, and the number of ways to
// build a string is unbounded: `/a/${id}/edit`, `'/a/' + id + '/edit'`, a helper that returns a
// path, a value read from the database. Asked about dynamic routes this check reported twenty-one,
// and the ones spot-checked were all reachable — /aquintutor/interview/[slug]/preflight is opened by
// `'/aquintutor/interview/' + templateSlug + '/preflight?session=' + …`, which is a link by any
// honest reading. Chasing those would mean approximating a resolver, and every approximation shows
// up as a false finding on correct code.
//
// A static page has no such ambiguity: some file names it or no file does. That is the question this
// answers, and it answers it with certainty.
const pageRoutes = routes.filter((r) =>
  !r.path.startsWith('/api/') && !r.file.includes('/api/') && !r.path.includes('['));
const orphans = [];
for (const r of pageRoutes) {
  if (NEVER_LINKED.has(r.path)) continue;
  const p = r.path.replace(/\/$/, '') || '/';
  if (literalTargets.has(p)) continue;
  if (matchesInterpolated(p)) continue;
  orphans.push(r);
}

for (const o of orphans) {
  console.log(`${red('orphan')}  ${o.path}`);
  console.log(dim(`          ${o.file}  — built, and no source file links to it`));
}

const total = broken.length + wrongMethod.length + orphans.length;
console.log('');
if (total === 0) {
  console.log(green('  Every link, form action and fetch resolves to a route that answers it,'));
  console.log(green('  and every page is reachable from somewhere.'));
} else {
  console.log(red(`  ${broken.length} broken target(s), ${wrongMethod.length} wrong method(s).`));
  console.log(dim('  A control that posts to nothing is a screen that looks finished and does nothing.'));
}
process.exit(total ? 1 : 0);
