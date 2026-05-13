import "dotenv/config";
import postgres from "postgres";
const sql = postgres(process.env.DATABASE_URL, { max: 1 });

const r = await sql`SELECT id, slug, name FROM products WHERE is_visible = true ORDER BY sort_order;`;
console.log("=== Visible products (for offer venture dropdown) ===");
r.forEach(p => console.log(" -", p.slug, "|", p.name));

await sql.end();
