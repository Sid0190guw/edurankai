// Every page under /aquintutor that writes to the database must decide who may write.
//
// =================================================================================================
// THE ONE THIS WAS WRITTEN FOR
// =================================================================================================
//
// /aquintutor/labs/train is an LLM fine-tuning console — base model, dataset URL, custom weights
// URL, hyperparameters. It sits in the public labs namespace where every other page is a
// learner-facing laboratory, nothing links to it, and it answered HTTP 200 to anybody.
//
// Its first line read `const user = Astro.locals.user` and then never consulted it. The POST handler
// inserted into training_jobs with `user_id = ${user?.id || null}` — the null branch is the tell: an
// anonymous writer was expected to work, and did.
//
// Nothing consumes training_jobs, so no dataset was ever fetched and nothing executed. What a
// stranger could do was insert unbounded rows carrying chosen job names and URLs into a production
// table, and those rows render on the AquinTutor admin dashboard.
//
// A page reading `locals.user` looks gated to a reviewer skimming it. This asserts that the read is
// followed by a decision.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { describe, it, expect, report } from './test-shim';

function pages(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = dir + '/' + name;
    if (statSync(p).isDirectory()) pages(p, acc);
    else if (p.endsWith('.astro')) acc.push(p);
  }
  return acc;
}

const WRITES = /INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM/i;
// A CREATE TABLE on its own is a self-bootstrap, not a user-driven write.
const POSTS = /Astro\.request\.method\s*===\s*['"]POST['"]|export const POST/;
// What counts as deciding, rather than merely reading.
const DECIDES = /Astro\.redirect|return\s+new\s+Response|\bcan\(|requireAquinAdmin|mayOpenAquinAdmin|denyAdminApi|throw\s+new\s+Response|status:\s*40[13]/;

const ALL = pages('src/pages/aquintutor');
// Windows gives back-slashed paths; the allowlist is written in forward slashes. charCode 92 rather
// than a literal, because escaping a backslash through three layers of tooling is how this line broke.
const norm = (f: string) => f.replace('src/pages/', '').split(String.fromCharCode(92)).join('/');
const strip = (s: string) =>
  s.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*|<!--)/.test(l)).join('\n');

describe('the AquinTutor page surface', () => {
  it('found pages to check, so this test is not vacuous', () => {
    expect(ALL.length).toBeGreaterThan(150);
  });

  // PUBLIC BY DESIGN, AND WRITTEN DOWN RATHER THAN INFERRED.
  //
  // These five are application forms: somebody who wants to book a hall, apply for placement help,
  // enquire about studying abroad, apply to the entrepreneur programme, or propose an institutional
  // partnership. Requiring an account first would defeat the point of each one. They collect
  // self-declared contact details and write a request row; none of them touches platform state.
  //
  // The list is explicit so that a NEW ungated writer fails this test until a person has looked at
  // it and decided. An inferred exemption — "the table name ends in _requests, so it is probably
  // fine" — would have quietly exempted /aquintutor/labs/train too, which wrote to training_jobs.
  const PUBLIC_INTAKE = new Set([
    'aquintutor/campus/halls.astro',
    'aquintutor/careerflow/placement.astro',
    'aquintutor/careerflow/study-abroad.astro',
    'aquintutor/incubation.astro',
    'aquintutor/partnerships.astro',
  ]);

  it('every page that accepts a POST and writes to the database either decides who may, or is a declared public form', () => {
    // Reading locals.user is not deciding. /aquintutor/labs/train did exactly that for its whole
    // life and accepted writes from anybody on the internet.
    const bad: string[] = [];
    for (const f of ALL) {
      const body = strip(readFileSync(f, 'utf8'));
      if (!POSTS.test(body) || !WRITES.test(body)) continue;
      const rel = norm(f);
      if (PUBLIC_INTAKE.has(rel)) continue;
      if (!DECIDES.test(body)) bad.push(rel);
    }
    expect(bad.join(', ')).toBe('');
  });

  it('the declared public forms all still exist, so the exemption cannot outlive the page', () => {
    // An allowlist entry for a deleted page is how an exemption silently transfers to something else.
    for (const rel of PUBLIC_INTAKE) {
      expect(ALL.some((f) => norm(f) === rel)).toBe(true);
    }
  });

  it('the training console specifically is gated', () => {
    // Named on its own, because a general rule can be satisfied by a redirect that admits everybody.
    const body = readFileSync('src/pages/aquintutor/labs/train.astro', 'utf8');
    expect(/if\s*\(!user\)\s*return\s+Astro\.redirect/.test(body)).toBe(true);
    expect(body.includes("super_admin")).toBe(true);
  });
});

describe('the labs estate, measured rather than assumed', () => {
  // Phase 1 of this audit claimed a learner sees 20 of 61 laboratories and that cad-bench was
  // unreachable. BOTH were wrong: the detector read src/data/labs-catalog.ts, which its own header
  // describes as the LICENSABLE catalogue for the partner page, while the learner-facing index
  // carries its own arrays. cad-bench is on that index at line 24 with live: true.
  const dir = 'src/pages/aquintutor/labs';
  const files = readdirSync(dir).filter((f) => f.endsWith('.astro') && f !== 'index.astro');
  const index = readFileSync(dir + '/index.astro', 'utf8');

  it('the labs index is the learner-facing list, and it is self-contained', () => {
    // If somebody later points the index at the licensing catalogue, the two numbers converge and
    // learners silently lose two thirds of the estate. This is the tripwire for that.
    expect(index.includes("from '@/data/labs-catalog'")).toBe(false);
    expect(/const LABS\s*=\s*\[/.test(index)).toBe(true);
  });

  it('cad-bench is listed on the index', () => {
    expect(index.includes("slug: 'cad-bench'")).toBe(true);
  });

  it('most laboratories on disk are reachable from the index', () => {
    const shown = new Set<string>();
    for (const m of index.matchAll(/slug:\s*'([a-z0-9\-]+)'/g)) shown.add(m[1]);
    for (const m of index.matchAll(/\/aquintutor\/labs\/([a-z0-9\-]+)/g)) shown.add(m[1]);
    const listed = files.map((f) => f.slice(0, -6)).filter((s) => shown.has(s));
    // 51 of 61 at the time of writing; the rest are hub-linked from a parent lab on purpose.
    expect(listed.length).toBeGreaterThan(45);
  });
});

report();
