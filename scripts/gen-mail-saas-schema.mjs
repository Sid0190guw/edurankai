// scripts/gen-mail-saas-schema.mjs — write db/mail-saas-schema.sql from the TypeScript source.
//
// The companion to scripts/gen-mail-schema.mjs, kept as a SEPARATE script rather than folded into
// it: the two schemas are owned by different parts of this build and applied in a fixed order (the
// platform schema first, this one second, because every table here has a foreign key into
// mp_organizations). Two files that must be applied in order are clearer as two commands.
//
//   npm run mail:saas-schema
//
// THIS SCRIPT DOES NOT CONNECT TO ANY DATABASE. It imports the statement list and writes a file.
// Applying it is the operator's action, deliberately — see CLAUDE.md on production database access.
// The runtime also bootstraps the same statements through ensureSaasSchema() on first use, so this
// file exists for the operator who would rather apply a migration than have one applied.

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const target = resolve(root, 'db/mail-saas-schema.sql');

// pg-store.ts imports '@/lib/db' at the top level. That import must resolve for this script to run,
// and it must NOT open a connection — src/lib/db connects lazily on the first query, so importing
// it is safe. tsx supplies the TypeScript and the path alias.
const mod = await import(pathToFileURL(resolve(root, 'src/lib/mailplatform/saas/pg-store.ts')).href);

const sql = mod.saasSchemaSql();
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, sql, 'utf8');

const tables = mod.SAAS_DDL.filter((s) => /CREATE TABLE/i.test(s)).length;
console.log(`Wrote db/mail-saas-schema.sql — ${tables} tables, ${mod.SAAS_DDL.length} statements.`);
console.log('');
console.log('You do not have to apply this by hand: ensureSaasSchema() creates the same tables on');
console.log('first use, so deploying the code is enough. To apply it ahead of time:');
console.log('');
console.log('  npx tsx .dev-scripts/apply-mail-schema.mjs --dry-run   # report, write nothing');
console.log('  npx tsx .dev-scripts/apply-mail-schema.mjs             # platform schema, then SaaS');
console.log('');
console.log('That runner needs no psql. If you do have psql, PowerShell wants $env: not a bare $:');
console.log('  psql $env:DATABASE_URL -f db/mail-platform-schema.sql   # first');
console.log('  psql $env:DATABASE_URL -f db/mail-saas-schema.sql       # then this');
