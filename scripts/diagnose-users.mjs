import "dotenv/config";
import postgres from "postgres";
const sql = postgres(process.env.DATABASE_URL, { max: 1 });

const newUsers = await sql`
  SELECT email, name, role, is_active, email_verified, 
         LENGTH(password_hash) as hash_len,
         SUBSTRING(password_hash, 1, 35) as hash_preview,
         created_at
  FROM users
  WHERE role != 'applicant'
  ORDER BY created_at DESC
  LIMIT 10
`;

console.log("\nAdmin users (most recent first):");
newUsers.forEach(u => {
  console.log("\n  " + u.email);
  console.log("    role:", u.role);
  console.log("    active:", u.is_active, "| verified:", u.email_verified);
  console.log("    hash_len:", u.hash_len);
  console.log("    hash_preview:", u.hash_preview);
  console.log("    created:", u.created_at);
});

await sql.end();
