import { z } from 'zod';
import {
  isTraineeRole,
  isPaidTrainee,
  declaresUnpaid,
  UNPAID_INTERN_SALARY,
  UNPAID_APPRENTICE_SALARY,
} from '@/lib/compensation-text';

export const levelSchema = z.enum(['C-Level', 'Lead', 'Senior', 'Mid', 'Junior', 'Intern', 'Apprentice']);
// THESE THREE ARE THE ONLY VALUES THE DATABASE ACCEPTS.
// `engagement_type` is a Postgres ENUM with exactly three labels — see engagementEnum in
// src/lib/db/schema.ts. This list used to carry nine, so /admin/roles/new and /admin/roles/[id]
// offered Part-Time, Contract, Freelance, Consultant, Fellowship and Volunteer, validation passed
// them, and the INSERT then died on "invalid input value for enum engagement_type" — with no
// try/catch on either page, so the admin got a 500 and lost the whole job description they had
// just typed.
//
// Adding a label to a Postgres enum is a migration (ALTER TYPE ... ADD VALUE), it cannot run inside
// a transaction, and downstream code branches on 'Internship' for unpaid-engagement rules. So the
// list is narrowed to what the column holds rather than widened here; extending it is a schema
// change plus a review of those branches, and it is handed to the user as a command, not run.
export const engagementSchema = z.enum(['Full-Time', 'Internship', 'Apprenticeship']);

export const roleSchema = z.object({
  title: z.string().min(2, 'Title required (min 2 chars)').max(200),
  slug: z.string().min(2).max(200).regex(/^[a-z0-9-]+$/, 'Slug: lowercase letters, numbers, hyphens only'),
  departmentId: z.string().min(1, 'Department required'),
  level: levelSchema,
  function: z.string().min(2).max(300),
  engagementType: engagementSchema,
  location: z.string().min(1).max(100),
  duration: z.string().min(1).max(50),
  salary: z.string().min(1).max(100),
  about: z.string().min(10, 'About: at least 10 characters'),
  responsibilities: z.array(z.string()).default([]),
  skills: z.array(z.string()).default([]),
  eligibility: z.array(z.string()).default([]),
  isOpen: z.boolean().default(true),
  isFeatured: z.boolean().default(false),
  sortOrder: z.number().int().default(0)
})
  // POLICY, enforced at the one place both admin write paths go through
  // (/admin/roles/new and /admin/roles/[id] each call roleSchema.safeParse).
  //
  // Every internship and apprenticeship is unpaid except 'llm-engineering-intern'. This field is
  // free text, and what an admin typed into it is how 49 rows came to advertise stipends on roles
  // that pay nothing - "up to INR 3 LPA", "Full-time stipend: up to INR 25,000/mo". The public
  // pages already refuse to publish those, but /admin/roles, the offer stage and every export read
  // the column raw, so the wrong value still misleads whoever reads it next.
  //
  // It NORMALISES rather than rejects, deliberately. Rejecting would block an admin from so much as
  // closing a posting whose salary was already wrong - the row cannot be saved without first fixing
  // a field they may not have been editing - and that turns a policy into an obstacle. Normalising
  // heals the row on any save instead.
  //
  // The test is the "Unpaid" PREFIX, not equality: a trainee row that already says
  // "Unpaid - certificate, verifiable credential and fee-waiver benefits" is more specific than the
  // generic line and is left exactly as it is.
  .transform((role) => {
    if (!isTraineeRole(role)) return role;
    if (isPaidTrainee(role.slug)) return role;
    if (declaresUnpaid(role.salary)) return role;
    const apprentice = role.level === 'Apprentice' || role.engagementType === 'Apprenticeship';
    return { ...role, salary: apprentice ? UNPAID_APPRENTICE_SALARY : UNPAID_INTERN_SALARY };
  });

export const departmentSchema = z.object({
  id: z.string().min(2).max(50).regex(/^[a-z0-9-]+$/, 'ID: lowercase letters, numbers, hyphens only'),
  name: z.string().min(2).max(200),
  icon: z.string().min(1).max(50),
  description: z.string().min(5),
  isFlagship: z.boolean().default(false),
  sortOrder: z.number().int().default(0),
  isVisible: z.boolean().default(true)
});

export type RoleInput = z.infer<typeof roleSchema>;
export type DepartmentInput = z.infer<typeof departmentSchema>;

export const slugify = (s: string) =>
  s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// Parse a textarea of one-item-per-line into a clean string array
export const parseLines = (text: string | null): string[] => {
  if (!text) return [];
  return text
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
};
