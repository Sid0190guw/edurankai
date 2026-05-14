import "dotenv/config";
import postgres from "postgres";
const sql = postgres(process.env.DATABASE_URL, { max: 1 });
const cols = await sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'applications' ORDER BY ordinal_position`;
console.log("applications columns:");
cols.forEach(c => console.log("  " + c.column_name));
await sql.end();
