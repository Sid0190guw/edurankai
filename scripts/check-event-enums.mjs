import 'dotenv/config';
import postgres from 'postgres';
const sql = postgres(process.env.DATABASE_URL, { max: 1 });

const enumVals = await sql`
  SELECT t.typname, e.enumlabel
  FROM pg_type t
  JOIN pg_enum e ON e.enumtypid = t.oid
  WHERE t.typname LIKE 'event%'
  ORDER BY t.typname, e.enumsortorder;
`;
console.log('=== Event enums ===');
enumVals.forEach(e => console.log(' -', e.typname, '|', e.enumlabel));

await sql.end();
