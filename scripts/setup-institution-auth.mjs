import "dotenv/config";
import postgres from "postgres";
const sql = postgres(process.env.DATABASE_URL, { max: 1 });

console.log("=== Institution user auth setup ===\n");

// Add institution_id column to users (nullable - only set for institution reps)
await sql`
  ALTER TABLE users
  ADD COLUMN IF NOT EXISTS institution_id uuid REFERENCES hei_institutions(id) ON DELETE SET NULL
`;
console.log("Added institution_id to users");

// Index for fast lookup
await sql`CREATE INDEX IF NOT EXISTS users_institution_idx ON users(institution_id) WHERE institution_id IS NOT NULL`;
console.log("Indexed users.institution_id");

// Check current user role enum
const enumValues = await sql`
  SELECT enum_range(NULL::role) AS values
`.catch(() => null);

if (enumValues) {
  console.log("Current user roles:", enumValues[0]?.values);
} else {
  console.log("(Could not introspect role enum - that's OK, we use varchar)");
}

// Try to add 'institution_admin' role - may already exist or be varchar
try {
  await sql`ALTER TYPE role ADD VALUE IF NOT EXISTS 'institution_admin'`;
  console.log("Added 'institution_admin' to role enum");
} catch (e) {
  console.log("Role column may be varchar not enum - that's OK, we'll just use the string value");
}

console.log("\nDB ready for institution user auth.");
await sql.end();
