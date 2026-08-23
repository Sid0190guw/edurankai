// The checklist must cover everything the code actually reads.
//
// The first draft of deployment-readiness.ts listed 30 of the 46 environment variables this codebase
// reads. Sixteen were missing — among them CERT_PRIVATE_KEY_PEM, where a new key pair makes every
// certificate already in somebody else's hands fail verification.
//
// A checklist that quietly omits a variable is worse than no checklist, because somebody trusts it
// and stops looking. So the list is compared against the source rather than maintained by hand.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { describe, it, expect, report } from './test-shim';
import { REQUIREMENTS, deploymentReadiness } from './deployment-readiness';

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
const PATTERNS: RegExp[] = [
  /(?:process\.env|import\.meta\.env)\.([A-Z][A-Z0-9_]{2,})/g,
  /envVar\s*:\s*['"]([A-Z][A-Z0-9_]{2,})['"]/g,
];
for (const f of sources('src')) {
  const body = readFileSync(f, 'utf8');
  for (const re of PATTERNS) {
    re.lastIndex = 0; // the regexes are module-scope and /g carries lastIndex between files
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) {
      if (!BUILTIN.has(m[1])) read.add(m[1]);
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
