-- db/auth-recovery-token.sql
--
-- RUN THIS BY HAND. Nothing in the application will create this table in production.
--
-- WHY IT HAS ITS OWN FILE. auth_recovery_token is the table behind the emailed one-time password
-- reset link. Its only creator was ensureRecoverySchema() in src/lib/auth/recovery.ts, and
-- src/lib/ensure-once.ts makes every such bootstrap a resolved promise when NODE_ENV=production and
-- SCHEMA_BOOTSTRAP is unset — which is the default. So on a restored, rebuilt or newly provisioned
-- database the table simply is not there.
--
-- THAT IS THE WORST TABLE ON THE PLATFORM TO BE MISSING, because of who needs it and when. Every
-- other bootstrap-only table costs a feature that reports nothing. This one costs the recovery path
-- of somebody who is ALREADY LOCKED OUT: they cannot sign in, so they ask for a reset link, and the
-- write that would issue it fails. A person with a working password never touches it, which is
-- exactly why its absence stays invisible until it matters most.
--
-- Found on 2026-08-24 after the Supabase account migration. The dump was taken at 14:56 and this
-- table was among the objects the restore could not carry, because it had never existed on the
-- source either — the bootstrap that owns it had been a no-op there since the production kill switch
-- landed. /api/health reported it as one of three missing module tables.
--
-- The DDL is copied verbatim from src/lib/auth/recovery.ts and must stay identical to it.
-- Idempotent: every statement is IF NOT EXISTS, and nothing here drops or alters existing data.

CREATE TABLE IF NOT EXISTS auth_recovery_token (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The token itself is never stored, only its hash. A database copy therefore cannot be used to
  -- mint a working reset link, which is the whole point of hashing a bearer credential at rest.
  token_hash text NOT NULL UNIQUE,
  user_id uuid NOT NULL,
  purpose text NOT NULL,
  method text,
  created_ip text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  -- Set when the link is redeemed. A consumed token is kept rather than deleted so that a second
  -- attempt can be told the link has already been used instead of that it never existed.
  consumed_at timestamptz
);

CREATE INDEX IF NOT EXISTS auth_recovery_token_user_idx
  ON auth_recovery_token(user_id, purpose);

CREATE INDEX IF NOT EXISTS auth_recovery_token_expiry_idx
  ON auth_recovery_token(expires_at);
