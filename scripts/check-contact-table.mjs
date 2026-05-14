import "dotenv/config";
import postgres from "postgres";
const sql = postgres(process.env.DATABASE_URL, { max: 1 });

const exists = await sql`
  SELECT EXISTS (
    SELECT FROM information_schema.tables
    WHERE table_name = 'contact_submissions'
  ) as exists
`;
console.log("contact_submissions table exists:", exists[0].exists);

if (exists[0].exists) {
  const cols = await sql`
    SELECT column_name, data_type FROM information_schema.columns
    WHERE table_name = 'contact_submissions'
    ORDER BY ordinal_position
  `;
  console.log("columns:");
  cols.forEach(c => console.log("  " + c.column_name + " (" + c.data_type + ")"));
}

await sql.end();
