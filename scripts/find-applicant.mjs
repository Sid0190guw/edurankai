// scripts/find-applicant.mjs — locate an applicant across users + applications (all states,
// including archived), so you can tell whether they are recoverable. READ-ONLY by default.
//
//   node scripts/find-applicant.mjs "Patil" --env-file .env.production
//   node scripts/find-applicant.mjs "Bhargavi" --env-file .env.production
//   node scripts/find-applicant.mjs "Patil" --env-file .env.production --unarchive <applicationId>
//
// Default run only SELECTs and prints what exists. --unarchive <id> is the ONLY write it can do
// (sets is_archived = false on that one application) — use it after you have confirmed the id.
import fs from 'node:fs';
import path from 'node:path';
import postgres from 'postgres';
import dotenv from 'dotenv';

const args = process.argv.slice(2);
const term = args.find((a) => !a.startsWith('--')) || 'Patil';
let envFile = null;
const eq = args.find((a) => a.startsWith('--env-file='));
if (eq) envFile = eq.slice('--env-file='.length);
const sp = args.indexOf('--env-file'); if (!envFile && sp !== -1) envFile = args[sp + 1];
const unSp = args.indexOf('--unarchive'); const unarchiveId = unSp !== -1 ? args[unSp + 1] : null;

if (envFile) {
  const p = path.resolve(process.cwd(), envFile);
  if (!fs.existsSync(p)) { console.error('No such env file: ' + p); process.exit(1); }
  dotenv.config({ path: p, override: true });
} else { dotenv.config(); }
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(1); }

const host = (String(process.env.DATABASE_URL).match(/@([^/:?]+)/) || [])[1] || 'unknown';
console.log('\nTarget: ' + host + '   Search: "' + term + '"\n');

const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false, onnotice: () => {} });
const rows = (r) => (Array.isArray(r) ? r : (r?.rows || []));
const like = '%' + term + '%';

try {
  // 1) user accounts (survive an application delete)
  const users = rows(await sql`
    SELECT id, name, email, role, is_active, created_at
    FROM users WHERE name ILIKE ${like} OR email ILIKE ${like}
    ORDER BY created_at DESC LIMIT 20`);
  console.log('USER ACCOUNTS: ' + users.length);
  for (const u of users) console.log(`  • ${u.name}  <${u.email}>  role=${u.role}  active=${u.is_active}  id=${u.id}`);

  // 2) applications in ANY state (including archived)
  const apps = rows(await sql`
    SELECT id, first_name, last_name, email, status, is_archived, role_title_snapshot, created_at
    FROM applications
    WHERE first_name ILIKE ${like} OR last_name ILIKE ${like} OR email ILIKE ${like}
    ORDER BY created_at DESC LIMIT 20`);
  console.log('\nAPPLICATIONS (all states, incl. archived): ' + apps.length);
  for (const a of apps) console.log(`  • ${a.first_name} ${a.last_name}  <${a.email}>  status=${a.status}  archived=${a.is_archived}  role=${a.role_title_snapshot || '-'}  id=${a.id}`);

  console.log('\nREAD THIS AS:');
  if (apps.some((a) => a.is_archived)) console.log('  → An ARCHIVED application exists. Unarchive it (admin Unarchive button, or --unarchive <id>).');
  if (apps.some((a) => !a.is_archived)) console.log('  → An ACTIVE application exists already — she may not have been deleted after all.');
  if (apps.length === 0 && users.length > 0) console.log('  → No application row, but her ACCOUNT still exists. She can log in at /portal and re-apply; the account is intact.');
  if (apps.length === 0 && users.length === 0) console.log('  → Nothing found. Both the application and the account are gone (hard delete). Recover from a Supabase backup, or re-create fresh.');

  if (unarchiveId) {
    const r = rows(await sql`UPDATE applications SET is_archived = false, updated_at = NOW() WHERE id = ${unarchiveId} RETURNING id, first_name, last_name`);
    console.log('\n' + (r.length ? `UNARCHIVED: ${r[0].first_name} ${r[0].last_name} (${r[0].id})` : `No application with id ${unarchiveId}.`));
  }
} catch (e) {
  console.error('\nQuery failed: ' + (e?.cause?.message || e?.message || e));
  process.exit(1);
} finally { await sql.end(); }
