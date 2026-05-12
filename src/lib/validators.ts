import { z } from 'zod';

export const levelSchema = z.enum(['C-Level', 'Lead', 'Senior', 'Mid', 'Junior', 'Intern', 'Apprentice']);
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
