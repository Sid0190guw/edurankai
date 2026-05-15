import "dotenv/config";
import postgres from "postgres";
const sql = postgres(process.env.DATABASE_URL, { max: 1 });

// Add assigned_reviewer_id column
await sql`
  ALTER TABLE applications
  ADD COLUMN IF NOT EXISTS assigned_reviewer_id uuid REFERENCES users(id) ON DELETE SET NULL
`;
console.log("Added assigned_reviewer_id column");

// Add is_archived flag
await sql`
  ALTER TABLE applications
  ADD COLUMN IF NOT EXISTS is_archived boolean NOT NULL DEFAULT false
`;
console.log("Added is_archived column");

await sql`CREATE INDEX IF NOT EXISTS apps_assigned_idx ON applications(assigned_reviewer_id)`;
await sql`CREATE INDEX IF NOT EXISTS apps_archived_idx ON applications(is_archived) WHERE is_archived = false`;
console.log("Indexes added");

await sql.end();
