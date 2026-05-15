import "dotenv/config";
import postgres from "postgres";
const sql = postgres(process.env.DATABASE_URL, { max: 1 });

console.log("=== Institution flow tables ===\n");

// 1. Institution claims
await sql`
  CREATE TABLE IF NOT EXISTS institution_claims (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id uuid NOT NULL REFERENCES hei_institutions(id) ON DELETE CASCADE,
    claim_token varchar(80) NOT NULL UNIQUE,
    contact_name varchar(200) NOT NULL,
    contact_designation varchar(200) NOT NULL,
    contact_email varchar(255) NOT NULL,
    contact_phone varchar(50),
    letterhead_url text,
    additional_evidence_url text,
    status varchar(30) NOT NULL DEFAULT 'pending',
    decision_notes text,
    reviewed_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
    reviewed_at timestamp with time zone,
    submitted_at timestamp with time zone NOT NULL DEFAULT NOW(),
    created_at timestamp with time zone NOT NULL DEFAULT NOW()
  )
`;
await sql`CREATE INDEX IF NOT EXISTS inst_claims_status_idx ON institution_claims(status)`;
await sql`CREATE INDEX IF NOT EXISTS inst_claims_inst_idx ON institution_claims(institution_id)`;
console.log("institution_claims table ready");

// 2. Institution submissions (per-dimension scores with evidence)
await sql`
  CREATE TABLE IF NOT EXISTS institution_submissions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id uuid NOT NULL REFERENCES hei_institutions(id) ON DELETE CASCADE,
    submitted_by_email varchar(255) NOT NULL,
    submission_status varchar(30) NOT NULL DEFAULT 'submitted',
    notes text,
    submitted_at timestamp with time zone NOT NULL DEFAULT NOW(),
    reviewed_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
    reviewed_at timestamp with time zone,
    methodology_version varchar(10) NOT NULL DEFAULT 'v0.4'
  )
`;
console.log("institution_submissions table ready");

// 3. Per-dimension submitted scores with evidence URLs
await sql`
  CREATE TABLE IF NOT EXISTS institution_submission_scores (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    submission_id uuid NOT NULL REFERENCES institution_submissions(id) ON DELETE CASCADE,
    dimension_id varchar(50) NOT NULL,
    proposed_score numeric(5,2) NOT NULL,
    evidence_url text NOT NULL,
    evidence_description text,
    admin_decision varchar(20) NOT NULL DEFAULT 'pending',
    admin_accepted_score numeric(5,2),
    admin_notes text,
    reviewed_at timestamp with time zone
  )
`;
await sql`CREATE INDEX IF NOT EXISTS inst_sub_scores_sub_idx ON institution_submission_scores(submission_id)`;
await sql`CREATE INDEX IF NOT EXISTS inst_sub_scores_decision_idx ON institution_submission_scores(admin_decision)`;
console.log("institution_submission_scores table ready");

// 4. Findings (admin draft findings about an institution)
await sql`
  CREATE TABLE IF NOT EXISTS hei_findings (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    institution_id uuid NOT NULL REFERENCES hei_institutions(id) ON DELETE CASCADE,
    dimension_id varchar(50),
    finding_title varchar(500) NOT NULL,
    finding_body text NOT NULL,
    evidence_summary text NOT NULL,
    proposed_score_impact numeric(5,2),
    status varchar(30) NOT NULL DEFAULT 'draft',
    notice_sent_at timestamp with time zone,
    response_window_ends_at timestamp with time zone,
    institution_response text,
    institution_response_at timestamp with time zone,
    response_quality_score integer,
    d7_modifier numeric(3,1),
    published_at timestamp with time zone,
    created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamp with time zone NOT NULL DEFAULT NOW(),
    updated_at timestamp with time zone NOT NULL DEFAULT NOW()
  )
`;
await sql`CREATE INDEX IF NOT EXISTS findings_inst_idx ON hei_findings(institution_id)`;
await sql`CREATE INDEX IF NOT EXISTS findings_status_idx ON hei_findings(status)`;
console.log("hei_findings table ready");

console.log("\nAll 4 stage tables created.");
await sql.end();
