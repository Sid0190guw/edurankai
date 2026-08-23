// THE ORPHAN REGRESSION GATE.
//
// A manual orphan audit is accurate until the next branch merges. Twelve orphaned modules were found
// by hand; the real number, measured by the detector, is twenty-seven. Without a gate the twenty-eighth
// arrives silently and the whole audit has to be redone.
//
// The invariant:
//
//     current_orphans  ⊆  approved_orphans      (.ci/orphan-allowlist.json)
//
// A NEW orphan fails this test. An existing one does not. The list may only shrink, and clearing an
// entry never fails the build — the asymmetry is deliberate, because a gate that punishes cleanup is
// a gate people disable.
//
// It also tests the detector itself against fixtures, because a detector that under-reports is
// worse than none: it produces a green tick over accumulating dead code.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  findOrphans,
  hasExports,
  importSpecifiers,
  normalisePath,
  orphanGate,
  specifierMatches,
  specifiersFor,
  type ModuleRef,
} from '@/lib/orphan-detect';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

// ---------------------------------------------------------------------------
// The detector, against fixtures
// ---------------------------------------------------------------------------

describe('import extraction', () => {
  it('finds static, type, dynamic and require imports', () => {
    const src = `
      import { a } from '@/lib/alpha';
      import type { B } from '@/lib/beta';
      export { c } from './gamma';
      const d = await import('@/lib/delta');
      const e = require('../epsilon');
    `;
    const specs = importSpecifiers(src);
    expect(specs).toContain('@/lib/alpha');
    expect(specs).toContain('@/lib/beta');
    expect(specs).toContain('./gamma');
    expect(specs).toContain('@/lib/delta');
    expect(specs).toContain('../epsilon');
  });

  it('does not mistake a string in code for an import', () => {
    expect(importSpecifiers(`const s = "@/lib/not-an-import";`)).toEqual([]);
  });
});

describe('specifier matching', () => {
  const specs = specifiersFor('src/lib/hr/sync.ts');

  it('matches the aliased form', () => {
    expect(specifierMatches('@/lib/hr/sync', specs)).toBe(true);
    expect(specifierMatches('@/lib/hr/sync.js', specs)).toBe(true);
  });

  it('matches relative forms from anywhere in the tree', () => {
    expect(specifierMatches('./sync', specs)).toBe(true);
    expect(specifierMatches('../hr/sync', specs)).toBe(true);
    expect(specifierMatches('../../lib/hr/sync', specs)).toBe(true);
  });

  it('does not match a module whose name merely ends with the same letters', () => {
    // '@/lib/gmail' must not satisfy a module called 'mail'.
    const mailSpecs = specifiersFor('src/lib/mail.ts');
    expect(specifierMatches('@/lib/gmail', mailSpecs)).toBe(false);
    expect(specifierMatches('@/lib/mail-csv', mailSpecs)).toBe(false);
    expect(specifierMatches('@/lib/mail', mailSpecs)).toBe(true);
  });

  it('treats an index file as reachable by its directory', () => {
    const specs2 = specifiersFor('src/lib/aquin/index.ts');
    expect(specifierMatches('@/lib/aquin', specs2)).toBe(true);
  });
});

describe('findOrphans', () => {
  const mod = (path: string): ModuleRef => ({ path, specifiers: specifiersFor(path), hasExports: true });

  it('finds a module nothing imports', () => {
    const sources = new Map([['src/pages/x.astro', `import { a } from '@/lib/used';`]]);
    const found = findOrphans([mod('src/lib/used.ts'), mod('src/lib/unused.ts')], sources);
    expect(found.map((f) => f.path)).toEqual(['src/lib/unused.ts']);
  });

  it('reports a module imported ONLY by its own test as an orphan', () => {
    const sources = new Map([['src/lib/thing.test.ts', `import { t } from '@/lib/thing';`]]);
    const found = findOrphans([mod('src/lib/thing.ts')], sources);
    expect(found).toHaveLength(1);
    expect(found[0].testOnly).toBe(true);
  });

  it('does NOT treat src/pages/api/tests/ as a test directory', () => {
    // That path is the assessment product. Treating it as a suite made three live routes look like
    // test-only importers, which would have marked a module every candidate assessment depends on
    // as dead code.
    const sources = new Map([['src/pages/api/tests/submit.ts', `import { x } from '@/lib/auth/attempt-access';`]]);
    const found = findOrphans([mod('src/lib/auth/attempt-access.ts')], sources);
    expect(found).toHaveLength(0);
  });

  it('ignores a module with no exports', () => {
    const found = findOrphans([{ path: 'src/lib/side-effect.ts', specifiers: [], hasExports: false }], new Map());
    expect(found).toHaveLength(0);
  });

  it('does not count a file importing itself', () => {
    const sources = new Map([['src/lib/self.ts', `import { a } from './self';`]]);
    expect(findOrphans([mod('src/lib/self.ts')], sources)).toHaveLength(1);
  });
});

