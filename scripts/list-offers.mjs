import "dotenv/config";
import postgres from "postgres";
const sql = postgres(process.env.DATABASE_URL, { max: 1 });

console.log("=== All offers ===");
const offers = await sql`SELECT id, token, candidate_name, candidate_email, role_title, status, created_at FROM offer_letters ORDER BY created_at DESC`;
for (const o of offers) {
  console.log("- " + o.candidate_name + " | " + o.role_title + " | status=" + o.status + " | sent to " + o.candidate_email);
}

await sql.end();
