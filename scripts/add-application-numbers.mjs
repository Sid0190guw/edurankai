import "dotenv/config";
import postgres from "postgres";
const sql = postgres(process.env.DATABASE_URL, { max: 1 });

// 1. Add column
await sql`ALTER TABLE applications ADD COLUMN IF NOT EXISTS application_number varchar(20) UNIQUE`;
console.log("Column added/verified");

// 2. Generate numbers for existing applications without one
const apps = await sql`SELECT id FROM applications WHERE application_number IS NULL ORDER BY created_at ASC`;
console.log(`Found ${apps.length} applications without numbers`);

let counter = 1;
for (const app of apps) {
  const num = `EDU-2026-${String(counter).padStart(5, '0')}`;
  await sql`UPDATE applications SET application_number = ${num} WHERE id = ${app.id}`;
  counter++;
}
console.log(`Assigned ${apps.length} application numbers`);

// 3. Add index for fast lookup during login
await sql`CREATE INDEX IF NOT EXISTS idx_applications_number_dob ON applications(application_number, dob)`;
console.log("Index added");

await sql.end();
