import 'dotenv/config';
import postgres from 'postgres';

const sql = postgres(process.env.DATABASE_URL, { max: 1 });

console.log('Creating offer_letters table...');

await sql.unsafe(`
  CREATE TABLE IF NOT EXISTS offer_letters (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    token varchar(64) NOT NULL UNIQUE,
    application_id uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
    generated_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
    status varchar(20) NOT NULL DEFAULT 'draft',
    template_type varchar(30) NOT NULL DEFAULT 'intern',
    language varchar(5) NOT NULL DEFAULT 'en',
    content jsonb NOT NULL,
    candidate_name varchar(300) NOT NULL,
    candidate_email varchar(255) NOT NULL,
    role_title varchar(300) NOT NULL,
    department varchar(200),
    ref_number varchar(64) NOT NULL,
    integrity_hash varchar(16) NOT NULL,
    offer_date varchar(20),
    joining_date varchar(20),
    expiry_date varchar(20),
    response_deadline varchar(20),
    signed_at timestamptz,
    signature_data_url text,
    signature_ip varchar(64),
    signature_user_agent text,
    withdrawn_at timestamptz,
    withdrawn_reason text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
`);

await sql.unsafe(`CREATE INDEX IF NOT EXISTS offer_token_idx ON offer_letters (token);`);
await sql.unsafe(`CREATE INDEX IF NOT EXISTS offer_app_idx ON offer_letters (application_id);`);
await sql.unsafe(`CREATE INDEX IF NOT EXISTS offer_status_idx ON offer_letters (status);`);

const check = await sql`SELECT COUNT(*) as c FROM offer_letters;`;
console.log('Table ready. Row count:', check[0].c);

await sql.end();
