import "dotenv/config";
import postgres from "postgres";
const sql = postgres(process.env.DATABASE_URL, { max: 1 });

const levels = await sql`SELECT enum_range(NULL::role_level_enum) as r`;
console.log("Level enum:", levels[0].r);

const engs = await sql`SELECT enum_range(NULL::engagement_type_enum) as r`;
console.log("Engagement enum:", engs[0].r);

await sql.end();
