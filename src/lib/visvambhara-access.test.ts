// src/lib/visvambhara-access.test.ts
//
// REGRESSION TESTS FOR TWO DEFECTS FOUND BY AUDIT ON 2026-08-30. Both were invisible to the build,
// to the type-checker and to every existing test, and one of them was live in production for three
// months.
//
// 1. THE SEVEN RESTRICTED RESEARCH MODULES WERE PUBLICLY DOWNLOADABLE.
//    They lived in public/visvambhara/ and were "protected" by a middleware branch keying on
//    path.startsWith('/visvambhara/'). Anything under public/ is emitted as a static asset, and the
//    Vercel adapter writes {"handle":"filesystem"} ahead of every dest:"_render" route — so the CDN
//    served the file and the render function, which is the only thing that runs middleware, was
//    never invoked. Verified live: all seven returned 200 with full bodies to an anonymous client.
//    The fix moved them to src/visvambhara-modules/ behind src/pages/visvambhara/[module].ts.
//    These tests fail if anyone puts them back, or removes the route that now guards them.
//
// 2. AN UNREADABLE ACCESS RECORD WAS RENDERED AS "YOU HAVE NOT APPLIED".
//    getUserAccess() catches internally and returns null, so null meant BOTH "no request on file"
//    and "the database could not be asked". Call sites wrapped it in try/catch, which could never
//    fire. getUserAccessResult() reports readability separately; hasApprovedAccess() must stay
//    fail-closed on top of it.
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

const MODULES = [
  'architecture', 'datasheet', 'concept-film', '3d-viewer',
  'fleet-3d', 'wind-tunnel', 'flight-profile',
];

