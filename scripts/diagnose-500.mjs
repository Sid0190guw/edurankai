import "dotenv/config";
import postgres from "postgres";
const sql = postgres(process.env.DATABASE_URL, { max: 1 });

// Check if role_page_permissions table exists
const t1 = await sql`SELECT to_regclass('role_page_permissions') as t`;
console.log("role_page_permissions exists:", t1[0].t !== null);

// Check if admin_conversations exists
const t2 = await sql`SELECT to_regclass('admin_conversations') as t`;
console.log("admin_conversations exists:", t2[0].t !== null);

// Check if admin_messages exists
const t3 = await sql`SELECT to_regclass('admin_messages') as t`;
console.log("admin_messages exists:", t3[0].t !== null);

// Check messages permission seeded
const t4 = await sql`SELECT role, can_view FROM role_page_permissions WHERE page_id = 'messages'`;
console.log("\nmessages page permissions:");
t4.forEach(r => console.log("  " + r.role + ": " + r.can_view));

await sql.end();
