import "dotenv/config";
import postgres from "postgres";
const sql = postgres(process.env.DATABASE_URL, { max: 1 });
const r = await sql`SELECT column_name, data_type FROM information_schema.columns WHERE table_name='offer_letters' ORDER BY ordinal_position`;
for (const c of r) console.log("  " + c.column_name.padEnd(30) + " : " + c.data_type);
await sql.end();
