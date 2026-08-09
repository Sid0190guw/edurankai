// src/lib/skill-graph.ts — RELATIONS BETWEEN SKILLS. Edges beside hr_skills, never a second catalogue.
//
// =================================================================================================
// WHAT WAS MISSING
// =================================================================================================
//
// hr_skills is a flat list. `category` is a free varchar(60), not a node. There is no parent, no
// child, no synonym and no "this one implies that one" anywhere in the repository. So
// departmentMatrix() and skillGaps() GROUP BY skill id and nothing else, and "nobody holds Postgres"
// cannot know that four people hold SQL. Every skill is an island and every count is wrong in the
// same quiet direction.
//
// This module adds the edges. It does NOT add a second catalogue: hr_skills stays the one store,
// hr_skill_relations sits beside it, and every id in it is an hr_skills id.
//
// =================================================================================================
// THE THREE RELATIONS, AND WHY THERE ARE ONLY THREE
// =================================================================================================
//
//   broader      FROM is a specific case of TO.   Postgres --broader--> SQL
//   equivalent   FROM and TO are the same skill under two names.   JS <--> JavaScript
//   implies      Holding FROM makes TO plausible, in a human's judgement.   Kubernetes --implies--> Linux
//
// `narrower` IS NOT STORED. It is `broader` read backwards. Storing both directions means storing a
// fact twice, and the day they disagree the graph has two answers and no way to choose. Every
// traversal below walks the single stored direction in both directions explicitly.
//
// =================================================================================================
// THE RULE THAT DECIDES WHAT AN EDGE IS WORTH
// =================================================================================================
//
// A relation is a HUMAN'S CURATION. Nobody measured it, nothing validated it, and it was typed by
// whoever had the ontology screen open. So:
//
//   ANYTHING REACHED THROUGH AN EDGE IS `inferred`, NEVER `verified`.
//
// Even when the skill at the far end was evidenced by a signed certificate. The certificate proves
// the person completed that course; the EDGE is somebody's opinion that the course is relevant to
// the other skill, and the chain is only as strong as its weakest link. src/lib/person-assertions.ts
// chainAssertion() enforces that arithmetic and this module never works around it.
//
// AND DIRECTION IS NOT SYMMETRIC FOR EVIDENCE. This is the distinction the whole thing turns on:
//
//   The job asks for SQL. The person evidenced Postgres.  -> Postgres is a specific case of SQL.
//                                                            It SUPPORTS the requirement. Inferred.
//   The job asks for Postgres. The person evidenced SQL.  -> SQL is the general case.
//                                                            It DOES NOT demonstrate the specific one.
//
// A graph that treats those two as the same thing is the keyword trap wearing a hierarchy. The
// second case is reported as related-but-not-supporting, in words, and it is never counted as cover.
//
// =================================================================================================
// MERGING IS THE DANGEROUS ONE
// =================================================================================================
//
// Merging two skills rewrites rows on other people's records. So mergePreview() is a separate,
// read-only function that NAMES WHAT WILL BE JOINED — how many people hold each side, which people
// hold both, and exactly which of their two rows would survive and why — and the screen shows that
// before the button appears. mergeSkills() never deletes a person's stronger record to keep a weaker
// one: it prefers the CHECKED row over the higher number, because keeping the bigger level would be
// a silent upgrade of a claim nobody made.
//
// AND IT NEVER DELETES THE LOSING SKILL. It retires it (is_active = false, the behaviour
// retireSkill() already documents) and writes an `equivalent` edge, so historical rows still resolve
// and the merge itself stays legible a year later.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { logAudit } from '@/lib/audit';
import { ensurePerformanceSchema } from '@/lib/performance-schema';
import { rowsOf, logFail, isUuid, clean, uuidList } from '@/lib/performance-scope';
import { ensureSpineSchema, readSentence, type Read } from '@/lib/person-spine';
import {
  strongerAssertion,
  assertionForSkillSource,
  type AssertionType,
} from '@/lib/person-assertions';

