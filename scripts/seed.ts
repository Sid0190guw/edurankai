import 'dotenv/config';
import { db } from '../src/lib/db/index';
import { users, departments } from '../src/lib/db/schema';
import { hashPassword } from '../src/lib/auth/password';
import { eq } from 'drizzle-orm';

async function seed() {
  console.log('Seeding database...\n');

  // ─── 1. Super admin ───
  const adminEmail = process.env.SEED_ADMIN_EMAIL || 'admin@edurankai.in';
  const adminPwd = process.env.SEED_ADMIN_PASSWORD || 'ChangeMe2026!';
  const adminName = process.env.SEED_ADMIN_NAME || 'Super Admin';

  const existing = await db.select().from(users).where(eq(users.email, adminEmail));

  if (existing.length === 0) {
    const passwordHash = await hashPassword(adminPwd);
    await db.insert(users).values({
      email: adminEmail,
      passwordHash,
      name: adminName,
      role: 'super_admin',
      emailVerified: true,
      isActive: true
    });
    console.log(`✓ Created super_admin: ${adminEmail}`);
    console.log(`  Password (from .env): ${adminPwd}`);
  } else {
    console.log(`• super_admin already exists: ${adminEmail}`);
  }

  // ─── 2. Departments (idempotent — only inserts if missing) ───
  const depts = [
    { id: 'founders', name: "Founder's Office", icon: 'star', description: 'Our flagship programme. Sit inside the founding team. Own a product end-to-end.', isFlagship: true, sortOrder: 0 },
    { id: 'exec', name: 'Executive Leadership', icon: 'crown', description: 'C-Suite roles defining the future of EduRankAI.', sortOrder: 1 },
    { id: 'ai', name: 'AI / Model', icon: 'cpu', description: 'Core AI research, training, evaluation, and inference.', sortOrder: 2 },
    { id: 'data', name: 'Data and Statistics', icon: 'chart', description: 'Data engineering, science, governance, and analytics.', sortOrder: 3 },
    { id: 'infra', name: 'Infrastructure', icon: 'gear', description: 'Cloud, platforms, SRE, DevOps, and core engineering.', sortOrder: 4 },
    { id: 'product', name: 'Product and UX', icon: 'sparkle', description: 'Product management, design, research, and frontend.', sortOrder: 5 },
    { id: 'safety', name: 'AI Safety and Governance', icon: 'shield', description: 'AI safety, security, policy, ethics, and governance.', sortOrder: 6 },
    { id: 'research', name: 'Innovation and Research', icon: 'microscope', description: 'Fundamental research, prototypes, and frontier exploration.', sortOrder: 7 },
    { id: 'quantum', name: 'Quantum Systems', icon: 'atom', description: 'Quantum computing research and software engineering.', sortOrder: 8 },
    { id: 'psychology', name: 'Psychology and Human Factors', icon: 'brain', description: 'Cognitive science, learning science, and human-AI interaction.', sortOrder: 9 },
    { id: 'hr', name: 'HR and People', icon: 'people', description: 'Talent acquisition, people ops, and culture.', sortOrder: 10 },
    { id: 'legal', name: 'Legal, Finance and Strategy', icon: 'scales', description: 'Legal, finance, business strategy, operations, and sales.', sortOrder: 11 },
    { id: 'growth', name: 'Growth and Marketing', icon: 'rocket', description: 'Growth, marketing, content, SEO, and community.', sortOrder: 12 },
    { id: 'dataengine', name: 'Data Engine', icon: 'database', description: 'Product data strategy, instrumentation, and feedback loops.', sortOrder: 13 },
    { id: 'formdb', name: 'Form and Database Systems', icon: 'form', description: 'Internal form builder and database systems team.', sortOrder: 14 }
  ];

  let inserted = 0;
  for (const d of depts) {
    const exists = await db.select().from(departments).where(eq(departments.id, d.id));
    if (exists.length === 0) {
      await db.insert(departments).values(d);
      inserted++;
    }
  }
  console.log(`✓ Departments: ${inserted} inserted, ${depts.length - inserted} already existed`);

  console.log('\nSeed complete. You can now log in to /admin/login\n');
  process.exit(0);
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
