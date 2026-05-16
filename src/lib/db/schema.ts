import { serial, pgTable, text, varchar, timestamp, boolean, integer, jsonb,
  pgEnum, uuid, primaryKey, index
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// Ã¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢Â
//   ENUMS
// Ã¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢Â

export const userRoleEnum = pgEnum('user_role', [
  'super_admin', 'hr', 'editor', 'applicant'
]);

export const levelEnum = pgEnum('role_level', [
  'C-Level', 'Lead', 'Senior', 'Mid', 'Junior', 'Intern', 'Apprentice'
]);

export const engagementEnum = pgEnum('engagement_type', [
  'Full-Time', 'Internship', 'Apprenticeship'
]);

export const applicationStatusEnum = pgEnum('application_status', [
  'submitted', 'reviewing', 'task_sent', 'interview', 'offer', 'hired', 'rejected', 'withdrawn'
]);

export const eventModeEnum = pgEnum('event_mode', [
  'online', 'in_person', 'hybrid'
]);

export const eventStatusEnum = pgEnum('event_status', [
  'upcoming', 'past', 'cancelled', 'draft'
]);

export const productStatusEnum = pgEnum('product_status', [
  'live', 'coming_soon', 'in_development', 'research', 'stealth'
]);

// Ã¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢Â
//   USERS & AUTH
// Ã¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢Â

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  name: varchar('name', { length: 200 }).notNull(),
  role: userRoleEnum('role').notNull().default('applicant'),
  emailVerified: boolean('email_verified').notNull().default(false),
  isActive: boolean('is_active').notNull().default(true),
  assignedDepartmentId: varchar('assigned_department_id', { length: 50 }),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  internalHandle: varchar('internal_handle', { length: 120 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
}, (t) => ({
  emailIdx: index('users_email_idx').on(t.email),
  roleIdx: index('users_role_idx').on(t.role)
}));

export const sessions = pgTable('sessions', {
  id: text('id').primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  userAgent: text('user_agent'),
  ipAddress: varchar('ip_address', { length: 64 })
}, (t) => ({
  userIdx: index('sessions_user_idx').on(t.userId),
  expiresIdx: index('sessions_expires_idx').on(t.expiresAt)
}));

// Ã¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢Â
//   DEPARTMENTS & ROLES (managed via admin panel)
// Ã¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢Â

export const departments = pgTable('departments', {
  id: varchar('id', { length: 50 }).primaryKey(),
  name: varchar('name', { length: 200 }).notNull(),
  icon: varchar('icon', { length: 50 }).notNull(),
  description: text('description').notNull(),
  isFlagship: boolean('is_flagship').notNull().default(false),
  sortOrder: integer('sort_order').notNull().default(0),
  isVisible: boolean('is_visible').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
});

export const roles = pgTable('roles', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: varchar('slug', { length: 200 }).notNull().unique(),
  departmentId: varchar('department_id', { length: 50 }).notNull().references(() => departments.id, { onDelete: 'cascade' }),
  title: varchar('title', { length: 200 }).notNull(),
  level: levelEnum('level').notNull(),
  function: varchar('function', { length: 300 }).notNull(),
  engagementType: engagementEnum('engagement_type').notNull(),
  location: varchar('location', { length: 100 }).notNull(),
  duration: varchar('duration', { length: 50 }).notNull(),
  salary: varchar('salary', { length: 300 }).notNull(),
  about: text('about').notNull(),
  responsibilities: jsonb('responsibilities').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  skills: jsonb('skills').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  eligibility: jsonb('eligibility').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  isOpen: boolean('is_open').notNull().default(true),
  isFeatured: boolean('is_featured').notNull().default(false),
  applicationDeadline: timestamp('application_deadline', { withTimezone: true }),
  sortOrder: integer('sort_order').notNull().default(0),
  viewCount: integer('view_count').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
}, (t) => ({
  slugIdx: index('roles_slug_idx').on(t.slug),
  deptIdx: index('roles_dept_idx').on(t.departmentId),
  levelIdx: index('roles_level_idx').on(t.level),
  openIdx: index('roles_open_idx').on(t.isOpen)
}));

