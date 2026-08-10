// scripts/run-shim-tests.mjs — run every test suite that is NOT a Vitest suite.
//
// This repository has two test runners. Most suites import from 'vitest'. Around sixty others use a
// small synchronous runner — src/lib/test-shim.ts, or a copy of the same idea declared inline —
// which ends by printing "N passed, M failed" and exiting non-zero on failure. Vitest cannot collect
// those: it sees a file that declares no vitest test and reports the FILE as failed. So `npm test`
// showed fifty-nine red files while every assertion in them passed.
//
// The split is decided the only way that cannot fall out of date: a suite is a Vitest suite if it
// imports Vitest. vitest.config.ts excludes the rest by the same rule, so the two halves are exact
// complements and nothing is skipped by either.
//
// Exit code is the point. One failing shim suite fails the whole command, so `npm test` cannot pass
// while something is broken.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC = join(ROOT, 'src');

function testFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) testFiles(full, out);
    else if (name.endsWith('.test.ts') || name.endsWith('.test.tsx')) out.push(full);
  }
  return out;
}

const suites = testFiles(SRC)
  .filter((f) => !/from ['"]vitest['"]/.test(readFileSync(f, 'utf8')))
  .sort();

if (suites.length === 0) {
  console.log('No shim suites found. Nothing to run.');
  process.exit(0);
}

console.log(`Running ${suites.length} shim suites with tsx\n`);

let passed = 0;
let failedFiles = [];
let totalAssertions = 0;

for (const f of suites) {
  const rel = relative(ROOT, f).split('\\').join('/');
  const r = spawnSync('npx', ['tsx', f], { encoding: 'utf8', shell: process.platform === 'win32' });
  const out = (r.stdout || '') + (r.stderr || '');

  // The shim's own summary line is the source of truth for counts.
  const m = out.match(/(\d+) passed, (\d+) failed/);
  const p = m ? Number(m[1]) : 0;
  const fl = m ? Number(m[2]) : 0;
  totalAssertions += p;

  if (r.status === 0 && fl === 0) {
    passed++;
    console.log(`  ok    ${rel}  (${p})`);
  } else {
    failedFiles.push(rel);
    console.log(`  FAIL  ${rel}  (${p} passed, ${fl} failed)`);
    // Show why, rather than making somebody re-run it by hand to find out.
    const tail = out.trim().split('\n').slice(-12).join('\n');
    console.log(tail.split('\n').map((l) => '        ' + l).join('\n'));
  }
}

console.log(`\n${passed}/${suites.length} shim suites passed, ${totalAssertions} assertions`);
if (failedFiles.length > 0) {
  console.log('failed: ' + failedFiles.join(', '));
  process.exit(1);
}
