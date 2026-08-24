-- db/application-invitations-schema.sql
--
-- RUN THIS BY HAND AGAINST PRODUCTION. Nothing in the application will create this table there.
--
-- =================================================================================================
-- WHY THIS FILE EXISTS
-- =================================================================================================
--
-- Schema bootstrap is OFF in production (src/lib/ensure-once.ts, plus the DDL guard on db.execute).
-- A table whose only creator is an ensure*() therefore does NOT exist on the live site. /api/health
-- is currently reporting four suppressed statements for exactly that reason, so this module is not
-- going to add a fifth: the table is written down here, run by hand, and registered in
-- BOOTSTRAP_MODULES so /api/health says out loud whether it is present.
--
-- HOW TO RUN IT. `psql -f db/application-invitations-schema.sql` commits statement by statement. A
-- paste into a SQL editor is ONE implicit transaction instead — every lock held together, and any
-- failure rolls the whole file back. Either is fine here (it is small), but know which one you did.
--
-- Safe to re-run.
--
-- =================================================================================================
-- WHAT AN INVITATION IS, AND WHAT IT IS NOT
-- =================================================================================================
--
-- An invitation says: "a named administrator asked THIS person to apply for THIS opportunity."
-- That is all. The person still fills in the application and it still goes to a human reviewer.
--
-- It is NOT tal_onboarding_code (ERA-SEL). That code means somebody was already SELECTED and skips
-- the application entirely, and it is a typed secret with a uniform rejection sentence because a
-- typed secret is guessable. An invitation is a 32-byte URL token that only shortens the walk to a
-- form anyone can reach anyway at /careers, so it does not carry the same blast radius.
--
-- THE TOKEN IS NEVER STORED. token_hash holds sha256(token) and nothing else; the plaintext is
-- returned once, to the administrator who created it, and is unrecoverable afterwards. A dump of
-- this table cannot be used to walk into anybody's application.

CREATE TABLE IF NOT EXISTS application_invitations (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- WHO. Lowercased at write time; the email is the binding between the invitation and the
  -- application that eventually appears, because an applicant signs in before step-1 and the email
  -- is the one identifier both sides already agree on.
  email             TEXT NOT NULL,
  full_name         TEXT NOT NULL DEFAULT '',

  -- WHAT FOR. role_id has no FOREIGN KEY, matching this project's convention for tables created
  -- outside the drizzle schema: an invitation must not vanish because a posting was archived. The
  -- slug and title are SNAPSHOTS so the link keeps working, and keeps meaning the same thing, after
  -- somebody renames the posting.
  role_id           UUID,
  role_slug         TEXT NOT NULL DEFAULT '',
  role_title        TEXT NOT NULL DEFAULT '',

  -- THE SECRET. sha256 of the token. The prefix is stored separately so the admin list can show
  -- which invitation a support email is about without the table holding anything that opens a door.
  token_hash        TEXT NOT NULL,
  token_prefix      TEXT NOT NULL DEFAULT '',

  -- A line from the administrator, shown in the email and on the landing page. Free text a person
  -- typed, so every surface that renders it must escape it.
  note              TEXT NOT NULL DEFAULT '',

  -- MONEY. Per-invitation, defaulting to off: being invited does not by itself waive a fee, an
  -- administrator has to decide it for this person. Read at fee time and recorded on the waiver.
  waive_fee         BOOLEAN NOT NULL DEFAULT FALSE,

  invited_by        UUID,
  invited_by_name   TEXT NOT NULL DEFAULT '',

  -- pending | opened | applied | revoked. Expiry is derived from expires_at rather than stored as a
  -- status, so nothing has to run on a schedule to keep this column honest.
  status            TEXT NOT NULL DEFAULT 'pending',

  -- WHETHER THE MAIL ACTUALLY WENT. Recorded rather than assumed: this project has been bitten by
  -- surfaces that reported a send they never confirmed, and an administrator who thinks an
  -- invitation was delivered will not follow up on it.
  email_sent        BOOLEAN NOT NULL DEFAULT FALSE,
  email_error       TEXT NOT NULL DEFAULT '',

  application_id    UUID,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at        TIMESTAMPTZ NOT NULL,
  sent_at           TIMESTAMPTZ,
  opened_at         TIMESTAMPTZ,
  applied_at        TIMESTAMPTZ,
  revoked_at        TIMESTAMPTZ,
  revoked_by        UUID
);

-- Redemption hashes the token from the URL and hits this index. There is no "find invitations
-- starting with..." path anywhere in the module, so there is nothing to walk.
CREATE UNIQUE INDEX IF NOT EXISTS app_inv_token_uq ON application_invitations (token_hash);

-- The fee-waiver lookup at application time: "does this email hold a live invitation for this role".
CREATE INDEX IF NOT EXISTS app_inv_email_idx ON application_invitations (email, role_slug);

-- The admin list, newest first.
CREATE INDEX IF NOT EXISTS app_inv_created_idx ON application_invitations (created_at DESC);

-- ONE LIVE INVITATION PER PERSON PER ROLE, enforced here rather than by convention, so re-inviting
-- somebody cannot leave two working links where revoking "the" invitation revokes one of them.
CREATE UNIQUE INDEX IF NOT EXISTS app_inv_active_uq
  ON application_invitations (email, role_slug)
  WHERE status IN ('pending', 'opened');
