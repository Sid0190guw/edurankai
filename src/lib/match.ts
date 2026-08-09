// src/lib/match.ts — COMPARING A PERSON TO A JOB, WITH THE EXPLANATION AS THE PRODUCT.
//
// =================================================================================================
// THE THING THIS FILE REFUSES TO BE
// =================================================================================================
//
// Before this build there was no candidate-to-job matching in this codebase at all — not keyword,
// not semantic, not any. That absence was an advantage: the fastest way to violate "never treat a
// keyword as proof of competence" would have been to overlap `roles.skills` strings with
// `applications.tech_skills` blobs and print a percentage.
//
// So the comparison here runs against RECORDED REQUIREMENTS (src/lib/job-twin.ts, job_requirements
// rows naming an hr_skills id, a level and a written reason) and EVIDENCED CAPABILITIES
// (hr_employee_skills, whose `source` column already distinguishes a self-claim from a confirmed
// completion). Words are carried through the whole pipeline as words: a keyword can produce the
// coverage value `claimed_only` and nothing better, ever, on any path.
//
// A job with no recorded requirements is NOT matched. evaluate() returns an explanation whose
// conclusion is that nothing could be compared. There is no fallback to the job description text,
// because a fallback is how a system designed to avoid the keyword trap walks into it on the day
// somebody forgets to record a requirement.
//
// =================================================================================================
// THE ONTOLOGY, AND ITS LIMITS, STATED HONESTLY
// =================================================================================================
//
// THIS MODULE DOES NOT OWN THE SKILL GRAPH AND DOES NOT CREATE A SECOND ONE.
//
// `hr_skill_relations` is a CURATED, HUMAN-ASSERTED edge table beside hr_skills. Its DDL belongs to
// src/lib/person-spine.ts and its WRITE path belongs to src/lib/skill-graph.ts (addRelation,
// removeRelation, mergeSkills). This file only READS it, one hop, scoped to the requirement skills
// of one job and the skills one person holds.
//
// THAT IS A CORRECTION, AND IT IS WORTH WRITING DOWN. An earlier draft of this module created the
// same table itself with different columns (is_active, asserted_by_user_id, asserted_at) and a
// different five-value relation vocabulary. Two CREATE TABLE IF NOT EXISTS statements for one name
// do not merge — the first to run wins and the second is a silent no-op — so whichever module
// bootstrapped second would then query columns that do not exist, catch the error, and return an
// empty edge list. Every comparison would have quietly reported "no related skill on file" for
// every requirement, which is the most confident possible way to be wrong about somebody. Worse,
// the two vocabularies were mirror images: a reader filtering `relation IN ('broader','implies')`
// reads none of the rows the other convention wrote. ONE TABLE, ONE OWNER, ONE VOCABULARY.
//
// The vocabulary is skill-graph.ts's, imported rather than restated:
//
//   broader      the FROM skill is the specific case (Postgres --broader--> SQL). Holding the
//                specific supports a requirement for the general. THE REVERSE DOES NOT: holding SQL
//                is not evidence of Postgres, and an edge walked that way earns nothing here.
//   equivalent   two names for one skill. The only relation that is genuinely symmetric, so it is
//                the only one this file reads in both directions.
//   implies      the weakest edge — a judgement that holding one makes the other plausible.
//
// ONE HOP ONLY. A chain of implications compounds its own error: two plausible edges become one
// implausible conclusion, and nobody can see where it went wrong. skill-graph.ts walks up to four
// hops for a browsing screen; a comparison that can affect whether somebody is called to interview
// walks exactly one. Coverage reached through the graph is never better than `partial` (or
// `substitute` for an equivalence), so a curated adjacency can never be presented as demonstrated
// capability.
//
// =================================================================================================
// EXPLAINABILITY IS THE FEATURE, AND THE TYPE ENFORCES IT
// =================================================================================================
//
// MatchExplanation carries a symbol brand that is not exported. No other module can construct one,
// so there is no way to produce a score in this system that does not arrive attached to: what was
// concluded, why, the evidence behind each dimension, the assumptions, what is uncertain, what data
// was used, and the statement that a human decides. There is no exported function that returns a
// bare number, and adding one would be the single change that undoes this design.
//
// Strong, partial, substitute, claimed-only and GAP are five separate lists. A gap is never folded
// away: a gap against a REQUIRED capability is also copied into decisionBlockers, in words.
//
// =================================================================================================
// FAIRNESS, STRUCTURALLY
// =================================================================================================
//
//   - The only inputs are: recorded requirements, evidenced skill holdings, ontology edges, claimed
//     keywords, and the department a job sits in. There is no attribute bag, no free-form feature
//     map and no numeric vector anywhere in this file, so there is nowhere for a protected value to
//     be put even by a caller who wanted to.
//   - Every field name that reaches the comparison is screened through classifyFieldName() from
//     src/lib/digital-twin.ts, and a screened-out name is reported rather than silently dropped.
//   - The weight profile's keys are a CLOSED UNION. An owner can change how much required skills
//     count for; nobody can add a dimension called culture fit, potential or engagement, because
//     saveWeightProfile() refuses a key that is not in the union instead of storing it.
//   - Nothing is predicted. There is no attrition, flight-risk, potential or personality output, and
//     no column, field or seam that could hold one.
//   - Nothing is inferred from monitoring. No activity metric, no communication volume, no
//     attendance signal enters this file.
//   - A candidate is never penalised for having used AI. Nothing here reads for it, scores it, or
//     records it.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { logAudit } from '@/lib/audit';
import { clean, isUuid, logFail, rowsOf, type PerfViewer } from '@/lib/performance-scope';
import { ensurePerformanceSchema } from '@/lib/performance-schema';
import {
  buildDigitalTwin,
  classifyFieldName,
  type ClaimedCapability,
  type DigitalTwin,
  type SkillHolding,
  type TwinAspect,
} from '@/lib/digital-twin';
import { buildJobTwin, type JobRequirement, type JobTwin, type JobKind, type Necessity } from '@/lib/job-twin';
// The skill graph's owners. person-spine.ts owns the table, skill-graph.ts owns the vocabulary and
// every write to it. Importing both is what keeps this module from becoming a second of either.
import { ensureSpineSchema } from '@/lib/person-spine';
import {
  SKILL_RELATIONS,
  RELATION_PHRASE,
  RELATION_HELP,
  isSkillRelation,
  type SkillRelation,
} from '@/lib/skill-graph';

const MOD = 'match';
const WRITE_FAILED = 'We could not save that just now. Nothing was changed.';

// -------------------------------------------------------------------------------------------------
// CAPABILITIES — declared above everything that reads them, and spelled the same here as in
// src/lib/auth/permissions.ts and src/lib/auth/registry.ts. A key that exists in only one of those
// answers false for EVERY role including super_admin, which is not a permission failure anybody can
// see: the feature simply never runs for anyone and every screen reports a refusal that looks like
// policy. These three are in the Permission union, in PERMS_BY_ROLE and in BUILTIN_PERMISSIONS.
// -------------------------------------------------------------------------------------------------
/** Read a person against a job's recorded requirements. */
export const MATCH_RUN = 'match.run';
/** Record what a human concluded after reading one. Sensitive: it is kept beside a named person. */
export const MATCH_OVERRIDE = 'match.override';
/** Change the weighting every reading is produced under. Sensitive: it is a policy about people. */
export const MATCH_WEIGHTS_MANAGE = 'match.weights.manage';

const LEVEL_LABELS: Record<number, string> = {
  1: 'Aware', 2: 'Assisted', 3: 'Independent', 4: 'Coaches', 5: 'Sets direction',
};

// =================================================================================================
// THE ONTOLOGY
// =================================================================================================

// The vocabulary is skill-graph.ts's, re-exported so a screen rendering a match can label an edge
// without importing two modules — NOT redefined. A second Record keyed on the same union is how two
// screens end up wording one relation differently.
export { SKILL_RELATIONS, RELATION_PHRASE, RELATION_HELP };
export type { SkillRelation };

