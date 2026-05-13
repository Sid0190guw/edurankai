import 'dotenv/config';
import postgres from 'postgres';
const sql = postgres(process.env.DATABASE_URL, { max: 1 });

// Check if contact_submissions table exists
const exists = await sql`
  SELECT EXISTS (
    SELECT FROM information_schema.tables WHERE table_name = 'contact_submissions'
  ) as e;
`;
console.log('contact_submissions exists:', exists[0].e);

if (!exists[0].e) {
  console.log('Creating contact_submissions table...');
  await sql.unsafe(`
    CREATE TABLE contact_submissions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name varchar(200),
      email varchar(255) NOT NULL,
      subject varchar(300),
      category varchar(50),
      message text NOT NULL,
      status varchar(20) NOT NULL DEFAULT 'new',
      handled_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
      handled_at timestamptz,
      ip_address varchar(64),
      user_agent text,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  await sql.unsafe(`CREATE INDEX contact_submissions_status_idx ON contact_submissions (status);`);
  await sql.unsafe(`CREATE INDEX contact_submissions_created_idx ON contact_submissions (created_at);`);
  console.log('Table created.');
} else {
  console.log('Table already exists - skipping creation.');
}

const cnt = await sql`SELECT COUNT(*) as c FROM contact_submissions;`;
console.log('Total submissions:', cnt[0].c);

await sql.end();
