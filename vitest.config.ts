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
// NOTHING ELSE IS CONFIGURED, on purpose. No environment, no setup file, no globals: the tests here
// import { describe, it, expect } from 'vitest' explicitly and exercise pure functions. A default
// that changed how they run would be a change nobody asked for.
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

export default {
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    exclude: ['**/node_modules/**', '**/dist/**', ...nonVitest],
  },
};
