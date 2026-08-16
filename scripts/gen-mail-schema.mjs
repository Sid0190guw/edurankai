// scripts/gen-mail-schema.mjs — write db/mail-platform-schema.sql from the TypeScript source.
//
// The schema has ONE source of truth (src/lib/mailplatform/schema.ts). This script renders it to the
// .sql file an operator runs against production by hand. Generated rather than hand-maintained, so
// the file and the code cannot drift — a migration file that says something different from what the
// application expects is worse than having no file.
//
//   npm run mail:schema
//
// THIS SCRIPT DOES NOT CONNECT TO ANY DATABASE. It imports the statement list and writes a file.
// Applying it is the operator's action, deliberately: see CLAUDE.md on production database access.

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const target = resolve(root, 'db/mail-platform-schema.sql');

// The module imports '@/lib/db' at the top level for ensureMailPlatformSchema(). That import must
// resolve for this script to run under plain node, and it must NOT open a connection — src/lib/db
// connects lazily on first query, so importing it is safe. tsx provides the TypeScript and the
// path alias; the npm script runs this through it.
const mod = await import(pathToFileURL(resolve(root, 'src/lib/mailplatform/schema.ts')).href);

const sql = mod.mailPlatformSchemaSql();
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, sql, 'utf8');

const tables = mod.MP_TABLES.length;
const statements = mod.MP_DDL.length + mod.MP_EXTENSIONS.length + mod.MP_TRIGGERS.length;
console.log(`Wrote db/mail-platform-schema.sql — schema version ${mod.SCHEMA_VERSION}, ${tables} tables, ${statements} statements.`);
console.log('Apply it yourself with:  psql "$DATABASE_URL" -f db/mail-platform-schema.sql');
