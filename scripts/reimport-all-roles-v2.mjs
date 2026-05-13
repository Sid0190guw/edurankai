import "dotenv/config";
import { readFileSync } from "fs";
import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL, { max: 1 });

const html = readFileSync("scripts/seed-data/original-careers.html", "utf8");

const match = html.match(/var departments=(\[[\s\S]*?\n\];)/);
if (!match) { console.error("Could not find departments array"); process.exit(1); }

let jsArray = match[1].replace(/;$/, "");
jsArray = jsArray.replace(/([{,])(\s*)([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g, '$1$2"$3":');
jsArray = jsArray.replace(/,(\s*[}\]])/g, '$1');

const departments = JSON.parse(jsArray);
console.log(`Parsed ${departments.length} departments`);
let totalRoles = 0;
departments.forEach(d => totalRoles += d.roles.length);
console.log(`Total roles: ${totalRoles}`);

const DEPT_MAP = {
  founders: "founders", exec: "exec", ai: "ai", data: "data", infra: "infra",
  product: "product", safety_gov: "safety", research: "research", quantum: "quantum",
  psychology: "psychology", hr: "hr", legal: "legal", growth: "growth",
  dataengine: "dataengine", formdb: "formdb"
};

const ENGAGEMENT_MAP = {
  "Internship": "Internship",
  "Apprenticeship": "Apprenticeship",
  "Full-Time": "Full-Time",
  "Contract": "Full-Time",
  "Part-Time": "Full-Time"
};

// Roles table is already wiped from previous run
const before = await sql`SELECT COUNT(*) as c FROM roles`;
console.log(`Roles currently in DB: ${before[0].c}`);

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").substring(0, 80);
}

let inserted = 0, skipped = 0;
const seenSlugs = new Set();

for (const dept of departments) {
  const dbDeptId = DEPT_MAP[dept.id];
  if (!dbDeptId) { skipped += dept.roles.length; continue; }

  for (const role of dept.roles) {
    let slug = slugify(role.title);
    if (seenSlugs.has(slug)) slug = dbDeptId + "-" + slug;
    if (seenSlugs.has(slug)) slug = slug + "-" + (seenSlugs.size + 1);
    seenSlugs.add(slug);

    const engagement = ENGAGEMENT_MAP[role.type] || "Full-Time";

    try {
      await sql`
        INSERT INTO roles (
          slug, department_id, title, level, function,
          engagement_type, location, duration, salary, about,
          responsibilities, skills, eligibility,
          is_open, sort_order
        ) VALUES (
          ${slug}, ${dbDeptId}, ${role.title}, ${role.level}, ${role.func || ""},
          ${engagement}, ${role.location || "Remote / Any"}, ${role.duration || ""}, ${role.salary || ""}, ${role.about || ""},
          ${JSON.stringify(role.responsibilities || [])}::jsonb,
          ${JSON.stringify(role.skills || [])}::jsonb,
          ${JSON.stringify(role.eligibility || [])}::jsonb,
          true, ${inserted}
        )
      `;
      inserted++;
    } catch (e) {
      console.log(`FAIL ${role.title} (${dept.id}): ${e.message}`);
      skipped++;
    }
  }
}

console.log(`\n--- DONE ---`);
console.log(`Inserted: ${inserted}`);
console.log(`Skipped: ${skipped}`);

const counts = await sql`SELECT department_id, COUNT(*) as c FROM roles GROUP BY department_id ORDER BY c DESC`;
console.log("\nRoles per department:");
counts.forEach(r => console.log("  " + r.department_id + ": " + r.c));

const total = await sql`SELECT COUNT(*) as c FROM roles`;
console.log(`\nTotal in DB: ${total[0].c}`);

await sql.end();
