import {
  pgTable, text, varchar, timestamp, boolean, integer, jsonb,
  pgEnum, uuid, primaryKey, index
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//   ENUMS
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

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

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//   USERS & AUTH
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

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

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//   DEPARTMENTS & ROLES (managed via admin panel)
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

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

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//   APPLICATIONS â€” the heart of the HR system
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

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

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//   EVENTS
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

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

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//   PRODUCTS / ECOSYSTEM
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

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

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//   POLICY / CONTENT PAGES (editable via admin)
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

export const contentPages = pgTable('content_pages', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: varchar('slug', { length: 100 }).notNull().unique(),
  title: varchar('title', { length: 300 }).notNull(),
  body: jsonb('body').$type<Record<string, any>>().notNull(),
  isPublished: boolean('is_published').notNull().default(false),
  version: integer('version').notNull().default(1),
  lastEditedByUserId: uuid('last_edited_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
});

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//   SETTINGS (single key-value table for site config)
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

export const settings = pgTable('settings', {
  key: varchar('key', { length: 100 }).primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
});

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//   AUDIT LOG â€” who changed what, when
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

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

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//   TYPE EXPORTS for use across the app
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

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

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
}, (t) => ({
  tokenIdx: index('offer_token_idx').on(t.token),
  appIdx: index('offer_app_idx').on(t.applicationId),
  statusIdx: index('offer_status_idx').on(t.status)
}));