const MOD = 'skill-graph';
const WRITE_FAILED = 'We could not save that just now. Nothing was changed.';

/** How far a traversal walks before it stops. A curated graph this size has no honest use for more. */
const MAX_HOPS = 4;

export const SKILL_RELATIONS = ['broader', 'equivalent', 'implies'] as const;
export type SkillRelation = (typeof SKILL_RELATIONS)[number];

export function isSkillRelation(v: unknown): v is SkillRelation {
  return typeof v === 'string' && (SKILL_RELATIONS as readonly string[]).indexOf(v) >= 0;
}

/** The sentence the screen prints for an edge. Written once so two screens cannot word it differently. */
export const RELATION_PHRASE: Record<SkillRelation, string> = {
  broader: 'is a specific case of',
  equivalent: 'is the same skill as',
  implies: 'suggests some capability in',
};

export const RELATION_HELP: Record<SkillRelation, string> = {
  broader: 'Somebody who can do the first can, by definition, do the kind of work the second names. '
    + 'Postgres is a specific case of SQL. This direction supports a requirement; the reverse does not.',
  equivalent: 'Two names for one skill. Use this instead of merging when both names are genuinely in '
    + 'use and you do not want to take one away from the people who recorded it.',
  implies: 'A judgement that holding the first makes the second plausible. It is the weakest edge and '
    + 'anything reached through it is always shown as inferred.',
};

export interface SkillRelationRow {
  id: string;
  fromSkillId: string;
  fromName: string;
  toSkillId: string;
  toName: string;
  relation: SkillRelation;
  note: string | null;
  createdAt: string | null;
}

export interface GraphWriteResult {
  ok: boolean;
  id?: string;
  error?: string;
}

function mapRelation(r: any): SkillRelationRow {
  return {
    id: String(r?.id ?? ''),
    fromSkillId: String(r?.from_skill_id ?? ''),
    fromName: r?.from_name ? String(r.from_name) : 'A retired skill',
    toSkillId: String(r?.to_skill_id ?? ''),
    toName: r?.to_name ? String(r.to_name) : 'A retired skill',
    relation: (isSkillRelation(r?.relation) ? r.relation : 'implies') as SkillRelation,
    note: r?.note ? String(r.note) : null,
    createdAt: r?.created_at ? new Date(r.created_at).toISOString() : null,
  };
}

// -------------------------------------------------------------------------------------------------
// READING THE GRAPH
// -------------------------------------------------------------------------------------------------

/**
 * Every edge, newest first.
 *
 * Returns the THREE-STATE read, not a bare array: "the graph tables are not there", "the graph is
 * genuinely empty" and "we could not read it" are three different things, and a screen that prints
 * one sentence for all three sends somebody hunting for a data problem that does not exist.
 */
export async function listRelations(): Promise<Read<SkillRelationRow[]>> {
  try {
    await ensurePerformanceSchema();
    await ensureSpineSchema();
    const rows = rowsOf(await db.execute(sql`
      SELECT r.*, f.name AS from_name, t.name AS to_name
        FROM hr_skill_relations r
        LEFT JOIN hr_skills f ON f.id = r.from_skill_id
        LEFT JOIN hr_skills t ON t.id = r.to_skill_id
       ORDER BY r.created_at DESC
       LIMIT 500`));
    const data = rows.map(mapRelation);
    return {
      state: data.length ? 'ok' : 'empty',
      sentence: data.length ? '' : 'No relations have been recorded yet. Until there are some, every skill is an '
        + 'island: a count of who holds SQL cannot know that somebody holds Postgres.',
      data,
    };
  } catch (e: any) {
    logFail(MOD, 'listRelations', e);
    return { state: 'unreadable', sentence: readSentence('unreadable', 'skill graph'), data: [] };
  }
}

