import 'dotenv/config';
import postgres from 'postgres';

const sql = postgres(process.env.DATABASE_URL, { max: 1 });

console.log('Creating application_messages table...');

await sql.unsafe(`
  CREATE TABLE IF NOT EXISTS application_messages (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    application_id uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
    sender_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
    sender_role varchar(20) NOT NULL,
    sender_name varchar(200),
    body text NOT NULL,
    is_system boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now()
  );
`);

await sql.unsafe(`CREATE INDEX IF NOT EXISTS app_msg_app_idx ON application_messages (application_id);`);
await sql.unsafe(`CREATE INDEX IF NOT EXISTS app_msg_created_idx ON application_messages (created_at);`);

const check = await sql.unsafe(`SELECT COUNT(*) as c FROM application_messages;`);
console.log('Table ready. Row count:', check[0].c);

await sql.end();
