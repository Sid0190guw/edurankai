import 'dotenv/config';
import postgres from 'postgres';

const sql = postgres(process.env.DATABASE_URL, { max: 1 });

console.log('Departments currently in your DB:');
console.log('');

const depts = await sql`SELECT id, name FROM departments ORDER BY sort_order`;
depts.forEach((d) => {
  console.log('  ' + d.id.padEnd(30) + ' -> ' + d.name);
});

console.log('');
console.log('Total: ' + depts.length + ' departments');

await sql.end();
