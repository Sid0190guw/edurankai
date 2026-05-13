import 'dotenv/config';
import postgres from 'postgres';
const sql = postgres(process.env.DATABASE_URL, { max: 1 });

const ventures = [
  {
    slug: 'karate-support',
    name: 'Karate.support',
    emphasis_word: 'Karate',
    status: 'coming_soon',
    short_description: 'A unified platform for the global karate community: schools, students, tournaments, and progression tracking.',
    long_description: 'Karate.support is being built to give karate schools, students, and federations a single digital home. It brings together belt progression tracking, tournament registration, dojo discovery, and a member directory in one place. We are launching to a closed beta on 30 May 2026, starting with select dojos in India before opening more broadly. The product is being built with input from active practitioners and instructors, and is designed to support both traditional schools and modern training programs.',
    external_url: 'https://karate.support',
    icon_key: 'karate',
    sort_order: 1
  },
  {
    slug: 'aquintutor-ai',
    name: 'AquinTutor.ai',
    emphasis_word: 'Aquin',
    status: 'in_development',
    short_description: 'A tutoring system designed around how students actually learn, not how AI tutors typically lecture.',
    long_description: 'AquinTutor.ai is a long-form tutoring system that prioritizes understanding over engagement metrics. Most AI tutors today optimize for the wrong things - completion rates, time-on-app, surface-level correctness. AquinTutor is being built around the slower, harder questions: when does a student actually understand, when are they pattern-matching, and how should a tutor respond to confusion versus disengagement. We are in active development, with research partnerships forming around evaluation methodology. No public launch date yet - we will not ship until the pedagogy holds up.',
    external_url: null,
    icon_key: 'tutor',
    sort_order: 2
  },
  {
    slug: 'sambandh',
    name: 'Sambandh',
    emphasis_word: 'Sambandh',
    status: 'in_development',
    short_description: 'Connecting students with educators, mentors, and peer learners through purposeful matching.',
    long_description: 'Sambandh - Sanskrit for "connection" - is an early-stage product focused on building meaningful relationships in education. Most matching products optimize for engagement; Sambandh is being designed around outcomes - did this connection actually help the learner. We are in early build phase, exploring matching algorithms, conversation design, and trust mechanisms. More details will be shared as the design solidifies.',
    external_url: null,
    icon_key: 'connect',
    sort_order: 3
  },
  {
    slug: 'sancharan',
    name: 'Sancharan',
    emphasis_word: 'Sancharan',
    status: 'in_development',
    short_description: 'Communication infrastructure for educational organizations - structured messaging that respects attention.',
    long_description: 'Sancharan - Sanskrit for "movement" or "flow" - is a communication layer being designed for educational institutions, online programs, and learning communities. Existing tools (Slack, Discord, WhatsApp) were not designed for learning contexts. Sancharan is exploring what structured, asynchronous-first, attention-respecting communication looks like in education. Early build phase. Specifications under development.',
    external_url: null,
    icon_key: 'communication',
    sort_order: 4
  },
  {
    slug: 'sampark',
    name: 'Sampark',
    emphasis_word: 'Sampark',
    status: 'in_development',
    short_description: 'Bridging the gap between learning and the working world - internships, projects, and real-world application.',
    long_description: 'Sampark - Sanskrit for "contact" or "link" - is being designed to address the disconnect between formal education and actual work. Most platforms in this space (job boards, internship aggregators) treat the problem as a matching market. Sampark is exploring it as a learning-design problem: how do we structure the bridge between classroom and workplace so that both sides genuinely benefit. Early build phase, with pilot conversations underway.',
    external_url: null,
    icon_key: 'bridge',
    sort_order: 5
  },
  {
    slug: 'foundational-models',
    name: 'Foundational Models',
    emphasis_word: 'Foundational',
    status: 'research',
    short_description: 'Research arm exploring small, specialized models tuned for educational reasoning and safety.',
    long_description: 'Our foundational research arm investigates what frontier model capabilities look like when adapted for educational use cases. The focus is on smaller, specialized models that can reason about learner intent, detect misconceptions, and act under tight safety constraints - rather than general-purpose chatbots adapted to education. This is research-stage work; we share findings as they mature. Collaborators welcome.',
    external_url: null,
    icon_key: 'research',
    sort_order: 6
  }
];

console.log('Seeding products...');

let inserted = 0;
let skipped = 0;

for (const v of ventures) {
  const existing = await sql`SELECT id FROM products WHERE slug = ${v.slug};`;
  if (existing.length > 0) {
    console.log(`  SKIP (exists): ${v.slug}`);
    skipped++;
    continue;
  }

  await sql`
    INSERT INTO products (
      slug, name, emphasis_word, status, short_description, long_description,
      external_url, icon_key, sort_order, is_visible
    ) VALUES (
      ${v.slug}, ${v.name}, ${v.emphasis_word}, ${v.status}::product_status,
      ${v.short_description}, ${v.long_description},
      ${v.external_url}, ${v.icon_key}, ${v.sort_order}, true
    );
  `;
  console.log(`  OK: ${v.slug} (${v.status})`);
  inserted++;
}

console.log('');
console.log('Inserted:', inserted, '| Skipped:', skipped);

const finalCount = await sql`SELECT COUNT(*) as c FROM products WHERE is_visible = true;`;
console.log('Total visible products in DB:', finalCount[0].c);

await sql.end();
