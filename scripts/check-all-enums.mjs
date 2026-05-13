import "dotenv/config";
import postgres from "postgres";
const sql = postgres(process.env.DATABASE_URL, { max: 1 });

const enums = await sql`
  SELECT t.typname, array_agg(e.enumlabel ORDER BY e.enumsortorder) as values
  FROM pg_type t
  JOIN pg_enum e ON e.enumtypid = t.oid
  GROUP BY t.typname
  ORDER BY t.typname
`;
console.log("=== ALL ENUMS IN DB ===");
enums.forEach(e => console.log("  " + e.typname + " : [" + e.values.join(", ") + "]"));

await sql.end();