export interface RelatedSkill {
  skillId: string;
  name: string;
  /** How many hops from the skill asked about. 1 is a direct edge. */
  hops: number;
  /** The path in words, for a screen to print: 'Postgres is a specific case of SQL'. */
  path: string;
  /**
   * Does holding THIS skill support a requirement for the skill asked about?
   *
   * True for equivalent, for `broader` walked from the specific towards the general, and for
   * `implies` walked forwards. FALSE when the person holds the general and the job asks for the
   * specific — see the header. A screen must never count a false one as cover.
   */
  supports: boolean;
  /** Always 'inferred' when hops > 0. An edge is a curation, not a measurement. */
  assertion: AssertionType;
}

/**
 * Skills related to this one, and whether each RELATION supports a requirement for it.
 *
 * WALKED IN MEMORY over a bounded fetch rather than as a recursive CTE. The graph is small (a
 * hand-curated list), the walk needs per-hop reasoning about direction that reads as noise in SQL,
 * and a cycle in the data must not become a runaway query on a pooler this project shares with a
 * live site. If the graph ever outgrows this, the fetch below is the thing to change, not the walk.
 */
export async function relatedTo(skillId: string): Promise<Read<RelatedSkill[]>> {
  if (!isUuid(skillId)) {
    return { state: 'unreadable', sentence: 'That skill was not named properly.', data: [] };
  }
  try {
    await ensurePerformanceSchema();
    await ensureSpineSchema();
    const edges = rowsOf(await db.execute(sql`
      SELECT r.from_skill_id::text AS f, r.to_skill_id::text AS t, r.relation,
             sf.name AS f_name, st.name AS t_name
        FROM hr_skill_relations r
        LEFT JOIN hr_skills sf ON sf.id = r.from_skill_id
        LEFT JOIN hr_skills st ON st.id = r.to_skill_id
       LIMIT 2000`));
    if (!edges.length) {
      return { state: 'empty', sentence: 'Nothing is related to this skill, because no relations have been recorded at all.', data: [] };
    }

    const nameOf = new Map<string, string>();
    for (const e of edges) {
      nameOf.set(String(e.f), String(e.f_name || 'A retired skill'));
      nameOf.set(String(e.t), String(e.t_name || 'A retired skill'));
    }

    // Each entry: reaching NEIGHBOUR from CURRENT, does holding NEIGHBOUR support a requirement for
    // CURRENT? That is the only question the coverage engine asks, so it is the only one modelled.
    const out = new Map<string, RelatedSkill>();
    const seen = new Set<string>([skillId]);
    let frontier: { id: string; hops: number; path: string; supports: boolean }[] = [
      { id: skillId, hops: 0, path: '', supports: true },
    ];

    while (frontier.length && frontier[0].hops < MAX_HOPS) {
      const next: typeof frontier = [];
      for (const node of frontier) {
        for (const e of edges) {
          const f = String(e.f);
          const t = String(e.t);
          // Annotated, not inferred: e.relation arrives as `any` off a plain-array row, and a type
          // predicate narrowing `any` still yields `any`, which cannot index RELATION_PHRASE.
          const rel: SkillRelation = isSkillRelation(e.relation) ? e.relation : 'implies';
          let neighbour: string | null = null;
          let supports = false;
          let phrase = '';

          if (t === node.id) {
            // Something points AT this node. X --broader--> node means X is the specific case, so
            // holding X supports a requirement for node. Same for implies. Same for equivalent.
            neighbour = f;
            supports = true;
            phrase = String(nameOf.get(f) || 'A skill') + ' ' + RELATION_PHRASE[rel] + ' ' + String(nameOf.get(t) || 'a skill');
          } else if (f === node.id) {
            // This node points AT something. node --broader--> Y means Y is the GENERAL case, and
            // holding the general does not demonstrate the specific. Only `equivalent` survives the
            // reversal, because equivalence is the one relation that is genuinely symmetric.
            neighbour = t;
            supports = rel === 'equivalent';
            phrase = String(nameOf.get(f) || 'A skill') + ' ' + RELATION_PHRASE[rel] + ' ' + String(nameOf.get(t) || 'a skill');
          }

          if (!neighbour || seen.has(neighbour)) continue;
          seen.add(neighbour);
          // Support does not survive a non-supporting hop. One "does not demonstrate" anywhere on the
          // path makes the whole path not demonstrate.
          const chainSupports = node.supports && supports;
          const entry: RelatedSkill = {
            skillId: neighbour,
            name: String(nameOf.get(neighbour) || 'A retired skill'),
            hops: node.hops + 1,
            path: node.path ? node.path + '; ' + phrase : phrase,
            supports: chainSupports,
            assertion: 'inferred',
          };
          out.set(neighbour, entry);
          next.push({ id: neighbour, hops: entry.hops, path: entry.path, supports: chainSupports });
        }
      }
      frontier = next;
    }

    const data = Array.from(out.values()).sort((a, b) => a.hops - b.hops || a.name.localeCompare(b.name));
    return {
      state: data.length ? 'ok' : 'empty',
      sentence: data.length ? '' : 'Nothing is recorded as related to this skill.',
      data,
    };
  } catch (e: any) {
    logFail(MOD, 'relatedTo', e);
    return { state: 'unreadable', sentence: readSentence('unreadable', 'skill graph'), data: [] };
  }
}

