import "dotenv/config";
import { readFileSync } from "fs";
import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL, { max: 1 });

const html = readFileSync("scripts/seed-data/original-careers.html", "utf8");

// Extract the departments array from JS source
const match = html.match(/var departments=(\[[\s\S]*?\n\];)/);
if (!match) { console.error("Could not find departments array"); process.exit(1); }

let jsArray = match[1].replace(/;$/, "");

// Convert JS object syntax to valid JSON
// 1. Quote unquoted keys: {id:"x" -> {"id":"x"
jsArray = jsArray.replace(/([{,])(\s*)([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g, '$1$2"$3":');

// 2. Remove trailing commas before } or ]
jsArray = jsArray.replace(/,(\s*[}\]])/g, '$1');

let departments;
try {
  departments = JSON.parse(jsArray);
} catch (err) {
  console.error("Parse error at:", err.message);
  console.error("Context:", jsArray.substring(0, 200));
  process.exit(1);
}

console.log(`Parsed ${departments.length} departments`);
let totalRoles = 0;
departments.forEach(d => totalRoles += d.roles.length);
console.log(`Total roles in source: ${totalRoles}`);

// Source dept ID -> DB dept ID mapping
const DEPT_MAP = {
  founders: "founders",
  exec: "exec",
  ai: "ai",
  data: "data",
  infra: "infra",
  product: "product",
  safety_gov: "safety",
  research: "research",
  quantum: "quantum",
  psychology: "psychology",
  hr: "hr",
  legal: "legal",
  growth: "growth",
  dataengine: "dataengine",
  formdb: "formdb"
};

// Level mapping (source to DB enum)
const LEVEL_MAP = {
  "C-Level": "C-Level",
  "Lead": "Lead",
  "Senior": "Senior",
  "Mid": "Mid",
  "Junior": "Junior",
  "Intern": "Intern",
  "Apprentice": "Apprentice"
};

// Get current dept IDs from DB
const dbDepts = await sql`SELECT id FROM departments`;
const dbDeptIds = new Set(dbDepts.map(d => d.id));
console.log(`DB has ${dbDeptIds.size} departments:`, [...dbDeptIds].join(", "));

// Step 1: Wipe test app messages, offer letters, applications, then roles
console.log("\n--- WIPING test data ---");

const appsBefore = await sql`SELECT COUNT(*) as c FROM applications`;
console.log(`Applications before wipe: ${appsBefore[0].c}`);

await sql`DELETE FROM application_messages`;
await sql`DELETE FROM offer_letters`;
await sql`DELETE FROM applications`;
await sql`DELETE FROM roles`;

console.log("Wiped: application_messages, offer_letters, applications, roles");

// Step 2: Slugify titles
function slugify(s) {
  return s.toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .substring(0, 80);
}

// Step 3: Insert all roles
console.log("\n--- INSERTING 213 roles ---");
let inserted = 0;
let skipped = 0;
const seenSlugs = new Set();

for (const dept of departments) {
  const dbDeptId = DEPT_MAP[dept.id];
  if (!dbDeptId || !dbDeptIds.has(dbDeptId)) {
    console.log(`SKIP dept ${dept.id} - not mapped or not in DB`);
    skipped += dept.roles.length;
    continue;
  }

  for (const role of dept.roles) {
    let slug = slugify(role.title);
    // Disambiguate duplicates by adding dept prefix
    if (seenSlugs.has(slug)) {
      slug = dbDeptId + "-" + slug;
    }
    if (seenSlugs.has(slug)) {
      slug = slug + "-" + (seenSlugs.size + 1);
    }
    seenSlugs.add(slug);

    const level = LEVEL_MAP[role.level] || "Mid";

    try {
      await sql`
        INSERT INTO roles (
          slug, department_id, title, level,
          function_summary, employment_type, location_type,
          duration, compensation, about,
          responsibilities, required_skills, eligibility,
          is_open, sort_order
        ) VALUES (
          ${slug}, ${dbDeptId}, ${role.title}, ${level},
          ${role.func || null}, ${role.type || null}, ${role.location || null},
          ${role.duration || null}, ${role.salary || null}, ${role.about || null},
          ${JSON.stringify(role.responsibilities || [])}::jsonb,
          ${JSON.stringify(role.skills || [])}::jsonb,
          ${JSON.stringify(role.eligibility || [])}::jsonb,
          true, ${inserted}
        )
      `;
      inserted++;
    } catch (e) {
      console.log(`FAIL ${role.title} (${dept.id}):`, e.message);
      skipped++;
    }
  }
}

console.log(`\n--- DONE ---`);
console.log(`Inserted: ${inserted}`);
console.log(`Skipped: ${skipped}`);

// Verify
const counts = await sql`SELECT department_id, COUNT(*) as c FROM roles GROUP BY department_id ORDER BY department_id`;
console.log("\nRoles per department (after import):");
counts.forEach(r => console.log("  " + r.department_id + ": " + r.c));

const total = await sql`SELECT COUNT(*) as c FROM roles`;
console.log(`\nTotal in DB: ${total[0].c}`);

await sql.end();
