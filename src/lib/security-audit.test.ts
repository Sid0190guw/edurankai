// src/lib/security-audit.test.ts — run: npx tsx src/lib/security-audit.test.ts
// Production hardening (Prompt AP7): NO hardcoded secrets in real source; the authz-guard scanner
// correctly flags an unguarded route (and passes a guarded one); the security-sensitive endpoints we
// added are all guarded; input validation + error sanitization behave.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { scanForSecrets, isRouteGuarded, auditRoutes, isAllowedPublic } from './security-audit';
import { validateBody, sanitizeError } from './http-guard';
import { z } from 'zod';

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, extra?: unknown) => { console.log((c ? '  ok  ' : 'FAIL  ') + n + (extra != null ? '  ' + JSON.stringify(extra) : '')); c ? pass++ : fail++; };

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) { const p = join(dir, e); const s = statSync(p); if (s.isDirectory()) walk(p, out); else if (/\.(ts|astro)$/.test(e) && !/\.test\.ts$/.test(e)) out.push(p); }
  return out;
}

console.log('\n== no hardcoded secrets in real source ==');
ok('the scanner catches a planted key', scanForSecrets('const k = "sk-ABCDEFGHIJKLMNOPQRSTUVWX"').length > 0 && scanForSecrets('rzp_live_ABCDEFGHIJ12').length > 0);
ok('clean text has no findings', scanForSecrets('const key = process.env.RAZORPAY_KEY_ID;').length === 0);
const files = [...walk('src/lib'), ...walk('src/pages/api')];
const leaks: string[] = [];
for (const f of files) { const hits = scanForSecrets(readFileSync(f, 'utf8')); if (hits.length) leaks.push(f + ' -> ' + hits.map((h) => h.name).join(',')); }
ok('src/lib + src/pages/api contain NO hardcoded secrets', leaks.length === 0, leaks.slice(0, 5));

console.log('\n== the authz-guard scanner flags an unguarded route ==');
ok('a guarded route is recognised', isRouteGuarded('const user = (locals as any)?.user; const g = await can(user, "write", {});'));
ok('an UNGUARDED route is flagged (fails the audit)', isRouteGuarded('export const POST = async ({ request }) => new Response("ok")') === false);
const audit = auditRoutes([{ path: '/api/danger', source: 'export const POST = () => new Response("secret")' }]);
ok('an unguarded, non-public route surfaces as a finding', audit.unguarded.includes('/api/danger') && !isAllowedPublic('/api/danger'));

console.log('\n== the security-sensitive endpoints we added are all guarded ==');
const sensitive = [
  'src/pages/api/aquintutor/moderate.ts', 'src/pages/api/aquintutor/checkout.ts', 'src/pages/api/admin/billing.ts',
  'src/pages/api/jobs/run.ts', 'src/pages/api/aquintutor/vod.ts', 'src/pages/api/aquintutor/broadcast.ts',
  'src/pages/api/aquintutor/broadcast/say.ts', 'src/pages/api/admin/i18n.ts', 'src/pages/api/aquintutor/board.ts',
  'src/pages/api/portal/meet/[room]/anim.ts', 'src/pages/api/portal/meet/[room]/breakout.ts',
];
const unguardedSensitive = sensitive.filter((f) => !isRouteGuarded(readFileSync(f, 'utf8')));
ok('every sensitive endpoint enforces authz', unguardedSensitive.length === 0, unguardedSensitive);

console.log('\n== input validation + error sanitization ==');
const schema = z.object({ email: z.string().email(), n: z.number() });
ok('valid input passes', validateBody(schema, { email: 'a@b.com', n: 3 }).ok === true);
const bad = validateBody(schema, { email: 'nope', n: 'x' });
ok('invalid input is rejected with a clean message (no throw)', bad.ok === false && typeof (bad as any).error === 'string');
ok('a stack/SQL/connection error is sanitized away', sanitizeError({ message: 'at Object.<anonymous> (/node_modules/pg/x)' }) === 'Something went wrong. Please try again.' && sanitizeError({ message: 'relation "users" does not exist' }).startsWith('Something'));
ok('a plain safe message is passed through', sanitizeError({ message: 'course not found' }) === 'course not found');

console.log('\n== a broad authz snapshot (informational) ==');
const apiFiles = walk('src/pages/api').map((p) => ({ path: p, source: readFileSync(p, 'utf8') }));
const snap = auditRoutes(apiFiles);
const unguardedNonPublic = snap.unguarded.filter((p) => !isAllowedPublic(p));
console.log('  ..  ' + snap.guarded.length + ' guarded, ' + snap.unguarded.length + ' unguarded (' + unguardedNonPublic.length + ' non-public) of ' + apiFiles.length);
ok('the audit runs across all API routes', apiFiles.length > 100 && snap.guarded.length > 0);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
