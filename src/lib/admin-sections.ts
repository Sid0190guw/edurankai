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