// Ã¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢Â
//   APPLICATIONS Ã¢â‚¬â€ the heart of the HR system
// Ã¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢Â

export const applications = pgTable('applications', {
  id: uuid('id').primaryKey().defaultRandom(),
  applicationNumber: varchar('application_number', { length: 20 }).unique(),
  roleId: uuid('role_id').references(() => roles.id, { onDelete: 'set null' }),
  applicantUserId: uuid('applicant_user_id').references(() => users.id, { onDelete: 'set null' }),

  // Personal
  firstName: varchar('first_name', { length: 100 }).notNull(),
  lastName: varchar('last_name', { length: 100 }).notNull(),
  email: varchar('email', { length: 255 }).notNull(),
  phone: varchar('phone', { length: 50 }).notNull(),
  city: varchar('city', { length: 200 }).notNull(),
  linkedin: text('linkedin'),
  portfolioUrl: text('portfolio_url').notNull(),
  photoUrl: text('photo_url'),
  dob: varchar('dob', { length: 20 }),
  birthTime: varchar('birth_time', { length: 20 }),
  birthPlace: varchar('birth_place', { length: 200 }),

  // Role pref
  departmentSnapshot: varchar('department_snapshot', { length: 200 }),
  roleTitleSnapshot: varchar('role_title_snapshot', { length: 200 }),
  level: levelEnum('level'),
  openToOther: boolean('open_to_other').notNull().default(false),

  // Education
  education: varchar('education', { length: 100 }),
  fieldOfStudy: varchar('field_of_study', { length: 200 }),
  institution: varchar('institution', { length: 300 }),
  experienceBand: varchar('experience_band', { length: 50 }),
  experienceDescription: text('experience_description'),
  duolingoScore: integer('duolingo_score'),
  duolingoScreenshotUrl: text('duolingo_screenshot_url'),

  // Skills (department-specific blob)
  techSkills: jsonb('tech_skills').$type<Record<string, any>>(),

  // Problem statement
  psSelected: varchar('ps_selected', { length: 100 }),
  psSolutionLink: text('ps_solution_link'),
  psNotes: text('ps_notes'),

  // Motivation
  whyERA: text('why_era'),
  whyRole: text('why_role'),
  whyAIEdu: text('why_ai_edu'),
  intersection: text('intersection'),
  ambitious: text('ambitious'),
  ethicsExperience: text('ethics_experience'),
  ethicsIdeal: text('ethics_ideal'),

  // Logistics
  availability: varchar('availability', { length: 100 }),
  engagementType: varchar('engagement_type_pref', { length: 100 }),
  remoteComfort: varchar('remote_comfort', { length: 100 }),
  compensation: varchar('compensation', { length: 200 }),
  source: varchar('source', { length: 100 }),

  // System
  status: applicationStatusEnum('status').notNull().default('submitted'),
  score: integer('score'),
  scoringFeedback: text('scoring_feedback'),
  reviewerNotes: text('reviewer_notes'),
  reviewedByUserId: uuid('reviewed_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  rawSubmission: jsonb('raw_submission').$type<Record<string, any>>(),
  ipAddress: varchar('ip_address', { length: 64 }),
  userAgent: text('user_agent'),
  assignedReviewerId: uuid('assigned_reviewer_id'),
  isArchived: boolean('is_archived').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
}, (t) => ({
  emailIdx: index('apps_email_idx').on(t.email),
  roleIdx: index('apps_role_idx').on(t.roleId),
  statusIdx: index('apps_status_idx').on(t.status),
  createdIdx: index('apps_created_idx').on(t.createdAt)
}));

// Saved drafts (cross-device, keyed by email until applicant has a user account)
export const applicationDrafts = pgTable('application_drafts', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: varchar('email', { length: 255 }).notNull(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
  data: jsonb('data').$type<Record<string, any>>().notNull(),
  step: integer('step').notNull().default(1),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
}, (t) => ({
  emailIdx: index('drafts_email_idx').on(t.email)
}));

// Ã¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢Â
//   EVENTS
// Ã¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢Â

export const events = pgTable('events', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: varchar('slug', { length: 200 }).notNull().unique(),
  title: varchar('title', { length: 300 }).notNull(),
  description: text('description').notNull(),
  longDescription: text('long_description'),
  mode: eventModeEnum('mode').notNull(),
  status: eventStatusEnum('status').notNull().default('draft'),
  startsAt: timestamp('starts_at', { withTimezone: true }),
  endsAt: timestamp('ends_at', { withTimezone: true }),
  location: varchar('location', { length: 300 }),
  capacity: integer('capacity'),
  registrationUrl: text('registration_url'),
  isFeatured: boolean('is_featured').notNull().default(false),
  tags: jsonb('tags').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
});

