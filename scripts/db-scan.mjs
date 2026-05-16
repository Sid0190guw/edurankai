import "dotenv/config";
import postgres from "postgres";
const sql = postgres(process.env.DATABASE_URL, { max: 1 });

const tables = [
  "users", "applications", "offer_letters",
  "chat_channels", "chat_messages", "chat_memberships",
  "chat_attachments", "chat_audit_log",
  "team_roles", "role_permissions", "user_role_assignments",
  "brand_profiles", "application_messages"
];

for (const t of tables) {
  try {
    const r = await sql.unsafe("SELECT count(*) AS n FROM " + t);
    const cols = await sql`
      SELECT count(*) AS c FROM information_schema.columns WHERE table_name = ${t}
    `;
    console.log("  OK " + t.padEnd(30) + " rows: " + String(r[0].n).padStart(5) + "   columns: " + cols[0].c);
  } catch (e) {
    console.log("  MISSING/ERROR " + t + ": " + e.message);
  }
}

await sql.end();
