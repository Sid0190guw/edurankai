import "dotenv/config";
import postgres from "postgres";
const sql = postgres(process.env.DATABASE_URL, { max: 1 });

console.log("Creating invite_tokens table...");
await sql`
  CREATE TABLE IF NOT EXISTS invite_tokens (
    token varchar(64) PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    application_id uuid REFERENCES applications(id) ON DELETE CASCADE,
    created_at timestamp with time zone NOT NULL DEFAULT NOW(),
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone,
    created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL
  )
`;
console.log("  invite_tokens table ready");

await sql`CREATE INDEX IF NOT EXISTS invite_tokens_user_idx ON invite_tokens(user_id)`;
await sql`CREATE INDEX IF NOT EXISTS invite_tokens_expires_idx ON invite_tokens(expires_at) WHERE used_at IS NULL`;
console.log("  indexes added");

const cols = await sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'invite_tokens' ORDER BY ordinal_position`;
console.log("\nColumns:");
cols.forEach(c => console.log("  " + c.column_name));

await sql.end();
