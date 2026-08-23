-- ================================================================================================
-- db/talent-os-validate.sql — WHAT THE SCHEMA CANNOT ENFORCE, DETECTED AFTER THE FACT
--
-- WHO RUNS THIS: the founder, or People Operations, after a bulk operation, a backfill, a merge, or
-- any manual correction. It is READ-ONLY. Every statement is a SELECT. Nothing here writes, deletes
-- or repairs anything, so it is safe to run against production at any time.
--
-- WHO DOES NOT RUN THIS: the agent that wrote it. Nothing in this phase touched the database.
--
-- HOW TO RUN IT (Supabase SQL editor, or psql against the transaction pooler):
--     \i db/talent-os-validate.sql
--
-- Each check returns ZERO ROWS when healthy. A row is a finding, and every finding carries enough
-- context to act on it without a second query.
--
-- ================================================================================================
-- WHY THIS FILE EXISTS AT ALL.
--
-- db/talent-os-schema.sql deliberately declines two things that a textbook schema would have:
--
--   1. FOREIGN KEYS. A person's selection history is the EVIDENCE BEHIND AN AUTHORIZATION. Deleting
--      an opportunity must not delete the record of who was authorised against it and by whom, and
--      ON DELETE CASCADE is precisely a mechanism for destroying that evidence quietly. The hr_* and
--      org_* tables in this codebase already work this way for the same reason.
--
--   2. CHECK CONSTRAINTS ON VOCABULARIES. This project has no migration runner — only
--      CREATE / ADD ... IF NOT EXISTS. Extending a CHECK means DROP CONSTRAINT then ADD CONSTRAINT,
--      by hand, against production. The vocabularies live in src/lib/talentos/vocab.ts instead.
--
-- Both choices trade enforcement for durability and operability. THE TRADE IS ONLY HONEST IF THE
-- GAP IS ACTUALLY WATCHED, and that is this file's whole job. db/org-graph-validate.sql makes the
-- same argument for the same reasons; this is its counterpart for the tos_* tables.
--
-- ================================================================================================
-- ONE THING TO KNOW BEFORE READING ANY QUERY BELOW.
--
-- departments.id is varchar(50) — a SLUG — in src/lib/db/schema.ts and UUID in db/hr-schema.sql.
-- Every department reference in the tos_* tables is TEXT and is NEVER cast to ::uuid. The joins
-- below compare department ids AS TEXT on both sides, deliberately. A ::uuid cast here would throw
-- "invalid input syntax for type uuid" the first time a slug arrives, turning a health check into
-- an outage.
-- ================================================================================================


-- ============================================================================================
-- === 1. VOCABULARY DRIFT (values no TypeScript writer would have produced) ===
-- ============================================================================================

-- A value outside the vocabulary means something wrote to these tables without going through
-- src/lib/talentos/vocab.ts. That writer is the finding, not the row.
SELECT 'tos_identity.identity_type' AS check_name, id, identity_code, identity_type AS bad_value
FROM tos_identity
WHERE identity_type NOT IN ('EMPLOYEE','INTERN','FELLOW','MEMBER','CAMPUS_AMBASSADOR',
                            'CONTRACTOR','CONSULTANT','OTHER_AUTHORIZED_IDENTITY')
UNION ALL
SELECT 'tos_identity.status', id, identity_code, status
FROM tos_identity
WHERE status NOT IN ('pending','active','suspended','expired','terminated')
UNION ALL
SELECT 'tos_application_link.pathway', application_id, NULL, pathway
FROM tos_application_link
WHERE pathway NOT IN ('recruitment','direct_onboarding')
UNION ALL
SELECT 'tos_application_link.applicant_type', application_id, NULL, applicant_type
FROM tos_application_link
WHERE applicant_type NOT IN ('external','internal')
UNION ALL
SELECT 'tos_stage_run.state', id, NULL, state
FROM tos_stage_run
WHERE state NOT IN ('not_started','invited','in_progress','submitted','under_review',
                    'passed','failed','waived','skipped')
UNION ALL
SELECT 'tos_stage_run.kind', id, NULL, kind
FROM tos_stage_run
WHERE kind NOT IN ('screening','assessment','assignment','interview','review','reference','decision')
UNION ALL
SELECT 'tos_selection.decision', id, selection_ref, decision
FROM tos_selection
WHERE decision NOT IN ('selected','rejected','waitlisted','withdrawn')
UNION ALL
SELECT 'tos_onboarding.state', id, onboarding_ref, state
FROM tos_onboarding
WHERE state NOT IN ('invited','started','pending','submitted','verification','approved',
                    'identity_created','access_provisioned','active','rejected','withdrawn');


