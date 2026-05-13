import 'dotenv/config';
import postgres from 'postgres';
const sql = postgres(process.env.DATABASE_URL, { max: 1 });
const result = await sql`DELETE FROM application_drafts WHERE email = 'test1@example.com'`;
console.log('Drafts cleared: ' + result.count);
await sql.end();
