import "dotenv/config";
import postgres from "postgres";
const sql = postgres(process.env.DATABASE_URL, { max: 1 });

const pages = [
  {
    slug: "hiring-philosophy",
    title: "Hiring Philosophy",
    metaDescription: "How EduRankAI hires - taste, judgment, proof of work over pedigree. No tricks. Honest stages. Senior evaluators.",
    body: `## What we look for\n\nWe hire for taste, judgment, and the ability to ship without supervision. Pedigree helps but does not substitute for proof of work. A strong portfolio link, a GitHub repo, a paper, a deployed product, a written critique — anything tangible — tells us more than a CV.\n\n## Our three principles\n\n- **Proof over claims.** Every candidate is asked to show real artifacts. We do not rely on resumes alone.\n- **Honest stages.** Applicants always know where they stand. Status is visible in the portal in real time. We do not ghost.\n- **Senior evaluators.** Candidates are interviewed by people at or above their target level. Junior engineers do not interview senior engineers.\n\n## Compensation\n\nInternships and apprenticeships at this stage are unpaid. Full-time roles are offered with real comp; details are discussed openly during the offer stage. We do not lowball — we share market context and our budget honestly. Equity (ESOP) is reserved for exceptional contribution.\n\n## Response time\n\nWe aim to respond within 5 business days of submission. If your application advances, you will hear quickly and clearly. If we do not move forward, we try to give honest, useful feedback rather than form rejections — though at scale this is not always possible.\n\n## No tricks\n\nWe do not use timed take-home assignments meant to stress-test you. We do not require coding under surveillance. Our evaluation is centered on a live walkthrough of your past work, in-depth conversation, and (for senior roles) collaborative debugging or system design.\n\n## Reapplying\n\nIf we say no this time, you can reapply for a different role or after 6 months. Many of our best candidates came back stronger on a second application.`,
    isPublished: true
  },
  {
    slug: "privacy",
    title: "Privacy Policy",
    metaDescription: "How EduRankAI collects, uses, and protects your data. Honest, minimal, traceable.",
    body: `## What we collect\n\nWhen you apply for a role, we collect the information you provide: name, email, contact details, education, work history, motivation answers, and any uploaded portfolio links or files. When you create an applicant portal account, we additionally store an account email and a hashed password.\n\nWhen you submit a contact form, we store your name, email, message, and the date.\n\nWe collect minimal technical metadata — IP address, user agent string — for security and abuse prevention only.\n\n## How we use it\n\nApplication data is used only to evaluate your candidacy for the role you applied to (and any future roles you opt in to be considered for). Contact form messages are used only to reply to you. Account data is used to authenticate you in the applicant portal.\n\nWe do not sell, rent, or share your data with third parties for marketing.\n\n## How long we keep it\n\nWe retain application data for 24 months from your last interaction with us, then delete it. Account data is retained while your account is active and deleted within 30 days of account closure. You can request deletion at any time by emailing hr@edurankai.in.\n\n## Your rights\n\nYou can request a copy of your data, ask us to correct it, or ask us to delete it. We will respond within 30 days. Email hr@edurankai.in.\n\n## Security\n\nWe encrypt data in transit (HTTPS everywhere) and at rest (database-level encryption). Passwords are hashed with Argon2id. Access to applicant data is restricted to a small number of named team members and logged in an audit trail.\n\n## Cookies\n\nWe use a single session cookie to keep you signed in to the applicant portal. We do not use third-party tracking cookies, ad cookies, or analytics that profile individuals.\n\n## Contact\n\nQuestions or requests: hr@edurankai.in`,
    isPublished: true
  },
  {
    slug: "terms",
    title: "Terms of Service",
    metaDescription: "Terms governing your use of EduRankAI's website and applicant portal.",
    body: `## Acceptance\n\nBy using this website (edurankai.in) or applying through it, you agree to these terms.\n\n## Use of the site\n\nYou may browse our public pages, apply to open roles, submit contact-form messages, and create an applicant portal account. You agree to provide accurate information in any application or message.\n\nYou agree not to: submit fraudulent applications; impersonate someone else; attempt to bypass security; scrape the site at volume; or use the site for any unlawful purpose.\n\n## Your content\n\nWhen you submit an application, you confirm that the information and any linked work is yours (or that you have permission to share it). You grant us a non-exclusive licence to use it solely for evaluation purposes.\n\n## Hiring decisions\n\nApplying does not guarantee a role. Hiring decisions are at our sole discretion based on our evaluation. We endeavour to give written feedback where possible, but we are not obligated to.\n\n## Availability\n\nWe operate the site on a best-effort basis. It may be unavailable for maintenance from time to time. We do not guarantee uptime.\n\n## Changes\n\nWe may update these terms. The current version is always at /p/terms. The \`Last updated\` date at the top of the page reflects the most recent revision.\n\n## Liability\n\nTo the maximum extent permitted by law, we are not liable for indirect, incidental, or consequential losses arising from your use of the site.\n\n## Governing law\n\nThese terms are governed by the laws of India.\n\n## Contact\n\nhr@edurankai.in`,
    isPublished: true
  }
];

for (const p of pages) {
  const exists = await sql`SELECT id FROM content_pages WHERE slug = ${p.slug}`;
  if (exists.length === 0) {
    await sql`
      INSERT INTO content_pages (slug, title, body, meta_description, is_published, version)
      VALUES (${p.slug}, ${p.title}, ${p.body}, ${p.metaDescription}, ${p.isPublished}, 1)
    `;
    console.log("  seeded: " + p.slug);
  } else {
    console.log("  skipped (exists): " + p.slug);
  }
}

console.log("\nDone.");
await sql.end();
