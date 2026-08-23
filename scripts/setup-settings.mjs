import "dotenv/config";
import postgres from "postgres";
const sql = postgres(process.env.DATABASE_URL, { max: 1 });

await sql`
  CREATE TABLE IF NOT EXISTS site_settings (
    key varchar(100) PRIMARY KEY,
    value text NOT NULL DEFAULT '',
    category varchar(50) NOT NULL DEFAULT 'general',
    label varchar(200) NOT NULL DEFAULT '',
    description text,
    input_type varchar(20) NOT NULL DEFAULT 'text',
    updated_at timestamp with time zone NOT NULL DEFAULT NOW(),
    updated_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL
  )
`;
console.log("site_settings table ready");

// Seed defaults
const seeds = [
  // Site basics
  { key: 'site_name', value: 'EduRankAI', category: 'site', label: 'Site name', description: 'Used in titles and footer', input_type: 'text' },
  { key: 'site_tagline', value: 'Frontier AI research lab. Building toward ASI.', category: 'site', label: 'Tagline', description: 'Short line in meta description', input_type: 'text' },
  { key: 'site_description', value: 'EduRankAI is a Bharat-built frontier AI research lab building foundational models, reasoning systems, and the Holistic Education Index.', category: 'site', label: 'Description', description: 'Long description for SEO meta', input_type: 'textarea' },
  { key: 'site_url', value: 'https://www.edurankai.in', category: 'site', label: 'Canonical URL', description: 'Production URL', input_type: 'text' },

  // Emails
  { key: 'email_hr', value: 'hr@edurankai.in', category: 'email', label: 'HR email', description: 'Applicants contact this', input_type: 'email' },
  { key: 'email_hei', value: 'hei@edurankai.in', category: 'email', label: 'HEI feedback email', description: 'Methodology reviewers contact this', input_type: 'email' },
  { key: 'email_connect', value: 'connect.edurankai@gmail.com', category: 'email', label: 'General contact email', description: 'Public general inquiries', input_type: 'email' },
  { key: 'email_security', value: 'security@edurankai.in', category: 'email', label: 'Security disclosures email', description: 'Responsible disclosure', input_type: 'email' },

  // Hiring
  { key: 'hiring_response_sla_days', value: '5', category: 'hiring', label: 'Application response SLA (days)', description: 'How many business days to respond to applicants', input_type: 'number' },
  { key: 'hiring_internship_duration', value: '3 months', category: 'hiring', label: 'Default internship duration', description: '', input_type: 'text' },
  { key: 'hiring_apprenticeship_duration', value: '6 months', category: 'hiring', label: 'Default apprenticeship duration', description: '', input_type: 'text' },
  // Was 'hiring_remote_default' = true, "New roles default to remote". Nothing here is remote
  // (src/lib/work-mode.ts): permanent engagements are on site and only internships and
  // apprenticeships may be hybrid. A seeded default that says otherwise is how the wrong mode
  // gets back onto a new role, so the setting now records the mode a new role starts in and
  // the only two values it may hold.
  { key: 'hiring_default_work_mode', value: 'on-site', category: 'hiring', label: 'Default work mode for new roles', description: 'on-site, or hybrid (internships and apprenticeships only). Never remote.', input_type: 'text' },

  // Feature flags
  { key: 'feature_applicant_portal', value: 'true', category: 'features', label: 'Applicant portal enabled', description: 'Allow applicants to log in and track', input_type: 'bool' },
  { key: 'feature_contact_form', value: 'true', category: 'features', label: 'Contact form enabled', description: 'Public /contact page accepts submissions', input_type: 'bool' },
  { key: 'feature_signup_enabled', value: 'true', category: 'features', label: 'Public signup enabled', description: 'Allow new applicants to create accounts', input_type: 'bool' },
  { key: 'feature_maintenance_mode', value: 'false', category: 'features', label: 'Maintenance mode', description: 'Show maintenance page to all public visitors', input_type: 'bool' }
];

// Keys that were seeded once and are now wrong. The loop below only ever INSERTs when a key is
// absent, so renaming a seed leaves the old row sitting in an already-seeded database forever --
// 'hiring_remote_default' = true ("New roles default to remote") would have survived this rename
// on production and gone on contradicting the policy in src/lib/work-mode.ts, beside the new key
// rather than instead of it.
const RETIRED_KEYS = ['hiring_remote_default'];
for (const key of RETIRED_KEYS) {
  const gone = await sql`DELETE FROM site_settings WHERE key = ${key} RETURNING key`;
  console.log(gone.length ? "  retired: " + key : "  absent:  " + key);
}

for (const s of seeds) {
  const exists = await sql`SELECT key FROM site_settings WHERE key = ${s.key}`;
  if (exists.length === 0) {
    await sql`
      INSERT INTO site_settings (key, value, category, label, description, input_type)
      VALUES (${s.key}, ${s.value}, ${s.category}, ${s.label}, ${s.description}, ${s.input_type})
    `;
    console.log("  seeded: " + s.key);
  } else {
    console.log("  exists: " + s.key);
  }
}

await sql.end();
