import 'dotenv/config';
import postgres from 'postgres';

const sql = postgres(process.env.DATABASE_URL, { max: 1 });

console.log('Widening salary column from varchar(100) to varchar(300)...');
await sql`ALTER TABLE roles ALTER COLUMN salary TYPE varchar(300)`;
console.log('Done.');

await sql.end();
