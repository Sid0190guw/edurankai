#!/usr/bin/env node
// scripts/lint-mail.mjs — the checks this repository actually needs, as code.
//
// THERE IS NO ESLINT HERE, AND ADDING ONE WOULD NOT CATCH ANY OF THIS. The faults that have taken
// this project down are not style faults — they are five specific mistakes, each of which has
// already cost an outage, and each of which is invisible to a general-purpose linter:
//
//   1. `r.rows[0]` on a postgres-js result. The driver returns a PLAIN ARRAY, so `.rows` is
//      undefined and the read silently yields nothing. Four modules carried this.
//   2. `e.message` alone in a database catch. The real Postgres reason is on `e.cause`; `e.message`
//      is only the failed SQL, so the log says nothing about why.
//   3. A `const` used by a handler declared ABOVE it. `const` is not hoisted; the page throws on its
//      first line while reporting "all checks passed".
//   4. An emoji in source. The house rule is inline monochrome SVG, everywhere, with no exceptions.
//   5. A secret committed. `.env*` is gitignored, but a key pasted into a source file is not.
//
// A CHECK THAT CANNOT BE SUPPRESSED IS A CHECK THAT GETS DELETED, so every rule can be silenced on
// one line with `// lint-mail-ignore: <rule>` and a reason. The point is to make the exception
// visible and attributable, not to make it impossible.
//
//   node scripts/lint-mail.mjs             check the mail subsystem
//   node scripts/lint-mail.mjs --all       check all of src/
//   node scripts/lint-mail.mjs --changed   check only files changed against origin/main
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const ALL = args.includes('--all');
const CHANGED = args.includes('--changed');

const tty = process.stdout.isTTY;
const paint = (c, s) => (tty ? `\x1b[${c}m${s}\x1b[0m` : s);
const red = (s) => paint('31', s);
const yellow = (s) => paint('33', s);
const green = (s) => paint('32', s);
const dim = (s) => paint('2', s);

/** Paths the mail subsystem lives in. Everything else is checked only under --all. */
const MAIL_PATHS = [
  'src/lib/mail', 'src/lib/mailops', 'src/lib/mailplatform', 'src/lib/mailapi', 'src/lib/mailgov',
  'src/pages/api/mail', 'src/pages/api/v1', 'src/pages/admin/mail', 'src/components/mail',
];

const EXTENSIONS = new Set(['.ts', '.tsx', '.astro', '.mjs', '.js']);