// -------------------------------------------------------------------------------------------------
// WRITING THE GRAPH
// -------------------------------------------------------------------------------------------------

/**
 * Would adding from -> to create a loop?
 *
 * A loop in `broader` is a statement that A is a specific case of B and B is a specific case of A,
 * which is not a hierarchy, it is a typo. It also makes every traversal above depend on MAX_HOPS to
 * terminate rather than on the data being sane. `equivalent` is exempt: A equivalent B and B
 * equivalent A is a legal, if redundant, thing to say.
 */
async function wouldCycle(fromSkillId: string, toSkillId: string): Promise<boolean> {
  const edges = rowsOf(await db.execute(sql`
    SELECT from_skill_id::text AS f, to_skill_id::text AS t
      FROM hr_skill_relations WHERE relation IN ('broader', 'implies') LIMIT 2000`));
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    const f = String(e.f);
    const list = adj.get(f) || [];
    list.push(String(e.t));
    adj.set(f, list);
  }
  // Is `fromSkillId` already reachable from `toSkillId`? If so, the new edge closes the loop.
  const seen = new Set<string>([toSkillId]);
  let frontier = [toSkillId];
  for (let depth = 0; depth < 12 && frontier.length; depth++) {
    const next: string[] = [];
    for (const n of frontier) {
      for (const m of (adj.get(n) || [])) {
        if (m === fromSkillId) return true;
        if (seen.has(m)) continue;
        seen.add(m);
        next.push(m);
      }
    }
    frontier = next;
  }
  return false;
}