-- ============================================================================================
-- === 2. ORPHANS (the price of having no foreign keys) ===
-- ============================================================================================

SELECT 'tos_person_email -> tos_person' AS check_name, e.id AS orphan_id, e.email AS detail
FROM tos_person_email e
LEFT JOIN tos_person p ON p.id = e.person_id
WHERE p.id IS NULL
UNION ALL
SELECT 'tos_identity -> tos_person', i.id, i.identity_code
FROM tos_identity i
LEFT JOIN tos_person p ON p.id = i.person_id
WHERE p.id IS NULL
UNION ALL
-- An employment-backed identity whose hr_employees row has gone. The identity still authorises
-- things, so this one matters more than it looks.
SELECT 'tos_identity -> hr_employees', i.id, i.identity_code
FROM tos_identity i
LEFT JOIN hr_employees h ON h.id = i.employee_id
WHERE i.employee_id IS NOT NULL AND h.id IS NULL
UNION ALL
SELECT 'tos_application_link -> applications', al.application_id, al.pathway
FROM tos_application_link al
LEFT JOIN applications a ON a.id = al.application_id
WHERE a.id IS NULL
UNION ALL
SELECT 'tos_application_link -> roles', al.application_id, al.opportunity_role_id::text
FROM tos_application_link al
LEFT JOIN roles r ON r.id = al.opportunity_role_id
WHERE r.id IS NULL
UNION ALL
SELECT 'tos_opportunity -> roles', o.role_id, o.opportunity_code
FROM tos_opportunity o
LEFT JOIN roles r ON r.id = o.role_id
WHERE r.id IS NULL
UNION ALL
SELECT 'tos_stage_run -> tos_pipeline_stage', sr.id, sr.slot_no::text
FROM tos_stage_run sr
LEFT JOIN tos_pipeline_stage ps ON ps.id = sr.pipeline_stage_id
WHERE ps.id IS NULL
UNION ALL
SELECT 'tos_evaluation -> tos_stage_run', ev.id, ev.verdict
FROM tos_evaluation ev
LEFT JOIN tos_stage_run sr ON sr.id = ev.stage_run_id
WHERE sr.id IS NULL
UNION ALL
-- A LIVE CREDENTIAL WHOSE SELECTION HAS GONE. This is the most serious orphan in the file: the
-- validation ladder reads tos_selection.is_authorised, and a missing selection row must refuse
-- rather than be treated as absent-therefore-fine.
SELECT 'tos_auth_code -> tos_selection', c.id, c.code_display_prefix
FROM tos_auth_code c
LEFT JOIN tos_selection s ON s.id = c.selection_id
WHERE s.id IS NULL
UNION ALL
SELECT 'tos_onboarding -> tos_selection', o.id, o.onboarding_ref
FROM tos_onboarding o
LEFT JOIN tos_selection s ON s.id = o.selection_id
WHERE s.id IS NULL
UNION ALL
SELECT 'tos_onboarding_grant -> tos_auth_code', g.id, g.id::text
FROM tos_onboarding_grant g
LEFT JOIN tos_auth_code c ON c.id = g.auth_code_id
WHERE c.id IS NULL
UNION ALL
SELECT 'tos_provisioning_event -> tos_identity', pe.id, pe.target_key
FROM tos_provisioning_event pe
LEFT JOIN tos_identity i ON i.id = pe.identity_id
WHERE i.id IS NULL;


-- ============================================================================================
-- === 3. MERGE INTEGRITY (rows still pointing at a person who was merged away) ===
-- ============================================================================================

-- tos_person uses merged_into_id rather than DELETE, so every reader must either filter
-- merged_into_id IS NULL or follow the pointer. A row here is a reader that did neither.
SELECT 'application linked to merged person' AS check_name,
       al.application_id AS row_id, p.person_code, p.merged_into_id
FROM tos_application_link al
JOIN tos_person p ON p.id = al.person_id
WHERE p.merged_into_id IS NOT NULL
UNION ALL
SELECT 'selection on merged person', s.id, p.person_code, p.merged_into_id
FROM tos_selection s
JOIN tos_person p ON p.id = s.person_id
WHERE p.merged_into_id IS NOT NULL
UNION ALL
SELECT 'live code on merged person', c.id, p.person_code, p.merged_into_id
FROM tos_auth_code c
JOIN tos_person p ON p.id = c.person_id
WHERE p.merged_into_id IS NOT NULL
  AND c.revoked_at IS NULL AND c.consumed_at IS NULL AND c.expires_at > NOW()
