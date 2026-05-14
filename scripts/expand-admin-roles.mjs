import "dotenv/config";
import postgres from "postgres";
const sql = postgres(process.env.DATABASE_URL, { max: 1 });

console.log("Adding new role enum values...");
// PostgreSQL: add values to existing enum
const newRoles = ['recruiter', 'reviewer', 'department_head', 'marketing'];
for (const r of newRoles) {
  try {
    await sql.unsafe(`ALTER TYPE user_role ADD VALUE IF NOT EXISTS '${r}'`);
    console.log("  added: " + r);
  } catch (err) {
    console.log("  skipped " + r + ": " + err.message);
  }
}

console.log("\nAdding assigned_department_id column to users...");
await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS assigned_department_id varchar(50)`;
console.log("  done");

console.log("\nVerifying...");
const enumVals = await sql`
  SELECT enumlabel FROM pg_enum
  WHERE enumtypid = (SELECT oid FROM pg_type WHERE typname = 'user_role')
  ORDER BY enumsortorder
`;
console.log("Current user_role enum values:");
enumVals.forEach(r => console.log("  - " + r.enumlabel));

const cols = await sql`
  SELECT column_name FROM information_schema.columns
  WHERE table_name = 'users' AND column_name = 'assigned_department_id'
`;
console.log("\nassigned_department_id column exists:", cols.length > 0);

await sql.end();