/** Record an edge. The caller has already checked `skills.administer`. */
export async function addRelation(input: {
  fromSkillId: string;
  toSkillId: string;
  relation: SkillRelation;
  note?: string | null;
  actorUserId: string;
}): Promise<GraphWriteResult> {
  const fromSkillId = String(input?.fromSkillId || '');
  const toSkillId = String(input?.toSkillId || '');
  const relation = input?.relation;
  const note = clean(input?.note, 500) || null;
  const actor = isUuid(input?.actorUserId) ? String(input.actorUserId) : null;

  if (!isUuid(fromSkillId) || !isUuid(toSkillId)) return { ok: false, error: 'Choose two skills.' };
  if (fromSkillId === toSkillId) return { ok: false, error: 'A skill cannot be related to itself.' };
  if (!isSkillRelation(relation)) return { ok: false, error: 'Choose what the relation says.' };
  if (!actor) return { ok: false, error: 'We could not tell who is making this statement, so nothing was written.' };

  try {
    await ensurePerformanceSchema();
    await ensureSpineSchema();

    const both = rowsOf(await db.execute(sql`
      SELECT id::text AS id, name FROM hr_skills WHERE id IN (${uuidList([fromSkillId, toSkillId])})`));
    if (both.length < 2) return { ok: false, error: 'One of those skills is not in the catalogue.' };

    if (relation !== 'equivalent' && await wouldCycle(fromSkillId, toSkillId)) {
      return {
        ok: false,
        error: 'That would create a loop: the second skill already leads back to the first. A loop in a '
          + 'hierarchy is a typo rather than a fact, and it would make every traversal depend on a hop limit '
          + 'to stop.',
      };
    }

    const rows = rowsOf(await db.execute(sql`
      INSERT INTO hr_skill_relations (from_skill_id, to_skill_id, relation, note, created_by_user_id)
      VALUES (${fromSkillId}::uuid, ${toSkillId}::uuid, ${String(relation)}, ${note}::text, ${actor}::uuid)
      ON CONFLICT DO NOTHING
      RETURNING id::text AS id`));
    if (!rows.length) return { ok: false, error: 'That relation is already recorded.' };

    await logAudit({
      userId: actor,
      action: 'skill.relation.add',
      entity: 'hr_skill_relations',
      entityId: String(rows[0].id),
      diff: { fromSkillId, toSkillId, relation, note },
    });
    return { ok: true, id: String(rows[0].id) };
  } catch (e: any) {
    logFail(MOD, 'addRelation', e);
    return { ok: false, error: e?.cause?.message || e?.message || WRITE_FAILED };
  }
}

/** Remove an edge. Edges carry no evidence of their own, so this is a genuine delete and is audited. */
export async function removeRelation(relationId: string, actorUserId: string): Promise<GraphWriteResult> {
  if (!isUuid(relationId)) return { ok: false, error: 'That relation does not exist.' };
  const actor = isUuid(actorUserId) ? String(actorUserId) : null;
  if (!actor) return { ok: false, error: 'We could not tell who is making this change, so nothing was written.' };
  try {
    await ensureSpineSchema();
    const rows = rowsOf(await db.execute(sql`
      DELETE FROM hr_skill_relations WHERE id = ${relationId}::uuid
      RETURNING from_skill_id::text AS f, to_skill_id::text AS t, relation`));
    if (!rows.length) return { ok: false, error: 'That relation does not exist.' };
    await logAudit({
      userId: actor,
      action: 'skill.relation.remove',
      entity: 'hr_skill_relations',
      entityId: relationId,
      diff: { fromSkillId: String(rows[0].f), toSkillId: String(rows[0].t), relation: String(rows[0].relation) },
    });
    return { ok: true, id: relationId };
  } catch (e: any) {
    logFail(MOD, 'removeRelation', e);
    return { ok: false, error: e?.cause?.message || e?.message || WRITE_FAILED };
  }
}

// -------------------------------------------------------------------------------------------------
// MERGE — named before it happens
// -------------------------------------------------------------------------------------------------

export interface MergeConflict {
  employeeId: string;
  employeeName: string;
  losingLevel: number;
  losingSource: string;
  winningLevel: number;
  winningSource: string;
  /** What will happen to this person's two rows, in a sentence, before anybody presses anything. */
  outcome: string;
  /** True when the row on the skill being retired is the stronger record and will replace the other. */
  replaces: boolean;
}

export interface MergePreview {
  ok: boolean;
  error?: string;
  loser: { id: string; name: string; holders: number } | null;
  winner: { id: string; name: string; holders: number } | null;
  /** Rows that move across cleanly, because the person does not hold the other skill. */
  movingRows: number;
  conflicts: MergeConflict[];
  relationsMoving: number;
  requirementsMoving: number;
  /** Everything the screen must print before offering the button. */
  sentences: string[];
}

/**
 * WHAT A MERGE WOULD DO, without doing any of it.
 *
 * Read-only, and the screen renders this before the confirm button exists. A merge rewrites rows on
 * other people's records; "Merge these skills?" with an OK button hides exactly the number that
 * should stop the reader, which is the same mistake the retire button on /admin/hr/performance/skills
 * was written to avoid.
 */
