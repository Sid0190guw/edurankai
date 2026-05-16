import "dotenv/config";
import postgres from "postgres";
const sql = postgres(process.env.DATABASE_URL, { max: 1 });

console.log("=== Chat audit + uniqueness migration ===\n");

// Unique stable code for each message (forensic reference)
await sql`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS message_code varchar(20)`;

// Backfill any existing messages
const rows = await sql`SELECT id FROM chat_messages WHERE message_code IS NULL`;
for (const r of rows) {
  const code = 'MSG-' + Math.random().toString(36).substring(2, 10).toUpperCase();
  await sql`UPDATE chat_messages SET message_code = ${code} WHERE id = ${r.id}`;
}
console.log("message_code backfilled for " + rows.length + " messages");

// Audit log for super_admin accessing private chats
await sql`
  CREATE TABLE IF NOT EXISTS chat_audit_log (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    accessed_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    accessed_channel_id uuid REFERENCES chat_channels(id) ON DELETE SET NULL,
    accessed_message_id uuid REFERENCES chat_messages(id) ON DELETE SET NULL,
    reason text,
    action varchar(40) NOT NULL DEFAULT 'view',
    ip_address varchar(50),
    user_agent text,
    accessed_at timestamp with time zone NOT NULL DEFAULT NOW()
  )
`;
await sql`CREATE INDEX IF NOT EXISTS chat_audit_log_by_user_idx ON chat_audit_log(accessed_by_user_id, accessed_at DESC)`;
console.log("chat_audit_log table ready");

// DM thread table (1-on-1 dms reuse chat_channels with isDm=true)
await sql`ALTER TABLE chat_channels ADD COLUMN IF NOT EXISTS is_dm boolean NOT NULL DEFAULT false`;
console.log("chat_channels.is_dm column added");

// Attachments table
await sql`
  CREATE TABLE IF NOT EXISTS chat_attachments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    message_id uuid NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
    blob_url text NOT NULL,
    file_name varchar(300),
    file_size integer,
    mime_type varchar(120),
    created_at timestamp with time zone NOT NULL DEFAULT NOW()
  )
`;
await sql`CREATE INDEX IF NOT EXISTS chat_attachments_msg_idx ON chat_attachments(message_id)`;
console.log("chat_attachments table ready");

console.log("\nDone.");
await sql.end();
