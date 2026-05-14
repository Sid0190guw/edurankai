import "dotenv/config";
import { scrypt as scryptCb, randomBytes, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { writeFileSync } from "node:fs";
import postgres from "postgres";

const scrypt = promisify(scryptCb);
const sql = postgres(process.env.DATABASE_URL, { max: 1 });

async function hashPassword(password) {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, 64);
  return salt.toString("hex") + ":" + derived.toString("hex");
}

async function verifyPassword(stored, candidate) {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(hashHex, "hex");
  const derived = await scrypt(candidate, salt, 64);
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}

// Generate strong password
const newPw = "Marketing" + Math.floor(1000 + Math.random()*9000) + "!Bharat";
const hash = await hashPassword(newPw);

await sql`
  UPDATE users
  SET password_hash = ${hash}, email_verified = true, updated_at = NOW()
  WHERE email = 'dev@edurankai.in'
`;

// Sanity-check it works
const got = await sql`SELECT password_hash, role, is_active FROM users WHERE email = 'dev@edurankai.in'`;
const verifyOk = await verifyPassword(got[0].password_hash, newPw);

const result = {
  email: "dev@edurankai.in",
  password: newPw,
  role: got[0].role,
  isActive: got[0].is_active,
  verifySelfTest: verifyOk
};

console.log("\nResetting dev@edurankai.in password.");
console.log("Self-test verify: " + (verifyOk ? "PASS ✓" : "FAIL ✗"));
console.log("Role:", got[0].role, "| Active:", got[0].is_active);
console.log("\nNew password written to file: C:\\Users\\user\\Desktop\\dev-password.txt");

writeFileSync(
  "C:\\Users\\user\\Desktop\\dev-password.txt",
  "Email: dev@edurankai.in\nPassword: " + newPw + "\nRole: " + got[0].role + "\nLogin at: https://www.edurankai.in/admin/login\n\nDelete this file after saving to password manager.\n"
);

await sql.end();
