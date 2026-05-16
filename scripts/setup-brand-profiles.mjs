import "dotenv/config";
import postgres from "postgres";
const sql = postgres(process.env.DATABASE_URL, { max: 1 });

console.log("=== Brand profiles for offer letters ===\n");

await sql`
  CREATE TABLE IF NOT EXISTS brand_profiles (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    slug varchar(60) NOT NULL UNIQUE,
    name varchar(120) NOT NULL,
    tagline varchar(200),
    primary_color varchar(20) NOT NULL DEFAULT '#FF4F00',
    domain varchar(120),
    is_active boolean NOT NULL DEFAULT true,
    sort_order integer NOT NULL DEFAULT 0,
    created_at timestamp with time zone NOT NULL DEFAULT NOW()
  )
`;

// Seed default brands
const seed = [
  { slug: 'edurankai', name: 'EduRankAI', tagline: 'BHARAT-BUILT FRONTIER AI LAB', primary_color: '#FF4F00', domain: 'edurankai.in', sort_order: 0 },
  { slug: 'karate-support', name: 'Karate Support', tagline: 'POWERED BY EDURANKAI', primary_color: '#FF4F00', domain: 'karate.support', sort_order: 1 },
  { slug: 'other', name: 'Other (Custom)', tagline: 'POWERED BY EDURANKAI', primary_color: '#FF4F00', domain: null, sort_order: 99 }
];

for (const b of seed) {
  await sql`
    INSERT INTO brand_profiles (slug, name, tagline, primary_color, domain, sort_order)
    VALUES (${b.slug}, ${b.name}, ${b.tagline}, ${b.primary_color}, ${b.domain}, ${b.sort_order})
    ON CONFLICT (slug) DO NOTHING
  `;
  console.log('Seeded brand: ' + b.slug);
}

console.log('\nDone.');
await sql.end();
