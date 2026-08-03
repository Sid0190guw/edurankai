// Single source of truth for admin sections / pages.
// The granular role-permission matrix (/admin/team/roles) and access checks
// read from this registry, so adding a new section here makes it AUTOMATICALLY
// appear in the permission editor - no other change needed. Keep keys stable
// (they are stored in role_permissions.page_key); labels/groups can change.

export interface AdminSection {
  key: string;
  label: string;
  hint?: string;
}
export interface AdminSectionGroup {
  label: string;
  sections: AdminSection[];
}

export const ADMIN_SECTION_GROUPS: AdminSectionGroup[] = [
  {
    label: 'Core',
    sections: [
      { key: 'dashboard', label: 'Dashboard' },
      { key: 'applications', label: 'Applications' },
      { key: 'offers', label: 'Offer Letters' },
      { key: 'messages', label: 'Help Inbox' },
      { key: 'dms', label: 'Direct Messages' },
      { key: 'discussion', label: 'Discussion' },
    ],
  },
  {
    label: 'People & HR',
    sections: [
      { key: 'hr', label: 'HR Management' },
      { key: 'employees', label: 'Employees' },
      { key: 'leave', label: 'Leave' },
      { key: 'attendance', label: 'Attendance' },
      { key: 'payroll', label: 'Payroll', hint: 'Salaries, payslips' },
      { key: 'payouts', label: 'Payouts', hint: 'Disbursements' },
      { key: 'training', label: 'Training' },
      { key: 'helpdesk', label: 'Helpdesk', hint: 'IT, HR, Finance, Admin and asset-request tickets' },
      { key: 'assets', label: 'Asset Register', hint: 'Equipment and licences issued to employees' },
      { key: 'finance', label: 'Finance & Payments', hint: 'Razorpay, revenue, fees' },
    ],
  },
  {
    label: 'Hiring',
    sections: [
      { key: 'roles', label: 'Job Roles' },
      { key: 'departments', label: 'Departments' },
      { key: 'interviews', label: 'Interviews (scheduled)' },
      { key: 'interviews_manual', label: 'Manual Interviews' },
      { key: 'interviews_ai', label: 'AI Interviews' },
    ],
  },
  {
    label: 'Assessments',
    sections: [
      { key: 'tests', label: 'Tests' },
      { key: 'tests_proctoring', label: 'Proctoring & Attempts' },
      { key: 'tests_restricted', label: 'Restricted Exams', hint: 'Designated-authority only' },
      { key: 'events', label: 'Events' },
      { key: 'lms', label: 'AquinTutor LMS' },
    ],
  },
  {
    label: 'Content & Products',
    sections: [
      { key: 'products', label: 'Products' },
      { key: 'content', label: 'Content Pages' },
      { key: 'custom_offer', label: 'Custom Offer' },
    ],
  },
  {
    label: 'HEI · Truth Report',
    sections: [
      { key: 'hei_institutions', label: 'Institutions' },
      { key: 'hei_entity_types', label: 'Entity Types' },
      { key: 'hei_import', label: 'CSV Import' },
      { key: 'hei_submetrics', label: 'Sub-metrics' },
      { key: 'hei_v1', label: 'v1.0 Methodology' },
      { key: 'hei_stories', label: 'Stories' },
      { key: 'hei_claims', label: 'Institution Claims' },
      { key: 'hei_submissions', label: 'Submissions' },
      { key: 'hei_findings', label: 'Findings' },
    ],
  },
  {
    label: 'Access & System',
    sections: [
      { key: 'users', label: 'Users' },
      { key: 'team_roles', label: 'Custom Roles' },
      { key: 'audit', label: 'Audit Log' },
      { key: 'settings', label: 'Settings' },
    ],
  },
];

export const ALL_ADMIN_SECTION_KEYS: string[] =
  ADMIN_SECTION_GROUPS.flatMap((g) => g.sections.map((s) => s.key));

export function adminSectionLabel(key: string): string {
  for (const g of ADMIN_SECTION_GROUPS) {
    const s = g.sections.find((x) => x.key === key);
    if (s) return s.label;
  }
  return key;
}

// ---------------------------------------------------------------------------------------------
// Permission key <-> section mapping.
//
// A permission key like `applications.view` and a row in role_permissions (page_key
// 'applications', can_view true) are THE SAME STATEMENT written twice. This function is the one
// place that says so, so the permission registry (src/lib/auth/registry.ts) can translate between
// the two without a second, drifting copy of the rule. It lives here, next to the section registry,
// because it is pure — no database, no session — and any module can import it without dragging a
// database client along.
//
// It is the same `<section>.<action>` shape seedCatalogueRows() writes into permission_catalogue and
// the same one src/lib/admin-nav.ts gates each sidebar entry on, so the catalogue, the section
// matrix and the menu all name one ability the same way.
// ---------------------------------------------------------------------------------------------

/** The four columns role_permissions stores, in the order the role editor shows them. */
export const ADMIN_SECTION_ACTIONS = ['view', 'edit', 'delete', 'export'] as const;
export type AdminSectionAction = typeof ADMIN_SECTION_ACTIONS[number];

const SECTION_KEY_SET = new Set<string>(ALL_ADMIN_SECTION_KEYS);

/**
 * The admin section a permission key controls, or null when it controls none.
 *
 * Split on the LAST dot, because section keys contain underscores rather than dots today but a key
 * like `hei.claims.view` must still resolve if one ever does. Returns null unless BOTH halves are
 * real: the action must be one of the four columns, and the section must be in the registry above.
 * That is what stops a typo, or a page_key somebody typed into a form years ago, from being
 * treated as a live grant.
 *
 * `admin.access` is excluded by name and not by accident: there is no `admin` section, but this is
 * the permission that opens the console and it must never be derivable from a page-key checkbox.
 * See the same rule enforced in registry.ts's customRoleKeys().
 */
export function sectionTargetFor(permissionKey: string): { section: string; action: AdminSectionAction } | null {
  const key = String(permissionKey || '').trim();
  if (!key || key === 'admin.access') return null;
  const dot = key.lastIndexOf('.');
  if (dot <= 0 || dot === key.length - 1) return null;
  const section = key.slice(0, dot);
  const action = key.slice(dot + 1) as AdminSectionAction;
  if (!(ADMIN_SECTION_ACTIONS as readonly string[]).includes(action)) return null;
  if (!SECTION_KEY_SET.has(section)) return null;
  return { section, action };
}
