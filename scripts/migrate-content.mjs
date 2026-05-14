import "dotenv/config";
import postgres from "postgres";
const sql = postgres(process.env.DATABASE_URL, { max: 1 });

console.log("Migrating content_pages.body from jsonb to text...");

// 1. Add temp markdown column
await sql`ALTER TABLE content_pages ADD COLUMN IF NOT EXISTS body_markdown text`;
console.log("  added body_markdown column");

// 2. Migrate existing data (will be empty since 0 rows)
const count = await sql`SELECT COUNT(*) FROM content_pages`;
console.log("  existing rows:", count[0].count);

// 3. Drop old jsonb body (safe, 0 rows)
await sql`ALTER TABLE content_pages DROP COLUMN IF EXISTS body`;
console.log("  dropped old jsonb body column");

// 4. Rename body_markdown -> body
await sql`ALTER TABLE content_pages RENAME COLUMN body_markdown TO body`;
console.log("  renamed body_markdown to body");

// 5. Make NOT NULL with empty string default
await sql`UPDATE content_pages SET body = '' WHERE body IS NULL`;
await sql`ALTER TABLE content_pages ALTER COLUMN body SET DEFAULT ''`;
await sql`ALTER TABLE content_pages ALTER COLUMN body SET NOT NULL`;
console.log("  set body NOT NULL with default ''");

// 6. Add meta_description column
await sql`ALTER TABLE content_pages ADD COLUMN IF NOT EXISTS meta_description varchar(300)`;
console.log("  added meta_description");

console.log("\nVerifying schema...");
const cols = await sql`
  SELECT column_name, data_type, is_nullable
  FROM information_schema.columns
  WHERE table_name = 'content_pages'
  ORDER BY ordinal_position
`;
cols.forEach(c => console.log("  " + c.column_name + " (" + c.data_type + ", " + (c.is_nullable === 'YES' ? 'null ok' : 'not null') + ")"));

await sql.end();
