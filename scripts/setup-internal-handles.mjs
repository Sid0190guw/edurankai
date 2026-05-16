import "dotenv/config";
import postgres from "postgres";
const sql = postgres(process.env.DATABASE_URL, { max: 1 });

console.log("=== Internal handles migration ===\n");

await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS internal_handle varchar(120)`;
await sql`CREATE UNIQUE INDEX IF NOT EXISTS users_internal_handle_unique ON users(internal_handle) WHERE internal_handle IS NOT NULL`;

console.log("users.internal_handle column ready + unique constraint added");

// Backfill existing users
const users = await sql`SELECT id, name, email FROM users WHERE internal_handle IS NULL`;
console.log("Users to backfill: " + users.length);

function normalize(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .substring(0, 30) || 'user';
}

for (const u of users) {
  const parts = (u.name || '').trim().split(/\s+/).filter(Boolean);
  const first = normalize(parts[0] || 'user');
  const last = normalize(parts[parts.length - 1] || '');

  let handle = first + '@edurankai.in';
  let suffix = 1;

  // Check collision
  while (true) {
    const existing = await sql`SELECT id FROM users WHERE internal_handle = ${handle} LIMIT 1`;
    if (existing.length === 0) break;
    suffix++;
    if (suffix === 2 && last && last !== first) {
      handle = first + '.' + last + '@edurankai.in';
    } else if (suffix === 3 && last) {
      handle = first + '.' + last + Math.random().toString(36).substring(2, 6) + '@edurankai.in';
    } else {
      handle = first + Math.random().toString(36).substring(2, 6) + '@edurankai.in';
    }
  }

  await sql`UPDATE users SET internal_handle = ${handle} WHERE id = ${u.id}`;
  console.log("  " + (u.name || u.email) + " -> " + handle);
}

console.log("\nDone.");
await sql.end();