UNION ALL
SELECT 'identity on merged person', i.id, p.person_code, p.merged_into_id
FROM tos_identity i
JOIN tos_person p ON p.id = i.person_id
WHERE p.merged_into_id IS NOT NULL;

-- A merge pointer that goes nowhere, or a chain of them. Merges must repoint to a LIVE person, not
-- to another merged row, or "follow the pointer" becomes an unbounded walk.
SELECT 'merge target missing or itself merged' AS check_name,
       p.id, p.person_code, p.merged_into_id
FROM tos_person p
LEFT JOIN tos_person t ON t.id = p.merged_into_id
WHERE p.merged_into_id IS NOT NULL
  AND (t.id IS NULL OR t.merged_into_id IS NOT NULL);


-- ============================================================================================
-- === 4. IDENTITY INVARIANTS ===
-- ============================================================================================

-- The partial unique index tos_identity_one_primary already makes two ACTIVE primaries impossible.
-- What it cannot catch is an identity that is primary while NOT active, which reads to a human as
-- "this is their current identity" and to the index as nothing at all.
SELECT 'primary identity that is not active' AS check_name,
       id, identity_code, status
FROM tos_identity
WHERE is_primary AND status <> 'active';

-- A person holding an active identity but no primary among them: every "their current role" query
-- returns nothing, and the person appears to have no place in the organisation.
SELECT 'active identities but none primary' AS check_name,
       p.id, p.person_code, count(*)::text AS active_count
FROM tos_person p
JOIN tos_identity i ON i.person_id = p.id AND i.status = 'active'
WHERE p.merged_into_id IS NULL
GROUP BY p.id, p.person_code
HAVING bool_and(NOT i.is_primary);

-- EMPLOYEE and INTERN are employment-backed and must carry an hr_employees row; nothing else may.
-- "A fellow is not payroll" is the rule, and this is where it is checked.
SELECT 'employment-backed identity with no employee row' AS check_name,
       id, identity_code, identity_type
FROM tos_identity
WHERE identity_type IN ('EMPLOYEE','INTERN') AND employee_id IS NULL AND status = 'active'
UNION ALL
SELECT 'non-employment identity carrying an employee row', id, identity_code, identity_type
FROM tos_identity
WHERE identity_type NOT IN ('EMPLOYEE','INTERN') AND employee_id IS NOT NULL;

-- A date range that runs backwards, or an active identity that has already ended.
SELECT 'identity dates inconsistent' AS check_name, id, identity_code,
       (started_on::text || ' -> ' || COALESCE(ended_on::text,'open')) AS detail
FROM tos_identity
WHERE (ended_on IS NOT NULL AND started_on IS NOT NULL AND ended_on < started_on)
   OR (status = 'active' AND ended_on IS NOT NULL AND ended_on < CURRENT_DATE);

-- Two identities claiming the same employment record.
SELECT 'employee row claimed by more than one identity' AS check_name,
       employee_id AS id, count(*)::text AS identity_count,
       string_agg(identity_code, ', ') AS detail
FROM tos_identity
WHERE employee_id IS NOT NULL
GROUP BY employee_id HAVING count(*) > 1;


-- ============================================================================================
-- === 5. THE SEVEN-SLOT INVARIANT ===
-- ============================================================================================

-- Seven slots is the framework. A pipeline with any other number is misconfigured, and every
-- candidate entering it gets a process nobody designed.
SELECT 'pipeline does not have exactly seven slots' AS check_name,
       p.id, p.key, count(ps.id)::text AS slot_count
FROM tos_pipeline p
LEFT JOIN tos_pipeline_stage ps ON ps.pipeline_id = p.id
GROUP BY p.id, p.key HAVING count(ps.id) <> 7;

-- Seven slots present but not numbered 1..7 (a gap, or a duplicate the unique index somehow missed).
SELECT 'pipeline slots are not 1..7' AS check_name,
       p.id, p.key, string_agg(ps.slot_no::text, ',' ORDER BY ps.slot_no) AS detail
FROM tos_pipeline p
JOIN tos_pipeline_stage ps ON ps.pipeline_id = p.id
GROUP BY p.id, p.key
HAVING string_agg(ps.slot_no::text, ',' ORDER BY ps.slot_no) <> '1,2,3,4,5,6,7';

