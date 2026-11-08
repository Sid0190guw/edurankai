// The SAMARTH module register (spec Parts 2.2 and 3). PURE DATA, rendered on /admin/samarth and
// mirrored in docs/samarth/MODULE_REGISTER.md.
//
// A STATUS HERE IS A CLAIM, so it is held to the project's rule that reported success and
// observable result are not the same thing:
//   built      code and surfaces exist in the repository and pass the gates (tests, build, typecheck)
//   partial    some of the scope is built; `pending` names what is not
//   planned    contracts are defined in the docs; no code yet
//   reserved   Component 03: nothing may be invented for it
// "built" never means "verified in production". Production verification is recorded separately
// in docs/samarth/IMPLEMENTATION_STATUS.md, and only from evidence.

export type ModuleStatus = 'built' | 'partial' | 'planned' | 'reserved';

export interface SamarthModule {
  id: string;
  name: string;
  status: ModuleStatus;
  release: number | null;
  dependsOn: string[];
  /** What exists now. */
  built: string[];
  /** What is not built yet. Empty only when status is 'built'. */
  pending: string[];
  /** Routes a person can open. */
  surfaces: string[];
}

export const MODULES: readonly SamarthModule[] = [
  {
    id: '00', name: 'Repository audit, master specification and governance', status: 'built', release: 1, dependsOn: [],
    built: ['Repository audit recorded in SYSTEM_ARCHITECTURE.md', 'docs/samarth governance set (13 documents)', 'Per-module specification and implementation files', 'Decision log, including resolved conflicts with standing project rules'],
    pending: [], surfaces: [],
  },
  {
    id: '01', name: 'Shared technical foundation, including payments', status: 'partial', release: 1, dependsOn: ['00'],
    built: ['samarth_* schema with self-bootstrap and a hand-run SQL file', 'Registered with /admin/setup bootstrap and /api/health', 'Access control: two admin sections (samarth, samarth_x), fail-closed to super admin', 'Booking-fee schedule configurable by category and currency, with approval', 'Payment orders, server-side verification, webhook and reconciliation through the existing gateway path', 'Idempotent paid effects, offline payment records, refund visibility', 'Invoices through the existing invoice module', 'Email and admin notifications', 'Audit log on every write', 'Feature flags for online checkout', 'State machines with guards'],
    pending: ['Native multi-currency charging (blocked on currency-aware finance totals)', 'Automated backup verification specific to SAMARTH tables (relies on platform backups)'],
    surfaces: ['/admin/samarth', '/admin/samarth/fees'],
  },
  {
    id: '02', name: 'Branding, navigation and public website', status: 'built', release: 1, dependsOn: ['01'],
    built: ['/samarth hub and sub-navigation', 'Sector, government, engineering, consultancy and consultation pages', 'Site navigation and sitemap entries', 'Structured data: organisation, services, breadcrumbs, FAQ', 'Listed as a venture on /ecosystem and /ecosystem/samarth, a homepage section, footer, About, FAQ and Contact'],
    pending: [], surfaces: ['/samarth', '/samarth/consultation', '/samarth/industry', '/samarth/government', '/samarth/engineering', '/ecosystem/samarth'],
  },
  {
    id: '03', name: 'Enterprise, industry, manufacturing and government service architecture', status: 'built', release: 3, dependsOn: ['02'],
    built: ['Tertiary, secondary and manufacturing verticals', 'Government categories, domains, six project levels and the sixteen-stage lifecycle, worded for any country', 'Ten discovery pathways'],
    pending: [], surfaces: ['/samarth/industry', '/samarth/government'],
  },
  {
    id: '04', name: 'Consultancy packages, pricing and applications', status: 'built', release: 2, dependsOn: ['01', '03'],
    built: ['Registration, applicant details, requirements, booking fee, call booking, consultant assignment', 'Government details: level, jurisdiction, department, authorised representative, procurement', 'Published consultancy packages and the eligibility estimator', 'Packages sold only as separate engagements with approved quotations'],
    pending: [], surfaces: ['/samarth/register', '/samarth/r', '/samarth/consultancy'],
  },
  {
    id: '05', name: 'AI application assistant', status: 'planned', release: 5, dependsOn: ['04'],
    built: [],
    pending: ['Text chat over the first-party LLM gateway', 'Voice input and optional speech output', 'Structured requirement extraction into the requirements form, labelled as suggestions', 'Document understanding from shared links'],
    surfaces: [],
  },
  {
    id: '06', name: 'Engineering, technology transfer and infrastructure project management', status: 'partial', release: 4, dependsOn: ['04', '07'],
    built: ['Engagements for engineering, infrastructure, technology transfer and government projects, each with its own quotation', 'Delivery model and named partners on every quotation', 'Award or contract reference required before delivery'],
    pending: ['Milestones and delivery-stage tracking', 'Feasibility and cost-estimation workspaces', 'Commissioning and handover records'],
    surfaces: ['/admin/samarth/engagements'],
  },
  {
    id: '07', name: 'Technology partner and consortium ecosystem', status: 'partial', release: 4, dependsOn: ['01'],
    built: ['Public partner registration', 'Registry with due-diligence checklist and approval workflow', 'Partner comparison', 'Approved partners attachable to a quotation, shown to the client'],
    pending: ['Partner quotations and evaluations per engagement', 'Delivery performance scoring over completed engagements', 'Consortium records for government bids'],
    surfaces: ['/samarth/partners', '/admin/samarth/partners'],
  },
  {
    id: '08', name: 'SAMARTH X venture-building programme', status: 'built', release: 6, dependsOn: ['01'],
    built: ['Programme page and public expression of interest, no fee', 'Event nominations and recruitment referrals entered by staff', 'One evaluation pipeline for all three channels', 'Reviewer scoring, advisory ranking, selection guards', 'Best-six incubation cap per cohort, agreement reference required', 'Milestones, resources, demonstrations and showcase records', 'SAMARTH events (hackathons, challenges, competitions) on the platform events system, with one-click nomination of participants into SAMARTH X'],
    pending: [], surfaces: ['/samarth/x', '/samarth/x/apply', '/samarth/events', '/admin/samarth/x', '/admin/samarth/events'],
  },
  {
    id: '09', name: 'Administration, project management and analytics', status: 'partial', release: 2, dependsOn: ['04', '07', '08'],
    built: ['Overview with a stage-column pipeline, segmented distribution bars and revenue tiles, on palettes validated for colour-blind readers', 'Readiness panel and one-click setup', 'Search across every SAMARTH record the administrator may see', 'Filters, keyset pagination and CSV export', 'Timeline and audit history on every record'],
    pending: ['Government directory of ministries and departments', 'Consultant scheduling calendar', 'Resource-utilisation analytics'],
    surfaces: ['/admin/samarth', '/admin/samarth/search', '/admin/samarth/applications'],
  },
  {
    id: '10', name: 'Payments, quotations, contracts and commercial operations', status: 'partial', release: 2, dependsOn: ['01', '04'],
    built: ['Quotations with internal approval, client acceptance, validity and terms', 'Booking-fee and engagement checkout behind feature flags', 'Offline payments and invoices'],
    pending: ['Contract document generation and e-signature', 'Milestone billing', 'Legal templates (consultancy terms, SLAs, incubation agreements) awaiting legal review'],
    surfaces: ['/admin/samarth/engagements'],
  },
  {
    id: '11', name: 'Global SEO, GEO and content discovery', status: 'partial', release: 7, dependsOn: ['02'],
    built: ['Fourteen capability pages with original content and FAQ structured data', 'Canonical URLs, sitemap entries, breadcrumbs, organisation and service data'],
    pending: ['Translated pages and hreflang (none exist yet, so none are declared)', 'Search-console and webmaster verification (needs the owner\'s accounts)', 'Publications and case studies (none may be published until real and permitted)'],
    surfaces: ['/samarth/services'],
  },
  {
    id: '12', name: 'Security, performance, accessibility and QA', status: 'partial', release: 8, dependsOn: ['01'],
    built: ['Unit tests for every pure rule', 'Rate limits and honeypots on every public form', 'Tokens hashed at rest, HttpOnly access cookies', 'Server-rendered pages with minimal client script'],
    pending: ['End-to-end tests against a local database', 'Accessibility audit of the new pages', 'Load test of public forms'],
    surfaces: [],
  },
  {
    id: '13', name: 'Integration, production release and handover', status: 'planned', release: 8, dependsOn: ['01', '02', '04', '08', '09', '10'],
    built: [],
    pending: ['Apply db/samarth-schema.sql in production', 'Approve the first booking fees', 'Sandbox-test then enable checkout', 'Production verification and operational handover'],
    surfaces: [],
  },
  {
    id: 'C03', name: 'Component 03 (reserved)', status: 'reserved', release: null, dependsOn: [],
    built: [], pending: ['Nothing may be built or announced until the component is defined.'], surfaces: [],
  },
];

export function moduleCounts(): Record<ModuleStatus, number> {
  const out: Record<ModuleStatus, number> = { built: 0, partial: 0, planned: 0, reserved: 0 };
  for (const m of MODULES) out[m.status]++;
  return out;
}
