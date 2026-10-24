// vitest.config.ts — THE ALIAS THE TESTS HAVE ALWAYS ASSUMED AND NEVER HAD.
//
// tsconfig.json maps "@/*" to "./src/*" and Astro honours it, so every module in this repository
// imports its siblings that way. VITEST DID NOT: there was no config file at all, and Vitest does
// not read tsconfig paths on its own. The result was silent and expensive — fourteen test files
// (assessment, animation, edu-runtime, kernel-content, scene-spec, vod, offline-sync,
// lesson-engine, estimators, vsm and the rest) failed at IMPORT with "Failed to resolve import
// @/lib/kernel", which reports as a failed FILE rather than a failed assertion, so a run could look
// like a handful of broken suites rather than a whole set that never executed at all.
//
// Adding this file makes those suites run again, and lets a new test import a module written in the
// project's own import style — which is every module in src/lib.
//
// NO `import { defineConfig } from 'vitest/config'`, DELIBERATELY. `vitest` is not in package.json
// on this checkout; it is run through npx, so the package is not resolvable FROM THIS FILE and that
// import makes the config itself fail to load — which takes down every suite, including the ones
// that were passing. A plain exported object is the shape Vitest reads either way.
//
// NO ENVIRONMENT, NO SETUP FILE, NO GLOBALS, on purpose. The tests here import
// { describe, it, expect } from 'vitest' explicitly and exercise pure functions. A default that
// changed how they run would be a change nobody asked for. The one exception is testTimeout, and
// the paragraph below is why it had to stop being a default.
import { fileURLToPath } from 'node:url';

// TWO TEST STYLES LIVE HERE, AND VITEST MUST NOT TRY TO RUN BOTH.
//
// Most suites import from 'vitest'. Five import the house shim (src/lib/test-shim.ts), which is a
// tiny synchronous runner that ends in report() and exits non-zero on failure. Run under Vitest a
// shim file fails at collection — it declares no vitest test — so `npm test` reported failures for
// suites that pass perfectly under tsx. A test command that always shows red is a test command
// nobody reads, which is worse than having none.
//
// So: Vitest skips them, and `npm test` runs both runners in turn. The split is by RUNNER, not by
// quality — the shim is right for synchronous pure functions and Vitest is right for anything async,
// because the shim's it() does not await and an async test written against it passes while
// asserting nothing.
// The split is WORKED OUT, not listed. A hand-written list of shim suites was wrong within a minute
// of being written — the real count is around sixty, because most of them declare a small runner
// inline rather than importing src/lib/test-shim.ts, so no single import string identifies them.
// A list would also rot on the next test somebody adds.
//
// So the rule is the honest one: a suite belongs to Vitest if it IMPORTS Vitest. Everything else is
// run by `npm run test:shim` with tsx. Nothing is skipped by this — both halves run in `npm test`.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = fileURLToPath(new URL('./src', import.meta.url));
const ROOT = fileURLToPath(new URL('.', import.meta.url));

function testFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) testFiles(full, out);
    else if (name.endsWith('.test.ts') || name.endsWith('.test.tsx')) out.push(full);
  }
  return out;
}

/** Suites that do NOT import vitest. Collected here so the list can never fall out of date. */
const nonVitest: string[] = [];
try {
  for (const f of testFiles(SRC)) {
    const src = readFileSync(f, 'utf8');
    if (!/from ['"]vitest['"]/.test(src)) {
      nonVitest.push(relative(ROOT, f).split('\\').join('/'));
    }
  }
} catch {
  // A config that cannot scan must not take the whole run down. Vitest then sees every suite and
  // the shim ones fail loudly, which is exactly the previous behaviour and no worse.
}

// THE DEFAULT TIMEOUT WAS 80% SPENT BEFORE ANY LOAD, WHICH IS WHY THE GATE FLAPPED.
//
// Vitest's default testTimeout is 5000ms and there was no config line changing it. Measured on this
// suite with --slowTestThreshold=300, the slowest test that the timeout ACTUALLY GOVERNS is
// src/lib/horizon/record.test.ts "bounds a hanging provider instead of holding the whole record" at
// 4014ms, with mail-engine/test/spool-durability.test.ts "gives every entry to exactly one of three
// racing workers" behind it at 3752ms. Both are async, so both are on the clock. That is 80% of the
// budget spent by a passing test on an idle machine.
//
// GOVERNS is the load-bearing word. src/lib/orphan-detect.test.ts runs for 11708ms — more than twice
// the old ceiling — and has never failed, because it is SYNCHRONOUS: it blocks the event loop, the
// timer never gets a turn, and Vitest cannot interrupt it. So the 5000ms figure was never a real
// bound on the suite's slowest work; it was a bound on its slowest AWAITING work only, and that is
// the half where a busy machine costs time.
//
// What that cost: this suite's own wall clock was observed at 16.49s and at 33.46s on the same
// checkout, a 2.03x spread driven purely by what else the machine was doing. Apply that spread to a
// 4014ms test and it lands at ~8.1s, past the fuse. The two failures seen were exactly that shape —
// src/lib/work-mode.test.ts timing out on a cold `await import('@/data/role-catalog')` as the first
// statement of the test, and neither failure reproducible in isolation (both files alone: 44 passed
// in 1.63s). A gate that is red for reasons unrelated to the code is a gate people re-run until it
// is green, which is how a real failure gets waved through.
//
// 20000ms is 4.98x the measured slowest governed test. That absorbs the observed 2.03x load spread
// with 2.4x still in hand, and it is deliberately NOT a disabled timeout: a genuinely hung await
// still fails this suite inside twenty seconds, and the whole run completes in 16-33s regardless.
// Raise this only against a new measurement, not a new flake.
const TEST_TIMEOUT_MS = 20000;

export default {
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    exclude: ['**/node_modules/**', '**/dist/**', ...nonVitest],
    testTimeout: TEST_TIMEOUT_MS,
  },
};
