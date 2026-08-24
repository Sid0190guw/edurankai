// scripts/apply-sql.mjs — run a .sql file against DATABASE_URL without needing psql installed.
//
//   node scripts/apply-sql.mjs db/hr-schema.sql --dry-run  # print what WOULD run, touch nothing
//   node scripts/apply-sql.mjs db/hr-schema.sql            # apply
//   node scripts/apply-sql.mjs db/hr-schema.sql --env-file .env.production
//
// CHECK THE TARGET BEFORE YOU APPLY. The banner prints the host it is connected to (credentials
// masked). The repo's .env may point at an OLD, RETIRED database. Confirm the host is
// Supabase, and a stale .env means you would migrate the wrong database and see no effect in
// production. To target production, pull its environment and pass it explicitly:
//
//   npx vercel env pull .env.production
//   node scripts/apply-sql.mjs db/hr-schema.sql --env-file .env.production --dry-run
//
// Uses the postgres driver the app already depends on, so there is nothing extra to install.
// Statements run ONE AT A TIME and each result is printed, so a failure names the exact statement
// instead of failing the whole file anonymously.
//
// NOT wrapped in a transaction, deliberately: db/hr-schema.sql is written so every statement is
// independently idempotent (CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS). If one
// statement fails, the ones that already succeeded are correct and re-running the file is safe.
import fs from 'node:fs';
import path from 'node:path';
import postgres from 'postgres';
import dotenv from 'dotenv';
import { splitStatements } from './sql-split.mjs';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const dryRun = args.includes('--dry-run');

// --env-file <path> (or --env-file=<path>) wins over .env, so you can point at a pulled
// production environment without touching the repo's .env.
let envFile = null;
const eqForm = args.find((a) => a.startsWith('--env-file='));
if (eqForm) envFile = eqForm.slice('--env-file='.length);
const spaceForm = args.indexOf('--env-file');
if (!envFile && spaceForm !== -1 && args[spaceForm + 1]) envFile = args[spaceForm + 1];

if (envFile) {
  const p = path.resolve(process.cwd(), envFile);
  if (!fs.existsSync(p)) { console.error('No such env file: ' + p); process.exit(1); }
  dotenv.config({ path: p, override: true });
  console.log('env: ' + envFile);
} else {
  dotenv.config();
}

if (!file) {
  console.error('Usage: node scripts/apply-sql.mjs <file.sql> [--dry-run]');
  process.exit(1);
}
const abs = path.resolve(process.cwd(), file);
if (!fs.existsSync(abs)) {
  console.error('No such file: ' + abs);
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. Put it in .env, or set it for this command only.');
  process.exit(1);
}

const raw = fs.readFileSync(abs, 'utf8');

// Split into statements. The splitter lives in scripts/sql-split.mjs so it can be tested without
// a database in the room — the version that used to sit here shredded every `DO $$ ... $$` block
// in db/ into unrunnable fragments, and reported it as a handful of failed statements in an
// otherwise green run. See the header of that file.


const statements = splitStatements(raw);
const label = (s) => s.replace(/\s+/g, ' ').slice(0, 92);

const host = (String(process.env.DATABASE_URL).match(/@([^/:?]+)/) || [])[1] || 'unknown';
console.log('\n' + '='.repeat(72));
console.log(`  FILE    ${file}  (${statements.length} statements)`);
console.log(`  TARGET  ${host}`);
console.log(`  MODE    ${dryRun ? 'dry run — nothing will be executed' : 'APPLYING CHANGES'}`);
console.log('='.repeat(72));
console.log('  Check TARGET is the database you mean before continuing.\n');

if (dryRun) {
  statements.forEach((s, i) => console.log(String(i + 1).padStart(3) + '. ' + label(s)));
  console.log('\nDry run — nothing was executed.');
  process.exit(0);
}

// prepare:false — Supabase's transaction pooler (pgbouncer, :6543) does not support prepared
// statements; without this a migration over the pooled URL can fail mid-file. Harmless on a
// direct/session connection too.
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false, onnotice: () => {} });

let ok = 0, failed = 0;
const failures = [];

for (let i = 0; i < statements.length; i++) {
  const stmt = statements[i];
  const n = String(i + 1).padStart(3);
  try {
    const result = await sql.unsafe(stmt);
    ok++;
    console.log(`${n}  ok    ${label(stmt)}`);
    // Show rows for diagnostic SELECTs (e.g. a "find duplicates" step in a migration).
    if (Array.isArray(result) && result.length > 0) {
      console.log(`       ${result.length} row(s):`);
      for (const row of result.slice(0, 100)) console.log('         ' + JSON.stringify(row));
      if (result.length > 100) console.log(`         … and ${result.length - 100} more`);
    }
  } catch (e) {
    failed++;
    // The real Postgres reason, not just the failed SQL.
    const reason = e?.cause?.message || e?.message || String(e);
    failures.push({ n: i + 1, stmt: label(stmt), reason });
    console.log(`${n}  FAIL  ${label(stmt)}`);
    console.log(`     -> ${reason}`);
  }
}

await sql.end();

console.log(`\n${ok} succeeded, ${failed} failed.`);
if (failures.length) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  ${f.n}. ${f.stmt}\n     ${f.reason}`);
  console.log('\nThe file is idempotent — fix the cause and re-run it; the statements that');
  console.log('already succeeded will simply be skipped.');
  process.exit(1);
}
console.log('Done.');
