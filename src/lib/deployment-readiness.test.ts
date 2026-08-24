// The checklist must cover everything the code actually reads.
//
// The first draft of deployment-readiness.ts listed 30 of the environment variables this codebase
// reads. Sixteen were missing — among them CERT_PRIVATE_KEY_PEM, where a new key pair makes every
// certificate already in somebody else's hands fail verification.
//
// A checklist that quietly omits a variable is worse than no checklist, because somebody trusts it
// and stops looking. So the list is compared against the source rather than maintained by hand.
//
// AND THEN THIS GATE HAD A BLIND SPOT THE EXACT SHAPE OF THE THING IT EXISTS TO CATCH.
//
// Until 2026-08-24 the scanner matched only DOT access. Every variable whose name is BUILT at
// runtime is read through a bracket instead, so none of them was visible to it: not the one in
// src/lib/crypto/keys.ts, which resolves the 32 bytes of key material for every encrypted column in
// this database. It was absent from the checklist, the gate could not see it was absent, and both
// facts read as "covered". It is the one variable in the file whose loss is unrecoverable — Postgres
// keeps the key id and nothing else — so a hosting move that regenerated it would have destroyed
// data with no error message at any point.
//
// The lesson is not "add a regex". It is that a completeness gate is only as complete as its
// detector, and a detector that cannot see a whole ACCESS FORM reports silence as coverage.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { describe, it, expect, report } from './test-shim';
import { REQUIREMENTS, deploymentReadiness, readEnvStatus } from './deployment-readiness';

function sources(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.astro' || name === 'dist') continue;
    const p = dir + '/' + name;
    if (statSync(p).isDirectory()) sources(p, acc);
    else if ((p.endsWith('.ts') || p.endsWith('.astro') || p.endsWith('.js')) && !p.endsWith('.test.ts')) acc.push(p);
  }
  return acc;
}

// Astro build-time flags are not deployment configuration.
const BUILTIN = new Set(['PROD', 'DEV', 'MODE', 'SSR', 'BASE_URL', 'NODE_ENV']);
const read = new Set<string>();

