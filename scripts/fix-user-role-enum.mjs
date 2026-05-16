import "dotenv/config";
import postgres from "postgres";
const sql = postgres(process.env.DATABASE_URL, { max: 1 });

console.log("=== Adding missing role enum values ===\n");

const valuesToAdd = ['recruiter', 'reviewer', 'department_head', 'marketing', 'institution_admin'];
for (const v of valuesToAdd) {
  try {
    await sql.unsafe(`ALTER TYPE user_role ADD VALUE IF NOT EXISTS '${v}'`);
    console.log("Added enum value: " + v);
  } catch (e) {
    console.log("(value " + v + " may already exist) " + (e.message || ''));
  }
}

console.log("\nDone. Checking final values:");
const r = await sql`SELECT enum_range(NULL::user_role) AS values`;
console.log("user_role enum now:", r[0].values);

await sql.end();
