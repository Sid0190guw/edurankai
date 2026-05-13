import "dotenv/config";
import postgres from "postgres";
const sql = postgres(process.env.DATABASE_URL, { max: 1 });
const cols = await sql`SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'roles' ORDER BY ordinal_position`;
console.log("=== ROLES TABLE COLUMNS ===");
cols.forEach(c => console.log("  " + c.column_name + " : " + c.data_type));
await sql.end();