/** What a match may say about credit reached through each relation, without overstating it. */
export const RELATION_CAUTION: Record<SkillRelation, string> = {
  broader: 'The person holds the specific case of what this job asks for. That supports the requirement; '
    + 'it is not the same as having the requirement itself recorded.',
  equivalent: 'A named person recorded these as two names for one skill, so the evidence behind one stands for the other. '
    + 'Equivalence is that person\'s curation, not a measurement.',
  implies: 'The weakest edge in the graph: somebody judged that holding one makes the other plausible. '
    + 'Plausible is not demonstrated, and this can never count as more than partial.',
};

/**
 * One edge, in the direction that matters to a comparison.
 *
 * `supportsRequirement` is resolved when the edge is read, using skill-graph.ts's direction rule:
 * an edge pointing AT the requirement supports it; an edge pointing AWAY from it supports nothing
 * unless it is an equivalence. A non-supporting edge is still carried, so a screen can say "there is
 * a relation here and it does not count", which is a different and more useful thing than silence.
 */
export interface SkillEdge {
  id: string;
  fromSkillId: string;
  fromSkillName: string;
  toSkillId: string;
  toSkillName: string;
  relation: SkillRelation;
  note: string | null;
  createdByUserId: string | null;
  createdAt: string | null;
  /** The requirement skill this edge was read against. */
  requirementSkillId: string;
  /** The skill the person actually holds. */
  heldSkillId: string;
  supportsRequirement: boolean;
}

// =================================================================================================
// SCHEMA — NOT BEHIND ensureOnce(), FOR THE REASON WRITTEN OUT IN job-twin.ts
// =================================================================================================

let _ready: Promise<void> | null = null;

