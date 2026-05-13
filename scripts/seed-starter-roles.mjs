import 'dotenv/config';
import postgres from 'postgres';

const sql = postgres(process.env.DATABASE_URL, { max: 1 });

const roles = [
  {
    title: "Product-Specific Intern",
    slug: "product-specific-intern",
    departmentId: "founders",
    level: "Intern",
    function: "Own and build a full product within the EduRankAI ecosystem",
    engagementType: "Internship",
    location: "Remote",
    duration: "3-6 Months",
    salary: "Unpaid + Revenue Share on the product you ship + Fast-track to ESOP-eligible Founder Office role on exceptional contribution",
    about: "This is EduRankAI's most ambitious internship. You will be handed full ownership of a real product within the EduRankAI ecosystem - not a side project, not a feature, but an entire product. You build it. You launch it. You drive its first revenue. Exceptional performers are fast-tracked into Founder Office full-time roles with ESOP allocation. The reward is real, the work is real, and the product you ship is yours to point to forever.",
    responsibilities: [
      "Take complete ownership of an assigned product from concept to launch",
      "Define the product roadmap, scope, and success metrics independently",
      "Drive the product to generate its first revenue",
      "Own go-to-market: positioning, outreach, and user acquisition",
      "Report weekly to the Founder Office with progress, blockers, and metrics"
    ],
    skills: ["Product Thinking", "Initiative", "Problem Solving", "Communication", "Resourcefulness", "Drive"],
    eligibility: [
      "Any educational background - hunger and capability matter most",
      "Demonstrated ability to build, ship, or create something",
      "Comfort with ambiguity and working with minimal supervision",
      "Strong written and verbal English"
    ],
    isOpen: true,
    isFeatured: true,
    sortOrder: 1
  },
  {
    title: "Managing Intern",
    slug: "managing-intern",
    departmentId: "founders",
    level: "Intern",
    function: "Coordinate and manage the intern cohort",
    engagementType: "Internship",
    location: "Remote",
    duration: "3 Months",
    salary: "Unpaid + Direct mentorship from Founder Office + Strong reference letter + Priority pathway to full-time leadership roles",
    about: "The Managing Intern sits at the heart of EduRankAI's internship programme, acting as the operational hub between the Founder Office and the wider intern cohort. You coordinate, you unblock, you keep the engine running. The role is invisible when done well and absolutely critical. Standout performers are first in line for full-time operations and people-leadership roles.",
    responsibilities: [
      "Coordinate daily and weekly tasks across the intern cohort",
      "Onboard new interns and orient them to processes",
      "Track deliverable progress and flag delays to the Founder Office",
      "Maintain intern documentation, rosters, schedules, and output logs"
    ],
    skills: ["Organisation", "Leadership", "Communication", "Google Workspace", "People Management"],
    eligibility: [
      "Pursuing or recently completed any undergraduate degree",
      "Demonstrated experience organising people or projects",
      "High emotional intelligence and ability to manage peers",
      "Availability: 2.5 hrs/day, 5 days/week"
    ],
    isOpen: true,
    isFeatured: false,
    sortOrder: 2
  },
  {
    title: "CEO",
    slug: "ceo",
    departmentId: "exec",
    level: "C-Level",
    function: "Overall vision and execution control",
    engagementType: "Full-Time",
    location: "Remote / Any",
    duration: "Permanent",
    salary: "Founder-level package + Major ESOP allocation + Compensation discussed individually with shortlisted candidates",
    about: "Own the overall vision, strategy, and execution of EduRankAI. The CEO sets the direction for everything the company does, builds the team, and is ultimately responsible for outcomes. This is not a hire - this is a partnership. Compensation reflects that.",
    responsibilities: [
      "Set and communicate EduRankAI mission and long-term strategy",
      "Build and lead the executive leadership team",
      "Own fundraising, investor relations, and board management",
      "Make high-stakes decisions on product, people, and partnerships",
      "Represent EduRankAI externally to media, partners, and the public"
    ],
    skills: ["Strategic Leadership", "Vision Setting", "Team Building", "Fundraising", "Communication", "Execution"],
    eligibility: [
      "Proven entrepreneurial or executive leadership experience",
      "Deep understanding of AI, EdTech, or technology sectors",
      "Track record of building and scaling teams and organisations",
      "Exceptional communication and stakeholder management skills"
    ],
    isOpen: true,
    isFeatured: true,
    sortOrder: 1
  },
  {
    title: "Senior ML Engineer",
    slug: "senior-ml-engineer",
    departmentId: "ai",
    level: "Senior",
    function: "Model optimization and scaling",
    engagementType: "Full-Time",
    location: "Remote / Any",
    duration: "Permanent",
    salary: "Senior package + Top-quartile for Bharat-based AI startups + Significant ESOP allocation + Reviewed annually",
    about: "Own the performance and efficiency of EduRankAI's core models. Train, optimize, and deploy frontier educational intelligence systems at scale. Work directly with the Chief AI Officer on architecture decisions that compound for years.",
    responsibilities: [
      "Optimize model training runs for throughput and cost efficiency",
      "Implement PEFT methods (LoRA, QLoRA) for targeted fine-tuning",
      "Benchmark model quality and regression-test across releases",
      "Support inference team with model export and quantization"
    ],
    skills: ["PyTorch", "Transformers", "CUDA", "Distributed Training", "HuggingFace"],
    eligibility: [
      "5+ years ML engineering experience",
      "Hands-on with large model training (1B+ parameters preferred)",
      "Production deployment experience"
    ],
    isOpen: true,
    isFeatured: true,
    sortOrder: 2
  },
  {
    title: "Product Manager",
    slug: "product-manager",
    departmentId: "product",
    level: "Senior",
    function: "Roadmap and execution",
    engagementType: "Full-Time",
    location: "Remote / Any",
    duration: "Permanent",
    salary: "Competitive + Above-market for Bharat-based candidates + ESOP eligible + Performance reviews twice yearly",
    about: "Own and drive high-impact product areas from discovery through delivery. Define what EduRankAI builds next and why. Direct line to the founding team - your decisions ship.",
    responsibilities: [
      "Own a product area from discovery to launch",
      "Write clear PRDs and user stories",
      "Conduct user interviews and synthesize insights",
      "Define and track KPIs for your product area"
    ],
    skills: ["Product Management", "Agile", "User Research", "Data Analysis", "Stakeholder Communication"],
    eligibility: [
      "4+ years in product management",
      "Shipped products that real users used",
      "Strong written communication"
    ],
    isOpen: true,
    isFeatured: false,
    sortOrder: 3
  },
  {
    title: "AI Safety Engineer",
    slug: "ai-safety-engineer",
    departmentId: "safety",
    level: "Senior",
    function: "Guardrails design and red-teaming",
    engagementType: "Full-Time",
    location: "Remote / Any",
    duration: "Permanent",
    salary: "Senior package + Top-quartile for Bharat-based AI startups + Significant ESOP allocation",
    about: "Design, build, and evaluate technical guardrails for EduRankAI's AI systems. Ensure models behave safely across every learner interaction. Safety is a first-class engineering concern here, not a checkbox - your work materially shapes what we ship and what we don't.",
    responsibilities: [
      "Implement content safety classifiers and output filters",
      "Design red-teaming protocols and adversarial test suites",
      "Evaluate models for bias, toxicity, and fairness metrics",
      "Build monitoring pipelines for safety regressions"
    ],
    skills: ["Python", "Classifier Design", "Red-Teaming", "Model Evaluation", "NLP", "Fairness Metrics"],
    eligibility: [
      "5+ years in ML engineering or AI safety research",
      "Published work or applied projects in AI safety preferred"
    ],
    isOpen: true,
    isFeatured: false,
    sortOrder: 4
  }
];

