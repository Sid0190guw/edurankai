import "dotenv/config";
import postgres from "postgres";
const sql = postgres(process.env.DATABASE_URL, { max: 1 });

// All admin roles get full view+edit access to team messages
// (it's their own communication, doesnt expose anything sensitive)
const roles = ['super_admin', 'hr', 'recruiter', 'reviewer', 'department_head', 'marketing', 'editor'];
for (const r of roles) {
  const exists = await sql`SELECT 1 FROM role_page_permissions WHERE role = ${r} AND page_id = 'messages'`;
  if (exists.length === 0) {
    await sql`INSERT INTO role_page_permissions (role, page_id, can_view, can_edit) VALUES (${r}, 'messages', true, true)`;
    console.log("  added: " + r + " -> messages");
  }
}
await sql.end();
