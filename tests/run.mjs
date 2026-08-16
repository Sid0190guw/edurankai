#!/usr/bin/env node
// tests/run.mjs — runs the suites that need a live stack.
//
//   node tests/run.mjs                     everything
//   node tests/run.mjs --only integration
//   node tests/run.mjs --only security
//   node tests/run.mjs --allow-skip        exit 0 even if suites were skipped
//
// EXIT CODES ARE THE CONTRACT:
//   0  everything ran and passed
//   1  something failed
//   2  something was SKIPPED and --allow-skip was not given
//
// Code 2 exists because a skipped suite is the failure mode this whole layer is built to avoid. In
// CI, a run that cannot reach the stack must not be green. `--allow-skip` is for the local case
// where you are deliberately testing one half of the system.
import { readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarise, colour } from './helpers/harness.mjs';
import { config, looksLikeProduction } from './helpers/config.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
const allowSkip = args.includes('--allow-skip');

// --- the production guard -------------------------------------------------------------------------
// These suites send mail, create campaigns and probe authorization. Against production that is
// somewhere between noisy and harmful. The check is on the resolved target, not on a flag, so
// forgetting to unset TEST_BASE_URL cannot quietly aim a load of test traffic at the live site.
if (looksLikeProduction(config.baseUrl) && process.env.ALLOW_PRODUCTION_TESTS !== 'yes-i-mean-it') {
  console.error(`\n${colour.red('Refusing to run against a non-local target.')}`);
  console.error(`  TEST_BASE_URL is ${config.baseUrl}`);
  console.error('  These suites create campaigns, send messages and probe authorization endpoints.');
  console.error('  If you genuinely mean to run them there:  ALLOW_PRODUCTION_TESTS=yes-i-mean-it\n');
  process.exit(2);
}

const DIRS = only ? [only] : ['integration', 'security'];

const suites = [];
for (const dir of DIRS) {
  let files;
  try {
    files = readdirSync(join(HERE, dir)).filter((f) => f.endsWith('.mjs'));
  } catch {
    console.error(`No such suite directory: tests/${dir}`);
    process.exit(2);
  }
  for (const file of files.sort()) {
    const mod = await import(pathToFileURL(join(HERE, dir, file)).href);
    if (mod.default) suites.push(mod.default);
  }
}

console.log(`\n${colour.bold('EduRankAI Mail — live-stack tests')}`);
console.log(colour.dim(`  target ${config.baseUrl}`));
console.log(colour.dim(`  sink   ${config.sink.apiUrl}`));
console.log(colour.dim(`  ${suites.length} suite(s): ${suites.map((s) => s.name).join(', ')}`));

const results = [];
for (const suite of suites) {
  results.push(...(await suite.run({ config })));
}

process.exit(summarise(results, { allowSkip }));