console.log('Inserting ' + roles.length + ' starter roles...');

let inserted = 0;
let updated = 0;

for (const r of roles) {
  const existing = await sql`SELECT id FROM roles WHERE slug = ${r.slug} LIMIT 1`;
  if (existing.length > 0) {
    await sql`
      UPDATE roles SET
        department_id = ${r.departmentId},
        salary = ${r.salary},
        about = ${r.about},
        updated_at = NOW()
      WHERE slug = ${r.slug}
    `;
    console.log('  ~ UPDATE: ' + r.title);
    updated++;
    continue;
  }

  await sql`
    INSERT INTO roles (
      title, slug, department_id, level, function, engagement_type,
      location, duration, salary, about, responsibilities, skills, eligibility,
      is_open, is_featured, sort_order, created_at, updated_at
    ) VALUES (
      ${r.title}, ${r.slug}, ${r.departmentId}, ${r.level}, ${r.function}, ${r.engagementType},
      ${r.location}, ${r.duration}, ${r.salary}, ${r.about},
      ${r.responsibilities}, ${r.skills}, ${r.eligibility},
      ${r.isOpen}, ${r.isFeatured}, ${r.sortOrder}, NOW(), NOW()
    )
  `;
  console.log('  + INSERT: ' + r.title);
  inserted++;
}

console.log('');
console.log('Done. Inserted: ' + inserted + ', Updated: ' + updated);

const total = await sql`SELECT count(*)::int as c FROM roles`;
console.log('Total roles in DB: ' + total[0].c);

await sql.end();
