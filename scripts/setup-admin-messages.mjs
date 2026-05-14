import "dotenv/config";
import postgres from "postgres";
const sql = postgres(process.env.DATABASE_URL, { max: 1 });

console.log("Creating admin messaging tables...");

// 1-on-1 conversations between admin users
await sql`
  CREATE TABLE IF NOT EXISTS admin_conversations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_a_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    user_b_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    last_message_at timestamp with time zone,
    created_at timestamp with time zone NOT NULL DEFAULT NOW(),
    CONSTRAINT user_a_lt_user_b CHECK (user_a_id < user_b_id),
    CONSTRAINT unique_pair UNIQUE (user_a_id, user_b_id)
  )
`;
console.log("  admin_conversations table ready");

await sql`
  CREATE TABLE IF NOT EXISTS admin_messages (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id uuid NOT NULL REFERENCES admin_conversations(id) ON DELETE CASCADE,
    sender_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body text NOT NULL,
    read_by_recipient boolean NOT NULL DEFAULT false,
    read_at timestamp with time zone,
    created_at timestamp with time zone NOT NULL DEFAULT NOW()
  )
`;
console.log("  admin_messages table ready");

await sql`CREATE INDEX IF NOT EXISTS conv_user_a_idx ON admin_conversations(user_a_id)`;
await sql`CREATE INDEX IF NOT EXISTS conv_user_b_idx ON admin_conversations(user_b_id)`;
await sql`CREATE INDEX IF NOT EXISTS conv_last_msg_idx ON admin_conversations(last_message_at DESC)`;
await sql`CREATE INDEX IF NOT EXISTS msg_conv_idx ON admin_messages(conversation_id, created_at DESC)`;
await sql`CREATE INDEX IF NOT EXISTS msg_unread_idx ON admin_messages(conversation_id, read_by_recipient) WHERE read_by_recipient = false`;
console.log("  indexes added");

console.log("\nDone.");
await sql.end();
