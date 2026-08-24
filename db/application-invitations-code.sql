-- db/application-invitations-code.sql
--
-- RUN THIS BY HAND AGAINST PRODUCTION, after db/application-invitations-schema.sql.
--
-- =================================================================================================
-- WHAT THIS ADDS
-- =================================================================================================
--
-- A typed code beside the link. An invitation link is a 43-character URL token, which is fine when
-- the person can click it and useless when they cannot: an email client mangles it, they read the
-- mail on a phone and apply on a laptop, somebody reads it out over a call. The code is
-- ERA-INV-XXXXX-XXXXX-XXXXX and can be typed at /invite.
--
-- SAME DISCIPLINE AS THE TOKEN. code_hash is sha256 of the normalised body and nothing else; the
-- plaintext is shown once, to the administrator who created the invitation, and is unrecoverable
-- afterwards. code_prefix is the first group only — enough for an administrator to recognise which
-- invitation somebody is asking about on the phone, never enough to reconstruct one.
--
-- WHY A CODE NEEDS MORE CARE THAN THE TOKEN. It is short enough to be guessed at, and what a guess
-- would reveal is not nothing: who was invited, to which posting, the line the administrator wrote
-- them, and whether their fee was waived. So the alphabet is the project's existing CODE_ALPHABET
-- (no O, 0, I or 1 to mistype), every refusal is the same sentence, and attempts are counted in
-- auth_attempt_limit — the limiter this project already has, rather than a second one.
--
-- ON THE ALTER. application_invitations is a table this feature owns and which held almost nothing
-- when this was written, so the ACCESS EXCLUSIVE lock is momentary. That is NOT true of the ALTERs
-- in db/application-stages-schema.sql, which is why those are commented out and these are not.
--
-- HOW TO RUN IT. Either the SQL editor (this file is small enough that one transaction is fine) or:
--   node scripts/apply-sql.mjs db/application-invitations-code.sql --env-file .env.production --dry-run
--
-- Safe to re-run.

ALTER TABLE application_invitations ADD COLUMN IF NOT EXISTS code_hash   TEXT;
ALTER TABLE application_invitations ADD COLUMN IF NOT EXISTS code_prefix TEXT NOT NULL DEFAULT '';

-- Redemption hashes what was typed and hits this index. Partial, because invitations issued before
-- this file ran have no code and a plain unique index would collide all of them on NULL.
CREATE UNIQUE INDEX IF NOT EXISTS app_inv_code_uq
  ON application_invitations (code_hash)
  WHERE code_hash IS NOT NULL;

-- -------------------------------------------------------------------------------------------------
-- Confirm it. Expect two rows.
-- -------------------------------------------------------------------------------------------------
-- SELECT column_name FROM information_schema.columns
--  WHERE table_schema = 'public' AND table_name = 'application_invitations'
--    AND column_name IN ('code_hash', 'code_prefix');
