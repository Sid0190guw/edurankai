import "dotenv/config";
import postgres from "postgres";
const sql = postgres(process.env.DATABASE_URL, { max: 1 });
const r = await sql`SELECT department_id, COUNT(*) as c FROM roles GROUP BY department_id ORDER BY c DESC;`;
console.log("Roles per department in DB:");
r.forEach(row => console.log("  " + row.department_id + ": " + row.c));
const t = await sql`SELECT COUNT(*) as c FROM roles;`;
console.log("Total: " + t[0].c);
await sql.end();
