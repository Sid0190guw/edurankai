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

export default {
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
};
