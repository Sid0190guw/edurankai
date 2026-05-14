import "dotenv/config";
import postgres from "postgres";
const sql = postgres(process.env.DATABASE_URL, { max: 1 });
const exists = await sql`SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'products') as e`;
console.log("products table exists:", exists[0].e);
if (exists[0].e) {
  const rows = await sql`SELECT * FROM products LIMIT 3`;
  console.log("\nSample rows:", rows.length);
  if (rows.length > 0) console.log("First row:", JSON.stringify(rows[0], null, 2));
  const cols = await sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'products' ORDER BY ordinal_position`;
  console.log("\nColumns:");
  cols.forEach(c => console.log("  " + c.column_name));
}
await sql.end();
