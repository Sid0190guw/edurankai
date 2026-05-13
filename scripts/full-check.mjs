import 'dotenv/config';
import postgres from 'postgres';
const sql = postgres(process.env.DATABASE_URL, { max: 1 });

// Get roles table columns
const cols = await sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'roles' ORDER BY ordinal_position;`;
console.log('=== roles columns ===');
cols.forEach(c => console.log(' -', c.column_name));

console.log('');
console.log('=== Counts ===');
const r = await sql`SELECT COUNT(*) as c FROM roles;`;
console.log('Roles total:', r[0].c);
const e = await sql`SELECT COUNT(*) as c FROM events;`;
console.log('Events:', e[0].c);
const p = await sql`SELECT COUNT(*) as c FROM products;`;
console.log('Products:', p[0].c);
const a = await sql`SELECT COUNT(*) as c FROM applications;`;
console.log('Applications:', a[0].c);
const m = await sql`SELECT COUNT(*) as c FROM application_messages;`;
console.log('Messages:', m[0].c);

console.log('');
console.log('=== First 10 roles ===');
const rolesSample = await sql`SELECT slug, title, department_id, level FROM roles ORDER BY created_at LIMIT 10;`;
rolesSample.forEach(r => console.log(' -', r.slug, '|', r.title, '|', r.department_id, '|', r.level));

console.log('');
console.log('=== Departments ===');
const depts = await sql`SELECT id, name FROM departments ORDER BY id;`;
depts.forEach(d => console.log(' -', d.id, '|', d.name));

await sql.end();
