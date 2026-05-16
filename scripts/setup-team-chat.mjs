import "dotenv/config";
import postgres from "postgres";
const sql = postgres(process.env.DATABASE_URL, { max: 1 });

console.log("=== Team chat tables ===\n");

await sql`
  CREATE TABLE IF NOT EXISTS chat_channels (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    slug varchar(60) NOT NULL UNIQUE,
    name varchar(120) NOT NULL,
    description text,
    is_private boolean NOT NULL DEFAULT false,
    created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
    sort_order integer NOT NULL DEFAULT 0,
    created_at timestamp with time zone NOT NULL DEFAULT NOW()
  )
`;

await sql`CREATE INDEX IF NOT EXISTS chat_channels_slug_idx ON chat_channels(slug)`;
console.log("chat_channels ready");

await sql`
  CREATE TABLE IF NOT EXISTS chat_messages (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_id uuid NOT NULL REFERENCES chat_channels(id) ON DELETE CASCADE,
    sender_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    sender_name varchar(120),
    body text NOT NULL,
    edited_at timestamp with time zone,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone NOT NULL DEFAULT NOW()
  )
`;
await sql`CREATE INDEX IF NOT EXISTS chat_messages_channel_idx ON chat_messages(channel_id, created_at DESC)`;
console.log("chat_messages ready");

// Channel memberships (for private channels later)
await sql`
  CREATE TABLE IF NOT EXISTS chat_memberships (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_id uuid NOT NULL REFERENCES chat_channels(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    joined_at timestamp with time zone NOT NULL DEFAULT NOW(),
    last_read_at timestamp with time zone NOT NULL DEFAULT NOW(),
    UNIQUE(channel_id, user_id)
  )
`;
console.log("chat_memberships ready");

// Seed default channels
const channels = [
  { slug: 'general', name: 'General', description: 'Team-wide announcements and chat', sort_order: 0 },
  { slug: 'hei', name: 'HEI', description: 'Truth Report methodology and institution operations', sort_order: 1 },
  { slug: 'engineering', name: 'Engineering', description: 'Codebase, builds, deploys, bugs', sort_order: 2 },
  { slug: 'random', name: 'Random', description: 'Off-topic, fun', sort_order: 9 }
];
for (const c of channels) {
  await sql`
    INSERT INTO chat_channels (slug, name, description, sort_order)
    VALUES (${c.slug}, ${c.name}, ${c.description}, ${c.sort_order})
    ON CONFLICT (slug) DO NOTHING
  `;
  console.log("Seeded channel: " + c.slug);
}

console.log("\nDone.");
await sql.end();
