#!/usr/bin/env node
// scripts/mail-env-check.mjs — validate an environment against the contract in src/lib/mailops/env.ts.
//
// ONE VALIDATOR, THREE CALLERS: this script (a person, before starting anything),
// /api/health/ready (a deployment gate), and CI. They share src/lib/mailops/env.ts, so a rule added
// in one place is enforced in all three. A checklist in a README is not a third caller — it is a
// document that goes stale.
//
//   node scripts/mail-env-check.mjs                    check the current process environment
//   node scripts/mail-env-check.mjs --file .env.local  check a file WITHOUT loading it
//   node scripts/mail-env-check.mjs --quiet            exit code only, for scripts
//
// IT NEVER PRINTS A VALUE, and it never `source`s the file. Parsing rather than sourcing matters:
// `source .env` on a value containing `$(...)` executes it, and a validator that can be made to run
// arbitrary code by the file it is validating is a worse problem than the one it solves.
//
// EXIT CODES:  0 = no errors (warnings may exist)   1 = at least one error   2 = could not run
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const valueOf = (f, d) => { const i = argv.indexOf(f); return i !== -1 && argv[i + 1] ? argv[i + 1] : d; };

const QUIET = has('--quiet');
const FILE = has('--file') ? valueOf('--file') : null;

const tty = process.stdout.isTTY && !QUIET;
const paint = (code, s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const red = (s) => paint('31', s);
const yellow = (s) => paint('33', s);
const green = (s) => paint('32', s);
const dim = (s) => paint('2', s);

/**
 * Parse a dotenv file. Deliberately minimal and deliberately not `dotenv`:
 *   - it must not expand `${...}` (that would resolve a placeholder into something that looks set)
 *   - it must not execute anything
 *   - it must not mutate process.env — the caller asked to CHECK a file, not to load it
 */
function parseEnvFile(path) {
  const out = {};
  const text = readFileSync(path, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    // Strip one layer of matching quotes; keep everything inside verbatim.
    if ((value.startsWith('"') && value.endsWith('"') && value.length > 1) || (value.startsWith("'") && value.endsWith("'") && value.length > 1)) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

async function loadChecker() {
  // The contract lives in TypeScript next to the code that uses it. Node cannot import .ts
  // directly on every supported version, so try the native type-stripping path first and fall back
  // to tsx, which this repository already depends on.
  const specifier = pathToFileURL(resolve(HERE, '../src/lib/mailops/env.ts')).href;
  try {
    return await import(specifier);
  } catch (e) {
    try {
      const { register } = await import('tsx/esm/api');
      const unregister = register();
      const mod = await import(specifier);
      unregister();
      return mod;
    } catch (e2) {
      console.error(red('Could not load src/lib/mailops/env.ts.'));
      console.error(dim(`  native import: ${e?.message}`));
      console.error(dim(`  via tsx:       ${e2?.message}`));
      console.error('  Try:  npx tsx scripts/mail-env-check.mjs');
      process.exit(2);
    }
  }
}

const { checkEnv } = await loadChecker();

let env;
let source;
if (FILE) {
  try {
    env = parseEnvFile(FILE);
    source = FILE;
  } catch (e) {
    console.error(red(`Cannot read ${FILE}: ${e.message}`));
    console.error('  cp .env.example .env.local   then fill it in.');
    process.exit(2);
  }
} else {
  env = process.env;
  source = 'the current process environment';
}

const report = checkEnv(env);

if (!QUIET) {
  console.log('');
  console.log(`Environment check — ${dim(source)}`);
  console.log('');

  if (report.errors.length) {
    console.log(red(`${report.errors.length} error${report.errors.length === 1 ? '' : 's'} — these break a shipped surface right now`));
    for (const e of report.errors) console.log(`  ${red('x')} ${e}`);
    console.log('');
  }

  if (report.warnings.length) {
    console.log(yellow(`${report.warnings.length} warning${report.warnings.length === 1 ? '' : 's'}`));
    for (const w of report.warnings) console.log(`  ${yellow('!')} ${w}`);
    console.log('');
  }

  // The set view. Names and booleans only — never a value. Grouped by tier so "this is not deployed
  // here" reads differently from "this is missing".
  const tiers = { live: 'read by shipped code', stack: 'read by the Docker mail stack', future: 'reserved, nothing reads it yet' };
  for (const [tier, label] of Object.entries(tiers)) {
    const vars = report.vars.filter((v) => v.tier === tier);
    if (!vars.length) continue;
    const set = vars.filter((v) => v.present).length;
    console.log(`${tier.padEnd(7)} ${dim(label)}  ${set}/${vars.length} set`);
    for (const v of vars) {
      console.log(`  ${v.present ? green('set') : dim('---')}  ${v.name}`);
    }
    console.log('');
  }

  if (report.ok && !report.warnings.length) console.log(green('No problems found.'));
  else if (report.ok) console.log(green('No errors.') + dim(' Warnings above are worth reading — most of them are silent fallbacks.'));
  console.log('');
}

process.exit(report.ok ? 0 : 1);