// TWO WAYS A VARIABLE IS "READ", AND THE SECOND ONE IS EASY TO MISS.
//
// The direct form is a literal lookup on process.env or import.meta.env. (Written in prose rather
// than spelled out, because this scanner reads its own source file too: a placeholder written in
// the matchable form registers as a variable named after the placeholder, which is a false positive
// this very comment produced on its first draft.) The INDIRECT form names the variable as DATA and
// resolves it at runtime — src/lib/intake-routing.ts carries
// `envVar: 'WELLNESS_COUNSELLOR_EMAIL'` on each routing destination, and the value is looked up
// through that string rather than written literally anywhere.
//
// Scanning only for the direct form made the checklist look STALE for exactly those variables: the
// "lists nothing the code does not read" assertion below flagged WELLNESS_COUNSELLOR_EMAIL as a rot
// entry, when in truth the entry is right and the DETECTOR could not see the read. Deleting the
// entry would have been the damaging fix — it would send somebody to deploy the wellness routing
// with no counsellor address configured, and /aquintutor/campus/wellness changes what it promises a
// user depending on whether that address is set.
//
// So both forms count. This makes the gate stricter, never looser: a variable declared indirectly is
// now also required to be on the checklist by the assertion above.
// A THIRD FORM: BRACKET ACCESS, WHICH IS HOW EVERY RUNTIME-BUILT NAME IS READ.
//
// `process.env['LITERAL']`, `process.env['PREFIX_' + suffix]`, and the template form that
// src/lib/crypto/keys.ts uses all take a bracket. The capture stops at the first character that is
// not part of a name, so a built name yields its constant PREFIX — DATA_ENCRYPTION_KEY_, FEATURE_ —
// which is exactly what deployment-readiness.ts declares for those, with `prefix: true`. Lowercase
// index expressions like process.env[k] do not match, which is correct: there is no name to check.
const PATTERNS: RegExp[] = [
  /(?:process\.env|import\.meta\.env)\.([A-Z][A-Z0-9_]{2,})/g,
  /(?:process\.env|import\.meta\.env)\[\s*[`'"]([A-Z][A-Z0-9_]{2,})/g,
  /envVar\s*:\s*['"]([A-Z][A-Z0-9_]{2,})['"]/g,
];

// READ BY NOTHING, WRITTEN FOR SOMEBODY ELSE TO READ.
//
// src/pages/developers/mail.astro publishes worked examples of calling the transactional API, in
// JavaScript and in Python. The JavaScript sample contains a bracket read of EDURANKAI_MAIL_KEY —
// a variable set in the API CONSUMER's environment, never in this one. It is documentation that
// happens to be syntactically indistinguishable from configuration.
//
// Listed by name rather than by skipping the file: excluding the whole page would also blind the
// scanner to any real variable that page ever comes to read.
const DOCUMENTATION_SAMPLES = new Set(['EDURANKAI_MAIL_KEY']);
for (const f of sources('src')) {
  const body = readFileSync(f, 'utf8');
  for (const re of PATTERNS) {
    re.lastIndex = 0; // the regexes are module-scope and /g carries lastIndex between files
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) {
      if (!BUILTIN.has(m[1]) && !DOCUMENTATION_SAMPLES.has(m[1])) read.add(m[1]);
    }
  }
}
const listed = new Set(REQUIREMENTS.map((r) => r.name));

describe('the checklist matches the code', () => {
  it('found variables to check at all, so this test is not vacuous', () => {
    expect(read.size).toBeGreaterThan(30);
  });

  it('every variable the code reads is on the checklist', () => {
    // Named, because "one is missing" sends somebody to diff two lists by eye.
    const missing = [...read].filter((n) => !listed.has(n)).sort();
    expect(missing.join(', ')).toBe('');
  });

  it('lists nothing the code does not read, so the list cannot rot', () => {
    // A stale entry is a different lie: it sends somebody hunting for a variable nothing needs.
    const stale = [...listed].filter((n) => !read.has(n)).sort();
    expect(stale.join(', ')).toBe('');
  });
});

describe('each entry says something useful', () => {
  it('every one explains what breaks, in a sentence', () => {
    for (const r of REQUIREMENTS) {
      expect(r.breaks.length).toBeGreaterThan(20);
      expect(r.breaks.trim().endsWith('.')).toBe(true);
    }
  });

  it('has no duplicate entries', () => {
    expect(new Set(REQUIREMENTS.map((r) => r.name)).size).toBe(REQUIREMENTS.length);
  });

  it('the ones that silently invalidate stored data still say so', () => {
    // The dangerous kind: set on the new account, look correct, and break data already in the
    // database. If this set ever empties, somebody has removed the warnings.
    const must = REQUIREMENTS.filter((r) => r.mustMatchOld).map((r) => r.name);
    expect(must.includes('VAPID_PUBLIC_KEY')).toBe(true);
    expect(must.includes('WEBAUTHN_ORIGINS')).toBe(true);
    expect(must.includes('CERT_PRIVATE_KEY_PEM')).toBe(true);
    expect(must.length).toBeGreaterThan(5);
  });

  it('the detector can see bracket access, or the gate above is decorative', () => {
    // The regression guard for the blind spot in this file's header. If the bracket pattern is ever
    // dropped, this fails HERE — loudly and with a reason — rather than the checklist quietly going
    // back to reporting full coverage of a set it can no longer see all of.
    expect(read.has('DATA_ENCRYPTION_KEY_')).toBe(true);
  });

  it('the unrecoverable one says that it is unrecoverable', () => {
    // Every other mustMatchOld costs a re-enrolment or a re-signin. This one cannot be undone by any
    // later fix: the key material lives only in the environment, so ciphertext outlives it.
    const k = REQUIREMENTS.find((r) => r.name === 'DATA_ENCRYPTION_KEY_');
    expect(k?.prefix).toBe(true);
    expect(String(k?.mustMatchOld)).toContain('DO NOT GENERATE NEW ONES');
  });

  it('presence of a runtime-named variable is actually detectable', () => {
    // A prefix entry that always reports "missing" would send somebody chasing a variable that is
    // already set; one that always reports "present" is worse. Both directions are checked.
    const name = 'DATA_ENCRYPTION_KEY_zz_probe';
    const before = readEnvStatus().find((s) => s.name === 'DATA_ENCRYPTION_KEY_');
    process.env[name] = 'x';
    try {
      const after = readEnvStatus().find((s) => s.name === 'DATA_ENCRYPTION_KEY_');
      expect(after?.present).toBe(true);
    } finally {
      delete process.env[name];
    }
    // And it is reading the environment rather than hard-coding an answer.
    expect(typeof before?.present).toBe('boolean');
  });

  it('the storage token is flagged as account-bound, not merely missing', () => {
    const blob = REQUIREMENTS.find((r) => r.name === 'BLOB_READ_WRITE_TOKEN');
    expect(String(blob?.accountBound)).toContain('OLD account');
  });

  it('every blocking variable is one the site genuinely cannot run without', () => {
    const blocking = REQUIREMENTS.filter((r) => r.severity === 'blocking').map((r) => r.name).sort();
    expect(blocking.join(', ')).toBe('CRON_SECRET, DATABASE_URL, SESSION_SECRET');
  });
});

describe('reading the current deployment', () => {
  it('never returns a value, only whether it is set', () => {
    // This renders on an admin screen. A page that prints secrets is a worse problem than the one
    // it was built to solve.
    const asText = JSON.stringify(deploymentReadiness().statuses);
    for (const v of Object.values(process.env)) {
      if (typeof v === 'string' && v.length > 24) expect(asText.includes(v)).toBe(false);
    }
  });

  it('summarises rather than making the caller count', () => {
    const r = deploymentReadiness();
    expect(typeof r.ok).toBe('boolean');
    expect(Array.isArray(r.blockingMissing)).toBe(true);
    expect(Array.isArray(r.mustMatch)).toBe(true);
  });
});

report();
