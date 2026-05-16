import "dotenv/config";
import postgres from "postgres";
const sql = postgres(process.env.DATABASE_URL, { max: 1 });

console.log("=== Offer credentials migration ===\n");

await sql`ALTER TABLE offer_letters ADD COLUMN IF NOT EXISTS plaintext_password varchar(40)`;
await sql`ALTER TABLE offer_letters ADD COLUMN IF NOT EXISTS created_user_id uuid REFERENCES users(id) ON DELETE SET NULL`;
console.log("offer_letters.plaintext_password + created_user_id added");

console.log("\nDone.");
await sql.end();