describe('restricted research modules are not publicly served', () => {
  it('public/visvambhara does not exist', () => {
    // The whole vulnerability in one assertion. public/ is copied verbatim into the static output
    // and served by the CDN ahead of any function, so a file here is a file anyone can download.
    expect(existsSync(join(ROOT, 'public', 'visvambhara'))).toBe(false);
  });

  it('no gated module is anywhere under public/', () => {
    const hits: string[] = [];
    const walk = (dir: string, rel: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const abs = join(dir, e.name);
        if (e.isDirectory()) { walk(abs, rel + e.name + '/'); continue; }
        const stem = e.name.replace(/\.html$/, '');
        if (e.name.endsWith('.html') && MODULES.includes(stem)) hits.push(rel + e.name);
      }
    };
    walk(join(ROOT, 'public'), '');
    expect(hits).toEqual([]);
  });

  it('all seven modules exist in the non-public source directory', () => {
    for (const m of MODULES) {
      expect(existsSync(join(ROOT, 'src', 'visvambhara-modules', m + '.html'))).toBe(true);
    }
  });

  it('the SSR route that serves them exists and checks approval itself', () => {
    const route = 'src/pages/visvambhara/[module].ts';
    expect(existsSync(join(ROOT, route))).toBe(true);
    const src = read(route);
    // Not merely "imports the helper" — it must actually call it and must not prerender, or it
    // becomes a static asset again and we are back where we started.
    expect(src).toMatch(/hasApprovedAccess\s*\(/);
    expect(src).toMatch(/export\s+const\s+prerender\s*=\s*false/);
    // An unauthenticated caller must never fall through to the file read.
    expect(src).toMatch(/if\s*\(!user\)/);
  });

  it('the module route never lets a shared cache hold a response', () => {
    // A CDN-cached copy of an approved viewer's response is the public URL this fix removed.
    const src = read('src/pages/visvambhara/[module].ts');
    expect(src).toMatch(/private[^'"`]*no-store/);
  });

  it('middleware still gates the prefix as defence in depth', () => {
    expect(read('src/middleware.ts')).toContain("path.startsWith('/visvambhara/')");
  });

  it('every module the hub links to exists, and every module is linked', () => {
    const hub = read('src/pages/products/visvambhara.astro');
    const linked = [...hub.matchAll(/slug:\s*'([a-z0-9-]+)'/g)].map((m) => m[1]);
    for (const m of MODULES) {
      expect(linked, m + ' missing from hub').toContain(m);
      expect(existsSync(join(ROOT, 'src', 'visvambhara-modules', m + '.html'))).toBe(true);
    }
    const files = readdirSync(join(ROOT, 'src', 'visvambhara-modules'))
      .filter((f) => f.endsWith('.html')).map((f) => f.replace(/\.html$/, ''));
    for (const f of files) expect(linked, f + ' exists but nothing links to it').toContain(f);
  });
});

describe('an unreadable access record is not an answer about the user', () => {
  const src = read('src/lib/visvambhara-access.ts');

  it('exposes a read that reports readability', () => {
    expect(src).toMatch(/export\s+async\s+function\s+getUserAccessResult/);
    expect(src).toMatch(/readable:\s*false/);
  });

  it('hasApprovedAccess stays fail-closed on an unreadable record', () => {
    // The security-critical half: "could not look" must deny, never approve.
    const fn = src.slice(src.indexOf('export async function hasApprovedAccess'));
    expect(fn).toMatch(/r\.readable\s*&&/);
    expect(fn).not.toMatch(/return\s+true\s*;?\s*\}/);
  });

  it('no surface that reports status to a user still uses the collapsing read', () => {
    // getUserAccess() folds "no record" and "could not look" into null. Any page that TELLS a user
    // about their own request must not use it, or it will claim they never applied.
    for (const p of ['src/pages/products/visvambhara.astro', 'src/pages/products/visvambhara/access.astro']) {
      const body = read(p).split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
      expect(body, p + ' uses the collapsing read').not.toMatch(/await\s+getUserAccess\s*\(/);
      expect(body).toMatch(/getUserAccessResult\s*\(/);
    }
  });

  it('the hub renders a distinct state for an unreadable record', () => {
    const hub = read('src/pages/products/visvambhara.astro');
    expect(hub).toMatch(/accessState === 'unknown'/);
    // It must not silently widen access: 'unknown' is a message, not a permission.
    expect(hub).toMatch(/const canViewModules = isStaff \|\| \(access\?\.status === 'approved'\)/);
  });
});

describe('request threads are scoped to their owner', () => {
  it('the applicant thread page filters by user_id', () => {
    const page = read('src/pages/portal/requests/visvambhara/[id].astro');
    expect(page).toMatch(/WHERE id = \$\{id\} AND user_id = \$\{user\.id\}/);
  });

  it('the applicant reply API refuses another user\'s request', () => {
    const api = read('src/pages/api/portal/requests/visvambhara/reply.ts');
    expect(api).toMatch(/req\.user_id !== user\.id/);
  });

  it('both admin APIs go through the admin guard', () => {
    for (const p of [
      'src/pages/api/admin/visvambhara-access/thread.ts',
      'src/pages/api/admin/visvambhara-access/reply.ts',
    ]) {
      expect(read(p)).toMatch(/denyAdminApi\s*\(/);
    }
  });

  it('an unreadable request is a 503, never a redirect that reads as "deleted"', () => {
    const page = read('src/pages/portal/requests/visvambhara/[id].astro');
    expect(page).toMatch(/status:\s*503/);
  });
});

describe('the restricted-research gate asks for a capability, not a role', () => {
  // `role !== 'applicant'` admitted `partner` (external accredited institutions), `teacher` and
  // `technical_moderator` to confidential unpublished research, and ignored the capability the
  // role editor grants, revokes and audits for exactly this purpose.
  const files = [
    'src/middleware.ts',
    'src/pages/visvambhara/[module].ts',
    'src/pages/products/visvambhara.astro',
    'src/pages/products/akasha-q.astro',
  ];

  it('all four enforcement points use research.restricted.view', () => {
    for (const f of files) {
      expect(read(f), f + ' does not ask for the capability').toMatch(/research\.restricted\.view/);
    }
  });

  it('no enforcement point still branches on the applicant role literal', () => {
    for (const f of ['src/pages/visvambhara/[module].ts', 'src/pages/products/visvambhara.astro']) {
      const body = read(f).split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
      expect(body, f + ' still uses a role literal').not.toMatch(/role\s*[!=]==\s*'applicant'/);
    }
  });

  it('pins WHO the capability currently admits, so widening it is a deliberate act', () => {
    // READ THIS BEFORE CHANGING THE ASSERTION.
    //
    // Switching these gates from `role !== 'applicant'` to the capability was NOT a narrowing:
    // every non-applicant role holds `research.restricted.view` today, the three AquinTutor-facing
    // ones because they are declared `[...INTERNAL_ROLE_KEYS]` and that array contains the key. So
    // `can(user, 'research.restricted.view')` and `role !== 'applicant'` currently admit exactly
    // the same people. What changed is that the capability is now load-bearing: revoking it from a
    // role finally does something, which is what src/lib/auth/registry.ts describes it as doing.
    //
    // This test pins the current population. If someone decides an external `partner` institution
    // should NOT read confidential unpublished research, this is the line that turns that from a
    // silent behaviour change into an explicit one.
    const perms = read('src/lib/auth/permissions.ts');
    expect(perms).toContain("'research.restricted.view',");
    const block = perms.slice(perms.indexOf('export const PERMS_BY_ROLE'));
    for (const role of ['partner', 'teacher', 'technical_moderator']) {
      const start = block.indexOf('\n  ' + role + ':');
      expect(start, role + ' not found in PERMS_BY_ROLE').toBeGreaterThan(-1);
      const body = block.slice(start, start + 120);
      expect(body, role + ' grant shape changed — re-read the note above').toContain('INTERNAL_ROLE_KEYS');
    }
    // The applicant is the one role that must never hold it: their route in is an approved row.
    const aStart = block.indexOf('\n  applicant:');
    const aEnd = block.indexOf('\n  ],', aStart);
    expect(block.slice(aStart, aEnd)).not.toContain('research.restricted.view');
  });

  it('the admin review desk is section-gated, not merely non-applicant', () => {
    // The desk lists every applicant's name, email, CV link and full note. The sidebar has always
    // declared it `section: 'settings'` (super_admin only); the URL did not enforce that.
    expect(read('src/middleware.ts')).toMatch(/\['\/admin\/visvambhara-access',\s*'settings'\]/);
    for (const f of [
      'src/pages/api/admin/visvambhara-access/thread.ts',
      'src/pages/api/admin/visvambhara-access/reply.ts',
    ]) {
      expect(read(f), f + ' missing section key').toMatch(/section:\s*'settings'/);
    }
  });
});

describe('one approval is described as covering both programmes', () => {
  it('the decision messages an applicant reads name the line, not one programme', () => {
    const admin = read('src/pages/admin/visvambhara-access.astro');
    expect(admin).toMatch(/restricted research access request has been approved/);
    expect(admin).toMatch(/Akasha-Q/);
  });

  it('the Akasha-Q access CTA points at a page every signed-in role can open', () => {
    // /portal/visvambhara redirects any non-applicant to /admin, so it dead-ended staff.
    const page = read('src/pages/products/akasha-q.astro');
    const gate = page.slice(page.indexOf('aq-gate-card'));
    expect(gate).toMatch(/href="\/products\/visvambhara\/access"/);
    expect(gate).not.toMatch(/href="\/portal\/visvambhara"/);
  });
});