-- An application that entered evaluation with fewer than seven runs. A slot a role does not use is
-- 'skipped', never absent, so that the audit shows seven slots for every candidate.
SELECT 'application has fewer than seven stage runs' AS check_name,
       sr.application_id AS id, count(*)::text AS run_count, NULL AS detail
FROM tos_stage_run sr
GROUP BY sr.application_id HAVING count(*) <> 7;

-- Exactly one default pipeline. The partial unique index enforces at-most-one; this catches none.
SELECT 'no default pipeline' AS check_name, NULL::uuid AS id, NULL AS detail
WHERE NOT EXISTS (SELECT 1 FROM tos_pipeline WHERE is_default AND is_active);


-- ============================================================================================
-- === 6. ADVISORY-ONLY DETECTION ===
-- ============================================================================================

-- AUTOMATED DETECTION IS ADVISORY. A human decides. A stage that failed with no human recorded
-- against the decision is the shape of an automated signal having decided an outcome, which is
-- forbidden — false positives here cause real harm to a real candidate.
SELECT 'stage failed with no human decider' AS check_name,
       id, application_id::text AS detail, slot_no::text AS slot
FROM tos_stage_run
WHERE state = 'failed' AND decided_by IS NULL;

-- A failed stage carrying advisory flags but no written outcome note: the flags must not be left to
-- speak for themselves, because a flag is a signal and never a finding of misconduct.
SELECT 'flagged failure with no written reason' AS check_name,
       id, application_id::text, slot_no::text
FROM tos_stage_run
WHERE state = 'failed'
  AND jsonb_array_length(COALESCE(advisory_flags,'[]'::jsonb)) > 0
  AND (outcome_note IS NULL OR length(btrim(outcome_note)) = 0);


-- ============================================================================================
-- === 7. SELECTION AND CREDENTIAL SAFETY ===
-- ============================================================================================

-- A written reason is promised in BOTH directions, and an appeal needs something to appeal against.
SELECT 'selection decided with no written reason' AS check_name, id, selection_ref, decision
FROM tos_selection
WHERE decision_reason IS NULL OR length(btrim(decision_reason)) < 10;

-- Authorised without an approver: is_authorised is what the validation ladder reads, so it must
-- never be true on a row nobody signed.
SELECT 'authorised with no approver' AS check_name, id, selection_ref, decided_at::text
FROM tos_selection
WHERE is_authorised AND approved_by_user_id IS NULL;

-- Authorised on a decision that is not a selection.
SELECT 'authorised but not selected' AS check_name, id, selection_ref, decision
FROM tos_selection
WHERE is_authorised AND decision <> 'selected';

-- A LIVE CODE AGAINST A DEAD SELECTION. Every one of these is a person who can still walk into
-- onboarding for something that was suspended, rejected or withdrawn. The ladder catches it at
-- redemption; this catches it before they try.
SELECT 'live code on suspended or unauthorised selection' AS check_name,
       c.id, c.code_display_prefix, s.decision AS detail
FROM tos_auth_code c
JOIN tos_selection s ON s.id = c.selection_id
WHERE c.revoked_at IS NULL AND c.consumed_at IS NULL AND c.expires_at > NOW()
  AND (s.suspended_at IS NOT NULL OR NOT s.is_authorised OR s.decision <> 'selected');

-- Use count past its ceiling, or consumed while still counted as unused.
SELECT 'code use count inconsistent' AS check_name, id, code_display_prefix,
       (use_count::text || ' of ' || max_uses::text) AS detail
FROM tos_auth_code
WHERE use_count > max_uses
   OR (consumed_at IS NOT NULL AND use_count = 0)
   OR (use_count >= max_uses AND consumed_at IS NULL AND revoked_at IS NULL);

-- A code whose plaintext looks like it was stored. code_hash is sha256 hex and nothing else; a
-- value with a dash in it is a code that was written to the database in the clear.
SELECT 'code_hash does not look like a hash' AS check_name, id, code_display_prefix, code_hash
FROM tos_auth_code
WHERE code_hash !~ '^[0-9a-f]{64}$';

-- Grants outliving their two-hour window without being consumed or revoked. A stale grant is not
-- itself authority — every route re-verifies — but a pile of them means the sweep is not running.
SELECT 'grant expired and never closed' AS check_name, id, person_id::text, expires_at::text
FROM tos_onboarding_grant
WHERE expires_at < NOW() - INTERVAL '7 days'
  AND consumed_at IS NULL AND revoked_at IS NULL;


