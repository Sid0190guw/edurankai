// src/lib/aquin/schema.ts — AquinTutor's own tables, namespaced so they can leave.
//
// =================================================================================================
// EVERY TABLE HERE IS PREFIXED aq_ FOR ONE REASON
// =================================================================================================
//
// The instruction is that AquinTutor shares this Supabase for a while and later does not. Whether
// that later separation is a weekend or a quarter is decided now, by whether its data is
// identifiable as its own.
//
// With the prefix, the eventual move is:
//
//     pg_dump --table='aq_*' ...   ->   restore into the new database   ->   repoint one env var
//
// Without it, somebody would be reading 258 tables trying to work out which rows belonged to which
// product, and the answer for `users` would be "both, and we cannot tell which".
//
// SO NOTHING IN AQUINTUTOR'S IDENTITY MAY REFERENCE AN EduRankAI TABLE. Not by foreign key, not by
// join, not by "we can look it up if we need to". A foreign key from aq_users to users would make
// the dump above fail to restore, and that failure would arrive on the day of the migration rather
// than today. There is deliberately no such column anywhere below.
//
// =================================================================================================
// WHAT IS AND IS NOT DUPLICATED
// =================================================================================================
//
// Identity is duplicated on purpose: a person who works for EduRankAI and teaches on AquinTutor has
// two accounts, because they are two organisations. That is the point of the separation, not a
// shortcoming of it.
//
// Course content, lessons and enrolments are NOT duplicated here. They already live in training_*
// and kernel_* and are shared while the database is shared; when the split comes they move with
// AquinTutor. That is a data migration, not an identity one, and mixing the two would make both
// harder.

/** Bumped when a statement is added, so a deployment can tell whether it has the current shape. */
export const AQUIN_SCHEMA_VERSION = 1;