export function ensureMatchSchema(): Promise<void> {
  if (_ready) return _ready;
  _ready = (async () => {
    try {
      await ensurePerformanceSchema(); // hr_skills is the catalogue both tables reference
      // hr_skill_relations is NOT created here. person-spine.ts owns its DDL; this asks that owner
      // to bootstrap and never issues a CREATE for a table another module defines. Two owners of one
      // table name is a silent no-op followed by a query against columns that are not there.
      await ensureSpineSchema();

      // THE WEIGHTS ARE A STORED RECORD WITH AN OWNER. A number that decides how a person is read
      // against a job is a policy, and a policy with nobody's name on it is one nobody can be asked
      // about.
      await db.execute(sql`CREATE TABLE IF NOT EXISTS match_weight_profiles (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        key VARCHAR(60) NOT NULL,
        label VARCHAR(200) NOT NULL,
        owner_user_id UUID,
        weights JSONB NOT NULL DEFAULT '{}'::jsonb,
        note TEXT,
        is_active BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT match_weight_profiles_key UNIQUE (key)
      )`);

      // EVERY SCORE KEEPS THE INPUTS THAT PRODUCED IT. Re-running a comparison next month against a
      // changed catalogue would otherwise silently rewrite what somebody was told in a meeting.
      await db.execute(sql`CREATE TABLE IF NOT EXISTS match_evaluations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        subject_person_key VARCHAR(120) NOT NULL,
        subject_employee_id UUID,
        subject_user_id UUID,
        subject_application_id UUID,
        job_kind VARCHAR(20) NOT NULL,
        job_id UUID NOT NULL,
        weight_profile_key VARCHAR(60),
        weights_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
        explanation JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_by_user_id UUID,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        human_decision VARCHAR(24),
        human_decision_note TEXT,
        human_decision_by_user_id UUID,
        human_decided_at TIMESTAMPTZ
      )`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS match_eval_job_idx ON match_evaluations(job_kind, job_id, created_at DESC)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS match_eval_subject_idx ON match_evaluations(subject_person_key, created_at DESC)`);
    } catch (e: any) {
      logFail(MOD, 'ensureMatchSchema', e);
      _ready = null;
      throw e;
    }
  })();
  return _ready;
}

/** Tables this module OWNS. */
export const MATCH_TABLES = ['match_weight_profiles', 'match_evaluations'] as const;

/** Tables this module READS and another module owns. Checked too — a dependency that is not there
 *  breaks this module just as completely as a missing table of its own, and blaming the wrong module
 *  is how an afternoon gets spent in the wrong file. */
export const MATCH_DEPENDENCY_TABLES = ['hr_skills', 'hr_employee_skills', 'hr_skill_relations'] as const;

export interface SchemaReport {
  ok: boolean;
  present: string[];
  missing: string[];
  /** Present dependencies, and the owner of each, so a missing one is actionable. */
  dependenciesMissing: string[];
  sentence: string;
  error?: string;
}

/**
 * WHAT IS ACTUALLY IN THE DATABASE.
 *
 * Never the ensure's return value. src/lib/ensure-once.ts ends in p.catch(() => {}), so on this
 * project a DDL failure has resolved silently and a caller has reported ten tables created when
 * none existed. This asks the catalogue.
 */
export async function verifyMatchSchema(): Promise<SchemaReport> {
  const all = [...MATCH_TABLES, ...MATCH_DEPENDENCY_TABLES];
  try {
    // The ensure is allowed to fail here. Its return value is not evidence of anything and is not
    // read; the catalogue below is the only thing that decides what this function reports.
    await ensureMatchSchema().catch(() => {});
    const r = rowsOf(await db.execute(sql`
      SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name IN (${sql.join(all.map((t) => sql`${t}`), sql`, `)})`));
    const present = r.map((x: any) => String(x.table_name));
    const missing = MATCH_TABLES.filter((t) => present.indexOf(t) < 0);
    const dependenciesMissing = MATCH_DEPENDENCY_TABLES.filter((t) => present.indexOf(t) < 0);

    const parts: string[] = [];
    if (missing.length) {
      parts.push('These tables this module owns are NOT in the database: ' + missing.join(', ')
        + '. No reading can be saved, whatever a bootstrap reported.');
    }
    if (dependenciesMissing.length) {
      parts.push('These tables this module reads are NOT in the database: ' + dependenciesMissing.join(', ')
        + '. hr_skills and hr_employee_skills belong to src/lib/performance-schema.ts and '
        + 'hr_skill_relations belongs to src/lib/person-spine.ts — this module never creates them, '
        + 'so the fix is in the module that owns each.');
    }
    return {
      ok: missing.length === 0 && dependenciesMissing.length === 0,
      present,
      missing,
      dependenciesMissing,
      sentence: parts.length ? parts.join(' ') : 'Every table this module owns or reads exists in the database.',
    };
  } catch (e: any) {
    const reason = e?.cause?.message || e?.message || 'unknown';
    logFail(MOD, 'verifyMatchSchema', e);
    return {
      ok: false,
      present: [],
      missing: [...MATCH_TABLES],
      dependenciesMissing: [...MATCH_DEPENDENCY_TABLES],
      error: reason,
      sentence: 'We could not read the database catalogue, so we cannot say what exists. (' + reason + ')',
    };
  }
}

// =================================================================================================
// ONTOLOGY READS AND WRITES
// =================================================================================================

/**
 * ONE HOP OF THE SKILL GRAPH, scoped to one comparison.
 *
 * `requirementSkillIds` are what the job asks for; `heldSkillIds` are what the person has recorded.
 * Both directions are fetched, because the DIRECTION IS THE MEANING:
 *
 *   held --broader--> requirement       the person holds the specific case. Supports.
 *   held --implies--> requirement       somebody judged it makes the requirement plausible. Supports, weakly.
 *   held --equivalent--> requirement    two names for one skill. Supports, in either direction.
 *   requirement --broader--> held       the person holds the GENERAL and the job asks for the
 *                                       SPECIFIC. DOES NOT SUPPORT, and is returned anyway with
 *                                       supportsRequirement false so a screen can say there is a
 *                                       relation here and it does not count. Silence would read as
 *                                       "no relation exists", which is a different claim.
 *
 * This is a READ of a table src/lib/person-spine.ts owns and src/lib/skill-graph.ts writes. It uses
 * only the columns that owner defines. It never writes: recording a relation is
 * skill-graph.addRelation(), behind `skills.administer`, and there is deliberately no second door
 * to it in this file.
 */
export async function relationsInto(
  requirementSkillIds: readonly string[],
  heldSkillIds: readonly string[],
): Promise<SkillEdge[]> {
  const reqs = Array.from(new Set(requirementSkillIds.filter(isUuid)));
  const held = Array.from(new Set(heldSkillIds.filter(isUuid)));
  if (!reqs.length || !held.length) return []; // never emit IN ()
  const reqList = sql.join(reqs.map((i) => sql`${i}::uuid`), sql`, `);
  const heldList = sql.join(held.map((i) => sql`${i}::uuid`), sql`, `);
  try {
    await ensureMatchSchema();
    const rows = rowsOf(await db.execute(sql`
      SELECT r.id, r.from_skill_id, r.to_skill_id, r.relation, r.note,
             r.created_by_user_id, r.created_at,
             sf.name AS from_name, st.name AS to_name
        FROM hr_skill_relations r
        JOIN hr_skills sf ON sf.id = r.from_skill_id
        JOIN hr_skills st ON st.id = r.to_skill_id
       WHERE (r.to_skill_id IN (${reqList}) AND r.from_skill_id IN (${heldList}))
          OR (r.from_skill_id IN (${reqList}) AND r.to_skill_id IN (${heldList}))
       LIMIT 500`));

    const reqSet = new Set(reqs);
    const out: SkillEdge[] = [];
    for (const r of rows as any[]) {
      const fromId = String(r.from_skill_id);
      const toId = String(r.to_skill_id);
      // An unrecognised relation string is read as the WEAKEST edge, never the strongest. If another
      // module ever writes a fourth value into this column, the failure mode is that somebody gets
      // slightly less credit than they might deserve, which a human reading the explanation can see
      // and correct. Defaulting to the strongest would silently manufacture evidence.
      const relation: SkillRelation = isSkillRelation(r.relation) ? r.relation : 'implies';
      // The edge points AT a requirement: the FROM skill is the one held, and it supports.
      // Otherwise the requirement is the FROM skill and only an equivalence survives the reversal.
      const pointsAtRequirement = reqSet.has(toId);
      out.push({
        id: String(r.id),
        fromSkillId: fromId,
        fromSkillName: String(r.from_name || 'A retired skill'),
        toSkillId: toId,
        toSkillName: String(r.to_name || 'A retired skill'),
        relation,
        note: r.note ? String(r.note) : null,
        createdByUserId: r.created_by_user_id ? String(r.created_by_user_id) : null,
        createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
        requirementSkillId: pointsAtRequirement ? toId : fromId,
        heldSkillId: pointsAtRequirement ? fromId : toId,
        supportsRequirement: pointsAtRequirement || relation === 'equivalent',
      });
    }
    return out;
  } catch (e: any) {
    logFail(MOD, 'relationsInto', e);
    return [];
  }
}

// =================================================================================================
// DIMENSIONS AND WEIGHTS
// =================================================================================================

export const MATCH_DIMENSIONS = [
  'required_skills',
  'preferred_skills',
  'competencies',
  'experience',
  'seniority',
  'education',
  'domain',
] as const;

export type MatchDimension = (typeof MATCH_DIMENSIONS)[number];

export const DIMENSION_LABELS: Record<MatchDimension, string> = {
  required_skills: 'Required capabilities',
  preferred_skills: 'Preferred capabilities',
  competencies: 'Competencies',
  experience: 'Experience',
  seniority: 'Seniority',
  education: 'Education',
  domain: 'Domain',
};

export type Weights = Record<MatchDimension, number>;

/** The built-in weighting. Nobody owns it, which is why a stored profile says so out loud. */
export const DEFAULT_WEIGHTS: Weights = {
  required_skills: 55,
  preferred_skills: 20,
  competencies: 5,
  experience: 5,
  seniority: 5,
  education: 5,
  domain: 5,
};

export interface WeightProfile {
  key: string;
  label: string;
  ownerUserId: string | null;
  weights: Weights;
  note: string | null;
  updatedAt: string | null;
  /** True when this is the built-in default rather than a stored, owned record. */
  isBuiltInDefault: boolean;
  sentence: string;
}

export const BUILT_IN_PROFILE: WeightProfile = {
  key: 'default',
  label: 'Built-in default weighting',
  ownerUserId: null,
  weights: { ...DEFAULT_WEIGHTS },
  note: null,
  updatedAt: null,
  isBuiltInDefault: true,
  sentence: 'No stored weighting was found, so the built-in default was used. Nobody owns it. '
    + 'Save a profile so the numbers that decide how people are read against jobs have a name attached.',
};

export interface WeightValidation {
  ok: boolean;
  weights: Weights;
  /** Keys that are not dimensions. REFUSED, never dropped: a silently ignored key is a silent policy. */
  rejected: string[];
  error?: string;
}

/**
 * Validate a weighting.
 *
 * THE UNION IS THE FAIRNESS CONTROL. An owner may decide required capabilities count for eighty and
 * domain for nothing. Nobody may add a dimension: a key outside MATCH_DIMENSIONS is rejected with
 * its name, so an attempt to introduce "culture fit", "potential" or "engagement" fails loudly at
 * the moment somebody tries rather than appearing as a column later.
 */
export function validateWeights(input: unknown): WeightValidation {
  const out: Weights = { ...DEFAULT_WEIGHTS };
  const rejected: string[] = [];
  if (!input || typeof input !== 'object') {
    return { ok: false, weights: out, rejected, error: 'No weighting was given.' };
  }
  const known = new Set<string>(MATCH_DIMENSIONS);
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (!known.has(k)) { rejected.push(k); continue; }
    const n = Number(v);
    if (!isFinite(n) || n < 0 || n > 100) {
      return { ok: false, weights: out, rejected, error: 'Each weight must be a number from 0 to 100. "' + k + '" was not.' };
    }
    out[k as MatchDimension] = Math.round(n);
  }
  if (rejected.length) {
    return {
      ok: false, weights: out, rejected,
      error: 'This system scores exactly ' + MATCH_DIMENSIONS.length + ' named dimensions. '
        + 'These are not among them and were refused rather than stored: ' + rejected.join(', ') + '.',
    };
  }
  const total = MATCH_DIMENSIONS.reduce((s, d) => s + out[d], 0);
  if (total <= 0) {
    return { ok: false, weights: out, rejected, error: 'At least one dimension must carry some weight.' };
  }
  return { ok: true, weights: out, rejected };
}

export async function getWeightProfile(key = 'default'): Promise<WeightProfile> {
  const k = clean(key, 60) || 'default';
  try {
    await ensureMatchSchema();
    const r = rowsOf(await db.execute(sql`
      SELECT * FROM match_weight_profiles WHERE key = ${k} AND is_active = true LIMIT 1`));
    if (!r.length) return { ...BUILT_IN_PROFILE, key: k };
    const v = validateWeights(r[0].weights);
    return {
      key: String(r[0].key),
      label: String(r[0].label || k),
      ownerUserId: r[0].owner_user_id ? String(r[0].owner_user_id) : null,
      weights: v.weights,
      note: r[0].note ? String(r[0].note) : null,
      updatedAt: r[0].updated_at ? new Date(r[0].updated_at).toISOString() : null,
      isBuiltInDefault: false,
      sentence: r[0].owner_user_id
        ? 'These weights are a stored record with a named owner. Changing them changes how every comparison reads, and the change is on the audit log.'
        : 'These weights are stored but nobody is recorded as owning them. Set an owner: a number that decides how people are read should have somebody to ask about it.',
    };
  } catch (e: any) {
    logFail(MOD, 'getWeightProfile', e);
    return {
      ...BUILT_IN_PROFILE,
      key: k,
      sentence: 'The stored weighting could not be read just now, so the built-in default was used. '
        + 'This comparison may not be the one your saved profile would produce.',
    };
  }
}

export async function saveWeightProfile(input: {
  key: string;
  label: string;
  weights: unknown;
  note?: string | null;
  ownerUserId: string;
  actorUserId: string;
  /** True when the caller holds `matching.weights.manage`. */
  mayManage: boolean;
}): Promise<{ ok: boolean; key?: string; error?: string; rejected?: string[] }> {
  if (input?.mayManage !== true) {
    return { ok: false, error: 'Changing the weighting needs ' + MATCH_WEIGHTS_MANAGE + '. Nothing was changed.' };
  }
  const key = clean(input?.key, 60);
  const label = clean(input?.label, 200);
  if (!key || !label) return { ok: false, error: 'Give the weighting a key and a name.' };
  const owner = isUuid(input?.ownerUserId) ? String(input.ownerUserId) : null;
  if (!owner) {
    return { ok: false, error: 'A weighting must have a named owner. A policy nobody owns is a policy nobody can be asked about.' };
  }
  const v = validateWeights(input?.weights);
  if (!v.ok) return { ok: false, error: v.error, rejected: v.rejected };
  const actor = isUuid(input?.actorUserId) ? String(input.actorUserId) : null;
  const note = clean(input?.note, 1000) || null;

  try {
    await ensureMatchSchema();
    const rows = rowsOf(await db.execute(sql`
      INSERT INTO match_weight_profiles (key, label, owner_user_id, weights, note)
      VALUES (${key}, ${label}, ${owner}::uuid, ${JSON.stringify(v.weights)}::jsonb, ${note}::text)
      ON CONFLICT (key) DO UPDATE
        SET label = EXCLUDED.label,
            owner_user_id = EXCLUDED.owner_user_id,
            weights = EXCLUDED.weights,
            note = EXCLUDED.note,
            is_active = true,
            updated_at = NOW()
      RETURNING key`));
    if (!rows.length) return { ok: false, error: WRITE_FAILED };
    await logAudit({
      userId: actor,
      action: 'match.weights.save',
      entity: 'match_weight_profiles',
      entityId: key,
      diff: { key, ownerUserId: owner, weights: v.weights },
    });
    return { ok: true, key };
  } catch (e: any) {
    logFail(MOD, 'saveWeightProfile', e);
    return { ok: false, error: e?.cause?.message || e?.message || WRITE_FAILED };
  }
}

// =================================================================================================
// THE COMPARISON
// =================================================================================================

export const COVERAGES = ['strong', 'partial', 'substitute', 'claimed_only', 'gap', 'unknown'] as const;
export type Coverage = (typeof COVERAGES)[number];

export const COVERAGE_LABELS: Record<Coverage, string> = {
  strong: 'Evidenced at or above the level asked for',
  partial: 'Some evidence, short of what was asked for',
  substitute: 'Covered by a recorded substitution',
  claimed_only: 'Claimed in words, with nothing behind it',
  gap: 'Nothing on record',
  unknown: 'Could not be looked at',
};

/** What each coverage contributes to a dimension. `unknown` contributes nothing and is excluded. */
const COVERAGE_CREDIT: Record<Coverage, number | null> = {
  strong: 1,
  partial: 0.5,
  substitute: 0.5,
  claimed_only: 0,
  gap: 0,
  unknown: null,
};

export interface EvidenceRef {
  what: string;
  source: string;
  assertion: string;
  recordedAt: string | null;
  url: string | null;
}

export interface RequirementResult {
  requirementId: string;
  skillId: string;
  skillName: string;
  necessity: Necessity;
  minLevel: number;
  minLevelLabel: string;
  coverage: Coverage;
  /** The one sentence that explains this line, on its own, to the person it is about. */
  why: string;
  evidence: EvidenceRef[];
  /** Present only when credit came through the ontology rather than from the skill itself. */
  via: {
    relation: SkillRelation;
    relationLabel: string;
    throughSkillId: string;
    throughSkillName: string;
    assertedByUserId: string | null;
    note: string | null;
    caution: string;
  } | null;
}

export interface DimensionResult {
  dimension: MatchDimension;
  label: string;
  weight: number;
  assessed: boolean;
  /** Why it was assessed, or why it could not be. Always a sentence. */
  because: string;
  /** null whenever `assessed` is false. A dimension that could not be looked at has no number. */
  coveragePct: number | null;
  requirements: RequirementResult[];
  evidence: EvidenceRef[];
  assumptions: string[];
  uncertainty: string[];
}

/** The brand. Not exported, so no other module can construct an unexplained score. */
const EXPLAINED = Symbol('match-explanation');

export interface MatchExplanation {
  readonly [EXPLAINED]: true;

  subject: { personKey: string; displayName: string | null };
  job: { jobKind: JobKind; jobId: string; title: string | null };

  /** WHAT WAS CONCLUDED. */
  conclusion: string;
  /** True only when there was something to compare at all. */
  assessable: boolean;

  overall: {
    /** Over the dimensions that could be assessed, and null when none could. Never shown alone. */
    coveragePct: number | null;
    /** How much of the job's weighting could be looked at at all, 0-100. */
    completenessPct: number;
    band: 'not-assessable' | 'evidence-thin' | 'partial-evidence' | 'well-evidenced';
    sentence: string;
  };

  /** WHY. */
  why: string[];
  dimensions: DimensionResult[];

  /** Five lists, kept apart. A gap is a gap. */
  strong: RequirementResult[];
  partial: RequirementResult[];
  substitute: RequirementResult[];
  claimedOnly: RequirementResult[];
  gaps: RequirementResult[];
  unknown: RequirementResult[];

  /** A required capability with nothing on record. Stated in words, never folded into the number. */
  decisionBlockers: string[];

  assumptions: string[];
  uncertainty: string[];
  dataUsed: { source: string; rows: number; sentence: string }[];

  weightProfile: {
    key: string;
    label: string;
    ownerUserId: string | null;
    weights: Weights;
    isBuiltInDefault: boolean;
    sentence: string;
  };

  fairness: {
    protectedAttributesUsed: string[];
    screenedFieldNames: string[];
    refusedFieldNames: string[];
    sentence: string;
  };

  humanAuthority: {
    overridable: true;
    sentence: string;
    routes: string[];
  };

  computedAt: string;
}

export interface MatchSubject {
  personKey: string;
  displayName: string | null;
  skills: SkillHolding[];
  claimed: ClaimedCapability[];
  departmentId: string | null;
  /** Aspects the viewer could not see. They become named uncertainty, never a silent zero. */
  aspectsWithheld: TwinAspect[];
  /** Aspects that were granted but could not be read. Also named uncertainty. */
  aspectsUnreadable: TwinAspect[];
}

/** Derive the comparison's inputs from a twin the viewer is already allowed to see. */
export function subjectFromTwin(twin: DigitalTwin): MatchSubject {
  return {
    personKey: twin.person.key,
    displayName: twin.person.displayName,
    skills: twin.skills || [],
    claimed: twin.claimedCapabilities || [],
    departmentId: twin.employment?.departmentId?.value ?? null,
    aspectsWithheld: (twin.withheld || []).map((w) => w.aspect),
    aspectsUnreadable: (twin.unreadable || []).map((u) => u.aspect),
  };
}

// -------------------------------------------------------------------------------------------------
// RATING ONE REQUIREMENT — PURE, AND THE PART WORTH TESTING
// -------------------------------------------------------------------------------------------------

const levelLabel = (n: number): string => LEVEL_LABELS[Math.min(Math.max(Math.round(n), 1), 5)] || String(n);

export function rateRequirement(
  req: JobRequirement,
  held: readonly SkillHolding[],
  claimed: readonly ClaimedCapability[],
  edges: readonly SkillEdge[],
  skillsVisible: boolean,
): RequirementResult {
  const base = {
    requirementId: req.id,
    skillId: req.skillId,
    skillName: req.skillName,
    necessity: req.necessity,
    minLevel: req.minLevel,
    minLevelLabel: levelLabel(req.minLevel),
  };

  if (!skillsVisible) {
    return {
      ...base, coverage: 'unknown', via: null, evidence: [],
      why: 'You may not see this person\'s recorded skills, so nothing was read and nothing is claimed either way. '
        + 'This is not a gap; it is a thing that was not looked at.',
    };
  }

  // ---- 1. THE SKILL ITSELF ----------------------------------------------------------------------
  const direct = held.find((h) => h.skillId === req.skillId);
  if (direct) {
    const evidence: EvidenceRef[] = [{
      what: direct.skillName + ' at ' + direct.levelLabel + ' (level ' + direct.level + ')',
      source: direct.provenance.source,
      assertion: direct.provenance.assertion,
      recordedAt: direct.provenance.recordedAt,
      url: direct.provenance.evidenceUrl,
    }];
    const checked = direct.provenance.assertion === 'verified';
    const byOther = direct.storedSource === 'manager';
    const meets = direct.level >= req.minLevel;

    if (meets && (checked || byOther)) {
      return {
        ...base, coverage: 'strong', via: null, evidence,
        why: 'Recorded at ' + direct.levelLabel + ', at or above the ' + base.minLevelLabel + ' this job asks for, and '
          + (checked
            ? 'attached to something this platform confirmed against the record that owns it.'
            : 'assessed by somebody the Organization Graph records as answering for this person\'s work.')
          + ' The level itself is a judgement, not a measurement.',
      };
    }
    if (meets) {
      return {
        ...base, coverage: 'partial', via: null, evidence,
        why: 'Recorded at ' + direct.levelLabel + ', at or above what this job asks for, but the person recorded it about themselves '
          + 'and nobody has checked it. That is a claim, and it is counted as one.',
      };
    }
    if (checked || byOther) {
      return {
        ...base, coverage: 'partial', via: null, evidence,
        why: 'Evidenced at ' + direct.levelLabel + ', which is below the ' + base.minLevelLabel + ' this job asks for. '
          + 'The evidence is real; it does not reach the bar.',
      };
    }
    return {
      ...base, coverage: 'claimed_only', via: null, evidence,
      why: 'Recorded by the person at ' + direct.levelLabel + ', below the ' + base.minLevelLabel + ' this job asks for, '
        + 'and unchecked. There is nothing here beyond somebody\'s own statement.',
    };
  }

  // ---- 2. THE SKILL GRAPH, ONE HOP --------------------------------------------------------------
  // Strongest relation first, so the best thing anybody actually recorded is the one reported.
  // An equivalence is the strongest because it says the two names are one skill; `implies` is last
  // because it is explicitly the weakest edge in the graph's own vocabulary.
  const forThis = edges.filter((e) => e.requirementSkillId === req.skillId);
  const order: SkillRelation[] = ['equivalent', 'broader', 'implies'];
  for (const rel of order) {
    for (const edge of forThis) {
      if (edge.relation !== rel || !edge.supportsRequirement) continue;
      const via = held.find((h) => h.skillId === edge.heldSkillId);
      if (!via) continue;
      const viaChecked = via.provenance.assertion === 'verified' || via.storedSource === 'manager';
      const phrase = via.skillName + ' ' + RELATION_PHRASE[rel] + ' ' + req.skillName;
      const evidence: EvidenceRef[] = [{
        what: via.skillName + ' at ' + via.levelLabel + ', where ' + phrase,
        source: via.provenance.source + ' + skill-graph (hr_skill_relations)',
        assertion: viaChecked ? via.provenance.assertion : 'provided',
        recordedAt: via.provenance.recordedAt,
        url: via.provenance.evidenceUrl,
      }];
      const viaBlock = {
        relation: rel,
        relationLabel: RELATION_PHRASE[rel],
        throughSkillId: edge.heldSkillId,
        throughSkillName: via.skillName,
        assertedByUserId: edge.createdByUserId,
        note: edge.note,
        caution: RELATION_CAUTION[rel] + ' The relation is one person\'s recorded judgement about the two '
          + 'skills, followed exactly one step. Nothing here is chained.',
      };
      if (!viaChecked) {
        return {
          ...base, coverage: 'claimed_only', via: viaBlock, evidence,
          why: 'Nothing is recorded against ' + req.skillName + '. The person recorded ' + via.skillName
            + ' about themselves, and ' + phrase + ' — an unchecked claim about a related skill, '
            + 'which is not evidence of this one.',
        };
      }
      const short = via.level < req.minLevel;
      return {
        ...base,
        // Never better than substitute, whatever the edge says. A curated relation is somebody's
        // opinion about two skills; presenting it as though the requirement itself were evidenced
        // would be exactly the promotion of an inference into a fact this whole model exists to stop.
        coverage: rel === 'equivalent' && !short ? 'substitute' : 'partial',
        via: viaBlock,
        evidence,
        why: 'Nothing is recorded against ' + req.skillName + ' itself. ' + via.skillName + ' is recorded at '
          + via.levelLabel + ' with evidence behind it, and ' + phrase + '. '
          + (short
            ? 'That related skill is itself below the ' + base.minLevelLabel + ' this job asks for, so it carries less than it would otherwise. '
            : '')
          + RELATION_CAUTION[rel],
      };
    }
  }

  // ---- 3. A WORD ON A FORM ----------------------------------------------------------------------
  const word = claimed.find((c) =>
    (c.resolvedSkillId && c.resolvedSkillId === req.skillId)
    || c.keyword.toLowerCase() === req.skillName.toLowerCase());
  if (word) {
    return {
      ...base, coverage: 'claimed_only', via: null,
      evidence: [{
        what: 'The word "' + word.keyword + '" on ' + word.from,
        source: word.from,
        assertion: 'provided',
        recordedAt: word.provenance.recordedAt,
        url: null,
      }],
      why: 'The word appears on a form this person filled in. A keyword is a claim, not a demonstration, '
        + 'and it can never count as more than that here.',
    };
  }

  // ---- 4. A GAP, SAID AS A GAP ------------------------------------------------------------------
  // A relation that exists and does not count is NOT the same as no relation, and a reader deciding
  // about a person deserves to be told which of the two this is. The person who holds the general
  // skill where the job asks for the specific one is a real case, and it reads as an insult when a
  // screen implies nothing related was found.
  const nonSupporting = forThis.filter((e) => !e.supportsRequirement);
  const heldNameOf = (e: SkillEdge): string =>
    (e.heldSkillId === e.fromSkillId ? e.fromSkillName : e.toSkillName) || 'a related skill';
  const nearMiss = nonSupporting.length
    ? ' The graph does record a relation to ' + Array.from(new Set(nonSupporting.map(heldNameOf))).slice(0, 3).join(', ')
      + ', in the direction that does not support this requirement: holding the general skill is not evidence of the specific one. '
      + 'It is recorded here so nobody reads this line as "nothing related was found".'
    : '';
  return {
    ...base, coverage: 'gap', via: null, evidence: [],
    why: 'Nothing is on record against ' + req.skillName + ' for this person: no recorded level, no related skill '
      + 'the graph connects to it in a direction that counts, and no claim. '
      + 'An unrecorded capability and an absent one look identical from here.' + nearMiss,
  };
}

// -------------------------------------------------------------------------------------------------
// THE WHOLE COMPARISON — PURE. Everything it needs is passed in, so it can be tested without a
// database and so nothing it does can depend on who is looking.
// -------------------------------------------------------------------------------------------------

function dimensionFrom(
  dimension: MatchDimension,
  weight: number,
  results: RequirementResult[],
  skillsVisible: boolean,
): DimensionResult {
  const scorable = results.filter((r) => COVERAGE_CREDIT[r.coverage] !== null);
  const assessed = results.length > 0 && scorable.length > 0;
  const pct = assessed
    ? Math.round((scorable.reduce((s, r) => s + (COVERAGE_CREDIT[r.coverage] as number), 0) / scorable.length) * 100)
    : null;
  const gaps = results.filter((r) => r.coverage === 'gap').length;
  return {
    dimension,
    label: DIMENSION_LABELS[dimension],
    weight,
    assessed,
    because: results.length === 0
      ? 'This job records no ' + DIMENSION_LABELS[dimension].toLowerCase() + ', so there was nothing to compare.'
      : !skillsVisible
        ? 'The person\'s recorded capabilities are not visible to you, so this could not be assessed.'
        : 'Assessed against ' + results.length + ' recorded requirement' + (results.length === 1 ? '' : 's') + '.',
    coveragePct: pct,
    requirements: results,
    evidence: results.flatMap((r) => r.evidence),
    assumptions: results.length
      ? [
        'A recorded level is somebody\'s judgement of capability, not a measurement of it.',
        'Credit reached through the ontology is one recorded relation, followed one step, and never chained.',
      ]
      : [],
    uncertainty: gaps
      ? [gaps + ' of these requirements have nothing on record. An unrecorded capability looks exactly like an absent one, and this cannot tell them apart.']
      : [],
  };
}

export function evaluate(
  subject: MatchSubject,
  job: JobTwin,
  profile: WeightProfile,
  edges: readonly SkillEdge[],
): MatchExplanation {
  const now = new Date().toISOString();
  const skillsVisible = subject.aspectsWithheld.indexOf('skills') < 0 && subject.aspectsUnreadable.indexOf('skills') < 0;

  // ---- FAIRNESS SCREEN: every field name that reaches the comparison, checked ---------------------
  const screenedFieldNames = [
    'skill_id', 'skill_name', 'level', 'source', 'evidence', 'evidence_url',
    'necessity', 'min_level', 'rationale', 'relation', 'department_id', 'keyword',
  ];
  const refusedFieldNames = screenedFieldNames.filter((f) => classifyFieldName(f) !== 'ok');
  if (refusedFieldNames.length) console.error('[' + MOD + '] refused input fields: ' + refusedFieldNames.join(', '));

  const fairness = {
    protectedAttributesUsed: [] as string[],
    screenedFieldNames: screenedFieldNames.filter((f) => classifyFieldName(f) === 'ok'),
    refusedFieldNames,
    sentence: 'No protected or sensitive attribute is an input to this comparison, and none is inferred from one. '
      + 'The inputs are recorded requirements, recorded capability levels with their evidence, curated relations '
      + 'between skills, words typed on forms, and the department a job sits in. There is no field on this object '
      + 'that could hold anything else.',
  };

  const humanAuthority = {
    overridable: true as const,
    sentence: 'This is an advisory reading of what is on record. It decides nothing. A human decides hiring, '
      + 'rejection, termination, promotion, compensation and discipline, and may disagree with every line of this '
      + 'without giving a reason to the system.',
    routes: [
      'Moving an application forward or closing it: src/lib/application-stages.ts, with an actor and a note.',
      'A promotion or any consequential sign-off: src/lib/workflow.ts, routed from the Organization Graph.',
      'Disagreeing with this reading itself: recordHumanDecision() below, which stores the disagreement beside the score.',
    ],
  };

  const weightBlock = {
    key: profile.key,
    label: profile.label,
    ownerUserId: profile.ownerUserId,
    weights: profile.weights,
    isBuiltInDefault: profile.isBuiltInDefault,
    sentence: profile.sentence,
  };

  // ---- NOT MATCHABLE: refuse, and say what would make it matchable --------------------------------
  if (!job.exists || !job.matchable) {
    return {
      [EXPLAINED]: true,
      subject: { personKey: subject.personKey, displayName: subject.displayName },
      job: { jobKind: job.jobKind, jobId: job.jobId, title: job.title?.value ?? null },
      conclusion: job.exists
        ? 'Nothing was compared. This job has no capabilities recorded in the skills catalogue, so there is no requirement to hold anybody against. '
          + 'The words on the job description are text; comparing a person to text would be a guess wearing a percentage.'
        : 'Nothing was compared, because the job could not be read.',
      assessable: false,
      overall: {
        coveragePct: null,
        completenessPct: 0,
        band: 'not-assessable',
        sentence: 'There is no score here, and that is the correct output rather than a missing one.',
      },
      why: [job.sentence],
      dimensions: [],
      strong: [], partial: [], substitute: [], claimedOnly: [], gaps: [], unknown: [],
      decisionBlockers: [],
      assumptions: [],
      uncertainty: ['Everything about this person\'s fit for this job is unknown to this system.'],
      dataUsed: [{ source: 'job-twin (job_requirements)', rows: 0, sentence: 'No requirement rows exist for this job.' }],
      weightProfile: weightBlock,
      fairness,
      humanAuthority,
      computedAt: now,
    };
  }

  // ---- THE SKILL DIMENSIONS ----------------------------------------------------------------------
  const requiredResults = job.requiredSkills.map((r) => rateRequirement(r, subject.skills, subject.claimed, edges, skillsVisible));
  const preferredResults = job.preferredSkills.map((r) => rateRequirement(r, subject.skills, subject.claimed, edges, skillsVisible));

  const dimensions: DimensionResult[] = [
    dimensionFrom('required_skills', profile.weights.required_skills, requiredResults, skillsVisible),
    dimensionFrom('preferred_skills', profile.weights.preferred_skills, preferredResults, skillsVisible),
  ];

  // ---- THE DIMENSIONS THIS CODEBASE CANNOT HONESTLY ASSESS ---------------------------------------
  // Named, weighted, and reported as NOT ASSESSED rather than quietly scored at zero or silently
  // dropped. A dimension nobody can measure is a hole in the reading, and a hole that is not printed
  // is a hole that gets read as agreement.
  dimensions.push({
    dimension: 'competencies',
    label: DIMENSION_LABELS.competencies,
    weight: profile.weights.competencies,
    assessed: false,
    because: 'The competency framework on this platform is attached to learning programmes, not to jobs, and no job '
      + 'records a competency requirement. There is nothing on the job side to compare against.',
    coveragePct: null,
    requirements: [],
    evidence: [],
    assumptions: [],
    uncertainty: ['Competencies this person has demonstrated may be relevant and were not considered by anything here.'],
  });
  dimensions.push({
    dimension: 'experience',
    label: DIMENSION_LABELS.experience,
    weight: profile.weights.experience,
    assessed: false,
    because: 'Every experience record on the person\'s side is a paragraph somebody wrote about themselves, and the job '
      + 'states a seniority band rather than a quantity. Turning either into a number would be a guess, so neither is.',
    coveragePct: null,
    requirements: [],
    evidence: [],
    assumptions: [],
    uncertainty: ['Experience is not part of this reading. A person with twenty relevant years and a person with none score identically here.'],
  });
  dimensions.push({
    dimension: 'seniority',
    label: DIMENSION_LABELS.seniority,
    weight: profile.weights.seniority,
    assessed: false,
    because: 'A job\'s seniority band and a person\'s recorded title are two different vocabularies that have never been '
      + 'mapped to each other. Comparing them would be string matching on job titles.',
    coveragePct: null,
    requirements: [],
    evidence: [],
    assumptions: [],
    uncertainty: ['Seniority is not part of this reading.'],
  });
  dimensions.push({
    dimension: 'education',
    label: DIMENSION_LABELS.education,
    weight: profile.weights.education,
    assessed: false,
    because: 'The job\'s eligibility text is prose and nothing parses it. On the person\'s side, education is self-stated '
      + 'unless a background-verification check confirmed it, and that check exists for a minority of records. '
      + 'A number here would mostly be measuring who happened to be verified.',
    coveragePct: null,
    requirements: [],
    evidence: [],
    assumptions: [],
    uncertainty: ['Education is not part of this reading. Where a verification exists it is shown on the person\'s record, beside the claim it verifies.'],
  });

  const sameDepartment = !!subject.departmentId && !!job.domain?.value.departmentId
    && String(subject.departmentId) === String(job.domain.value.departmentId);
  const domainAssessable = !!subject.departmentId && !!job.domain?.value.departmentId;
  dimensions.push({
    dimension: 'domain',
    label: DIMENSION_LABELS.domain,
    weight: profile.weights.domain,
    assessed: domainAssessable,
    because: domainAssessable
      ? 'Both the job and the person record a department, so this compares two recorded facts and nothing else.'
      : 'One side or the other records no department, so there was nothing to compare.',
    coveragePct: domainAssessable ? (sameDepartment ? 100 : 0) : null,
    requirements: [],
    evidence: domainAssessable
      ? [{
        what: sameDepartment ? 'Already in the department this job sits in' : 'In a different department from this job',
        source: 'hr_employees.department_id and the job record',
        assertion: 'factual',
        recordedAt: null,
        url: null,
      }]
      : [],
    assumptions: ['Sitting in a department is a fact about where somebody works. It is not evidence of capability, which is why it carries little weight by default.'],
    uncertainty: domainAssessable ? [] : ['No department is recorded on one side.'],
  });

  // ---- THE AGGREGATE, OVER WHAT COULD BE ASSESSED ------------------------------------------------
  const assessedDims = dimensions.filter((d) => d.assessed && d.coveragePct !== null);
  const totalWeight = MATCH_DIMENSIONS.reduce((s, d) => s + profile.weights[d], 0);
  const assessedWeight = assessedDims.reduce((s, d) => s + d.weight, 0);
  const coveragePct = assessedWeight > 0
    ? Math.round(assessedDims.reduce((s, d) => s + (d.coveragePct as number) * d.weight, 0) / assessedWeight)
    : null;
  const completenessPct = totalWeight > 0 ? Math.round((assessedWeight / totalWeight) * 100) : 0;

  const all = [...requiredResults, ...preferredResults];
  const pick = (c: Coverage) => all.filter((r) => r.coverage === c);
  const gaps = pick('gap');
  const decisionBlockers = requiredResults
    .filter((r) => r.coverage === 'gap')
    .map((r) => 'Required: ' + r.skillName + ' at ' + r.minLevelLabel + '. Nothing is on record. '
      + 'This is a gap, and it stays a gap however the rest of the reading looks.');

  const band: MatchExplanation['overall']['band'] = coveragePct === null
    ? 'not-assessable'
    : coveragePct >= 70 ? 'well-evidenced'
      : coveragePct >= 35 ? 'partial-evidence'
        : 'evidence-thin';

  const why: string[] = [
    'This job records ' + job.requiredSkills.length + ' required and ' + job.preferredSkills.length
      + ' preferred capabilities in the skills catalogue, each one put there by a named person with a written reason.',
    skillsVisible
      ? 'The person has ' + subject.skills.length + ' recorded capability levels, each carrying how it was established.'
      : 'The person\'s recorded capabilities were not visible to you, so no capability was read.',
    'Each requirement was rated on its own and the sentence for each is on its line. Nothing was averaged before it was explained.',
    'Credit was given through the skill ontology only where a named person recorded a relation, and only one step.',
    completenessPct < 100
      ? 'Only ' + completenessPct + ' per cent of the weighting could be assessed at all. The rest is named above as not assessed, and is not counted as agreement.'
      : 'Every weighted dimension could be assessed.',
  ];

  const conclusion = coveragePct === null
    ? 'Nothing could be assessed about this person against this job.'
    : 'Against the capabilities this job records, ' + (subject.displayName || 'this person')
      + ' is evidenced at or above the level asked for'
      + ' on ' + pick('strong').length + ' of ' + all.length + ' requirements, partly evidenced on '
      + (pick('partial').length + pick('substitute').length) + ', claimed-only on ' + pick('claimed_only').length
      + ', and has nothing on record for ' + gaps.length + '. '
      + (decisionBlockers.length
        ? decisionBlockers.length + ' of the gaps are against REQUIRED capabilities.'
        : 'None of the gaps is against a required capability.')
      + ' This is a reading of what is recorded, not a judgement of the person.';

  const assumptions = [
    'A recorded skill level is a judgement, by the person or by their manager, and never a measurement.',
    'An unrecorded capability is indistinguishable from an absent one. Everything here reads the record, not the person.',
    'A completion or a passed assessment evidences that work was done on this platform. EduRankAI is the technology platform; accredited partners award credentials, and nothing here claims one.',
    'Ontology relations are curated by people in this organization. They are opinions about skills, recorded with a name attached.',
    'The weighting is a policy decision, not a fact about jobs. It is stored, owned and changeable.',
  ];

  const uncertainty = [
    ...dimensions.flatMap((d) => d.uncertainty),
    ...(subject.aspectsWithheld.length
      ? ['You may not see these parts of this person\'s record, so they were not read: ' + subject.aspectsWithheld.join(', ') + '.']
      : []),
    ...(subject.aspectsUnreadable.length
      ? ['These parts could not be read just now, so this reading is incomplete rather than empty: ' + subject.aspectsUnreadable.join(', ') + '.']
      : []),
    ...(job.keywords.unmapped.length
      ? [job.keywords.unmapped.length + ' capabilities are written as text on the job description and have no recorded requirement, '
        + 'so they were not compared against anybody: ' + job.keywords.unmapped.slice(0, 12).join(', ') + '.']
      : []),
  ];

  const dataUsed = [
    { source: 'job-twin (job_requirements)', rows: job.requiredSkills.length + job.preferredSkills.length, sentence: 'What this job asks for, in the skills catalogue\'s vocabulary.' },
    { source: 'skills (hr_employee_skills + hr_skills)', rows: subject.skills.length, sentence: 'Recorded capability levels and how each was established.' },
    { source: 'match (hr_skill_relations)', rows: edges.length, sentence: 'Curated relations between skills, each with the person who asserted it.' },
    { source: 'claimed capabilities (applications, profiles)', rows: subject.claimed.length, sentence: 'Words typed on forms. Carried, never counted as evidence.' },
    { source: 'match_weight_profiles', rows: profile.isBuiltInDefault ? 0 : 1, sentence: profile.sentence },
  ];

  return {
    [EXPLAINED]: true,
    subject: { personKey: subject.personKey, displayName: subject.displayName },
    job: { jobKind: job.jobKind, jobId: job.jobId, title: job.title?.value ?? null },
    conclusion,
    assessable: coveragePct !== null,
    overall: {
      coveragePct,
      completenessPct,
      band,
      sentence: coveragePct === null
        ? 'There is no score here, and that is the correct output rather than a missing one.'
        : 'This number covers ' + completenessPct + ' per cent of the weighting and nothing else. '
          + 'It is not a ranking of a person, it does not include the gaps listed separately, and it decides nothing.',
    },
    why,
    dimensions,
    strong: pick('strong'),
    partial: pick('partial'),
    substitute: pick('substitute'),
    claimedOnly: pick('claimed_only'),
    gaps,
    unknown: pick('unknown'),
    decisionBlockers,
    assumptions,
    uncertainty,
    dataUsed,
    weightProfile: weightBlock,
    fairness,
    humanAuthority,
    computedAt: now,
  };
}

// =================================================================================================
// RUNNING ONE, AGAINST THE DATABASE
// =================================================================================================

export interface RunMatchResult {
  ok: boolean;
  explanation: MatchExplanation | null;
  evaluationId: string | null;
  error?: string;
  /** Recording the comparison failed. The reading is still valid; it just is not on file. */
  notRecorded?: string;
}

/**
 * Compare one person to one job, for one viewer.
 *
 * THE TWIN IS BUILT FIRST, PER VIEWER. A viewer who may not see this person's capabilities gets a
 * comparison whose skill requirements all read `unknown` — not zero, not a gap. The comparison can
 * never see more of a person than the viewer running it can.
 */
export async function runMatch(input: {
  person: { userId?: string | null; employeeId?: string | null; applicationId?: string | null };
  jobKind: JobKind;
  jobId: string;
  weightProfileKey?: string | null;
  viewer: PerfViewer;
  holds: (key: string) => boolean;
  /** True when the caller holds `match.run`. Checked on the page, asked for here. */
  mayRun: boolean;
  /** Store the reading. Off for a preview that nobody should be able to cite later. */
  record?: boolean;
}): Promise<RunMatchResult> {
  if (input?.mayRun !== true) {
    return {
      ok: false, explanation: null, evaluationId: null,
      error: 'Comparing a person to a job needs ' + MATCH_RUN + '. Nothing was read.',
    };
  }

  const twin = await buildDigitalTwin(input.person, input.viewer, input.holds);
  const job = await buildJobTwin({ jobKind: input.jobKind, jobId: input.jobId });
  const subject = subjectFromTwin(twin);
  const profile = await getWeightProfile(input?.weightProfileKey || 'default');

  const reqIds = [...job.requiredSkills, ...job.preferredSkills].map((r) => r.skillId);
  const heldIds = subject.skills.map((s) => s.skillId);
  const edges = reqIds.length && heldIds.length ? await relationsInto(reqIds, heldIds) : [];

  const explanation = evaluate(subject, job, profile, edges);

  if (input?.record === false) {
    return { ok: true, explanation, evaluationId: null };
  }

  let evaluationId: string | null = null;
  let notRecorded: string | undefined;
  try {
    await ensureMatchSchema();
    const rows = rowsOf(await db.execute(sql`
      INSERT INTO match_evaluations
        (subject_person_key, subject_employee_id, subject_user_id, subject_application_id,
         job_kind, job_id, weight_profile_key, weights_snapshot, explanation, created_by_user_id)
      VALUES
        (${twin.person.key || 'unresolved'},
         ${twin.person.employeeId}::uuid, ${twin.person.userId}::uuid,
         ${twin.person.applicationIds[0] || null}::uuid,
         ${job.jobKind}, ${job.jobId}::uuid, ${profile.key},
         ${JSON.stringify(profile.weights)}::jsonb,
         ${JSON.stringify(explanation)}::jsonb,
         ${input.viewer.userId}::uuid)
      RETURNING id`));
    evaluationId = rows.length ? String(rows[0].id) : null;
    if (evaluationId) {
      await logAudit({
        userId: input.viewer.userId,
        action: 'match.evaluate',
        entity: 'match_evaluations',
        entityId: evaluationId,
        diff: { jobKind: job.jobKind, jobId: job.jobId, personKey: twin.person.key, profile: profile.key },
      });
    }
  } catch (e: any) {
    // NEVER SWALLOWED. The reading is returned because it is correct, and the caller is told in
    // words that it is not on file — a comparison somebody acts on and cannot later produce is worse
    // than one that failed loudly.
    logFail(MOD, 'runMatch:record', e);
    notRecorded = 'This reading was produced but could not be saved (' + (e?.cause?.message || e?.message || 'unknown')
      + '), so it cannot be looked up again later.';
  }

  return { ok: true, explanation, evaluationId, notRecorded };
}

export const HUMAN_DECISIONS = ['agreed', 'disagreed', 'set_aside'] as const;
export type HumanDecision = (typeof HUMAN_DECISIONS)[number];

export const HUMAN_DECISION_LABELS: Record<HumanDecision, string> = {
  agreed: 'A person read this and agreed with it',
  disagreed: 'A person read this and disagreed with it',
  set_aside: 'A person set this reading aside and decided on other grounds',
};

/**
 * Record what a human did with a reading.
 *
 * THIS IS NOT AN APPROVAL ENGINE. It stores a disagreement beside the score so the record shows that
 * somebody looked and what they thought. The DECISION about the person — moving a stage, making an
 * offer, closing an application — happens in src/lib/application-stages.ts and src/lib/workflow.ts,
 * which are the only places in this product where such a thing may happen.
 */
export async function recordHumanDecision(input: {
  evaluationId: string;
  decision: HumanDecision;
  note: string;
  actorUserId: string;
  /**
   * True when the caller holds `match.override`. Checked on the page, asked for here.
   *
   * This gate is not decoration. What gets written is a named person's recorded judgement about
   * another named person, kept beside that person's record and read later by whoever is deciding.
   * An ungated write would let anybody who could reach the endpoint put a sentence about a
   * colleague into the file that a hiring conversation is held over.
   */
  mayOverride: boolean;
}): Promise<{ ok: boolean; error?: string }> {
  if (input?.mayOverride !== true) {
    return { ok: false, error: 'Recording a decision against a reading needs ' + MATCH_OVERRIDE + '. Nothing was changed.' };
  }
  if (!isUuid(input?.evaluationId)) return { ok: false, error: 'That reading does not exist.' };
  if ((HUMAN_DECISIONS as readonly string[]).indexOf(String(input?.decision)) < 0) {
    return { ok: false, error: 'Say whether you agreed, disagreed, or set this aside.' };
  }
  const note = clean(input?.note, 2000);
  if (note.length < 12) {
    return { ok: false, error: 'Write what you concluded. A disagreement with no reason cannot be read back by anybody later.' };
  }
  const actor = isUuid(input?.actorUserId) ? String(input.actorUserId) : null;
  if (!actor) return { ok: false, error: 'We could not tell who you are, so nothing was recorded.' };
  try {
    await ensureMatchSchema();
    const rows = rowsOf(await db.execute(sql`
      UPDATE match_evaluations
         SET human_decision = ${String(input.decision)},
             human_decision_note = ${note}::text,
             human_decision_by_user_id = ${actor}::uuid,
             human_decided_at = NOW()
       WHERE id = ${input.evaluationId}::uuid
       RETURNING id`));
    if (!rows.length) return { ok: false, error: 'That reading does not exist.' };
    await logAudit({
      userId: actor,
      action: 'match.human_decision',
      entity: 'match_evaluations',
      entityId: input.evaluationId,
      diff: { decision: String(input.decision) },
    });
    return { ok: true };
  } catch (e: any) {
    logFail(MOD, 'recordHumanDecision', e);
    return { ok: false, error: e?.cause?.message || e?.message || WRITE_FAILED };
  }
}

/** Past readings for one job, newest first. Display only; it decides nothing. */
export async function evaluationsForJob(jobKind: JobKind, jobId: string, limit = 50) {
  if (!isUuid(jobId)) return [];
  const kind: JobKind = jobKind === 'requisition' ? 'requisition' : 'role';
  const n = Math.min(Math.max(Math.round(Number(limit) || 50), 1), 200);
  try {
    await ensureMatchSchema();
    const rows = rowsOf(await db.execute(sql`
      SELECT id, subject_person_key, subject_employee_id, subject_user_id, subject_application_id,
             weight_profile_key, created_at, created_by_user_id,
             human_decision, human_decision_note, human_decided_at
        FROM match_evaluations
       WHERE job_kind = ${kind} AND job_id = ${jobId}::uuid
       ORDER BY created_at DESC
       LIMIT ${n}`));
    return rows.map((r: any) => ({
      id: String(r.id),
      personKey: String(r.subject_person_key || ''),
      employeeId: r.subject_employee_id ? String(r.subject_employee_id) : null,
      userId: r.subject_user_id ? String(r.subject_user_id) : null,
      applicationId: r.subject_application_id ? String(r.subject_application_id) : null,
      weightProfileKey: r.weight_profile_key ? String(r.weight_profile_key) : null,
      createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
      createdByUserId: r.created_by_user_id ? String(r.created_by_user_id) : null,
      humanDecision: r.human_decision ? String(r.human_decision) : null,
      humanDecisionNote: r.human_decision_note ? String(r.human_decision_note) : null,
      humanDecidedAt: r.human_decided_at ? new Date(r.human_decided_at).toISOString() : null,
    }));
  } catch (e: any) {
    logFail(MOD, 'evaluationsForJob', e);
    return [];
  }
}
