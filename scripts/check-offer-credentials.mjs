import "dotenv/config";
import postgres from "postgres";
const sql = postgres(process.env.DATABASE_URL, { max: 1 });

const offers = await sql`
  SELECT id, token, candidate_name, candidate_email, plaintext_password, created_user_id, created_at
  FROM offer_letters
  ORDER BY created_at DESC
  LIMIT 5
`;

console.log("Recent offers:");
for (const o of offers) {
  console.log("- Token: " + o.token);
  console.log("  Name: " + o.candidate_name + " (" + o.candidate_email + ")");
  console.log("  Password: " + (o.plaintext_password ? '"' + o.plaintext_password + '"' : '(NULL — pre-feature or failed)'));
  console.log("  CreatedUserId: " + (o.created_user_id || '(NULL)'));
  console.log("  Created: " + o.created_at);
  console.log("");
}

await sql.end();