export const AQUIN_DDL: readonly string[] = Object.freeze([
  // -----------------------------------------------------------------------------------------------
  // ACCOUNTS. AquinTutor's own, with no link of any kind to the EduRankAI users table.
  // -----------------------------------------------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS aq_users (
     id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     email         TEXT NOT NULL,
     email_lower   TEXT GENERATED ALWAYS AS (lower(email)) STORED,
     name          TEXT NOT NULL DEFAULT '',
     password_hash TEXT,
     is_active     BOOLEAN NOT NULL DEFAULT true,
     -- Why the account cannot sign in, in words, so a locked-out person can be told something
     -- better than "invalid credentials".
     inactive_reason TEXT,
     last_seen_at  TIMESTAMPTZ,
     created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
  // Case-insensitive uniqueness. Two accounts differing only by capitalisation is how one person
  // ends up with two histories and no way to say which is theirs.
  `CREATE UNIQUE INDEX IF NOT EXISTS aq_users_email_key ON aq_users (email_lower)`,

  // -----------------------------------------------------------------------------------------------
  // SESSIONS. Separate table AND separate cookie name — see tenant.ts for why the name matters.
  // -----------------------------------------------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS aq_sessions (
     id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     -- The cookie carries a random token; only its SHA-256 is stored, so a leaked database backup
     -- does not hand over live sessions.
     token_hash  TEXT NOT NULL,
     user_id     UUID NOT NULL REFERENCES aq_users(id) ON DELETE CASCADE,
     issued_ip   TEXT,
     user_agent  TEXT,
     expires_at  TIMESTAMPTZ NOT NULL,
     revoked_at  TIMESTAMPTZ,
     created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
  `CREATE UNIQUE INDEX IF NOT EXISTS aq_sessions_token_key ON aq_sessions (token_hash)`,
  `CREATE INDEX IF NOT EXISTS aq_sessions_user_idx ON aq_sessions (user_id)`,

  // -----------------------------------------------------------------------------------------------
  // ROLES. AquinTutor's own roster and its own super admin, unrelated to EduRankAI's.
  // -----------------------------------------------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS aq_roles (
     key         TEXT PRIMARY KEY,
     label       TEXT NOT NULL,
     description TEXT NOT NULL DEFAULT '',
     -- 'admin' roles reach the AquinTutor admin; 'main' roles never do. Same distinction the
     -- EduRankAI engine draws, kept because it is the one that stops an ordinary account
     -- administering the platform.
     surface     TEXT NOT NULL DEFAULT 'main',
     is_system   BOOLEAN NOT NULL DEFAULT true,
     rank        INTEGER NOT NULL DEFAULT 0,
     created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW())`,

  `CREATE TABLE IF NOT EXISTS aq_role_capabilities (
     role_key   TEXT NOT NULL,
     capability TEXT NOT NULL,
     PRIMARY KEY (role_key, capability))`,

  // One ROW per role held, so a person can hold several at once and removing one leaves the rest.
  `CREATE TABLE IF NOT EXISTS aq_user_roles (
     id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     user_id     UUID NOT NULL REFERENCES aq_users(id) ON DELETE CASCADE,
     role_key    TEXT NOT NULL,
     assigned_by UUID,
     assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     UNIQUE (user_id, role_key))`,
  `CREATE INDEX IF NOT EXISTS aq_user_roles_user_idx ON aq_user_roles (user_id)`,

  // -----------------------------------------------------------------------------------------------
  // AUDIT. Append-only. Who did what, on which host, from which account.
  // -----------------------------------------------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS aq_audit (
     id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     actor_id   UUID,
     action     TEXT NOT NULL,
     subject    TEXT,
     detail     JSONB NOT NULL DEFAULT '{}'::jsonb,
     host       TEXT,
     ip         TEXT,
     at         TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
  `CREATE INDEX IF NOT EXISTS aq_audit_at_idx ON aq_audit (at DESC)`,
]);

/** The tables the DDL above is expected to produce, for verifying rather than trusting an ensure. */
export const AQUIN_TABLES: readonly string[] = Object.freeze([
  'aq_users', 'aq_sessions', 'aq_roles', 'aq_role_capabilities', 'aq_user_roles', 'aq_audit',
]);

// -------------------------------------------------------------------------------------------------
// THE SEEDED ROLE ROSTER
// -------------------------------------------------------------------------------------------------
//
// Deliberately short. A role that nobody can describe in one line is a role nobody will assign
// correctly, and the roster is easier to add to than to take away from once accounts hold them.

export interface AquinRole {
  key: string;
  label: string;
  description: string;
  surface: 'admin' | 'main';
  capabilities: string[];
  rank: number;
}

export const AQUIN_ROLES: readonly AquinRole[] = Object.freeze([
  {
    key: 'super_admin', label: 'Super admin', surface: 'admin', rank: 100,
    description: 'Full control of AquinTutor, including who else may administer it. Independent of any EduRankAI account.',
    capabilities: ['administer'],
  },
  {
    key: 'admin', label: 'Administrator', surface: 'admin', rank: 80,
    description: 'Runs the platform day to day: courses, learners, partners, moderation. Cannot grant administration to others.',
    capabilities: ['read', 'write', 'create', 'manage', 'audit'],
  },
  {
    key: 'teacher', label: 'Teacher', surface: 'admin', rank: 60,
    description: 'Authors and teaches their own courses; sees their own learners and nobody else\'s.',
    capabilities: ['read', 'write', 'create', 'execute'],
  },
  {
    key: 'partner', label: 'Partner', surface: 'admin', rank: 50,
    description: 'An accredited partner organisation: its own catalogue, enrolments and settlements.',
    capabilities: ['read', 'execute'],
  },
  {
    key: 'moderator', label: 'Moderator', surface: 'admin', rank: 40,
    description: 'Reviews reported content and live sessions. Decisions are theirs; automated flags only advise.',
    capabilities: ['read', 'write'],
  },
  {
    key: 'learner', label: 'Learner', surface: 'main', rank: 10,
    description: 'Studies on the platform. Never reaches the admin.',
    capabilities: ['read', 'execute'],
  },
  {
    key: 'guest', label: 'Guest', surface: 'main', rank: 0,
    description: 'Browses the public catalogue.',
    capabilities: ['read'],
  },
]);

export const AQUIN_ADMIN_ROLE_KEYS: readonly string[] =
  Object.freeze(AQUIN_ROLES.filter((r) => r.surface === 'admin').map((r) => r.key));

/** Holding this authorises everything, and only super_admin has it. */
export const AQUIN_ROOT_CAPABILITY = 'administer';
