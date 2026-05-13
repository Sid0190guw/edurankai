import 'dotenv/config';
import postgres from 'postgres';
const sql = postgres(process.env.DATABASE_URL, { max: 1 });

const cols = await sql`SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'events' ORDER BY ordinal_position;`;
console.log('=== events columns ===');
cols.forEach(c => console.log(' -', c.column_name, '(' + c.data_type + ')'));

console.log('');
const existing = await sql`SELECT * FROM events LIMIT 1;`;
console.log('Existing events:', existing.length);

await sql.end();
