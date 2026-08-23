-- EduRankAI: remove equity/ESOP promises from candidate-facing DATA.
-- Written for you to run yourself. Nothing here was executed: no database connection was
-- opened while producing it. Review before running; each statement is idempotent (a second
-- run matches zero rows).
--
-- Context: the code changes are already in the working tree, but two kinds of copy live in
-- the database and cannot be fixed by editing files:
--   A. content_pages -> the /p/hiring-philosophy body (the page in your screenshot)
--   B. roles.salary  -> free text shown on /careers/<slug> and syndicated by /api/jobs-feed
--
-- Note on urgency for (B): /careers/[slug].astro and /api/jobs-feed.ts now strip an ownership
-- promise at render time, so a stale row is no longer shown to a candidate. These statements
-- are the real fix at source; the strip is the guard until they run.

-- ===========================================================================
-- A. /p/hiring-philosophy -- the Compensation section
-- ===========================================================================
-- scripts/seed-content.mjs is INSERT-only ("skipped (exists)"), so the corrected body will
-- never reach production through the seeder. This is the only way to update it apart from
-- editing the page by hand at /admin/content (which is the easier route if you prefer a UI).

WITH new_copy(body) AS (VALUES ($body$## What we look for

We hire for taste, judgment, and the ability to ship without supervision. Pedigree helps but does not substitute for proof of work. A strong portfolio link, a GitHub repo, a paper, a deployed product, a written critique — anything tangible — tells us more than a CV.

## Our three principles

- **Proof over claims.** Every candidate is asked to show real artifacts. We do not rely on resumes alone.
- **Honest stages.** Applicants always know where they stand. Status is visible in the portal in real time. We do not ghost.
- **Senior evaluators.** Candidates are interviewed by people at or above their target level. Junior engineers do not interview senior engineers.

## Compensation

Internships and apprenticeships at this stage are unpaid. We state that before you apply, not after.

Full-time roles carry real monetary compensation. It is discussed openly at the offer stage: we share the market context we are working from and the budget we actually have, rather than anchoring low and waiting to be negotiated up. What we offer follows role scope, strategic responsibility, demonstrated capability, and what the firm can genuinely fund.

EduRankAI is a proprietorship. There is no ESOP, no stock, no shares, and no equity programme of any kind — at any level, and not as a deferred promise either.

The one exception is net-profit sharing, and it is deliberately narrow. It may be extended, at the firm’s discretion, to extraordinary C-level leadership whose exceptional contribution and strategic impact are materially significant to the firm. It is not a standard benefit and does not attach to a title; where it applies, it is governed by the terms of that leadership arrangement and by firm performance.

## Response time

We aim to respond within 5 business days of submission. If your application advances, you will hear quickly and clearly. If we do not move forward, we try to give honest, useful feedback rather than form rejections — though at scale this is not always possible.

## No tricks

We do not use timed take-home assignments meant to stress-test you. We do not require coding under surveillance. Our evaluation is centered on a live walkthrough of your past work, in-depth conversation, and (for senior roles) collaborative debugging or system design.

## Reapplying

If we say no this time, you can reapply for a different role or after 6 months. Many of our best candidates came back stronger on a second application.$body$))
UPDATE content_pages c
   SET body       = n.body,
       version    = c.version + 1,
       updated_at = now()
  FROM new_copy n
 WHERE c.slug = 'hiring-philosophy'
   AND c.body IS DISTINCT FROM n.body;

-- Verify: expect still_promises_equity = false, has_proprietorship_copy = true.
SELECT slug, version, updated_at, is_published,
       (body LIKE '%Equity (ESOP) is reserved%')          AS still_promises_equity,
       (body LIKE '%no equity programme of any kind%')    AS has_proprietorship_copy
  FROM content_pages
 WHERE slug = 'hiring-philosophy';


-- ===========================================================================
-- B1. roles.salary -- the six rows seeded by scripts/seed-starter-roles.mjs
-- ===========================================================================
-- These mirror the corrected seed file exactly. Keyed on slug, never blanket.

UPDATE roles SET
  salary     = $s$Unpaid + Full ownership of the product you ship + Direct Founder Office mentorship + Priority pathway to full-time roles on exceptional contribution$s$,
  updated_at = now()
 WHERE slug = 'product-specific-intern' AND salary IS DISTINCT FROM $s$Unpaid + Full ownership of the product you ship + Direct Founder Office mentorship + Priority pathway to full-time roles on exceptional contribution$s$;

UPDATE roles SET
  salary     = $s$Full-time compensation discussed individually with shortlisted candidates + Discretionary net-profit sharing for extraordinary C-level contribution$s$,
  updated_at = now()
 WHERE slug = 'ceo' AND salary IS DISTINCT FROM $s$Full-time compensation discussed individually with shortlisted candidates + Discretionary net-profit sharing for extraordinary C-level contribution$s$;

UPDATE roles SET
  salary     = $s$Senior package + Top-quartile for Bharat-based AI startups + Market context and budget shared openly + Reviewed annually$s$,
  updated_at = now()
 WHERE slug = 'senior-ml-engineer' AND salary IS DISTINCT FROM $s$Senior package + Top-quartile for Bharat-based AI startups + Market context and budget shared openly + Reviewed annually$s$;

UPDATE roles SET
  salary     = $s$Competitive + Above-market for Bharat-based candidates + Budget shared openly at offer stage + Performance reviews twice yearly$s$,
  updated_at = now()
 WHERE slug = 'product-manager' AND salary IS DISTINCT FROM $s$Competitive + Above-market for Bharat-based candidates + Budget shared openly at offer stage + Performance reviews twice yearly$s$;

UPDATE roles SET
  salary     = $s$Senior package + Top-quartile for Bharat-based AI startups + Market context and budget shared openly$s$,
  updated_at = now()
 WHERE slug = 'ai-safety-engineer' AND salary IS DISTINCT FROM $s$Senior package + Top-quartile for Bharat-based AI startups + Market context and budget shared openly$s$;


-- ===========================================================================
-- B2. roles.salary -- everything else (about 80 rows, seeded from .dev-scripts/*.cjs)
-- ===========================================================================
-- These were written by seed scripts that are gitignored and are not part of this change,
-- so there is no corrected file to copy from. Look at them first and decide the replacement
-- text per row -- do NOT bulk-regex them, because the money half and the equity half are
-- welded into one sentence in several rows and a blind substitution produces nonsense.

-- Step 1 (read-only): list what is left.
SELECT slug, title, level, salary
  FROM roles
 WHERE salary ~* '(esop|equity|stock|yshares?y|ownership stake|employee ownership|profit[- ]?shar|revenue[- ]?shar|vest)'
 ORDER BY level, slug;

-- Step 2: one statement per slug from step 1, with the pay text you decide on.
-- (Or edit the role in /admin/roles, which writes the same column.)
UPDATE roles
   SET salary     = 'PASTE THE MONETARY TEXT ONLY',
       updated_at = now()
 WHERE slug = 'PASTE-SLUG-FROM-STEP-1'
   AND salary IS DISTINCT FROM 'PASTE THE MONETARY TEXT ONLY';

-- Step 3 (read-only): confirm. Expect 0.
SELECT count(*) AS rows_still_promising_equity
  FROM roles
 WHERE salary ~* '(esop|equity|stock|yshares?y|ownership stake|employee ownership|profit[- ]?shar|revenue[- ]?shar|vest)';

-- Note: y is the Postgres word boundary.  means backspace in Postgres regex -- do not
-- rewrite these patterns with .
