import "dotenv/config";
import postgres from "postgres";
const sql = postgres(process.env.DATABASE_URL, { max: 1 });

const exists = await sql`SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'content_pages') as e`;
console.log("content_pages table exists:", exists[0].e);

if (exists[0].e) {
  const rows = await sql`SELECT id, slug, title, is_published, version, updated_at FROM content_pages ORDER BY slug`;
  console.log("\nExisting pages: " + rows.length);
  rows.forEach(r => console.log("  " + r.slug + " | " + r.title + " | " + (r.is_published ? "PUBLISHED" : "draft") + " | v" + r.version));
  if (rows.length > 0) {
    const sample = await sql`SELECT body FROM content_pages LIMIT 1`;
    console.log("\nSample body structure:", JSON.stringify(sample[0].body, null, 2).substring(0, 500));
  }
}
await sql.end();
