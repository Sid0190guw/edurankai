import "dotenv/config";
import postgres from "postgres";
const sql = postgres(process.env.DATABASE_URL, { max: 1 });

console.log("Creating HEI core tables...\n");

// 1. Institutions (universities/colleges/schools/govt programmes being ranked)
await sql`
  CREATE TABLE IF NOT EXISTS hei_institutions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    slug varchar(150) NOT NULL UNIQUE,
    name varchar(300) NOT NULL,
    tier varchar(20) NOT NULL DEFAULT 'university',
    country varchar(100) NOT NULL DEFAULT 'India',
    state_region varchar(100),
    city varchar(100),
    type varchar(50),
    established_year integer,
    student_count integer,
    website_url text,
    nirf_rank integer,
    qs_rank integer,
    the_rank integer,
    truth_score numeric(5,2),
    truth_rank integer,
    has_full_data boolean NOT NULL DEFAULT false,
    is_published boolean NOT NULL DEFAULT false,
    notes text,
    created_at timestamp with time zone NOT NULL DEFAULT NOW(),
    updated_at timestamp with time zone NOT NULL DEFAULT NOW()
  )
`;
console.log("  hei_institutions ready");

// 2. Methodology dimensions (the 7 core dimensions)
await sql`
  CREATE TABLE IF NOT EXISTS hei_dimensions (
    id varchar(50) PRIMARY KEY,
    sort_order integer NOT NULL DEFAULT 0,
    title varchar(200) NOT NULL,
    subtitle varchar(300),
    weight_percent numeric(4,1) NOT NULL DEFAULT 0,
    blurb text NOT NULL,
    evidence_basis text,
    is_published boolean NOT NULL DEFAULT true,
    created_at timestamp with time zone NOT NULL DEFAULT NOW(),
    updated_at timestamp with time zone NOT NULL DEFAULT NOW()
  )
`;
console.log("  hei_dimensions ready");

// 3. Sub-metrics under each dimension
await sql`
  CREATE TABLE IF NOT EXISTS hei_submetrics (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    dimension_id varchar(50) NOT NULL REFERENCES hei_dimensions(id) ON DELETE CASCADE,
    sort_order integer NOT NULL DEFAULT 0,
    title varchar(300) NOT NULL,
    description text,
    weight_within_dimension numeric(4,1) NOT NULL DEFAULT 0,
    created_at timestamp with time zone NOT NULL DEFAULT NOW()
  )
`;
console.log("  hei_submetrics ready");

// 4. Stories / investigations (newspaper-style content)
await sql`
  CREATE TABLE IF NOT EXISTS hei_stories (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    slug varchar(200) NOT NULL UNIQUE,
    headline varchar(500) NOT NULL,
    deck text,
    body text NOT NULL,
    category varchar(50) NOT NULL DEFAULT 'investigation',
    institution_id uuid REFERENCES hei_institutions(id) ON DELETE SET NULL,
    author_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
    is_published boolean NOT NULL DEFAULT false,
    published_at timestamp with time zone,
    cover_image_url text,
    created_at timestamp with time zone NOT NULL DEFAULT NOW(),
    updated_at timestamp with time zone NOT NULL DEFAULT NOW()
  )
`;
console.log("  hei_stories ready");

// Indexes
await sql`CREATE INDEX IF NOT EXISTS hei_inst_tier_idx ON hei_institutions(tier)`;
await sql`CREATE INDEX IF NOT EXISTS hei_inst_country_idx ON hei_institutions(country)`;
await sql`CREATE INDEX IF NOT EXISTS hei_inst_published_idx ON hei_institutions(is_published) WHERE is_published = true`;
await sql`CREATE INDEX IF NOT EXISTS hei_sub_dim_idx ON hei_submetrics(dimension_id)`;
await sql`CREATE INDEX IF NOT EXISTS hei_story_published_idx ON hei_stories(is_published, published_at DESC)`;
console.log("\nIndexes added.");

// Seed 7 dimensions
console.log("\nSeeding dimensions...");
const dimensions = [
  { id: 'academic_excellence', order: 1, title: 'Academic Excellence', subtitle: 'Whether students actually learn', weight: 25.0, blurb: 'Whether students walk out genuinely capable. Not reputation. Not endowment. Not famous faculty names.' },
  { id: 'research_innovation', order: 2, title: 'Research & Innovation', subtitle: 'Originality, not citation cartels', weight: 15.0, blurb: 'Research that genuinely moves a field forward. Penalises citation gaming and self-citation rings.' },
  { id: 'student_wellbeing', order: 3, title: 'Student Well-being', subtitle: 'The dimension every other ranking ignores', weight: 20.0, blurb: 'Mental health. Burnout. Belonging. Basic-needs security. Forty-seven per cent of OECD students reported significant distress. Zero per cent of QS weight reflects this.' },
  { id: 'equity_access', order: 4, title: 'Equity & Access', subtitle: 'No discrimination on any basis', weight: 15.0, blurb: 'Measured across caste, religion, gender, economic background, region of origin, disability, language, sexual orientation, and viewpoint.' },
  { id: 'ethical_impact', order: 5, title: 'Ethical & Social Impact', subtitle: 'What the institution returns to the world', weight: 10.0, blurb: 'Environmental responsibility. Civic engagement. Ethics in curriculum. Governance transparency.' },
  { id: 'adaptability', order: 6, title: 'Adaptability', subtitle: 'Whether the institution can still learn', weight: 10.0, blurb: 'Curriculum revision velocity. Student feedback response. Technology adoption. Policy responsiveness.' },
  { id: 'transparency', order: 7, title: 'Transparency & Governance', subtitle: 'Open books, open process', weight: 5.0, blurb: 'Public financial reports. Open hiring criteria. Disclosure of conflicts of interest. Right of reply protocols.' }
];

for (const d of dimensions) {
  const exists = await sql`SELECT 1 FROM hei_dimensions WHERE id = ${d.id}`;
  if (exists.length === 0) {
    await sql`
      INSERT INTO hei_dimensions (id, sort_order, title, subtitle, weight_percent, blurb, is_published)
      VALUES (${d.id}, ${d.order}, ${d.title}, ${d.subtitle}, ${d.weight}, ${d.blurb}, true)
    `;
    console.log("  seeded: " + d.title + " (" + d.weight + "%)");
  } else {
    console.log("  exists: " + d.title);
  }
}

const sum = dimensions.reduce((s, d) => s + d.weight, 0);
console.log("\nTotal weight: " + sum + "% " + (sum === 100 ? "✓" : "✗ should be 100"));

await sql.end();