export const eventInterest = pgTable('event_interest', {
  id: uuid('id').primaryKey().defaultRandom(),
  eventId: uuid('event_id').notNull().references(() => events.id, { onDelete: 'cascade' }),
  email: varchar('email', { length: 255 }).notNull(),
  name: varchar('name', { length: 200 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
});

// Ã¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢Â
//   PRODUCTS / ECOSYSTEM
// Ã¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢Â

export const products = pgTable('products', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: varchar('slug', { length: 100 }).notNull().unique(),
  name: varchar('name', { length: 200 }).notNull(),
  emphasisWord: varchar('emphasis_word', { length: 100 }),
  status: productStatusEnum('status').notNull().default('coming_soon'),
  shortDescription: text('short_description').notNull(),
  longDescription: text('long_description'),
  externalUrl: text('external_url'),
  iconKey: varchar('icon_key', { length: 50 }),
  sortOrder: integer('sort_order').notNull().default(0),
  isVisible: boolean('is_visible').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
});

// Ã¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢Â
//   POLICY / CONTENT PAGES (editable via admin)
// Ã¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢Â

export const contentPages = pgTable('content_pages', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: varchar('slug', { length: 100 }).notNull().unique(),
  title: varchar('title', { length: 300 }).notNull(),
  body: text('body').notNull().default(''),
  metaDescription: varchar('meta_description', { length: 300 }),
  isPublished: boolean('is_published').notNull().default(false),
  version: integer('version').notNull().default(1),
  lastEditedByUserId: uuid('last_edited_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
});

// Ã¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢Â
//   SETTINGS (single key-value table for site config)
// Ã¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢Â

export const settings = pgTable('settings', {
  key: varchar('key', { length: 100 }).primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
});

// Ã¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢Â
//   AUDIT LOG Ã¢â‚¬â€ who changed what, when
// Ã¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢Â

export const auditLog = pgTable('audit_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  action: varchar('action', { length: 100 }).notNull(),
  entity: varchar('entity', { length: 100 }).notNull(),
  entityId: varchar('entity_id', { length: 200 }),
  diff: jsonb('diff').$type<Record<string, any>>(),
  ipAddress: varchar('ip_address', { length: 64 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, (t) => ({
  userIdx: index('audit_user_idx').on(t.userId),
  entityIdx: index('audit_entity_idx').on(t.entity, t.entityId),
  createdIdx: index('audit_created_idx').on(t.createdAt)
}));

// Ã¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢Â
//   TYPE EXPORTS for use across the app
// Ã¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢Â

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Session = typeof sessions.$inferSelect;
export type Department = typeof departments.$inferSelect;
export type Role = typeof roles.$inferSelect;
export type NewRole = typeof roles.$inferInsert;
export type Application = typeof applications.$inferSelect;
export type Event = typeof events.$inferSelect;
export type Product = typeof products.$inferSelect;


// =========================================================================
// Application Messages - in-app conversation thread between applicant and admin
// =========================================================================
export const applicationMessages = pgTable('application_messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  applicationId: uuid('application_id').references(() => applications.id, { onDelete: 'cascade' }).notNull(),
  senderUserId: uuid('sender_user_id').references(() => users.id, { onDelete: 'set null' }),
  senderRole: varchar('sender_role', { length: 20 }).notNull(),
  senderName: varchar('sender_name', { length: 200 }),
  body: text('body').notNull(),
  isSystem: boolean('is_system').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, (t) => ({
  appIdx: index('app_msg_app_idx').on(t.applicationId),
  createdIdx: index('app_msg_created_idx').on(t.createdAt)
}));
// =========================================================================
// Offer Letters - generated offer letters with digital signatures
// =========================================================================

export const inviteTokens = pgTable('invite_tokens', {
  token: varchar('token', { length: 64 }).primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  applicationId: uuid('application_id').references(() => applications.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' })
});

// =========================================================================
// =========================================================================
export const offerLetters = pgTable('offer_letters', {
  id: uuid('id').primaryKey().defaultRandom(),
  token: varchar('token', { length: 64 }).notNull().unique(),
  applicationId: uuid('application_id').references(() => applications.id, { onDelete: 'cascade' }).notNull(),
  generatedByUserId: uuid('generated_by_user_id').references(() => users.id, { onDelete: 'set null' }),

  // Status
  status: varchar('status', { length: 20 }).notNull().default('draft'),

  // Letter content (jsonb so we can change template fields without migrations)
  templateType: varchar('template_type', { length: 30 }).notNull().default('intern'),
  language: varchar('language', { length: 5 }).notNull().default('en'),
  content: jsonb('content').$type<Record<string, any>>().notNull(),

  // Key fields for quick query
  candidateName: varchar('candidate_name', { length: 300 }).notNull(),
  candidateEmail: varchar('candidate_email', { length: 255 }).notNull(),
  roleTitle: varchar('role_title', { length: 300 }).notNull(),
  department: varchar('department', { length: 200 }),
  refNumber: varchar('ref_number', { length: 64 }).notNull(),
  integrityHash: varchar('integrity_hash', { length: 16 }).notNull(),

  // Dates
  offerDate: varchar('offer_date', { length: 20 }),
  joiningDate: varchar('joining_date', { length: 20 }),
  expiryDate: varchar('expiry_date', { length: 20 }),
  responseDeadline: varchar('response_deadline', { length: 20 }),

  // Signature (when applicant signs)
  signedAt: timestamp('signed_at', { withTimezone: true }),
  signatureDataUrl: text('signature_data_url'),
  signatureIp: varchar('signature_ip', { length: 64 }),
  signatureUserAgent: text('signature_user_agent'),

  // Withdrawal
  withdrawnAt: timestamp('withdrawn_at', { withTimezone: true }),
  withdrawnReason: text('withdrawn_reason'),

  plaintextPassword: varchar('plaintext_password', { length: 40 }),
  createdUserId: uuid('created_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
}, (t) => ({
  tokenIdx: index('offer_token_idx').on(t.token),
  appIdx: index('offer_app_idx').on(t.applicationId),
  statusIdx: index('offer_status_idx').on(t.status)
}));

// =========================================================================
// ADMIN TEAM MESSAGING (1-on-1 direct messages between admin users)
// =========================================================================

export const adminConversations = pgTable('admin_conversations', {
  id: uuid('id').primaryKey().defaultRandom(),
  userAId: uuid('user_a_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  userBId: uuid('user_b_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  lastMessageAt: timestamp('last_message_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
});

export const adminMessages = pgTable('admin_messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  conversationId: uuid('conversation_id').notNull().references(() => adminConversations.id, { onDelete: 'cascade' }),
  senderUserId: uuid('sender_user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  body: text('body').notNull(),
  readByRecipient: boolean('read_by_recipient').notNull().default(false),
  readAt: timestamp('read_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
});

// =========================================================================
// HEI - Holistic Education Index data
// =========================================================================

export const heiInstitutions = pgTable('hei_institutions', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: varchar('slug', { length: 150 }).notNull().unique(),
  name: varchar('name', { length: 300 }).notNull(),
  tier: varchar('tier', { length: 20 }).notNull().default('university'),
  country: varchar('country', { length: 100 }).notNull().default('India'),
  stateRegion: varchar('state_region', { length: 100 }),
  city: varchar('city', { length: 100 }),
  type: varchar('type', { length: 50 }),
  establishedYear: integer('established_year'),
  studentCount: integer('student_count'),
  websiteUrl: text('website_url'),
  nirfRank: integer('nirf_rank'),
  qsRank: integer('qs_rank'),
  theRank: integer('the_rank'),
  truthScore: text('truth_score'),
  truthRank: integer('truth_rank'),
  hasFullData: boolean('has_full_data').notNull().default(false),
  entityTypeId: varchar('entity_type_id', { length: 80 }),
  parentInstitutionId: uuid('parent_institution_id'),
  isPublished: boolean('is_published').notNull().default(false),
  notes: text('notes'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
});

export const heiDimensions = pgTable('hei_dimensions', {
  id: varchar('id', { length: 50 }).primaryKey(),
  sortOrder: integer('sort_order').notNull().default(0),
  title: varchar('title', { length: 200 }).notNull(),
  subtitle: varchar('subtitle', { length: 300 }),
  weightPercent: text('weight_percent').notNull().default('0'),
  blurb: text('blurb').notNull(),
  evidenceBasis: text('evidence_basis'),
  isPublished: boolean('is_published').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
});

export const heiSubmetrics = pgTable('hei_submetrics', {
  id: uuid('id').primaryKey().defaultRandom(),
  dimensionId: varchar('dimension_id', { length: 50 }).notNull().references(() => heiDimensions.id, { onDelete: 'cascade' }),
  sortOrder: integer('sort_order').notNull().default(0),
  title: varchar('title', { length: 300 }).notNull(),
  description: text('description'),
  weightWithinDimension: text('weight_within_dimension').notNull().default('0'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
});

export const heiStories = pgTable('hei_stories', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: varchar('slug', { length: 200 }).notNull().unique(),
  headline: varchar('headline', { length: 500 }).notNull(),
  deck: text('deck'),
  body: text('body').notNull(),
  category: varchar('category', { length: 50 }).notNull().default('investigation'),
  institutionId: uuid('institution_id').references(() => heiInstitutions.id, { onDelete: 'set null' }),
  authorUserId: uuid('author_user_id').references(() => users.id, { onDelete: 'set null' }),
  isPublished: boolean('is_published').notNull().default(false),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  coverImageUrl: text('cover_image_url'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
});

export const heiInstitutionScores = pgTable('hei_institution_scores', {
  institutionId: uuid('institution_id').notNull().references(() => heiInstitutions.id, { onDelete: 'cascade' }),
  dimensionId: varchar('dimension_id', { length: 50 }).notNull().references(() => heiDimensions.id, { onDelete: 'cascade' }),
  score: text('score').notNull().default('0'),
  notes: text('notes'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
});

// =========================================================================
// HEI Entity Types (universal taxonomy for all education/training entities)
// =========================================================================

export const heiEntityTypes = pgTable('hei_entity_types', {
  id: varchar('id', { length: 80 }).primaryKey(),
  label: varchar('label', { length: 200 }).notNull(),
  category: varchar('category', { length: 50 }).notNull(),
  description: text('description'),
  sortOrder: integer('sort_order').notNull().default(0),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
});

// =========================================================================
// HEI v1.0 Canonical Framework (4 metrics, 23 aspects, 7 pipelines, SDG-Indic map, purusharthas)
// =========================================================================

export const heiMetrics = pgTable('hei_metrics', {
  id: varchar('id', { length: 50 }).primaryKey(),
  sortOrder: integer('sort_order').notNull().default(0),
  title: varchar('title', { length: 200 }).notNull(),
  subtitle: varchar('subtitle', { length: 300 }),
  weightPercent: text('weight_percent').notNull().default('0'),
  description: text('description').notNull(),
  blurb: text('blurb'),
  methodologyVersion: varchar('methodology_version', { length: 10 }).notNull().default('v1.0'),
  isPublished: boolean('is_published').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
});

export const heiAspects = pgTable('hei_aspects', {
  id: varchar('id', { length: 80 }).primaryKey(),
  metricId: varchar('metric_id', { length: 50 }).notNull().references(() => heiMetrics.id, { onDelete: 'cascade' }),
  sortOrder: integer('sort_order').notNull().default(0),
  title: varchar('title', { length: 200 }).notNull(),
  sanskritRoot: varchar('sanskrit_root', { length: 200 }),
  description: text('description').notNull(),
  sdgLinks: text('sdg_links'),
  measurementNotes: text('measurement_notes'),
  methodologyVersion: varchar('methodology_version', { length: 10 }).notNull().default('v1.0'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
});

export const heiPipelines = pgTable('hei_pipelines', {
  id: varchar('id', { length: 10 }).primaryKey(),
  sortOrder: integer('sort_order').notNull().default(0),
  title: varchar('title', { length: 200 }).notNull(),
  useClass: varchar('use_class', { length: 50 }).notNull(),
  sources: text('sources').notNull(),
  description: text('description').notNull(),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
});

export const heiSdgIndicMap = pgTable('hei_sdg_indic_map', {
  id: serial('id').primaryKey(),
  sdgNumber: integer('sdg_number').notNull(),
  sdgName: varchar('sdg_name', { length: 200 }).notNull(),
  indicPrinciple: varchar('indic_principle', { length: 300 }).notNull(),
  sanskritPhrase: varchar('sanskrit_phrase', { length: 300 }),
  explanation: text('explanation'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
});

export const heiPurusharthas = pgTable('hei_purusharthas', {
  id: varchar('id', { length: 20 }).primaryKey(),
  sortOrder: integer('sort_order').notNull().default(0),
  title: varchar('title', { length: 100 }).notNull(),
  transliteration: varchar('transliteration', { length: 100 }),
  description: text('description').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
});

// =========================================================================
// Institution self-claim + score submission + findings (4 stages)
// =========================================================================

export const institutionClaims = pgTable('institution_claims', {
  id: uuid('id').primaryKey().defaultRandom(),
  institutionId: uuid('institution_id').notNull().references(() => heiInstitutions.id, { onDelete: 'cascade' }),
  claimToken: varchar('claim_token', { length: 80 }).notNull().unique(),
  contactName: varchar('contact_name', { length: 200 }).notNull(),
  contactDesignation: varchar('contact_designation', { length: 200 }).notNull(),
  contactEmail: varchar('contact_email', { length: 255 }).notNull(),
  contactPhone: varchar('contact_phone', { length: 50 }),
  letterheadUrl: text('letterhead_url'),
  additionalEvidenceUrl: text('additional_evidence_url'),
  status: varchar('status', { length: 30 }).notNull().default('pending'),
  decisionNotes: text('decision_notes'),
  reviewedByUserId: uuid('reviewed_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  submittedAt: timestamp('submitted_at', { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
});

export const institutionSubmissions = pgTable('institution_submissions', {
  id: uuid('id').primaryKey().defaultRandom(),
  institutionId: uuid('institution_id').notNull().references(() => heiInstitutions.id, { onDelete: 'cascade' }),
  submittedByEmail: varchar('submitted_by_email', { length: 255 }).notNull(),
  submissionStatus: varchar('submission_status', { length: 30 }).notNull().default('submitted'),
  notes: text('notes'),
  submittedAt: timestamp('submitted_at', { withTimezone: true }).notNull().defaultNow(),
  reviewedByUserId: uuid('reviewed_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  methodologyVersion: varchar('methodology_version', { length: 10 }).notNull().default('v0.4')
});

export const institutionSubmissionScores = pgTable('institution_submission_scores', {
  id: uuid('id').primaryKey().defaultRandom(),
  submissionId: uuid('submission_id').notNull().references(() => institutionSubmissions.id, { onDelete: 'cascade' }),
  dimensionId: varchar('dimension_id', { length: 50 }).notNull(),
  proposedScore: text('proposed_score').notNull(),
  evidenceUrl: text('evidence_url').notNull(),
  evidenceDescription: text('evidence_description'),
  adminDecision: varchar('admin_decision', { length: 20 }).notNull().default('pending'),
  adminAcceptedScore: text('admin_accepted_score'),
  adminNotes: text('admin_notes'),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true })
});

export const heiFindings = pgTable('hei_findings', {
  id: uuid('id').primaryKey().defaultRandom(),
  institutionId: uuid('institution_id').notNull().references(() => heiInstitutions.id, { onDelete: 'cascade' }),
  dimensionId: varchar('dimension_id', { length: 50 }),
  findingTitle: varchar('finding_title', { length: 500 }).notNull(),
  findingBody: text('finding_body').notNull(),
  evidenceSummary: text('evidence_summary').notNull(),
  proposedScoreImpact: text('proposed_score_impact'),
  status: varchar('status', { length: 30 }).notNull().default('draft'),
  noticeSentAt: timestamp('notice_sent_at', { withTimezone: true }),
  responseWindowEndsAt: timestamp('response_window_ends_at', { withTimezone: true }),
  institutionResponse: text('institution_response'),
  institutionResponseAt: timestamp('institution_response_at', { withTimezone: true }),
  responseQualityScore: integer('response_quality_score'),
  d7Modifier: text('d7_modifier'),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
});

// =========================================================================
// Dynamic role system (additive — coexists with hardcoded role enum)
// =========================================================================

export const teamRoles = pgTable('team_roles', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 80 }).notNull().unique(),
  description: text('description'),
  color: varchar('color', { length: 20 }).notNull().default('orange'),
  isSystem: boolean('is_system').notNull().default(false),
  createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
});

export const rolePermissions = pgTable('role_permissions', {
  id: uuid('id').primaryKey().defaultRandom(),
  roleId: uuid('role_id').notNull().references(() => teamRoles.id, { onDelete: 'cascade' }),
  pageKey: varchar('page_key', { length: 80 }).notNull(),
  canView: boolean('can_view').notNull().default(false),
  canEdit: boolean('can_edit').notNull().default(false),
  canDelete: boolean('can_delete').notNull().default(false),
  canExport: boolean('can_export').notNull().default(false)
});

export const userRoleAssignments = pgTable('user_role_assignments', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  roleId: uuid('role_id').notNull().references(() => teamRoles.id, { onDelete: 'cascade' }),
  assignedByUserId: uuid('assigned_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  assignedAt: timestamp('assigned_at', { withTimezone: true }).notNull().defaultNow()
});

// =========================================================================
// Brand profiles (for offer letters across EduRankAI and partner products)
// =========================================================================
export const brandProfiles = pgTable('brand_profiles', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: varchar('slug', { length: 60 }).notNull().unique(),
  name: varchar('name', { length: 120 }).notNull(),
  tagline: varchar('tagline', { length: 200 }),
  primaryColor: varchar('primary_color', { length: 20 }).notNull().default('#FF4F00'),
  domain: varchar('domain', { length: 120 }),
  isActive: boolean('is_active').notNull().default(true),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
});

// =========================================================================
// Team chat (polling-based, channels)
// =========================================================================
export const chatChannels = pgTable('chat_channels', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: varchar('slug', { length: 60 }).notNull().unique(),
  name: varchar('name', { length: 120 }).notNull(),
  description: text('description'),
  isPrivate: boolean('is_private').notNull().default(false),
  createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
});

export const chatMessages = pgTable('chat_messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  channelId: uuid('channel_id').notNull().references(() => chatChannels.id, { onDelete: 'cascade' }),
  senderUserId: uuid('sender_user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  senderName: varchar('sender_name', { length: 120 }),
  body: text('body').notNull(),
  editedAt: timestamp('edited_at', { withTimezone: true }),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
});

export const chatMemberships = pgTable('chat_memberships', {
  id: uuid('id').primaryKey().defaultRandom(),
  channelId: uuid('channel_id').notNull().references(() => chatChannels.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
  lastReadAt: timestamp('last_read_at', { withTimezone: true }).notNull().defaultNow()
});