export async function mergePreview(loserId: string, winnerId: string): Promise<MergePreview> {
  const empty: MergePreview = {
    ok: false, loser: null, winner: null, movingRows: 0, conflicts: [],
    relationsMoving: 0, requirementsMoving: 0, sentences: [],
  };
  if (!isUuid(loserId) || !isUuid(winnerId)) return { ...empty, error: 'Choose two skills.' };
  if (loserId === winnerId) return { ...empty, error: 'Those are the same skill.' };

  try {
    await ensurePerformanceSchema();
    await ensureSpineSchema();

    const skills = rowsOf(await db.execute(sql`
      SELECT s.id::text AS id, s.name,
             (SELECT COUNT(*)::int FROM hr_employee_skills es WHERE es.skill_id = s.id) AS holders
        FROM hr_skills s WHERE s.id IN (${uuidList([loserId, winnerId])})`));
    const loser = skills.find((s: any) => String(s.id) === loserId);
    const winner = skills.find((s: any) => String(s.id) === winnerId);
    if (!loser || !winner) return { ...empty, error: 'One of those skills is not in the catalogue.' };

    const loserInfo = { id: loserId, name: String(loser.name || ''), holders: Number(loser.holders) || 0 };
    const winnerInfo = { id: winnerId, name: String(winner.name || ''), holders: Number(winner.holders) || 0 };

    const both = rowsOf(await db.execute(sql`
      SELECT l.employee_id::text AS employee_id,
             e.full_name,
             l.level AS l_level, l.source AS l_source,
             w.level AS w_level, w.source AS w_source
        FROM hr_employee_skills l
        JOIN hr_employee_skills w ON w.employee_id = l.employee_id AND w.skill_id = ${winnerId}::uuid
        LEFT JOIN hr_employees e ON e.id = l.employee_id
       WHERE l.skill_id = ${loserId}::uuid
       LIMIT 500`));

    const conflicts: MergeConflict[] = both.map((r: any) => {
      const lLevel = Number(r.l_level) || 1;
      const wLevel = Number(r.w_level) || 1;
      const lSource = String(r.l_source || 'self');
      const wSource = String(r.w_source || 'self');
      const lAssert = assertionForSkillSource(lSource);
      const wAssert = assertionForSkillSource(wSource);
      // THE CHECKED ROW WINS, EVEN WHEN IT IS THE LOWER NUMBER. Keeping the bigger level would
      // silently upgrade a claim nobody made, which is the one thing this whole spine exists to stop.
      const strongest = strongerAssertion(lAssert, wAssert);
      const replaces = lAssert === strongest && wAssert !== strongest
        ? true
        : (lAssert === wAssert && lLevel > wLevel);
      const name = r.full_name ? String(r.full_name) : 'An employee';
      return {
        employeeId: String(r.employee_id),
        employeeName: name,
        losingLevel: lLevel,
        losingSource: lSource,
        winningLevel: wLevel,
        winningSource: wSource,
        replaces,
        outcome: replaces
          ? name + ' holds both. The row on ' + loserInfo.name + ' is the stronger record ('
            + (lAssert === 'verified' ? 'it was checked' : 'a higher level, and neither was checked')
            + '), so it will replace the row on ' + winnerInfo.name + '. The replaced values are kept in the audit log.'
          : name + ' holds both. The row on ' + winnerInfo.name + ' is kept as it is, and their row on '
            + loserInfo.name + ' is LEFT WHERE IT IS on the retired skill rather than deleted, so nothing they '
            + 'recorded is lost.',
      };
    });

    const movingRows = Math.max(0, loserInfo.holders - conflicts.length);

    const rel = rowsOf(await db.execute(sql`
      SELECT COUNT(*)::int AS n FROM hr_skill_relations
       WHERE from_skill_id = ${loserId}::uuid OR to_skill_id = ${loserId}::uuid`));
    const req = rowsOf(await db.execute(sql`
      SELECT COUNT(*)::int AS n FROM hr_role_requirements WHERE skill_id = ${loserId}::uuid`));

    const sentences: string[] = [
      loserInfo.name + ' will be RETIRED and ' + winnerInfo.name + ' will be kept. Retiring is not deleting: '
        + 'the skill stays on every record that references it and drops out of the pickers.',
      movingRows + ' recorded ' + (movingRows === 1 ? 'level moves' : 'levels move') + ' from ' + loserInfo.name
        + ' to ' + winnerInfo.name + ' unchanged.',
      conflicts.length === 0
        ? 'Nobody holds both skills, so no record has to be chosen between.'
        : conflicts.length + ' ' + (conflicts.length === 1 ? 'person holds' : 'people hold') + ' both. Each one is '
          + 'listed below with what happens to their two rows.',
      Number(rel[0]?.n || 0) + ' graph ' + (Number(rel[0]?.n || 0) === 1 ? 'relation' : 'relations')
        + ' and ' + Number(req[0]?.n || 0) + ' job ' + (Number(req[0]?.n || 0) === 1 ? 'requirement' : 'requirements')
        + ' point at the retired skill and will be repointed at ' + winnerInfo.name + '.',
      'An `equivalent` relation will be recorded between them, so that historical rows on the retired skill '
        + 'still resolve and this merge stays legible later.',
    ];

    return {
      ok: true,
      loser: loserInfo,
      winner: winnerInfo,
      movingRows,
      conflicts,
      relationsMoving: Number(rel[0]?.n || 0),
      requirementsMoving: Number(req[0]?.n || 0),
      sentences,
    };
  } catch (e: any) {
    logFail(MOD, 'mergePreview', e);
    return { ...empty, error: 'We could not work out what a merge would do, so nothing is offered. ' + String(e?.cause?.message || e?.message || '') };
  }
}

