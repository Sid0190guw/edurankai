import "dotenv/config";
import postgres from "postgres";
import { scrypt as scryptCb, randomBytes } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb);
const KEY_LEN = 64;

async function hashPassword(password) {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, KEY_LEN);
  return "scrypt$" + salt.toString("hex") + "$" + derived.toString("hex");
}

const sql = postgres(process.env.DATABASE_URL, { max: 1 });

const offers = await sql`SELECT id, candidate_name, candidate_email, token FROM offer_letters WHERE plaintext_password IS NULL LIMIT 1`;
if (offers.length === 0) {
  console.log("No offers need backfilling.");
  await sql.end();
  process.exit(0);
}

const offer = offers[0];

function genPw() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let p = '';
  for (let i = 0; i < 16; i++) {
    if (i > 0 && i % 4 === 0) p += '-';
    p += chars[Math.floor(Math.random() * chars.length)];
  }
  return p;
}

const pw = genPw();
const hashed = await hashPassword(pw);

let userId;
const existingUsers = await sql`SELECT id FROM users WHERE email = ${offer.candidate_email} LIMIT 1`;
if (existingUsers.length > 0) {
  userId = existingUsers[0].id;
  await sql`UPDATE users SET password_hash = ${hashed}, updated_at = NOW() WHERE id = ${userId}`;
  console.log("Updated existing user: " + offer.candidate_email);
} else {
  const inserted = await sql`
    INSERT INTO users (email, name, password_hash, role, is_active)
    VALUES (${offer.candidate_email}, ${offer.candidate_name}, ${hashed}, 'editor', true)
    RETURNING id
  `;
  userId = inserted[0].id;
  console.log("Created new user: " + offer.candidate_email);
}

await sql`UPDATE offer_letters SET plaintext_password = ${pw}, created_user_id = ${userId} WHERE id = ${offer.id}`;

console.log("");
console.log("=== Offer credentials backfilled ===");
console.log("Token:    " + offer.token);
console.log("Email:    " + offer.candidate_email);
console.log("Password: " + pw);
console.log("");
console.log("Test URL: https://www.edurankai.in/portal/offer/" + offer.token);

await sql.end();
