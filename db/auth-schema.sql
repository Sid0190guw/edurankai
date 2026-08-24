-- db/auth-schema.sql
--
-- THE AUTHENTICATION TABLES, WHICH NO COMMITTED FILE HAS EVER CREATED.
--
--   psql "$DATABASE_URL" -f db/auth-schema.sql
--
-- RUN IT YOURSELF — CLAUDE.md forbids me from opening a database connection from this working
-- directory, and db/incident-2026-08-24-diagnostics.sql records why. This is that hand-over.
--
-- USE psql -f, NOT A PASTE INTO THE SUPABASE SQL EDITOR. The difference is not cosmetic. psql -f
-- sends one statement at a time, so each lock is taken and released in turn and each statement
-- commits on its own. A paste of the whole file is a single multi-statement Query, which Postgres
-- runs as ONE IMPLICIT TRANSACTION — every ACCESS EXCLUSIVE lock below is then held together until
-- the last statement, and a failure anywhere rolls back the whole file rather than leaving the
-- earlier statements committed. Both of those defeat the reasoning in the SAFETY section.
--
-- If the SQL editor is the only thing available, paste ONE NUMBERED SECTION AT A TIME. Each section
-- is independent, except that section 7 must run in its written order.
--
-- =================================================================================================
-- WHY THIS FILE EXISTS — AND WHAT IT DOES NOT CLAIM
-- =================================================================================================
--
-- SCHEMA_BOOTSTRAP is OFF in production and src/lib/db/index.ts refuses request-time DDL at the
-- db.execute chokepoint, so the rule in src/lib/ensure-once.ts holds: a table whose only creator is
-- an ensure*() does not create itself on the live site any more. Every table below is created by an
-- ensure*() in src/lib/auth/ and by NOTHING ELSE — checked on 2026-08-24 by grepping every
-- `CREATE TABLE IF NOT EXISTS` in src/lib/auth/*.ts against every file in db/. Not one of these
-- names appears in any of them.
--
-- THAT IS A GAP IN THE REPOSITORY. IT IS NOT, BY ITSELF, EVIDENCE THAT ANY TABLE IS MISSING.
--
-- A first draft of this file said these tables were absent in production and that sign-in was
-- therefore broken. That was wrong, and the way it was wrong is worth keeping. These bootstraps do
-- NOT go through ensureOnce: they call db.execute directly behind a module-level `let ensured`, so
-- they are among the ~forty unmemoised bootstraps described in src/lib/schema-bootstrap.ts, and
-- their CREATE TABLEs ran on every cold instance from the day each shipped until the DDL guard
-- landed on 2026-08-23. src/lib/auth/twofactor.ts was added on 2026-06-30 and is reached on every
-- successful password sign-in, so it had eight weeks of doing exactly that. Its tables are very
-- probably there.
--
-- The live /api/health reporting `ddl.suppressed: 7` says only that no-op DDL is still being
-- attempted and refused on warm instances. It says nothing about whether the relation exists. And
-- the loudest evidence is the plainest: people sign in.
--
-- SO WHAT IS THIS FILE FOR. Two things that do not depend on the answer:
--
--   1. THE SCHEMA BECOMES RECOVERABLE. Today the only description of these tables is DDL embedded in
--      TypeScript that production is configured never to run. A new environment, a restore, or a
--      second region has no way to create them at all. This file is that way.
--   2. THE QUESTION BECOMES ANSWERABLE. Run section 8 below, or read `schemas.missingCount` from
--      /api/health — every table here is now registered in BOOTSTRAP_MODULES
--      (src/lib/observability-health.ts), so the endpoint reports it continuously instead of being
--      silent about the entire authentication subsystem. Silence read as health, which is how a
--      whole subsystem went unmonitored.
--
-- Running it is a no-op for every table that is already present. That is the point: it costs nothing
-- to stop guessing.
--
-- =================================================================================================
-- WHAT WOULD BREAK IF ONE OF THESE IS ABSENT
-- =================================================================================================
--
-- Written as a conditional, because that is what it is. If section 8 comes back all-true, none of
-- this is happening and the file has done its second job anyway.
--
--   auth_attempt_limit   countAttempt() in src/lib/auth/two-factor.ts INSERTs here with no catch of
--                        its own, on all four password sign-in forms and on the public form limiter.
--                        This is the newest of them, so it is the one most worth confirming.
--
--   user_2fa_policy      isSecondStepRequired() SELECTs it after a CORRECT password on /admin/login,
--   auth_pending_2fa     /portal/login, /aquintutor/login and /hei/login. A missing relation is an
--                        ordinary query error there, and each page's catch turns it into "Sign-in is
--                        temporarily unavailable" — a sign-in outage rather than a degraded feature.
--
--   user_totp            TOTP enrolment and the hashed one-time recovery codes: /api/2fa/start,
--   user_backup_codes    /api/2fa/confirm, /api/2fa/disable, /api/auth/totp-login and the three
--                        security pages.
--
--   user_passkeys        Passkey / fingerprint / Face ID sign-in. Any ONE of password, passkey, face
--                        or TOTP signs you in here, so this is a front door, not an extra.
--
--   auth_recovery_token  Account recovery. Absent, a locked-out person cannot be let back in by the
--                        path built for it.
--
--   face_erasure_log     Not a feature table: the record that facial data was erased, by whom and
--                        why. Its absence does not break a screen — it means the erasure happened
--                        with no evidence that it happened.
--
--   team_roles           The RBAC registry. These are certainly present — src/middleware.ts reads
--   role_permissions     role_permissions and user_role_assignments through getViewableSectionKeys()
--   user_role_assignments on every admin page load, and that gate RE-THROWS anything that is not a
--   permission_catalogue timeout, so a missing relation there would be a 500 on every /admin page
--   role_permission_grants rather than a degraded one. Included because no committed file creates
--                        them either, and because role_permission_grants depends on two of them.
--
-- =================================================================================================
-- SAFETY
-- =================================================================================================
--
-- Every statement is CREATE TABLE / CREATE INDEX / ALTER TABLE ADD COLUMN with IF NOT EXISTS, so
-- running this twice is the same as running it once. Nothing here drops, renames, or rewrites a
-- column, and nothing takes a lock on a busy table for longer than an ALTER that finds its column
-- already present.
--
-- NOT WRAPPED IN ONE TRANSACTION, DELIBERATELY. src/lib/ensure-once.ts sets out the reason at
-- length: an ALTER TABLE takes its ACCESS EXCLUSIVE lock BEFORE it evaluates IF NOT EXISTS, and
-- inside one transaction it holds every lock it takes until commit — so a single batch would hold
-- exclusive locks on all of these at once while readers queued behind it. Statement by statement,
-- each lock is taken and released in turn. If one statement fails, fix it and re-run: everything
-- before it has already committed and everything after is idempotent.
--
-- THAT SENTENCE IS ONLY TRUE UNDER psql -f. There is no BEGIN in this file, but the absence of one
-- does not by itself make these separate transactions — that depends on how the client sends them.
-- Pasting the file into a SQL editor sends it as one Query and Postgres wraps it in one implicit
-- transaction, which restores exactly the all-locks-at-once behaviour this section is written to
-- avoid, and turns a failure at the end into a rollback of everything before it. See the note at
-- the top of the file.
--
-- ORDER MATTERS in exactly one place: role_permission_grants references team_roles(id) and
-- permission_catalogue(key), so those two come first.

SET lock_timeout = '5s';
SET statement_timeout = '60s';


-- =================================================================================================
-- 1. SHARED ATTEMPT LIMITER  (src/lib/auth/two-factor.ts)
-- =================================================================================================
--
-- On serverless there is no memory between invocations, so a per-request counter or an in-process
-- Map limits nothing. This table IS the limiter, for every guessable auth path on the project.

CREATE TABLE IF NOT EXISTS auth_attempt_limit (
  bucket text NOT NULL,
  window_start timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, window_start)
);


-- =================================================================================================
-- 2. SECOND-STEP ENFORCEMENT  (src/lib/auth/two-factor.ts)
-- =================================================================================================
--
-- Per-account opt-in. An absent ROW means "not enforced", which keeps every existing account on the
-- unchanged any-one-method model — but an absent TABLE means the question cannot be asked at all,
-- which is a different and much worse answer.

CREATE TABLE IF NOT EXISTS user_2fa_policy (
  user_id uuid PRIMARY KEY,
  required boolean NOT NULL DEFAULT false,
  enabled_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Half-finished sign-ins. The raw token never touches the database — only its hash.
CREATE TABLE IF NOT EXISTS auth_pending_2fa (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text NOT NULL UNIQUE,
  user_id uuid NOT NULL,
  surface text NOT NULL,
  first_factor text NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz
);

CREATE INDEX IF NOT EXISTS auth_pending_2fa_expiry_idx ON auth_pending_2fa(expires_at);


-- =================================================================================================
-- 3. TOTP AND RECOVERY CODES  (src/lib/auth/twofactor.ts)
-- =================================================================================================
--
-- RFC 6238, computed with node:crypto. No third-party library and no external service.

CREATE TABLE IF NOT EXISTS user_totp (
  user_id uuid PRIMARY KEY,
  secret text NOT NULL,
  confirmed_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_backup_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  code_hash text NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS user_backup_codes_user_idx ON user_backup_codes(user_id);


-- =================================================================================================
-- 4. PASSKEYS  (src/lib/auth/webauthn.ts)
-- =================================================================================================
--
-- Self-built WebAuthn. A passkey is a first-class sign-in method here, not a second factor bolted
-- onto a password.

CREATE TABLE IF NOT EXISTS user_passkeys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  credential_id text NOT NULL UNIQUE,
  public_key text NOT NULL,
  alg integer NOT NULL,
  counter bigint NOT NULL DEFAULT 0,
  name text,
  transports text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);

CREATE INDEX IF NOT EXISTS user_passkeys_user_idx ON user_passkeys(user_id);


-- =================================================================================================
-- 5. ACCOUNT RECOVERY  (src/lib/auth/recovery.ts)
-- =================================================================================================

CREATE TABLE IF NOT EXISTS auth_recovery_token (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text NOT NULL UNIQUE,
  user_id uuid NOT NULL,
  purpose text NOT NULL,
  method text,
  created_ip text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz
);

CREATE INDEX IF NOT EXISTS auth_recovery_token_user_idx ON auth_recovery_token(user_id, purpose);
CREATE INDEX IF NOT EXISTS auth_recovery_token_expiry_idx ON auth_recovery_token(expires_at);


-- =================================================================================================
-- 6. FACE ERASURE RECORD  (src/lib/auth/face-erasure.ts)
-- =================================================================================================
--
-- Not a feature table. This is the evidence that facial data was erased, by whom and why, which is
-- the part of an erasure that outlives the erasure.

CREATE TABLE IF NOT EXISTS face_erasure_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  actor_user_id UUID,
  reason TEXT,
  photo_cleared BOOLEAN NOT NULL DEFAULT false,
  at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- =================================================================================================
-- 7. THE RBAC REGISTRY  (src/lib/auth/registry.ts)
-- =================================================================================================
--
-- Almost certainly already present: src/middleware.ts reads role_permissions and
-- user_role_assignments on every admin page load through getViewableSectionKeys(), and admin pages
-- open. Included anyway because no committed file creates them either, and because
-- role_permission_grants at the end depends on two of them.

CREATE TABLE IF NOT EXISTS team_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(80) NOT NULL UNIQUE,
  description TEXT,
  color VARCHAR(20) NOT NULL DEFAULT 'orange',
  is_system BOOLEAN NOT NULL DEFAULT false,
  created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE team_roles ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE team_roles ADD COLUMN IF NOT EXISTS color VARCHAR(20) NOT NULL DEFAULT 'orange';
ALTER TABLE team_roles ADD COLUMN IF NOT EXISTS is_system BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE team_roles ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- The stable identifier. `name` is the label an admin edits; role_key is set once and never changes,
-- so a script can name a role and still mean the same role a year later. Nullable, and NULLs do not
-- conflict in a Postgres unique index, so the index below is safe to add to a populated table.
ALTER TABLE team_roles ADD COLUMN IF NOT EXISTS role_key VARCHAR(80);
CREATE UNIQUE INDEX IF NOT EXISTS team_roles_role_key_uidx ON team_roles (role_key) WHERE role_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS role_permissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  role_id UUID NOT NULL REFERENCES team_roles(id) ON DELETE CASCADE,
  page_key VARCHAR(80) NOT NULL,
  can_view BOOLEAN NOT NULL DEFAULT false,
  can_edit BOOLEAN NOT NULL DEFAULT false,
  can_delete BOOLEAN NOT NULL DEFAULT false,
  can_export BOOLEAN NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS role_permissions_role_idx ON role_permissions (role_id);

CREATE TABLE IF NOT EXISTS user_role_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id UUID NOT NULL REFERENCES team_roles(id) ON DELETE CASCADE,
  assigned_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS user_role_assign_user_idx ON user_role_assignments (user_id);
CREATE INDEX IF NOT EXISTS user_role_assign_role_idx ON user_role_assignments (role_id);

-- Permissions live here as ROWS. A new permission is an INSERT, not a build and a deploy.
CREATE TABLE IF NOT EXISTS permission_catalogue (
  key TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  group_key TEXT NOT NULL DEFAULT 'Other',
  description TEXT,
  is_builtin BOOLEAN NOT NULL DEFAULT false,
  is_sensitive BOOLEAN NOT NULL DEFAULT false,
  sort_order INTEGER NOT NULL DEFAULT 100,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS permission_catalogue_group_idx ON permission_catalogue (group_key, sort_order);

-- ON DELETE RESTRICT on permission_key is deliberate: a permission somebody still holds cannot be
-- quietly deleted out from under them. granted_by_email is denormalised so "who granted admin.access"
-- still has an answer after that person's account is gone.
CREATE TABLE IF NOT EXISTS role_permission_grants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  role_id UUID NOT NULL REFERENCES team_roles(id) ON DELETE CASCADE,
  permission_key TEXT NOT NULL REFERENCES permission_catalogue(key) ON DELETE RESTRICT,
  granted_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  granted_by_email TEXT,
  reason TEXT,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (role_id, permission_key)
);

CREATE INDEX IF NOT EXISTS role_permission_grants_role_idx ON role_permission_grants (role_id);
CREATE INDEX IF NOT EXISTS role_permission_grants_key_idx ON role_permission_grants (permission_key);


-- =================================================================================================
-- 8. CONFIRM
-- =================================================================================================
--
-- Run this after the file. Every row must say true. `/api/health` reports the same thing
-- continuously from now on — these tables are registered in BOOTSTRAP_MODULES
-- (src/lib/observability-health.ts), so `schemas.missingCount` is the live answer and
-- /api/health/deep names any that are still absent.

SELECT t.name, to_regclass('public.' || t.name) IS NOT NULL AS exists
FROM (VALUES
  ('auth_attempt_limit'),
  ('user_2fa_policy'),
  ('auth_pending_2fa'),
  ('user_totp'),
  ('user_backup_codes'),
  ('user_passkeys'),
  ('auth_recovery_token'),
  ('face_erasure_log'),
  ('team_roles'),
  ('role_permissions'),
  ('user_role_assignments'),
  ('permission_catalogue'),
  ('role_permission_grants')
) AS t(name)
ORDER BY exists, t.name;
