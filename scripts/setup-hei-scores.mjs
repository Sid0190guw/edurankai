import "dotenv/config";
import postgres from "postgres";
const sql = postgres(process.env.DATABASE_URL, { max: 1 });

await sql`
  CREATE TABLE IF NOT EXISTS hei_institution_scores (
    institution_id uuid NOT NULL REFERENCES hei_institutions(id) ON DELETE CASCADE,
    dimension_id varchar(50) NOT NULL REFERENCES hei_dimensions(id) ON DELETE CASCADE,
    score numeric(5,2) NOT NULL DEFAULT 0,
    notes text,
    updated_at timestamp with time zone NOT NULL DEFAULT NOW(),
    PRIMARY KEY (institution_id, dimension_id)
  )
`;
await sql`CREATE INDEX IF NOT EXISTS hei_scores_inst_idx ON hei_institution_scores(institution_id)`;
console.log("hei_institution_scores table ready");
await sql.end();
