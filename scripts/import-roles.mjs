import 'dotenv/config';
import fs from 'fs';
import postgres from 'postgres';

const sql = postgres(process.env.DATABASE_URL, { max: 1 });

function slugify(title) {
  return title.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

const p1 = JSON.parse(fs.readFileSync('scripts/seed-data/roles-part-1.json', 'utf8'));
const p2 = JSON.parse(fs.readFileSync('scripts/seed-data/roles-part-2.json', 'utf8'));
const allDepts = [...p1, ...p2];

// Get existing slugs to avoid duplicates
const existing = await sql`SELECT slug FROM roles;`;
const existingSlugs = new Set(existing.map(r => r.slug));
console.log('Existing slugs in DB:', existingSlugs.size);

// Get valid department IDs in DB
const depts = await sql`SELECT id FROM departments;`;
const validDepts = new Set(depts.map(d => d.id));
console.log('Valid departments:', validDepts.size);

let inserted = 0;
let skipped = 0;
let errors = 0;
let invalidDept = 0;

for (const dept of allDepts) {
  const deptId = dept.id;
  if (!validDepts.has(deptId)) {
    console.log(`SKIPPING department "${deptId}" - not in departments table`);
    invalidDept++;
    continue;
  }

  if (!Array.isArray(dept.roles)) continue;

  for (const role of dept.roles) {
    const slug = slugify(role.title);

    if (existingSlugs.has(slug)) {
      console.log(`  SKIP (exists): ${slug}`);
      skipped++;
      continue;
    }

    try {
      await sql`
        INSERT INTO roles (
          slug, department_id, title, level, function, engagement_type,
          location, duration, salary, about, responsibilities, skills, eligibility,
          is_open, is_featured, sort_order
        ) VALUES (
          ${slug},
          ${deptId},
          ${role.title},
          ${role.level},
          ${role.func || null},
          ${role.type || null},
          ${role.location || 'Remote'},
          ${role.duration || null},
          ${role.salary || null},
          ${role.about || null},
          ${JSON.stringify(role.responsibilities || [])}::jsonb,
          ${JSON.stringify(role.skills || [])}::jsonb,
          ${JSON.stringify(role.eligibility || [])}::jsonb,
          true,
          false,
          0
        );
      `;
      console.log(`  OK: [${deptId}/${role.level}] ${role.title}`);
      existingSlugs.add(slug);
      inserted++;
    } catch (err) {
      console.log(`  ERROR: ${slug} - ${err.message}`);
      errors++;
    }
  }
}

console.log('');
console.log('=== Summary ===');
console.log('Inserted:', inserted);
console.log('Skipped (already exists):', skipped);
console.log('Errors:', errors);
console.log('Invalid departments:', invalidDept);

const finalCount = await sql`SELECT COUNT(*) as c FROM roles WHERE is_open = true;`;
console.log('Total open roles in DB now:', finalCount[0].c);

await sql.end();
