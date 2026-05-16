import "dotenv/config";
import postgres from "postgres";
const sql = postgres(process.env.DATABASE_URL, { max: 1 });

console.log("=== Users with their role ===");
const users = await sql`SELECT id, name, email, role, internal_handle FROM users ORDER BY created_at DESC`;
for (const u of users) {
  console.log("- " + u.name.padEnd(25) + " | role=" + u.role.padEnd(15) + " | email=" + u.email + " | handle=" + (u.internal_handle || '-'));
}
await sql.end();