describe('orphanGate', () => {
  const f = (path: string) => ({ path, importers: [], testOnly: false });

  it('passes when every current orphan is approved', () => {
    expect(orphanGate([f('a.ts')], ['a.ts', 'b.ts']).ok).toBe(true);
  });

  it('FAILS on a new orphan', () => {
    const r = orphanGate([f('a.ts'), f('new.ts')], ['a.ts']);
    expect(r.ok).toBe(false);
    expect(r.unapproved.map((u) => u.path)).toEqual(['new.ts']);
  });

  it('does not fail when an approved orphan has been wired up — cleanup is never blocked', () => {
    const r = orphanGate([], ['a.ts', 'b.ts']);
    expect(r.ok).toBe(true);
    expect(r.resolved).toEqual(['a.ts', 'b.ts']);
  });
});

// ---------------------------------------------------------------------------
// The gate, against the real repository
// ---------------------------------------------------------------------------

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return out; }
  for (const name of entries) {
    if (name === 'node_modules' || name === 'dist' || name === '.git' || name === '.astro') continue;
    const full = join(dir, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function scanRepository() {
  const sources = new Map<string, string>();
  for (const dir of ['src', 'scripts', 'mail-engine']) {
    for (const f of walk(join(ROOT, dir))) {
      if (!/\.(ts|tsx|astro|mjs|js)$/.test(f)) continue;
      try { sources.set(normalisePath(relative(ROOT, f)), readFileSync(f, 'utf8')); } catch { /* unreadable */ }
    }
  }
  const modules: ModuleRef[] = [];
  for (const f of walk(join(ROOT, 'src/lib'))) {
    const rel = normalisePath(relative(ROOT, f));
    if (!/\.tsx?$/.test(rel) || /\.test\.tsx?$/.test(rel) || /\.d\.ts$/.test(rel)) continue;
    modules.push({ path: rel, specifiers: specifiersFor(rel), hasExports: hasExports(sources.get(rel) || '') });
  }
  return { modules, sources };
}

function approvedPaths(): string[] {
  const raw = JSON.parse(readFileSync(join(ROOT, '.ci/orphan-allowlist.json'), 'utf8'));
  const out: string[] = [];
  for (const group of Object.values(raw.groups as Record<string, { paths: string[] }>)) out.push(...group.paths);
  return out;
}

describe('repository orphan gate', () => {
  it('introduces no orphaned module that is not on the approved list', () => {
    const { modules, sources } = scanRepository();
    expect(modules.length).toBeGreaterThan(100);   // the scan actually found the tree

    const current = findOrphans(modules, sources);
    const gate = orphanGate(current, approvedPaths());

    if (!gate.ok) {
      const lines = gate.unapproved.map((u) =>
        `  ${u.path}${u.testOnly ? '  (imported only by its own test)' : '  (imported by nothing)'}`);
      throw new Error(
        `${gate.unapproved.length} new orphaned module(s) under src/lib:\n${lines.join('\n')}\n\n` +
        'A library module nothing imports is dead code, and dead code accumulates silently.\n' +
        'Either wire it to a real consumer, or add it to .ci/orphan-allowlist.json WITH A REASON\n' +
        'and a decision (wire / merge / migrate / deprecate / remove).',
      );
    }
    expect(gate.ok).toBe(true);
    // 60s: this reads every source file in the repository. It is the slowest test here by two orders
    // of magnitude and it competes with the rest of the suite for I/O, so the default 5s is not
    // enough under a full parallel run — and a gate that fails intermittently is a gate people mute.
  }, 60_000);

  it('every approved orphan carries a documented reason and decision', () => {
    const raw = JSON.parse(readFileSync(join(ROOT, '.ci/orphan-allowlist.json'), 'utf8'));
    for (const [name, group] of Object.entries(raw.groups as Record<string, any>)) {
      expect(group.why, `group "${name}" has no reason`).toBeTruthy();
      expect(String(group.why).length, `group "${name}" reason is too thin to act on`).toBeGreaterThan(40);
      expect(group.decision, `group "${name}" has no decision`).toBeTruthy();
      expect(Array.isArray(group.paths) && group.paths.length, `group "${name}" lists no paths`).toBeTruthy();
    }
  });

  it('the allowlist contains no duplicate entries', () => {
    const paths = approvedPaths();
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('the allowlist count matches what it claims', () => {
    const raw = JSON.parse(readFileSync(join(ROOT, '.ci/orphan-allowlist.json'), 'utf8'));
    expect(approvedPaths().length).toBe(raw.count);
  });
});