-- ============================================================================================
-- === 8. ONBOARDING AND PROVISIONING ===
-- ============================================================================================

-- Approved onboarding that never produced an identity. This is the exact shape of the failure that
-- went unnoticed for eleven days on the hire path: the record says approved, and nothing exists.
SELECT 'approved onboarding with no identity' AS check_name,
       id, onboarding_ref, approved_at::text
FROM tos_onboarding
WHERE state IN ('approved','identity_created','access_provisioned','active')
  AND identity_id IS NULL;

-- An identity pointing back at an onboarding record that does not point at it. One of the two
-- writes landed and the other did not.
SELECT 'onboarding and identity disagree' AS check_name,
       o.id, o.onboarding_ref, i.identity_code AS detail
FROM tos_onboarding o
JOIN tos_identity i ON i.id = o.identity_id
WHERE i.source_onboarding_id IS DISTINCT FROM o.id;

-- Two onboarding records for one selection. The UNIQUE on selection_id prevents it; this catches a
-- database restored from before that index existed.
SELECT 'duplicate onboarding for one selection' AS check_name,
       selection_id AS id, count(*)::text AS detail, string_agg(onboarding_ref, ', ') AS refs
FROM tos_onboarding
GROUP BY selection_id HAVING count(*) > 1;

-- HALF-APPLIED PROVISIONING. A profile that granted four of six targets leaves a person with
-- partial access and no surface saying so. These rows are why tos_provisioning_event exists.
SELECT 'provisioning stuck pending' AS check_name,
       pe.id, pe.target_kind || ':' || pe.target_key AS detail, pe.created_at::text
FROM tos_provisioning_event pe
WHERE pe.state = 'pending' AND pe.created_at < NOW() - INTERVAL '1 hour'
UNION ALL
SELECT 'provisioning failed and not retried', pe.id,
       pe.target_kind || ':' || pe.target_key, COALESCE(pe.error_reason,'(no reason recorded)')
FROM tos_provisioning_event pe
WHERE pe.state = 'failed';

-- ACCESS THAT OUTLIVED ITS IDENTITY. Every grant here belongs to somebody who is suspended, expired
-- or terminated, and every one of them is a live way in.
SELECT 'access granted to a non-active identity' AS check_name,
       pe.id, i.identity_code, i.status || ' / ' || pe.target_kind || ':' || pe.target_key AS detail
FROM tos_provisioning_event pe
JOIN tos_identity i ON i.id = pe.identity_id
WHERE pe.action = 'grant' AND pe.state = 'applied'
  AND i.status <> 'active'
  AND NOT EXISTS (
    SELECT 1 FROM tos_provisioning_event r
    WHERE r.identity_id = pe.identity_id
      AND r.target_kind = pe.target_kind AND r.target_key = pe.target_key
      AND r.action = 'revoke' AND r.state = 'applied' AND r.created_at > pe.created_at);


-- ============================================================================================
-- === 9. OVERRIDES WITHOUT A REASON ===
-- ============================================================================================

-- Never implement a silent override. A reason shorter than a sentence is a dropdown pretending to
-- be one, and an override with no actor is not an override, it is an accident.
SELECT 'override with no usable reason' AS check_name,
       id, entity || ':' || entity_id::text AS detail, COALESCE(reason,'(null)') AS reason
FROM tos_override
WHERE reason IS NULL OR length(btrim(reason)) < 20 OR actor_user_id IS NULL;


-- ============================================================================================
-- === 10. DEPARTMENT REFERENCES (compared AS TEXT on both sides, never ::uuid) ===
-- ============================================================================================

-- departments.id is a slug in one declaration and a UUID in another, so this join is deliberately
-- text-to-text. A row here is a department reference pointing at nothing.
SELECT 'tos_identity.department_id unknown' AS check_name, i.id, i.identity_code, i.department_id
FROM tos_identity i
WHERE i.department_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM departments d WHERE d.id::text = i.department_id)
UNION ALL
SELECT 'tos_selection.offered_department_id unknown', s.id, s.selection_ref, s.offered_department_id
FROM tos_selection s
WHERE s.offered_department_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM departments d WHERE d.id::text = s.offered_department_id)
UNION ALL
SELECT 'tos_access_profile.department_id unknown', ap.id, ap.profile_key, ap.department_id
FROM tos_access_profile ap
WHERE ap.department_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM departments d WHERE d.id::text = ap.department_id);


-- ============================================================================================
-- === VALIDATION COMPLETE — every section above should have returned zero rows ===
-- ============================================================================================
