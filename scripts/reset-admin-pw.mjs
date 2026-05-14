import "dotenv/config";
import { scrypt as scryptCb, randomBytes } from "node:crypto";
import { promisify } from "node:util";
import postgres from "postgres";

const scrypt = promisify(scryptCb);
const sql = postgres(process.env.DATABASE_URL, { max: 1 });

function generatePassword() {
  const adj = ["Quantum", "Frontier", "Honest", "Curious", "Rooted", "Bharat"];
  const noun = ["Lab", "Index", "Anchor", "Beam", "Vector", "River"];
  const a = adj[Math.floor(Math.random() * adj.length)];
  const n = noun[Math.floor(Math.random() * noun.length)];
  const num = Math.floor(1000 + Math.random() * 9000);
  const sym = ["!", "#", "$", "@", "&"][Math.floor(Math.random() * 5)];
  return a + n + num + sym + a.toLowerCase().substring(0,3);
}

async function hashPassword(password) {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, 64);
  return `${salt.toString("hex")}:${derived.toString("hex")}`;
}

const newPassword = generatePassword();
const hashed = await hashPassword(newPassword);

const result = await sql`
  UPDATE users
  SET password_hash = ${hashed}, updated_at = NOW()
  WHERE email = 'siddharth@edurankai.in'
  RETURNING email, name, role
`;

if (result.length === 0) {
  console.log("ERROR: User siddharth@edurankai.in not found.");
} else {
  console.log("\n========================================");
  console.log("PASSWORD RESET SUCCESSFUL");
  console.log("========================================");
  console.log("Account:", result[0].email);
  console.log("Name:   ", result[0].name);
  console.log("Role:   ", result[0].role);
  console.log("\nNEW PASSWORD:", newPassword);
  console.log("\n>>> SAVE THIS PASSWORD NOW <<<");
  console.log(">>> It will not be shown again <<<");
  console.log("========================================\n");
}

await sql.end();
