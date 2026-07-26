// scripts/verify-db.mjs — READ-ONLY. Answers "is the whole schema really in this database?"
//
//   node scripts/verify-db.mjs --env-file .env.production
//
// It does three things, running only SELECTs (never writes):
//   1. Extracts every table the repo DEFINES in src/lib/db/schema.ts (pgTable('name', ...)).
//   2. Lists every table that ACTUALLY exists in the target database (information_schema).
//   3. Diffs them — tables defined-but-missing (the gap that matters for a migration) and
//      tables present-but-not-in-schema (lazily created: HR, ensureXSchema, etc.) — and prints
//      row counts for a few key tables so you can see data actually came across.
//
// The banner prints the target host (password masked) so you confirm you're pointed at Supabase.
import fs from 'node:fs';
import path from 'node:path';
import postgres from 'postgres';
import dotenv from 'dotenv';

const args = process.argv.slice(2);
let envFile = null;
const eq = args.find((a) => a.startsWith('--env-file='));
if (eq) envFile = eq.slice('--env-file='.length);
const sp = args.indexOf('--env-file');
if (!envFile && sp !== -1 && args[sp + 1]) envFile = args[sp + 1];
if (envFile) {
  const p = path.resolve(process.cwd(), envFile);
  if (!fs.existsSync(p)) { console.error('No such env file: ' + p); process.exit(1); }
  dotenv.config({ path: p, override: true });
  console.log('env: ' + envFile);
} else {
  dotenv.config();
}
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(1); }

// 1) tables the repo defines
const schemaPath = path.resolve(process.cwd(), 'src/lib/db/schema.ts');
const defined = new Set();
if (fs.existsSync(schemaPath)) {
  const src = fs.readFileSync(schemaPath, 'utf8');
  const re = /pgTable\(\s*['"`]([a-zA-Z0-9_]+)['"`]/g;
  let m;
  while ((m = re.exec(src)) !== null) defined.add(m[1]);
}

const host = (String(process.env.DATABASE_URL).match(/@([^/:?]+)/) || [])[1] || 'unknown';
console.log('\n' + '='.repeat(64));
console.log('  TARGET  ' + host);
console.log('  SCHEMA  src/lib/db/schema.ts defines ' + defined.size + ' tables');
console.log('='.repeat(64) + '\n');

const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false, onnotice: () => {} });

try {
  const rows = (r) => (Array.isArray(r) ? r : (r?.rows || []));

  const actualRows = rows(await sql`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    ORDER BY table_name`);
  const actual = new Set(actualRows.map((r) => r.table_name));

  console.log('Tables actually in the database: ' + actual.size);

  const missing = [...defined].filter((t) => !actual.has(t)).sort();
  const extra = [...actual].filter((t) => !defined.has(t)).sort();

  console.log('\nDefined in schema.ts but MISSING from the database: ' + missing.length);
  if (missing.length) console.log('  ' + missing.join(', '));
  else console.log('  (none — every schema.ts table exists)');

  console.log('\nIn the database but not in schema.ts (lazily-created: HR, ensureXSchema, etc.): ' + extra.length);
  if (extra.length) console.log('  ' + extra.slice(0, 60).join(', ') + (extra.length > 60 ? ' …' : ''));

  // row counts for a few anchors so you can see DATA came across, not just structure
  const keys = ['users', 'applications', 'roles', 'hr_employees', 'offer_letters'];
  console.log('\nRow counts (data check):');
  for (const t of keys) {
    if (!actual.has(t)) { console.log('  ' + t.padEnd(16) + 'table not present'); continue; }
    try {
      const c = rows(await sql.unsafe(`SELECT count(*)::int AS n FROM "${t}"`))[0]?.n ?? '?';
      console.log('  ' + t.padEnd(16) + c + ' rows');
    } catch (e) { console.log('  ' + t.padEnd(16) + 'error: ' + (e?.message || e)); }
  }

  console.log('\nVerdict: ' + (missing.length === 0
    ? 'every schema.ts table is present in this database.'
    : missing.length + ' schema tables are MISSING here — schema is NOT fully transferred.'));
} catch (e) {
  console.error('\nCould not read the database: ' + (e?.cause?.message || e?.message || e));
  process.exit(1);
} finally {
  await sql.end();
}
