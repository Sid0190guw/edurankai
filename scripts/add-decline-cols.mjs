import "dotenv/config";
import postgres from "postgres";
const sql = postgres(process.env.DATABASE_URL, { max: 1 });
await sql`ALTER TABLE offer_letters ADD COLUMN IF NOT EXISTS declined_at timestamp with time zone`;
await sql`ALTER TABLE offer_letters ADD COLUMN IF NOT EXISTS declined_reason text`;
console.log("declined_at + declined_reason columns added");
await sql.end();