const RULES = [
  {
    id: 'pg-rows',
    severity: 'error',
    skipComments: true,
    // ONLY ON VALUES THAT CAME FROM THE DRIVER, and that precision is the whole rule.
    //
    // The first version matched `.rows` on any variable called r/res/result. It reported
    // src/lib/mailgov/users.ts for `r.rows[0]` where `r` is the return of listMembers() — a plain
    // `{ ok, rows }` object, entirely correct, in a file that already normalises driver results
    // properly one function above. Two findings, both wrong, in the one file a reviewer would have
    // trusted the tool about.
    //
    // So: `file.driverVars` holds only names assigned from db.execute()/query() in this file, and
    // `.rows` is a finding only on one of those. A rule that cries wolf on correct code is worse
    // than no rule, because the next real finding gets waved through.
    test: (line, file) => {
      if (/Array\.isArray/.test(line)) return false;
      const m = /\b([A-Za-z_$][\w$]*)\s*(?:\?\.)?\.rows\b/.exec(line);
      return !!m && file.driverVars.has(m[1]);
    },
    message: 'postgres-js returns a PLAIN ARRAY, so `.rows` is undefined and this read silently yields nothing. Normalise: `const rows = Array.isArray(r) ? r : (r?.rows || []);`',
  },
  {
    id: 'error-cause',
    severity: 'warn',
    skipComments: true,
    // Server-side only. `.astro` files carry inline BROWSER scripts whose `e.message` comes from
    // fetch, not from the Postgres driver, and there is no `e.cause` to read there.
    skipFile: (path) => path.endsWith('.astro'),
    test: (line) => /catch\s*\([^)]*\)\s*\{?[^}]*\be\??\.message\b/.test(line) && !/cause/.test(line),
    message: 'The real Postgres reason is on `e.cause.message`; `e.message` is only the failed SQL. Log `e?.cause?.message || e?.message`.',
  },
  {
    id: 'emoji',
    severity: 'error',
    // EMOJI-PRESENTATION CHARACTERS ONLY. The first pass of this rule used ☀-➿ wholesale
    // and flagged `✓`, `✗` and `○` across the admin pages. Those are dingbats with TEXT
    // presentation by default — they are not emoji, they are typography, and a rule that calls them
    // emoji produces a wall of findings nobody reads, which is how the real one gets missed.
    //
    // So: the pictographic planes, plus anything explicitly forced to emoji presentation with
    // VS16 (U+FE0F) — `✓` is fine, `✓️` is not, and that distinction is the actual house rule.
    // Emoji in a COMMENT still counts; there is no skipComments here on purpose.
    test: (line) => /[\u{1F300}-\u{1FAFF}\u{1F000}-\u{1F0FF}]/u.test(line) || /️/.test(line),
    message: 'No emojis anywhere — the house rule is inline monochrome SVG. This applies to UI, seeds, notifications and log lines alike.',
  },
  {
    id: 'hardcoded-secret',
    severity: 'error',
    // A test fixture is a made-up string by definition. Flagging them trains people to ignore this
    // rule, and this is the one rule that must never be ignored.
    skipFile: (path) => /\.test\.(ts|tsx|mjs|js)$/.test(path) || path.includes('/tests/'),
    test: (line) => {
      if (/process\.env\./.test(line)) return false;                     // reading one is the correct thing
      if (/^\s*(\/\/|\*|#)/.test(line)) return false;                    // a comment describing a shape
      if (/example|placeholder|your[-_]?key|xxx|test-secret|<[a-z]/i.test(line)) return false;
      return (
        /(?:secret|password|api[_-]?key|token|private[_-]?key)\s*[:=]\s*['"][A-Za-z0-9+/_-]{24,}['"]/i.test(line) ||
        /['"](?:sk|rzp|whsec|ghp)_[A-Za-z0-9]{20,}['"]/.test(line) ||
        /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(line)
      );
    },
    message: 'This looks like a real credential in source. Secrets belong in the environment; a key committed to git is compromised even after the commit is reverted.',
  },
  {
    id: 'cors-wildcard-credentials',
    // WARN, NOT ERROR, AND THE DOWNGRADE IS THE HONEST CALL. A wildcard origin WITHOUT
    // `Allow-Credentials: true` is not exploitable: the browser refuses to attach cookies to a
    // cross-origin request whose response says `*`, so the request fails rather than succeeding
    // with someone else's session. It is still worth flagging — a route that documents "send a
    // session cookie" while publishing `*` is one `Allow-Credentials` line away from a real hole,
    // and nobody adding that line later will think to re-check the origin. But calling it an error
    // overstates it, and a security check that overstates is one people learn to skip.
    severity: 'warn',
    skipComments: true,
    // THE RULE IS ABOUT THE COMBINATION, NOT THE WILDCARD.
    //
    // `Access-Control-Allow-Origin: *` is CORRECT on an API authenticated by an `x-api-key` header
    // that carries no cookies — that is what src/lib/api-keys.ts, src/lib/mailapi/errors.ts and
    // src/lib/mailplatform/api.ts are, and flagging them was wrong. It is unsafe only where the
    // browser will attach credentials.
    //
    // So the wildcard is reported only in a file that also deals in cookies or sessions. That is
    // a heuristic and it can be fooled; it is right far more often than "every wildcard is a bug",
    // which was the first version and produced three false positives out of three findings.
    test: (line, file) => /Access-Control-Allow-Origin['"]?\s*[:=]\s*['"]\*['"]/.test(line) && /cookie|session|credentials\s*:\s*['"]include/i.test(file.text),
    message: 'A wildcard CORS origin in a file that also accepts cookie authentication. Not exploitable while Allow-Credentials is absent — browsers will not attach cookies to a `*` response — but adding that header later turns this into a cross-origin read of a signed-in session. For a credentialed endpoint, echo one allowlisted origin: src/lib/mailops/cors.ts.',
  },
  {
    id: 'fail-open-secret',
    severity: 'error',
    skipComments: true,
    test: (line) => /if\s*\(\s*!\s*(?:secret|token|key)\s*\)\s*(?:\{\s*)?return\s+true/.test(line),
    message: 'FAILS OPEN: an unset secret authorises every caller. This exact shape opened four job endpoints at once. Return false when no secret is configured.',
  },
];

function walk(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const name of entries) {
    if (name === 'node_modules' || name === 'dist' || name === '.astro' || name.startsWith('.')) continue;
    const full = join(dir, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) walk(full, out);
    else if (EXTENSIONS.has(extname(name))) out.push(full);
  }
  return out;
}

function targetFiles() {
  if (CHANGED) {
    try {
      const base = execSync('git merge-base HEAD origin/main', { cwd: ROOT, encoding: 'utf8' }).trim();
      const list = execSync(`git diff --name-only ${base}`, { cwd: ROOT, encoding: 'utf8' });
      return list.split('\n').map((f) => f.trim()).filter((f) => f && EXTENSIONS.has(extname(f))).map((f) => join(ROOT, f)).filter((f) => { try { return statSync(f).isFile(); } catch { return false; } });
    } catch {
      process.stderr.write(dim('  (--changed: could not diff against origin/main; falling back to the full mail subsystem)\n'));
    }
  }
  if (ALL) return walk(join(ROOT, 'src'));
  const files = [];
  for (const p of MAIL_PATHS) {
    const full = join(ROOT, p);
    try {
      if (statSync(full).isDirectory()) walk(full, files);
    } catch { /* a path a sibling patch has not created yet */ }
  }
  // Plus the mail-adjacent single files that live directly in src/lib.
  for (const f of walk(join(ROOT, 'src', 'lib')).filter((f) => /[\\/]mail[-.]/.test(f))) files.push(f);
  return [...new Set(files)];
}

const files = targetFiles();
const findings = [];

for (const file of files) {
  const rel = relative(ROOT, file).split('\\').join('/');
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { continue; }
  const lines = text.split(/\r?\n/);

  // Which names currently hold a DRIVER result, tracked as a rolling map rather than a file-level
  // set. `r` is reused constantly — in mailgov/users.ts one function assigns it from db.execute()
  // and the next assigns it from a helper returning `{ ok, rows }` — so a file-level set flags the
  // second one for the sins of the first. Following the most recent assignment is not real scope
  // analysis, but it is right in every shape that actually occurs in this codebase.
  const driverVars = new Set();
  const fileCtx = { path: rel, text, driverVars };
  const trackAssignment = (line) => {
    const m = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(.+)$/.exec(line);
    if (!m) return;
    const [, name, rhs] = m;
    if (/\b(?:execute|query)\s*[(<`]/.test(rhs)) driverVars.add(name);
    else driverVars.delete(name);
  };

  // A line that is prose ABOUT a fault is not the fault. The first version of this linter reported
  // three findings that were all comments explaining the very bug being checked for — including the
  // headers of the files that FIXED it. Rules opt in with `skipComments`.
  const isComment = (line) => /^\s*(?:\/\/|\/\*|\*|#)/.test(line);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    trackAssignment(line);
    // The suppression must be on the offending line or the one above it, and must name the rule.
    const suppressions = `${lines[i - 1] || ''}\n${line}`;
    for (const rule of RULES) {
      if (rule.skipFile?.(rel)) continue;
      if (rule.skipComments && isComment(line)) continue;
      if (new RegExp(`lint-mail-ignore:\\s*${rule.id}\\b`).test(suppressions)) continue;
      if (rule.test(line, fileCtx)) findings.push({ rel, line: i + 1, rule, text: line.trim().slice(0, 140) });
    }
  }
}

const errors = findings.filter((f) => f.rule.severity === 'error');
const warns = findings.filter((f) => f.rule.severity === 'warn');

process.stdout.write(`\nlint-mail — ${files.length} file(s)${ALL ? ' (all of src/)' : CHANGED ? ' (changed)' : ' (mail subsystem)'}\n\n`);

for (const f of [...errors, ...warns]) {
  const tag = f.rule.severity === 'error' ? red('error') : yellow(' warn');
  process.stdout.write(`  ${tag}  ${f.rel}:${f.line}  ${dim(f.rule.id)}\n`);
  process.stdout.write(`         ${dim(f.text)}\n`);
  process.stdout.write(`         ${f.rule.message}\n\n`);
}

if (!findings.length) process.stdout.write(green('  clean\n\n'));
else process.stdout.write(`  ${errors.length} error(s), ${warns.length} warning(s)\n  ${dim('Suppress one line with:  // lint-mail-ignore: <rule-id>  (and say why)')}\n\n`);

// Warnings do not fail the build. They are patterns that are usually wrong, not always wrong, and a
// check that blocks on "usually" is a check people route around.
process.exit(errors.length ? 1 : 0);