/**
 * Do the merge the preview described.
 *
 * NOT A TRANSACTION, AND THAT IS STATED RATHER THAN HIDDEN. Every statement below is idempotent or
 * additive and the order is chosen so a failure part-way leaves a readable state: rows move first,
 * the equivalent edge is written next, and the retirement is LAST, so an interrupted merge leaves
 * both skills active and the screen shows the real, partial position rather than a skill nobody can
 * record against any more. Re-running it finishes the job.
 */
export async function mergeSkills(input: {
  loserId: string;
  winnerId: string;
  actorUserId: string;
}): Promise<GraphWriteResult> {
  const loserId = String(input?.loserId || '');
  const winnerId = String(input?.winnerId || '');
  const actor = isUuid(input?.actorUserId) ? String(input.actorUserId) : null;
  if (!isUuid(loserId) || !isUuid(winnerId) || loserId === winnerId) return { ok: false, error: 'Choose two different skills.' };
  if (!actor) return { ok: false, error: 'We could not tell who is making this change, so nothing was written.' };

  const preview = await mergePreview(loserId, winnerId);
  if (!preview.ok || !preview.loser || !preview.winner) {
    return { ok: false, error: preview.error || 'We could not work out what this merge would do, so it did not run.' };
  }

  try {
    await ensurePerformanceSchema();
    await ensureSpineSchema();

    // 1. The conflicting rows where the retiring skill holds the stronger record.
    const replaced: any[] = [];
    for (const c of preview.conflicts) {
      if (!c.replaces) continue;
      const r = rowsOf(await db.execute(sql`
        UPDATE hr_employee_skills w
           SET level = l.level, evidence = l.evidence, evidence_url = l.evidence_url,
               source = l.source, assessed_by_user_id = l.assessed_by_user_id, assessed_at = l.assessed_at
          FROM hr_employee_skills l
         WHERE w.employee_id = ${c.employeeId}::uuid AND w.skill_id = ${winnerId}::uuid
           AND l.employee_id = ${c.employeeId}::uuid AND l.skill_id = ${loserId}::uuid
        RETURNING w.id::text AS id`));
      if (r.length) {
        await db.execute(sql`
          DELETE FROM hr_employee_skills
           WHERE employee_id = ${c.employeeId}::uuid AND skill_id = ${loserId}::uuid`);
        replaced.push({
          employeeId: c.employeeId,
          replacedLevel: c.winningLevel, replacedSource: c.winningSource,
          keptLevel: c.losingLevel, keptSource: c.losingSource,
        });
      }
    }

    // 2. Everything that does not collide moves across. The WHERE NOT EXISTS is what keeps the
    //    unique index on (employee_id, skill_id) from throwing on a row we deliberately left behind.
    const moved = rowsOf(await db.execute(sql`
      UPDATE hr_employee_skills l
         SET skill_id = ${winnerId}::uuid
       WHERE l.skill_id = ${loserId}::uuid
         AND NOT EXISTS (
           SELECT 1 FROM hr_employee_skills w
            WHERE w.employee_id = l.employee_id AND w.skill_id = ${winnerId}::uuid)
      RETURNING l.id::text AS id`));

    // 3. Job requirements follow the skill. Same NOT EXISTS reason.
    await db.execute(sql`
      UPDATE hr_role_requirements r
         SET skill_id = ${winnerId}::uuid
       WHERE r.skill_id = ${loserId}::uuid
         AND NOT EXISTS (
           SELECT 1 FROM hr_role_requirements o WHERE o.role_id = r.role_id AND o.skill_id = ${winnerId}::uuid)`);
    await db.execute(sql`DELETE FROM hr_role_requirements WHERE skill_id = ${loserId}::uuid`);

    // 4. Edges get repointed, then any self-edge the repointing created is dropped: A --broader--> B
    //    where B is merged into A would otherwise become A --broader--> A.
    await db.execute(sql`
      UPDATE hr_skill_relations SET from_skill_id = ${winnerId}::uuid
       WHERE from_skill_id = ${loserId}::uuid AND to_skill_id <> ${winnerId}::uuid`);
    await db.execute(sql`
      UPDATE hr_skill_relations SET to_skill_id = ${winnerId}::uuid
       WHERE to_skill_id = ${loserId}::uuid AND from_skill_id <> ${winnerId}::uuid`);
    await db.execute(sql`
      DELETE FROM hr_skill_relations
       WHERE from_skill_id = to_skill_id
          OR from_skill_id = ${loserId}::uuid OR to_skill_id = ${loserId}::uuid`);

    // 5. The equivalence, so the retired name still resolves.
    await db.execute(sql`
      INSERT INTO hr_skill_relations (from_skill_id, to_skill_id, relation, note, created_by_user_id)
      VALUES (${loserId}::uuid, ${winnerId}::uuid, 'equivalent',
              ${'Recorded automatically when these two skills were merged.'}, ${actor}::uuid)
      ON CONFLICT DO NOTHING`);

    // 6. Retire, last, so an interrupted merge never leaves a skill nobody can record against.
    await db.execute(sql`UPDATE hr_skills SET is_active = false WHERE id = ${loserId}::uuid`);

    await logAudit({
      userId: actor,
      action: 'skill.merge',
      entity: 'hr_skills',
      entityId: winnerId,
      diff: {
        retired: { id: loserId, name: preview.loser.name },
        kept: { id: winnerId, name: preview.winner.name },
        rowsMoved: moved.length,
        rowsReplaced: replaced,
        rowsLeftOnRetiredSkill: preview.conflicts.filter((c) => !c.replaces).map((c) => c.employeeId),
        relationsRepointed: preview.relationsMoving,
        requirementsRepointed: preview.requirementsMoving,
      },
    });

    return { ok: true, id: winnerId };
  } catch (e: any) {
    logFail(MOD, 'mergeSkills', e);
    return {
      ok: false,
      error: 'The merge failed part-way and stopped: ' + String(e?.cause?.message || e?.message || 'unknown error')
        + '. Nothing was retired, so both skills are still recordable. Re-open the preview to see the real position.',
    };
  }
}
