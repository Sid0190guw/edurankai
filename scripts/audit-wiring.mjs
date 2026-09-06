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
//
// WHAT IT DELIBERATELY DOES NOT REPORT. A URL built by concatenation (`'/a/b/' + id`) or by template
// interpolation is a dynamic route and is not checked as a literal — the first version of this did
// check them and reported ten findings, every one of them correct code, which is the fastest way to
// make a check unrunnable. Orphan detection ("no page links here") is not here either: this codebase
// links from nav registries and template literals, so the honest answer needs a resolver this file
// does not have, and a wall of false orphans would bury the two faults above.
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

const total = broken.length + wrongMethod.length;
console.log('');
if (total === 0) {
  console.log(green('  Every link, form action and fetch resolves to a route that answers it.'));
} else {
  console.log(red(`  ${broken.length} broken target(s), ${wrongMethod.length} wrong method(s).`));
  console.log(dim('  A control that posts to nothing is a screen that looks finished and does nothing.'));
}
process.exit(total ? 1 : 0);
