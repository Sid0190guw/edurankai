// src/lib/skill-ontology.ts — SKILLS AS NODES, AND THE EDGES BETWEEN THEM.
//
// =================================================================================================
// WHAT THIS ADDS, AND WHAT IT REFUSES TO ADD
// =================================================================================================
//
// THERE IS ALREADY ONE SKILL CATALOGUE AND THIS FILE DOES NOT CREATE A SECOND ONE. `hr_skills` is
// the node table. Its DDL belongs to src/lib/performance-schema.ts and its write path belongs to
// src/lib/skills.ts (createSkill / retireSkill), and both stay exactly where they are. What did not
// exist anywhere in this codebase was the part BETWEEN two skills: no parent, no child, no "this
// one implies that one", no way for a grid that says nobody holds PostgreSQL to know that four
// people hold SQL. That gap is what this module fills, with two tables that hang off hr_skills:
//
//   skill_relations   one asserted edge between two catalogue rows, with the human who asserted it.
//   skill_aliases     the other names for one node, so Machine Learning, ML and machine-learning
//                     are ONE skill and not three.
//
// A seventh skill vocabulary would have been the wrong answer. There are already six free-text ones
// (roles.skills, applications.tech_skills, applicant_profiles.skills, hr_employee_profile.skills,
// hr_requisitions.skills_required, aquin_competencies) and the point of this file is to give them
// somewhere to CONVERGE — resolveSkillNode() turns any of those strings into an hr_skills id or
// says honestly that it cannot.
//
// =================================================================================================
// THE HONEST SIZE OF THIS THING
// =================================================================================================
//
// This is NOT a universal skills taxonomy and this module must never be described as one. Real skill
// ontologies come from a licensed framework or a large labelled corpus; what is here is a small,
// hand-curated starter set plus whatever an administrator adds afterwards. Every edge therefore
// carries WHO asserted it and WHEN, and ontologyStats() reports the true size rather than implying
// coverage. A graph that looks authoritative and is actually twenty rows somebody typed is worse
// than no graph, so the size is always sayable on the screen.
//
// EXPANSION NEEDS NO CODE CHANGE. STARTER_ONTOLOGY is a starting point, applied once by an explicit
// admin action, never automatically on boot. After that, assertRelation() and addAlias() are the
// mechanism, and both are ordinary rows an admin writes and can remove again.
//
// =================================================================================================
// THERE IS A SECOND EDGE STORE IN THIS WORKTREE, AND THIS FILE SAYS SO OUT LOUD
// =================================================================================================
//
// `hr_skill_relations` also exists. Its DDL is written by src/lib/person-spine.ts, and again by
// src/lib/match.ts and src/lib/skill-graph.ts, and src/lib/capability-coverage.ts reads it. Those
// modules use a DIFFERENT relation vocabulary — broader / equivalent / implies — and, critically,
// the OPPOSITE direction convention for hierarchy: their `broader` means the FROM skill is the
// specific case, while `parent` here means the FROM skill is the broader area. The two are not
// dialects of one thing; one is the mirror of the other.
//
// So this module does NOT write into that table. Merging them would put two conventions behind one
// `relation` column, where a reader filtering `relation IN ('broader','implies')` reads none of the
// rows written here and reports a confident empty answer — the quietest possible wrong. Two tables
// at least fail visibly. It is not a good state, and it is a state somebody has to DECIDE about
// rather than discover, which is why verifyOntologySchema() reports the other store, its row count,
// and the sentence saying it is not read here. A screen rendering this graph as the whole graph
// while another screen answers from the other table is the failure to avoid, and it cannot be
// avoided by a module that pretends the other table is not there.
//
// =================================================================================================
// WHAT AN EDGE IS ALLOWED TO IMPLY, WHICH IS ALMOST NOTHING
// =================================================================================================
//
// Seven relations exist because the spec names seven, but they are NOT interchangeable and only one
// of them can support any statement about a person:
//
//   parent / child   broader and narrower. Holding a NARROWER skill lets the system INFER something
//                    about the broader one — and the word for that is inferred, never demonstrated.
//                    impliedBy() returns exactly that, marked, with the edge that produced it.
//   prerequisite     directional and ORDERING ONLY. Holding Machine Learning does not prove somebody
//                    holds Statistics. This relation is for planning a path, never for crediting a
//                    capability, and nothing here derives a claim from it.
//   related          two skills that come up together. Context for a human. Implies nothing.
//   adjacent         a short step away. A hint about who could learn what. Implies nothing.
//   complementary    stronger together. A team-shape observation. Implies nothing.
//   substitute       one can stand in for the other FOR SOME PURPOSES, and which purposes is a
//                    judgement a human makes. requirementResolution() surfaces a substitute as a
//                    question for a person, never as a satisfied requirement.
//
// IMPLYING_RELATIONS is that rule as code: it contains 'parent' and nothing else, and everything
// derived from an edge is stamped inferred.
//
// =================================================================================================
// WHAT THIS FILE CANNOT BE USED FOR
// =================================================================================================
//
// A node here is a SKILL. There is no field on either table for an attribute of a person — no
// nationality, no religion, no gender, no health, no politics, no age band — and no free-text
// column on a person's side of anything. The graph keys on hr_skills ids, so there is no seam
// through which a protected attribute could become a node about somebody, and none should ever be
// added: the day a "skill" called Mother Tongue appears in the catalogue, this becomes a machine
// for inferring origin.
//
// Nothing here scores anybody. There is no weight column on an edge, no distance metric, and
// requirementResolution() deliberately returns named statuses rather than a percentage, because a
// number is what people read when a sentence is what they need.
//
// =================================================================================================
// HOUSE RULES OBSERVED HERE
// =================================================================================================
//
//   - postgres-js returns PLAIN ARRAYS. Every read goes through rowsOf() from performance-scope.ts.
//   - The real Postgres reason is on e.cause. logFail() prints e?.cause?.message || e?.message.
//   - No write path swallows an exception; every one returns a sentence a person can read.
//   - Every const is declared ABOVE the function that reads it. const is not hoisted.
//   - DDL is additive only, inside ONE ensureOnce guard on a NEW key, and ensureOnce SWALLOWS, so
//     verifyOntologySchema() asks information_schema what actually exists rather than trusting it.
//   - departments are not touched here; hr_skills.id is a real UUID on both schemas.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ensureOnce } from '@/lib/ensure-once';
import { logAudit } from '@/lib/audit';
import { ensurePerformanceSchema } from '@/lib/performance-schema';
import { createSkill } from '@/lib/skills';
import { clean, isUuid, logFail, rowsOf } from '@/lib/performance-scope';
// Pure — no runtime imports of its own, so this adds nothing to load time.
import { protectedAttributeConcern } from '@/lib/person-assertions';
import { textIn } from '@/lib/pg-array';

const MOD = 'skill-ontology';
const WRITE_FAILED = 'We could not save that just now. Nothing was changed.';

/** How far any graph walk is allowed to go. A curated graph this small has no legitimate depth 8. */
const MAX_WALK_DEPTH = 6;

// =================================================================================================
// THE VOCABULARY
// =================================================================================================

export const SKILL_RELATIONS = [
  'parent',
  'child',
  'related',
  'prerequisite',
  'adjacent',
  'complementary',
  'substitute',
] as const;
export type SkillRelation = (typeof SKILL_RELATIONS)[number];

export function isSkillRelation(v: unknown): v is SkillRelation {
  return typeof v === 'string' && (SKILL_RELATIONS as readonly string[]).includes(v);
}

export const RELATION_LABELS: Record<SkillRelation, string> = {
  parent: 'Broader skill',
  child: 'Narrower skill',
  related: 'Related',
  prerequisite: 'Prerequisite',
  adjacent: 'Adjacent',
  complementary: 'Complementary',
  substitute: 'Substitute',
};

/** One sentence per relation, printed beside it so nobody has to guess what an edge asserts. */
export const RELATION_MEANING: Record<SkillRelation, string> = {
  parent: 'The first skill is the broader area the second one sits inside.',
  child: 'The first skill is a narrower part of the second one.',
  related: 'The two come up together. This says nothing about either one on its own.',
  prerequisite: 'The first is usually learned before the second. It is an ordering, not a credit.',
  adjacent: 'A short step away for somebody who holds the first. A learning hint, nothing more.',
  complementary: 'Stronger held together than separately. An observation about team shape.',
  substitute: 'One can stand in for the other for some purposes. Which purposes is a human judgement.',
};

/**
 * The relations stored SYMMETRICALLY: one row serves both directions, and the pair is canonicalised
 * by id order so asserting it the other way round collides with the row that is already there
 * instead of creating a mirror that can later disagree with it.
 */
export const SYMMETRIC_RELATIONS: readonly SkillRelation[] = ['related', 'adjacent', 'complementary', 'substitute'];

/**
 * THE ONLY RELATION FROM WHICH ANYTHING ABOUT A PERSON MAY BE DERIVED, and even then only as an
 * inference. Holding a narrower skill says something about the broader one; nothing else on this
 * list says anything about anybody. Changing this constant changes what the system is willing to
 * assert about people, which is why it is one line and heavily guarded rather than a parameter.
 */
export const IMPLYING_RELATIONS: readonly SkillRelation[] = ['parent'];

export const ALIAS_KINDS = ['synonym', 'abbreviation', 'spelling', 'legacy'] as const;
export type AliasKind = (typeof ALIAS_KINDS)[number];

export const ALIAS_KIND_LABELS: Record<AliasKind, string> = {
  synonym: 'Another name for the same skill',
  abbreviation: 'A short form somebody types',
  spelling: 'A spelling or punctuation variant',
  legacy: 'An older name kept so old records still resolve',
};

export function isAliasKind(v: unknown): v is AliasKind {
  return typeof v === 'string' && (ALIAS_KINDS as readonly string[]).includes(v);
}

// =================================================================================================
// NORMALISATION — the reason ML and machine-learning are one node
// =================================================================================================

/**
 * The comparison form of a skill name. Pure, and it is the DEFINITION: the database index below is
 * a backstop against a concurrent insert, not the mechanism.
 *
 * `+` and `#` survive, because C++ and C# are different skills from C and stripping the punctuation
 * would silently merge three nodes into one.
 *
 * WHAT THIS DOES NOT DO: it does not expand abbreviations. "ML" normalises to "ml" and resolves only
 * because somebody recorded an alias row saying so. Guessing that ML means Machine Learning is how a
 * matrix ends up crediting a Maximum Likelihood course to a machine-learning skill, and an
 * abbreviation is exactly the kind of thing a human should have to state once.
 */
export function normalizeSkillText(v: unknown): string {
  return String(v ?? '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9+#]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 160);
}

/**
 * The same rule in SQL, used for the lookup and for the backstop index.
 *
 * IT IS NOT CHARACTER-FOR-CHARACTER THE JS RULE: Postgres is not doing the NFKD fold, so a name
 * written with combining accents can normalise differently on the two sides. That is stated here
 * rather than hidden because it is a real limit — resolveSkillNode() therefore also tries the plain
 * lower(name) match, and an accented duplicate is a thing verifyOntologySchema() reports rather than
 * a thing this module pretends cannot happen.
 */
const NORM_SQL = (col: any) => sql`btrim(regexp_replace(lower(${col}), '[^a-z0-9+#]+', ' ', 'g'))`;

// =================================================================================================
// TYPES
// =================================================================================================

export interface SkillNode {
  id: string;
  name: string;
  category: string;
  isActive: boolean;
}

export interface SkillResolution {
  /** What was asked for, verbatim. */
  input: string;
  normalized: string;
  node: SkillNode | null;
  matchedBy: 'name' | 'alias' | 'none' | 'unreadable';
  /** The alias row that matched, when one did — so a screen can show why. */
  viaAlias: string | null;
  /** A sentence for the screen. Never blank, never an apology for an empty catalogue. */
  sentence: string;
}

export interface SkillEdge {
  id: string;
  /** The relation AS SEEN FROM the skill that was asked about. */
  relation: SkillRelation;
  direction: 'outgoing' | 'incoming' | 'symmetric';
  otherSkillId: string;
  otherSkillName: string;
  otherCategory: string;
  note: string | null;
  source: string;
  assertedByUserId: string | null;
  assertedAt: string | null;
  sentence: string;
}

export interface OntologyPathNode {
  skillId: string;
  name: string;
  category: string;
  depth: number;
  /** The chain of skill ids walked to reach this node, starting at the skill asked about. */
  path: string[];
}

export interface ImpliedSkill extends OntologyPathNode {
  /**
   * Always 'inferred'. It is a field rather than a constant in the caller because the value must
   * travel with the row onto the screen and into the evidence graph, where collapsing it into a
   * demonstrated capability is the exact failure the whole phase exists to prevent.
   */
  assertion: 'inferred';
  sentence: string;
}

export interface OntologyWriteResult {
  ok: boolean;
  id?: string;
  error?: string;
}

export interface SchemaTableReport {
  table: string;
  present: boolean;
  columns: string[];
  missingColumns: string[];
}

/**
 * Another edge table that exists in this codebase and is NOT read by this module.
 *
 * Reported rather than merged: see the header. `rows` is -1 when the table is present but could not
 * be counted, which is a different fact from an empty one and must not render as zero.
 */
export interface ForeignEdgeStore {
  table: string;
  present: boolean;
  rows: number;
  ownedBy: string[];
  sentence: string;
}

export interface OntologySchemaReport {
  ok: boolean;
  tables: SchemaTableReport[];
  /** The uniqueness backstop on normalised skill names — absent when existing data already collides. */
  normalizedNameIndex: boolean;
  /**
   * Edge stores this module does not read. Empty means the check ran and found none, so a screen may
   * say the graph below is the only one. It is never assumed.
   */
  foreignEdgeStores: ForeignEdgeStore[];
  /** Printed under the schema report when another edge store holds rows. Empty string when it does not. */
  divergenceSentence: string;
  sentence: string;
  error?: string;
}

// =================================================================================================
// SCHEMA — additive, one guard, a NEW key, and VERIFIED afterwards rather than trusted
// =================================================================================================

const RELATION_COLUMNS = [
  'id', 'from_skill_id', 'to_skill_id', 'relation', 'note', 'source', 'asserted_by_user_id', 'created_at',
];
const ALIAS_COLUMNS = [
  'id', 'skill_id', 'alias', 'alias_norm', 'kind', 'source', 'created_by_user_id', 'created_at',
];

/**
 * Edge stores that are NOT this module's and are NOT read by it. Declared here, above every function
 * that reads it — const is not hoisted, and a const read before its declaration throws on the first
 * line of the function that reads it, which has taken pages down on this project.
 *
 * This list is deliberately data rather than a comment: when somebody removes the second store, this
 * entry goes with it and the divergence sentence stops appearing on the screen by itself.
 */
const FOREIGN_EDGE_STORES: { table: string; ownedBy: string[]; why: string }[] = [
  {
    table: 'hr_skill_relations',
    ownedBy: ['src/lib/person-spine.ts', 'src/lib/match.ts', 'src/lib/skill-graph.ts', 'src/lib/capability-coverage.ts'],
    why: 'It uses the broader / equivalent / implies vocabulary, in which the FROM skill is the '
      + 'specific case — the mirror of the parent / child convention here. Rows written there are not '
      + 'read by this module and rows written here are not read by those, so two screens can answer '
      + 'the same question differently until somebody decides which store is the graph.',
  },
];

/**
 * ensureOnce() ends in p.catch(() => {}). A DDL failure inside it RESOLVES, and the caller reports
 * success — ten module tables were reported created on this project and none of them existed. So the
 * catch lives INSIDE the callback, logs the real Postgres reason off e.cause and RE-THROWS, which is
 * what makes ensureOnce drop its cache entry and retry on the next request; and nothing anywhere
 * treats a returned ensure as proof. verifyOntologySchema() asks the database.
 */
export function ensureSkillOntologySchema(): Promise<void> {
  return ensureOnce('skill_ontology_v1', async () => {
    try {
      await createOntologyTables();
    } catch (e: any) {
      logFail(MOD, 'ensureSkillOntologySchema', e);
      throw e;
    }
  });
}

async function createOntologyTables(): Promise<void> {
  // hr_skills must exist first: both tables below reference it. Its DDL has exactly one owner and
  // this is not it.
  await ensurePerformanceSchema();

  await db.execute(sql`CREATE TABLE IF NOT EXISTS skill_relations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    from_skill_id UUID NOT NULL REFERENCES hr_skills(id) ON DELETE CASCADE,
    to_skill_id UUID NOT NULL REFERENCES hr_skills(id) ON DELETE CASCADE,
    relation TEXT NOT NULL,
    note TEXT,
    source TEXT NOT NULL DEFAULT 'admin',
    asserted_by_user_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS skill_relations_from_idx
    ON skill_relations (from_skill_id, relation)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS skill_relations_to_idx
    ON skill_relations (to_skill_id, relation)`);

  await db.execute(sql`CREATE TABLE IF NOT EXISTS skill_aliases (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    skill_id UUID NOT NULL REFERENCES hr_skills(id) ON DELETE CASCADE,
    alias TEXT NOT NULL,
    alias_norm TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'synonym',
    source TEXT NOT NULL DEFAULT 'admin',
    created_by_user_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS skill_aliases_skill_idx ON skill_aliases (skill_id)`);

  // Own try/catch on every UNIQUE index: these are the only statements here that can fail on DATA
  // rather than on syntax, and losing one must not take the tables with it. Every write path below
  // checks for the collision itself first, so the index is insurance against a concurrent double
  // submit, not the mechanism.
  try {
    await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS skill_relations_edge_uidx
      ON skill_relations (from_skill_id, to_skill_id, relation)`);
  } catch (e: any) {
    logFail(MOD, 'skill_relations_edge_uidx', e);
  }
  try {
    await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS skill_aliases_norm_uidx
      ON skill_aliases (alias_norm)`);
  } catch (e: any) {
    logFail(MOD, 'skill_aliases_norm_uidx', e);
  }
  // The backstop on hr_skills itself. It can legitimately fail: a catalogue that already contains
  // "Machine Learning" and "machine-learning" has two rows that normalise the same, and refusing to
  // create the index is the correct outcome — verifyOntologySchema() then REPORTS that it is absent
  // rather than letting a screen assume names are unique.
  try {
    await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS hr_skills_norm_uidx
      ON hr_skills (btrim(regexp_replace(lower(name), '[^a-z0-9+#]+', ' ', 'g')))`);
  } catch (e: any) {
    logFail(MOD, 'hr_skills_norm_uidx', e);
  }
}

/**
 * WHAT IS ACTUALLY THERE. Asked of information_schema, never inferred from the ensure returning.
 *
 * Reports per table, and names the missing columns rather than only "absent", because the failure
 * this guards against is a table created by an older version of this file and then quietly missing
 * the column a read depends on.
 */
export async function verifyOntologySchema(): Promise<OntologySchemaReport> {
  const want: { table: string; columns: string[] }[] = [
    { table: 'hr_skills', columns: ['id', 'name', 'category', 'is_active'] },
    { table: 'skill_relations', columns: RELATION_COLUMNS },
    { table: 'skill_aliases', columns: ALIAS_COLUMNS },
  ];
  try {
    const names = want.map((w) => w.table);
    const cols = rowsOf(await db.execute(sql`
      SELECT table_name, column_name
        FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name::text IN (${textIn(names)})`));
    const byTable = new Map<string, Set<string>>();
    for (const c of cols) {
      const t = String(c.table_name);
      if (!byTable.has(t)) byTable.set(t, new Set());
      byTable.get(t)!.add(String(c.column_name));
    }
    const tables: SchemaTableReport[] = want.map((w) => {
      const have = byTable.get(w.table) || new Set<string>();
      return {
        table: w.table,
        present: have.size > 0,
        columns: Array.from(have).sort(),
        missingColumns: w.columns.filter((c) => !have.has(c)),
      };
    });
    const idx = rowsOf(await db.execute(sql`
      SELECT 1 AS ok FROM pg_indexes
       WHERE schemaname = 'public' AND indexname = 'hr_skills_norm_uidx' LIMIT 1`));
    const foreignEdgeStores = await readForeignEdgeStores();
    const holding = foreignEdgeStores.filter((f) => f.present && f.rows !== 0);
    const divergenceSentence = holding.length === 0
      ? ''
      : holding.map((f) => f.table + ' holds '
        + (f.rows < 0 ? 'an unknown number of' : String(f.rows))
        + ' relation' + (f.rows === 1 ? '' : 's') + ' that this graph does not read. ' + f.sentence).join(' ');
    const bad = tables.filter((t) => !t.present || t.missingColumns.length > 0);
    const sentence = bad.length === 0
      ? 'The skill graph tables are present with every column this module reads.'
      : bad.map((t) => t.present
        ? t.table + ' exists but is missing ' + t.missingColumns.join(', ')
        : t.table + ' does not exist').join('. ') + '.';
    return {
      ok: bad.length === 0,
      tables,
      normalizedNameIndex: idx.length > 0,
      foreignEdgeStores,
      divergenceSentence,
      sentence: sentence + (idx.length > 0
        ? ''
        : ' The uniqueness backstop on normalised skill names is not in place, which usually means the'
          + ' catalogue already holds two names that differ only in punctuation or case.'),
    };
  } catch (e: any) {
    logFail(MOD, 'verifyOntologySchema', e);
    return {
      ok: false,
      tables: [],
      normalizedNameIndex: false,
      foreignEdgeStores: [],
      divergenceSentence: '',
      sentence: 'We could not read the database schema, so we cannot say what is present.',
      error: e?.cause?.message || e?.message || 'unreadable',
    };
  }
}

/**
 * Is there another edge store, and does it hold anything?
 *
 * Presence comes from information_schema; the COUNT is issued only for a table that is actually
 * there, in its own try/catch, because a count that fails must report -1 rather than 0. Zero is a
 * finding about the other table; -1 is a finding about us, and printing the second as the first is
 * how a divergence gets declared resolved without anybody resolving it.
 *
 * The whole function is guarded: this is a footnote on a schema report, and a footnote must never be
 * able to take the report down with it.
 */
async function readForeignEdgeStores(): Promise<ForeignEdgeStore[]> {
  const out: ForeignEdgeStore[] = [];
  if (FOREIGN_EDGE_STORES.length === 0) return out;
  try {
    const names = FOREIGN_EDGE_STORES.map((f) => f.table);
    const found = rowsOf(await db.execute(sql`
      SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name::text IN (${textIn(names)})`));
    const present = new Set(found.map((r: any) => String(r.table_name)));
    for (const f of FOREIGN_EDGE_STORES) {
      if (!present.has(f.table)) {
        out.push({
          table: f.table,
          present: false,
          rows: 0,
          ownedBy: f.ownedBy.slice(),
          sentence: f.table + ' is not in the database, so this graph is currently the only edge store.',
        });
        continue;
      }
      let rows = -1;
      try {
        // Identifier interpolation is safe here: the name comes from FOREIGN_EDGE_STORES above, a
        // module constant, and never from a caller. sql.raw is used because a table name cannot be a
        // bound parameter.
        const c = rowsOf(await db.execute(sql.raw('SELECT COUNT(*)::int AS n FROM ' + f.table)));
        rows = Number(c[0]?.n);
        if (!isFinite(rows)) rows = -1;
      } catch (e: any) {
        logFail(MOD, 'readForeignEdgeStores:count:' + f.table, e);
      }
      out.push({ table: f.table, present: true, rows, ownedBy: f.ownedBy.slice(), sentence: f.why });
    }
    return out;
  } catch (e: any) {
    logFail(MOD, 'readForeignEdgeStores', e);
    return [];
  }
}

// =================================================================================================
// RESOLUTION — a string becomes a node, or honestly does not
// =================================================================================================

const NOT_IN_CATALOGUE = 'is not in the skill catalogue. Nothing was recorded against it; an '
  + 'administrator can add it as a new skill, or record it as another name for one that is already there.';

function mapNode(r: any): SkillNode {
  return {
    id: String(r?.id ?? ''),
    name: r?.name ? String(r.name) : '',
    category: r?.category ? String(r.category) : 'general',
    isActive: r?.is_active !== false,
  };
}

/**
 * Turn one written skill name into one node.
 *
 * THIS IS THE CONVERGENCE POINT for the six free-text vocabularies. It is also the file's most
 * dangerous function, because a resolved node reads like a fact when all that happened is that a
 * string matched. So the resolution says how it matched, and every caller that writes something
 * about a PERSON from this must record it as a claim. A keyword is not proof of competence; a
 * keyword that resolved to a node in a curated list is still a keyword.
 *
 * A retired skill still resolves. Retirement means it drops out of the pickers, not that the eight
 * people who recorded it stop having recorded it.
 */
export async function resolveSkillNode(text: unknown): Promise<SkillResolution> {
  const input = clean(text, 160);
  const normalized = normalizeSkillText(input);
  const base: SkillResolution = {
    input, normalized, node: null, matchedBy: 'none', viaAlias: null,
    sentence: input ? '"' + input + '" ' + NOT_IN_CATALOGUE : 'No skill name was given.',
  };
  if (!normalized) return base;
  try {
    await ensureSkillOntologySchema();
    const direct = rowsOf(await db.execute(sql`
      SELECT id, name, category, is_active FROM hr_skills
       WHERE ${NORM_SQL(sql`name`)} = ${normalized} OR lower(name) = ${input.toLowerCase()}
       ORDER BY is_active DESC, name ASC LIMIT 1`));
    if (direct.length) {
      const node = mapNode(direct[0]);
      return {
        ...base,
        node,
        matchedBy: 'name',
        sentence: '"' + input + '" is the catalogue skill ' + node.name + '.',
      };
    }
    const alias = rowsOf(await db.execute(sql`
      SELECT s.id, s.name, s.category, s.is_active, a.alias, a.kind
        FROM skill_aliases a
        JOIN hr_skills s ON s.id = a.skill_id
       WHERE a.alias_norm = ${normalized} LIMIT 1`));
    if (alias.length) {
      const node = mapNode(alias[0]);
      return {
        ...base,
        node,
        matchedBy: 'alias',
        viaAlias: String(alias[0].alias || input),
        sentence: '"' + input + '" is recorded as another name for ' + node.name + '.',
      };
    }
    return base;
  } catch (e: any) {
    logFail(MOD, 'resolveSkillNode', e);
    return {
      ...base,
      matchedBy: 'unreadable',
      sentence: 'We could not read the skill catalogue, so we cannot say whether "' + input
        + '" is in it. Nothing was recorded.',
    };
  }
}

/**
 * The same for a list — a CV's skill array, a role's `skills` jsonb, a requisition's free text.
 *
 * Resolved and unresolved come back TOGETHER and in the input order. Silently dropping the ones that
 * did not match is how a job description with eleven requirements renders as three.
 */
export async function resolveSkillNodes(texts: readonly unknown[]): Promise<SkillResolution[]> {
  const list = (texts || []).slice(0, 100);
  const out: SkillResolution[] = [];
  for (const t of list) out.push(await resolveSkillNode(t));
  return out;
}

// =================================================================================================
// WRITING THE GRAPH
// =================================================================================================

/**
 * The stored form of an asserted edge.
 *
 * "A child B" is not stored as its own relation: it is the same fact as "B parent A", and storing
 * both would be two rows that can disagree the first time somebody deletes one. The symmetric
 * relations are canonicalised by id order for the same reason.
 *
 * Pure, so the rule can be read without a database.
 */
export function canonicalEdge(
  fromSkillId: string,
  relation: SkillRelation,
  toSkillId: string,
): { from: string; to: string; relation: SkillRelation } | null {
  if (!isUuid(fromSkillId) || !isUuid(toSkillId) || fromSkillId === toSkillId) return null;
  if (!isSkillRelation(relation)) return null;
  if (relation === 'child') return { from: toSkillId, to: fromSkillId, relation: 'parent' };
  if (SYMMETRIC_RELATIONS.includes(relation)) {
    return fromSkillId < toSkillId
      ? { from: fromSkillId, to: toSkillId, relation }
      : { from: toSkillId, to: fromSkillId, relation };
  }
  return { from: fromSkillId, to: toSkillId, relation };
}

/** Would asserting `parent` here close a loop? Asked of the database, depth-capped, cycle-guarded. */
async function wouldCycle(parentSkillId: string, childSkillId: string): Promise<boolean> {
  const found = rowsOf(await db.execute(sql`
    WITH RECURSIVE up AS (
      SELECT r.from_skill_id AS id, 1 AS depth,
             ARRAY[r.to_skill_id::text, r.from_skill_id::text] AS path
        FROM skill_relations r
       WHERE r.relation = 'parent' AND r.to_skill_id = ${parentSkillId}::uuid
      UNION ALL
      SELECT r.from_skill_id, up.depth + 1, up.path || r.from_skill_id::text
        FROM skill_relations r
        JOIN up ON r.to_skill_id = up.id
       WHERE r.relation = 'parent' AND up.depth < ${MAX_WALK_DEPTH}::int
         AND NOT (r.from_skill_id::text = ANY(up.path))
    )
    SELECT 1 AS hit FROM up WHERE id = ${childSkillId}::uuid LIMIT 1`));
  return found.length > 0;
}

/**
 * Assert one edge. The caller has already checked `skills.manage`; this module reads no
 * authorization engine and must never become a second one.
 *
 * `A relation B` reads as an English sentence in that order: assertRelation(SQL, 'parent',
 * PostgreSQL) says SQL is the broader area PostgreSQL sits inside.
 */
export async function assertRelation(input: {
  fromSkillId: string;
  relation: SkillRelation;
  toSkillId: string;
  note?: string | null;
  actorUserId?: string | null;
  /** 'seed' only for the starter set. Everything a human types is 'admin'. */
  source?: 'admin' | 'seed';
}): Promise<OntologyWriteResult> {
  const canonical = canonicalEdge(String(input?.fromSkillId || ''), input?.relation, String(input?.toSkillId || ''));
  if (!canonical) {
    return {
      ok: false,
      error: 'Choose two different skills from the catalogue and a relation from the list.',
    };
  }
  const note = clean(input?.note, 500) || null;
  const actor = isUuid(input?.actorUserId) ? String(input.actorUserId) : null;
  const source = input?.source === 'seed' ? 'seed' : 'admin';
  try {
    await ensureSkillOntologySchema();
    const both = rowsOf(await db.execute(sql`
      SELECT id::text AS id, name FROM hr_skills
       WHERE id = ${canonical.from}::uuid OR id = ${canonical.to}::uuid`));
    if (both.length < 2) return { ok: false, error: 'One of those skills is not in the catalogue.' };

    // THE HEADER SAYS NO SEAM EXISTS FOR A PROTECTED ATTRIBUTE TO BECOME A NODE. It says so about
    // this module's own tables, and this is where that stops being a sentence. createSkill() now
    // refuses such a name at the front door, but rows predating that guard are already in
    // hr_skills, and an edge is what would make one of them REACHABLE: broaderThan() would walk to
    // it, impliedBy() would suggest it, and requirementResolution() would answer whether somebody
    // holds it. No edge is built onto a node named after a protected attribute.
    for (const s of both) {
      const concern = protectedAttributeConcern(String(s.name || ''));
      if (concern.level === 'refuse') {
        return {
          ok: false,
          error: 'The catalogue skill "' + String(s.name || '') + '" names a protected or sensitive '
            + 'attribute, so no relation is recorded onto it and it stays unreachable through this '
            + 'graph. Retire that catalogue row; it is not a skill.',
        };
      }
    }

    if (canonical.relation === 'parent' && await wouldCycle(canonical.from, canonical.to)) {
      return {
        ok: false,
        error: 'That would make a loop: the broader skill already sits underneath the narrower one. '
          + 'Remove the existing edge first if the direction was recorded the wrong way round.',
      };
    }

    const existing = rowsOf(await db.execute(sql`
      SELECT id::text AS id FROM skill_relations
       WHERE from_skill_id = ${canonical.from}::uuid
         AND to_skill_id = ${canonical.to}::uuid
         AND relation = ${canonical.relation} LIMIT 1`));
    if (existing.length) {
      return { ok: false, id: String(existing[0].id), error: 'That relation is already recorded.' };
    }

    const rows = rowsOf(await db.execute(sql`
      INSERT INTO skill_relations (from_skill_id, to_skill_id, relation, note, source, asserted_by_user_id)
      VALUES (${canonical.from}::uuid, ${canonical.to}::uuid, ${canonical.relation}, ${note}::text,
              ${source}, ${actor}::uuid)
      RETURNING id::text AS id`));
    if (!rows.length) return { ok: false, error: WRITE_FAILED };
    await logAudit({
      userId: actor,
      action: 'skill.relation.assert',
      entity: 'skill_relations',
      entityId: String(rows[0].id),
      diff: { from: canonical.from, to: canonical.to, relation: canonical.relation, source },
    });
    return { ok: true, id: String(rows[0].id) };
  } catch (e: any) {
    logFail(MOD, 'assertRelation', e);
    return { ok: false, error: e?.cause?.message || e?.message || WRITE_FAILED };
  }
}

/**
 * Remove an edge. A curated graph is wrong sometimes and an administrator must be able to say so
 * without a deploy — that is what "expansion without a code change" has to mean in both directions.
 * The removal is audited; the edge itself is gone, because an edge is an assertion about two
 * concepts and not a record about a person.
 */
export async function removeRelation(relationId: string, actorUserId?: string | null): Promise<OntologyWriteResult> {
  if (!isUuid(relationId)) return { ok: false, error: 'That relation does not exist.' };
  try {
    await ensureSkillOntologySchema();
    const rows = rowsOf(await db.execute(sql`
      DELETE FROM skill_relations WHERE id = ${relationId}::uuid
      RETURNING from_skill_id::text AS from_skill_id, to_skill_id::text AS to_skill_id, relation`));
    if (!rows.length) return { ok: false, error: 'That relation does not exist.' };
    await logAudit({
      userId: isUuid(actorUserId) ? String(actorUserId) : null,
      action: 'skill.relation.remove',
      entity: 'skill_relations',
      entityId: relationId,
      diff: {
        from: String(rows[0].from_skill_id),
        to: String(rows[0].to_skill_id),
        relation: String(rows[0].relation),
      },
    });
    return { ok: true, id: relationId };
  } catch (e: any) {
    logFail(MOD, 'removeRelation', e);
    return { ok: false, error: e?.cause?.message || e?.message || WRITE_FAILED };
  }
}

/**
 * Record another name for a node.
 *
 * TWO COLLISIONS ARE REFUSED BY NAME rather than by a database error, because both mean somebody is
 * about to make two skills into one by accident:
 *   1. the alias already points at a DIFFERENT skill;
 *   2. the alias normalises to the name of a different catalogue skill, which would make one node
 *      unreachable through resolveSkillNode() forever.
 */
export async function addAlias(input: {
  skillId: string;
  alias: string;
  kind?: AliasKind;
  actorUserId?: string | null;
  source?: 'admin' | 'seed';
}): Promise<OntologyWriteResult> {
  const skillId = String(input?.skillId || '');
  const alias = clean(input?.alias, 160);
  const normalized = normalizeSkillText(alias);
  if (!isUuid(skillId)) return { ok: false, error: 'Choose a skill from the catalogue.' };
  if (!normalized) return { ok: false, error: 'Give the other name.' };
  const kind: AliasKind = isAliasKind(input?.kind) ? input.kind : 'synonym';
  const actor = isUuid(input?.actorUserId) ? String(input.actorUserId) : null;
  const source = input?.source === 'seed' ? 'seed' : 'admin';
  // An alias is a NAME somebody types that resolves to a node. "Gender" recorded as another name for
  // anything would let a protected attribute arrive through resolveSkillNode() from any of the six
  // free-text vocabularies, which is the same seam by the other door.
  const aliasConcern = protectedAttributeConcern(alias);
  if (aliasConcern.level === 'refuse') return { ok: false, error: aliasConcern.sentence };
  try {
    await ensureSkillOntologySchema();
    const target = rowsOf(await db.execute(sql`
      SELECT id::text AS id, name FROM hr_skills WHERE id = ${skillId}::uuid LIMIT 1`));
    if (!target.length) return { ok: false, error: 'That skill is not in the catalogue.' };
    const targetConcern = protectedAttributeConcern(String(target[0].name || ''));
    if (targetConcern.level === 'refuse') {
      return {
        ok: false,
        error: 'The catalogue skill "' + String(target[0].name || '') + '" names a protected or '
          + 'sensitive attribute, so no other name is recorded for it and it stays unreachable '
          + 'through this graph. Retire that catalogue row; it is not a skill.',
      };
    }

    const clash = rowsOf(await db.execute(sql`
      SELECT s.id::text AS id, s.name FROM hr_skills s
       WHERE ${NORM_SQL(sql`s.name`)} = ${normalized} AND s.id <> ${skillId}::uuid LIMIT 1`));
    if (clash.length) {
      return {
        ok: false,
        error: '"' + alias + '" is already the name of another catalogue skill (' + String(clash[0].name)
          + '). Recording it here would make that skill unreachable by name. Merge the two skills instead.',
      };
    }

    const taken = rowsOf(await db.execute(sql`
      SELECT a.id::text AS id, s.name FROM skill_aliases a
        JOIN hr_skills s ON s.id = a.skill_id
       WHERE a.alias_norm = ${normalized} LIMIT 1`));
    if (taken.length) {
      const sameNode = rowsOf(await db.execute(sql`
        SELECT 1 AS hit FROM skill_aliases
         WHERE alias_norm = ${normalized} AND skill_id = ${skillId}::uuid LIMIT 1`));
      return {
        ok: false,
        id: String(taken[0].id),
        error: sameNode.length
          ? 'That name is already recorded for this skill.'
          : '"' + alias + '" is already recorded as another name for ' + String(taken[0].name) + '.',
      };
    }

    const rows = rowsOf(await db.execute(sql`
      INSERT INTO skill_aliases (skill_id, alias, alias_norm, kind, source, created_by_user_id)
      VALUES (${skillId}::uuid, ${alias}, ${normalized}, ${kind}, ${source}, ${actor}::uuid)
      RETURNING id::text AS id`));
    if (!rows.length) return { ok: false, error: WRITE_FAILED };
    await logAudit({
      userId: actor,
      action: 'skill.alias.add',
      entity: 'skill_aliases',
      entityId: String(rows[0].id),
      diff: { skillId, alias, normalized, kind, source },
    });
    return { ok: true, id: String(rows[0].id) };
  } catch (e: any) {
    logFail(MOD, 'addAlias', e);
    return { ok: false, error: e?.cause?.message || e?.message || WRITE_FAILED };
  }
}

export async function removeAlias(aliasId: string, actorUserId?: string | null): Promise<OntologyWriteResult> {
  if (!isUuid(aliasId)) return { ok: false, error: 'That name does not exist.' };
  try {
    await ensureSkillOntologySchema();
    const rows = rowsOf(await db.execute(sql`
      DELETE FROM skill_aliases WHERE id = ${aliasId}::uuid
      RETURNING skill_id::text AS skill_id, alias`));
    if (!rows.length) return { ok: false, error: 'That name does not exist.' };
    await logAudit({
      userId: isUuid(actorUserId) ? String(actorUserId) : null,
      action: 'skill.alias.remove',
      entity: 'skill_aliases',
      entityId: aliasId,
      diff: { skillId: String(rows[0].skill_id), alias: String(rows[0].alias) },
    });
    return { ok: true, id: aliasId };
  } catch (e: any) {
    logFail(MOD, 'removeAlias', e);
    return { ok: false, error: e?.cause?.message || e?.message || WRITE_FAILED };
  }
}

export async function aliasesFor(skillId: string): Promise<{ id: string; alias: string; kind: string; source: string }[]> {
  if (!isUuid(skillId)) return [];
  try {
    await ensureSkillOntologySchema();
    return rowsOf(await db.execute(sql`
      SELECT id::text AS id, alias, kind, source FROM skill_aliases
       WHERE skill_id = ${skillId}::uuid ORDER BY alias ASC LIMIT 200`))
      .map((r: any) => ({
        id: String(r.id), alias: String(r.alias || ''), kind: String(r.kind || 'synonym'), source: String(r.source || 'admin'),
      }));
  } catch (e: any) {
    logFail(MOD, 'aliasesFor', e);
    return [];
  }
}

// =================================================================================================
// READING THE GRAPH
// =================================================================================================

/** Pure: the words a screen prints for one edge, from the point of view of the skill asked about. */
export function edgeSentence(
  subjectName: string,
  relation: SkillRelation,
  direction: 'outgoing' | 'incoming' | 'symmetric',
  otherName: string,
): string {
  switch (relation) {
    case 'parent':
      return direction === 'outgoing'
        ? subjectName + ' is the broader area that ' + otherName + ' sits inside.'
        : otherName + ' is the broader area that ' + subjectName + ' sits inside.';
    case 'child':
      return subjectName + ' is a narrower part of ' + otherName + '.';
    case 'prerequisite':
      return direction === 'outgoing'
        ? subjectName + ' is usually learned before ' + otherName + '. It is an ordering, not a credit.'
        : otherName + ' is usually learned before ' + subjectName + '. It is an ordering, not a credit.';
    case 'related':
      return subjectName + ' and ' + otherName + ' come up together. That says nothing about either one on its own.';
    case 'adjacent':
      return otherName + ' is a short step away for somebody who works in ' + subjectName + '.';
    case 'complementary':
      return subjectName + ' and ' + otherName + ' are stronger held together than separately.';
    case 'substitute':
      return otherName + ' can stand in for ' + subjectName + ' for some purposes. Which purposes is a judgement for a person.';
    default:
      return subjectName + ' and ' + otherName + ' are recorded as connected.';
  }
}

/**
 * Every direct edge touching one node, written from that node's point of view.
 *
 * THE STRICT VARIANT THROWS. A caller that is about to say something about a PERSON — whether a
 * requirement is answered — must be able to tell "the graph records nothing" from "the graph could
 * not be read", because those two render as the same empty list and only one of them is a finding.
 * requirementResolution() calls this one; screens that are only drawing the graph call the tolerant
 * export below, where an empty list is an honest picture of an unreadable graph.
 */
async function edgesForStrict(skillId: string): Promise<SkillEdge[]> {
  if (!isUuid(skillId)) return [];
  {
    await ensureSkillOntologySchema();
    const self = rowsOf(await db.execute(sql`
      SELECT name FROM hr_skills WHERE id = ${skillId}::uuid LIMIT 1`));
    const subjectName = self.length ? String(self[0].name) : 'This skill';
    const rows = rowsOf(await db.execute(sql`
      SELECT r.id::text AS id, r.relation, r.note, r.source,
             r.asserted_by_user_id::text AS asserted_by_user_id, r.created_at,
             r.from_skill_id::text AS from_skill_id, r.to_skill_id::text AS to_skill_id,
             sf.name AS from_name, sf.category AS from_category,
             st.name AS to_name, st.category AS to_category
        FROM skill_relations r
        JOIN hr_skills sf ON sf.id = r.from_skill_id
        JOIN hr_skills st ON st.id = r.to_skill_id
       WHERE r.from_skill_id = ${skillId}::uuid OR r.to_skill_id = ${skillId}::uuid
       ORDER BY r.relation ASC, r.created_at ASC
       LIMIT 300`));
    return rows.map((r: any): SkillEdge => {
      const outgoing = String(r.from_skill_id) === skillId;
      const stored = String(r.relation) as SkillRelation;
      const symmetric = SYMMETRIC_RELATIONS.includes(stored);
      const relation: SkillRelation = symmetric ? stored : (stored === 'parent' && !outgoing ? 'child' : stored);
      const direction: 'outgoing' | 'incoming' | 'symmetric' = symmetric ? 'symmetric' : (outgoing ? 'outgoing' : 'incoming');
      return {
        id: String(r.id),
        relation,
        direction,
        otherSkillId: outgoing ? String(r.to_skill_id) : String(r.from_skill_id),
        otherSkillName: outgoing ? String(r.to_name || '') : String(r.from_name || ''),
        otherCategory: outgoing ? String(r.to_category || 'general') : String(r.from_category || 'general'),
        note: r.note ? String(r.note) : null,
        source: String(r.source || 'admin'),
        assertedByUserId: r.asserted_by_user_id ? String(r.asserted_by_user_id) : null,
        assertedAt: r.created_at ? new Date(r.created_at).toISOString() : null,
        sentence: edgeSentence(
          subjectName,
          relation,
          direction,
          outgoing ? String(r.to_name || '') : String(r.from_name || ''),
        ),
      };
    });
  }
}

/** The tolerant form, for a screen drawing the graph. An unreadable graph draws as no edges. */
export async function edgesFor(skillId: string): Promise<SkillEdge[]> {
  try {
    return await edgesForStrict(skillId);
  } catch (e: any) {
    logFail(MOD, 'edgesFor', e);
    return [];
  }
}

/** THROWS on an unreadable graph, for the same reason edgesForStrict() does. */
async function walkStrict(skillId: string, up: boolean, maxDepth: number): Promise<OntologyPathNode[]> {
  if (!isUuid(skillId)) return [];
  const depth = Math.min(Math.max(1, Math.round(Number(maxDepth) || MAX_WALK_DEPTH)), MAX_WALK_DEPTH);
  {
    await ensureSkillOntologySchema();
    const rows = up
      ? rowsOf(await db.execute(sql`
        WITH RECURSIVE w AS (
          SELECT r.from_skill_id AS id, 1 AS depth,
                 ARRAY[r.to_skill_id::text, r.from_skill_id::text] AS path
            FROM skill_relations r
           WHERE r.relation = 'parent' AND r.to_skill_id = ${skillId}::uuid
          UNION ALL
          SELECT r.from_skill_id, w.depth + 1, w.path || r.from_skill_id::text
            FROM skill_relations r JOIN w ON r.to_skill_id = w.id
           WHERE r.relation = 'parent' AND w.depth < ${depth}::int
             AND NOT (r.from_skill_id::text = ANY(w.path))
        )
        SELECT w.id::text AS id, w.depth, w.path, s.name, s.category
          FROM w JOIN hr_skills s ON s.id = w.id
         ORDER BY w.depth ASC, s.name ASC LIMIT 200`))
      : rowsOf(await db.execute(sql`
        WITH RECURSIVE w AS (
          SELECT r.to_skill_id AS id, 1 AS depth,
                 ARRAY[r.from_skill_id::text, r.to_skill_id::text] AS path
            FROM skill_relations r
           WHERE r.relation = 'parent' AND r.from_skill_id = ${skillId}::uuid
          UNION ALL
          SELECT r.to_skill_id, w.depth + 1, w.path || r.to_skill_id::text
            FROM skill_relations r JOIN w ON r.from_skill_id = w.id
           WHERE r.relation = 'parent' AND w.depth < ${depth}::int
             AND NOT (r.to_skill_id::text = ANY(w.path))
        )
        SELECT w.id::text AS id, w.depth, w.path, s.name, s.category
          FROM w JOIN hr_skills s ON s.id = w.id
         ORDER BY w.depth ASC, s.name ASC LIMIT 200`));
    return rows.map((r: any) => ({
      skillId: String(r.id),
      name: String(r.name || ''),
      category: String(r.category || 'general'),
      depth: Number(r.depth) || 1,
      path: Array.isArray(r.path) ? r.path.map((x: any) => String(x)) : [],
    }));
  }
}

async function walk(skillId: string, up: boolean, maxDepth: number): Promise<OntologyPathNode[]> {
  try {
    return await walkStrict(skillId, up, maxDepth);
  } catch (e: any) {
    logFail(MOD, up ? 'broaderThan' : 'narrowerThan', e);
    return [];
  }
}

/** The broader skills this one sits inside, nearest first. */
export function broaderThan(skillId: string, maxDepth = MAX_WALK_DEPTH): Promise<OntologyPathNode[]> {
  return walk(skillId, true, maxDepth);
}

/** The narrower skills underneath this one, nearest first. */
export function narrowerThan(skillId: string, maxDepth = MAX_WALK_DEPTH): Promise<OntologyPathNode[]> {
  return walk(skillId, false, maxDepth);
}

/**
 * WHAT HOLDING THIS SKILL LETS THE SYSTEM INFER, AND NOTHING MORE.
 *
 * Only the broader skills, only through 'parent' edges, and every row comes back stamped inferred
 * with the chain that produced it. Somebody who has demonstrated PostgreSQL has plainly used SQL;
 * they have NOT demonstrated it, and no caller of this function is permitted to record it as though
 * they had — src/lib/evidence-graph.ts enforces that by giving an ontology-derived claim a ceiling
 * of 'inferred' that no code path can raise.
 *
 * Prerequisites are deliberately absent. Holding Machine Learning is not evidence of Statistics.
 */
export async function impliedBy(skillId: string, maxDepth = MAX_WALK_DEPTH): Promise<ImpliedSkill[]> {
  const self = await skillNode(skillId);
  const name = self ? self.name : 'that skill';
  const up = await broaderThan(skillId, maxDepth);
  return up.map((n) => ({
    ...n,
    assertion: 'inferred' as const,
    sentence: 'Holding ' + name + ' suggests some ' + n.name + ', because the graph records '
      + n.name + ' as the broader area it sits inside. That is an inference, not a demonstration.',
  }));
}

/** THROWS on an unreadable catalogue, so "not in the catalogue" is never said about a failed read. */
async function skillNodeStrict(skillId: string): Promise<SkillNode | null> {
  if (!isUuid(skillId)) return null;
  await ensurePerformanceSchema();
  const r = rowsOf(await db.execute(sql`
    SELECT id, name, category, is_active FROM hr_skills WHERE id = ${skillId}::uuid LIMIT 1`));
  return r.length ? mapNode(r[0]) : null;
}

export async function skillNode(skillId: string): Promise<SkillNode | null> {
  try {
    return await skillNodeStrict(skillId);
  } catch (e: any) {
    logFail(MOD, 'skillNode', e);
    return null;
  }
}

// =================================================================================================
// A REQUIREMENT MEETS A SET OF HELD SKILLS — AND IS NOT TOTALLED
// =================================================================================================

export type RequirementMatch = 'exact' | 'narrower' | 'broader_only' | 'substitute' | 'none' | 'unreadable';

export interface RequirementResolution {
  requiredSkillId: string;
  requiredSkillName: string;
  match: RequirementMatch;
  /** The held skill that produced the match, when one did. */
  viaSkillId: string | null;
  viaSkillName: string | null;
  /**
   * True only for 'exact', and it is a statement about the ROUTE, never about the evidence.
   *
   * It means "no judgement is needed about whether this is the same skill", because it is the same
   * node. It does NOT mean the person has shown anything: the held set handed to this function is
   * just a list of skill ids, and a skill somebody typed on a CV reaches this branch exactly as a
   * demonstrated one does. WHAT THEY CAN SHOW FOR IT IS THE EVIDENCE GRAPH'S QUESTION — see
   * requirementCoverage() in src/lib/evidence-graph.ts, which takes this route and then reads the
   * claim's evidence level before calling anything evidenced. A caller that renders this field as
   * "requirement met" without that second read has turned a keyword into a competence.
   */
  countsWithoutJudgement: boolean;
  sentence: string;
}

/**
 * Does anything in this person's held set answer this requirement, and by what route.
 *
 * IT RETURNS A NAMED STATUS AND NEVER A NUMBER. A percentage here would be keyword overlap wearing
 * a score, on two vocabularies that have never been joined, about a capability nobody demonstrated.
 * The four routes are kept apart because they mean genuinely different things to the person reading:
 *
 *   exact        the same node. The only route that answers a requirement on its own.
 *   narrower     they hold something underneath it. Real, and still an inference about the parent.
 *   broader_only they hold the broader area. That is NOT an answer — holding Databases says nothing
 *                about PostgreSQL — and it is returned so a human can see the near miss, not so a
 *                screen can count it.
 *   substitute   the graph records an alternative. A question for a person, never a pass.
 *
 * Evidence is not consulted here. What a person can SHOW for the matched skill is the evidence
 * graph's question, and joining the two is done there, on purpose, so that a match can never quietly
 * become proof on its way through this function.
 */
export async function requirementResolution(
  requiredSkillId: string,
  heldSkillIds: readonly string[],
): Promise<RequirementResolution> {
  const held = (heldSkillIds || []).filter(isUuid);
  const unreadableBase: RequirementResolution = {
    requiredSkillId: String(requiredSkillId || ''),
    requiredSkillName: 'that skill',
    match: 'unreadable',
    viaSkillId: null,
    viaSkillName: null,
    countsWithoutJudgement: false,
    sentence: 'We could not read the skill catalogue, so we cannot say whether this requirement is answered.',
  };
  // The lookup is guarded SEPARATELY from the walks below, because its two failures say opposite
  // things: a null node means the requirement names no catalogue skill, and a throw means nobody
  // can say what it names. Reporting the second as the first is a statement about a job description
  // that nobody made.
  let node: SkillNode | null;
  try {
    node = await skillNodeStrict(requiredSkillId);
  } catch (e: any) {
    logFail(MOD, 'requirementResolution:node', e);
    return unreadableBase;
  }
  const requiredName = node ? node.name : 'that skill';
  const base: RequirementResolution = {
    requiredSkillId: String(requiredSkillId || ''),
    requiredSkillName: requiredName,
    match: 'none',
    viaSkillId: null,
    viaSkillName: null,
    countsWithoutJudgement: false,
    sentence: 'Nothing on record answers ' + requiredName + '.',
  };
  if (!node) return { ...base, match: 'unreadable', sentence: 'That requirement is not a skill in the catalogue.' };
  if (held.includes(String(requiredSkillId))) {
    return {
      ...base,
      match: 'exact',
      viaSkillId: String(requiredSkillId),
      viaSkillName: requiredName,
      countsWithoutJudgement: true,
      sentence: requiredName + ' is held directly.',
    };
  }
  try {
    // THE STRICT VARIANTS, DELIBERATELY. The tolerant ones return an empty list when the database
    // cannot be read, and an empty list here would come back as "Nothing on record answers X" — a
    // confident negative about a person, manufactured out of a failed read, on a screen where
    // somebody is deciding. An unreadable graph must reach the catch below and say so.
    const [down, up, edges] = await Promise.all([
      walkStrict(requiredSkillId, false, MAX_WALK_DEPTH),
      walkStrict(requiredSkillId, true, MAX_WALK_DEPTH),
      edgesForStrict(requiredSkillId),
    ]);
    const narrower = down.find((n) => held.includes(n.skillId));
    if (narrower) {
      return {
        ...base,
        match: 'narrower',
        viaSkillId: narrower.skillId,
        viaSkillName: narrower.name,
        countsWithoutJudgement: false,
        sentence: narrower.name + ' is held, which sits underneath ' + requiredName
          + '. That is an inference about ' + requiredName + ', not a demonstration of it.',
      };
    }
    const substitute = edges.find((e) => e.relation === 'substitute' && held.includes(e.otherSkillId));
    if (substitute) {
      return {
        ...base,
        match: 'substitute',
        viaSkillId: substitute.otherSkillId,
        viaSkillName: substitute.otherSkillName,
        countsWithoutJudgement: false,
        sentence: substitute.otherSkillName + ' is recorded as a substitute for ' + requiredName
          + ' for some purposes. Whether it answers this requirement is a judgement for a person.',
      };
    }
    const broader = up.find((n) => held.includes(n.skillId));
    if (broader) {
      return {
        ...base,
        match: 'broader_only',
        viaSkillId: broader.skillId,
        viaSkillName: broader.name,
        countsWithoutJudgement: false,
        sentence: broader.name + ' is held, which is the broader area ' + requiredName
          + ' sits inside. That does not answer the requirement.',
      };
    }
    return base;
  } catch (e: any) {
    logFail(MOD, 'requirementResolution', e);
    return {
      ...base,
      match: 'unreadable',
      sentence: 'We could not read the skill graph, so we cannot say whether ' + requiredName + ' is answered.',
    };
  }
}

// =================================================================================================
// ONE NODE, ASSEMBLED FOR A SCREEN — WITH THE THREE STATES KEPT APART
// =================================================================================================

/**
 * The state of a read, as four words that a screen must never collapse into one.
 *
 * The same shape person-spine.ts uses. It is restated here rather than imported because this module
 * is already imported by evidence-graph.ts and by every match surface, and a screen-shaped helper is
 * not worth pulling another module into all of them.
 */
export type OntologyReadState = 'ok' | 'not_configured' | 'empty' | 'unreadable';

export interface OntologyAlias {
  id: string;
  alias: string;
  kind: string;
  source: string;
}

export interface SkillGraphView {
  state: OntologyReadState;
  /** The sentence the screen prints. Never invented at the call site. */
  sentence: string;
  node: SkillNode | null;
  edges: SkillEdge[];
  aliases: OntologyAlias[];
  broader: OntologyPathNode[];
  narrower: OntologyPathNode[];
  /** Always stamped inferred, with the chain that produced each row. */
  implied: ImpliedSkill[];
  error?: string;
}

/**
 * EVERYTHING RECORDED ABOUT ONE NODE, IN ONE READ, WITHOUT THE TOLERANT SHORTCUT.
 *
 * edgesFor() and broaderThan() swallow and return an empty list on purpose — a screen that is only
 * DRAWING the graph draws nothing when it cannot be read. A screen an administrator EDITS the graph
 * from cannot use those: "this skill has no relations" and "we could not read the relations" are the
 * difference between adding the edge that was missing and adding a duplicate of one that is already
 * there, and only one of them is a finding. So this uses the strict internals and reports which of
 * the four states it is actually in — including not_configured, asked of information_schema rather
 * than assumed from ensureSkillOntologySchema() returning, which it does even when the DDL failed.
 */
export async function skillGraphView(skillId: string): Promise<SkillGraphView> {
  const base: SkillGraphView = {
    state: 'unreadable',
    sentence: '',
    node: null,
    edges: [],
    aliases: [],
    broader: [],
    narrower: [],
    implied: [],
  };
  if (!isUuid(skillId)) {
    return { ...base, state: 'empty', sentence: 'No skill was chosen, so there is nothing to show.' };
  }
  try {
    await ensureSkillOntologySchema();
    // ASKED, NEVER ASSUMED. ensureOnce ends in p.catch(() => {}) and this module's own guard rethrows
    // into it, so a returned ensure proves that a promise settled and nothing else.
    const tables = rowsOf(await db.execute(sql`
      SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name IN ('skill_relations', 'skill_aliases')`));
    const have = new Set(tables.map((r: any) => String(r.table_name)));
    const node = await skillNodeStrict(skillId);
    if (!have.has('skill_relations') || !have.has('skill_aliases')) {
      const missing = ['skill_relations', 'skill_aliases'].filter((t) => !have.has(t));
      return {
        ...base,
        state: 'not_configured',
        node,
        sentence: 'The skill graph has not been set up in this database yet — ' + missing.join(' and ')
          + ' ' + (missing.length === 1 ? 'is' : 'are') + ' not there. That is not a statement that '
          + 'nothing is related to this skill; nothing has been able to be recorded at all.',
      };
    }
    if (!node) {
      return {
        ...base,
        state: 'empty',
        sentence: 'That skill is not in the catalogue, so there is no node to show relations for.',
      };
    }
    const [edges, aliasRows, broader, narrower] = await Promise.all([
      edgesForStrict(skillId),
      db.execute(sql`
        SELECT id::text AS id, alias, kind, source FROM skill_aliases
         WHERE skill_id = ${skillId}::uuid ORDER BY alias ASC LIMIT 200`),
      walkStrict(skillId, true, MAX_WALK_DEPTH),
      walkStrict(skillId, false, MAX_WALK_DEPTH),
    ]);
    const aliases: OntologyAlias[] = rowsOf(aliasRows).map((r: any) => ({
      id: String(r.id),
      alias: String(r.alias || ''),
      kind: String(r.kind || 'synonym'),
      source: String(r.source || 'admin'),
    }));
    // Built from the walk that was already read rather than by calling impliedBy(), which would walk
    // the same edges a third time. The wording is the one impliedBy() prints, kept identical here on
    // purpose: two screens must not describe the same inference in two ways.
    const implied: ImpliedSkill[] = broader.map((n) => ({
      ...n,
      assertion: 'inferred' as const,
      sentence: 'Holding ' + node.name + ' suggests some ' + n.name + ', because the graph records '
        + n.name + ' as the broader area it sits inside. That is an inference, not a demonstration.',
    }));
    const empty = edges.length === 0 && aliases.length === 0;
    return {
      state: empty ? 'empty' : 'ok',
      sentence: empty
        ? 'Nothing is recorded about ' + node.name + ' in the graph: no relation to any other skill '
          + 'and no other name. The graph is curated by hand, so an absent edge means nobody has '
          + 'written it down yet — not that there is none.'
        : '',
      node,
      edges,
      aliases,
      broader,
      narrower,
      implied,
    };
  } catch (e: any) {
    logFail(MOD, 'skillGraphView', e);
    return {
      ...base,
      state: 'unreadable',
      sentence: 'We could not read the skill graph just now, so this shows nothing rather than '
        + 'guessing. It is not a statement that nothing is recorded.',
      error: e?.cause?.message || e?.message || 'unreadable',
    };
  }
}

// =================================================================================================
// HOW BIG IS THIS GRAPH, REALLY
// =================================================================================================

export interface OntologyStats {
  ok: boolean;
  skills: number;
  activeSkills: number;
  relations: number;
  aliases: number;
  seedRelations: number;
  /** Nodes with no edge at all — the honest measure of how partial this is. */
  isolatedSkills: number;
  sentence: string;
}

/**
 * Counts of concepts, never of people. Nothing in this function touches an employee row, so there is
 * no small-group disclosure to suppress and no MIN_GROUP question to get wrong.
 */
export async function ontologyStats(): Promise<OntologyStats> {
  const empty: OntologyStats = {
    ok: false, skills: 0, activeSkills: 0, relations: 0, aliases: 0, seedRelations: 0, isolatedSkills: 0,
    sentence: 'We could not read the skill graph.',
  };
  try {
    await ensureSkillOntologySchema();
    const r = rowsOf(await db.execute(sql`
      SELECT
        (SELECT COUNT(*)::int FROM hr_skills) AS skills,
        (SELECT COUNT(*)::int FROM hr_skills WHERE is_active = true) AS active_skills,
        (SELECT COUNT(*)::int FROM skill_relations) AS relations,
        (SELECT COUNT(*)::int FROM skill_relations WHERE source = 'seed') AS seed_relations,
        (SELECT COUNT(*)::int FROM skill_aliases) AS aliases,
        (SELECT COUNT(*)::int FROM hr_skills s WHERE NOT EXISTS (
           SELECT 1 FROM skill_relations r
            WHERE r.from_skill_id = s.id OR r.to_skill_id = s.id)) AS isolated`))[0];
    if (!r) return empty;
    const skills = Number(r.skills) || 0;
    const relations = Number(r.relations) || 0;
    const isolated = Number(r.isolated) || 0;
    return {
      ok: true,
      skills,
      activeSkills: Number(r.active_skills) || 0,
      relations,
      aliases: Number(r.aliases) || 0,
      seedRelations: Number(r.seed_relations) || 0,
      isolatedSkills: isolated,
      sentence: skills === 0
        ? 'The skill catalogue is empty, so there is no graph yet.'
        : relations + ' relation' + (relations === 1 ? '' : 's') + ' between ' + skills + ' skills, '
          + 'and ' + isolated + ' skill' + (isolated === 1 ? ' has' : 's have') + ' no relation recorded at all. '
          + 'This is a curated graph, not a complete map of the field.',
    };
  } catch (e: any) {
    logFail(MOD, 'ontologyStats', e);
    return empty;
  }
}

// =================================================================================================
// THE STARTER SET
// =================================================================================================

/**
 * A SMALL, HONEST STARTING POINT. Twenty-odd nodes somebody can read in a minute and correct.
 *
 * It is data, not behaviour: an administrator adds to it through assertRelation() and addAlias()
 * without a deploy, and every row it writes is marked source = 'seed' so the difference between
 * "we shipped this" and "our organization decided this" stays visible forever.
 *
 * The relations are written in reading order — [A, relation, B] reads as the English sentence.
 */
export const STARTER_ONTOLOGY: {
  skills: { name: string; category: string; description: string }[];
  relations: [string, SkillRelation, string][];
  aliases: { skill: string; alias: string; kind: AliasKind }[];
} = {
  skills: [
    { name: 'Software Engineering', category: 'engineering', description: 'Building and maintaining software systems.' },
    { name: 'Programming', category: 'engineering', description: 'Writing code in any language.' },
    { name: 'Python', category: 'engineering', description: 'The Python language and its ecosystem.' },
    { name: 'JavaScript', category: 'engineering', description: 'The JavaScript language and its runtimes.' },
    { name: 'TypeScript', category: 'engineering', description: 'Typed JavaScript.' },
    { name: 'Databases', category: 'engineering', description: 'Storing, querying and modelling data at rest.' },
    { name: 'SQL', category: 'engineering', description: 'Querying relational databases.' },
    { name: 'PostgreSQL', category: 'engineering', description: 'The PostgreSQL relational database.' },
    { name: 'Data Modelling', category: 'engineering', description: 'Designing the shape data is stored in.' },
    { name: 'Web Development', category: 'engineering', description: 'Building software delivered through a browser.' },
    { name: 'Accessibility', category: 'engineering', description: 'Building so that disabled people can use it.' },
    { name: 'Testing', category: 'engineering', description: 'Checking that software does what it should.' },
    { name: 'Data Analysis', category: 'data', description: 'Answering questions from data.' },
    { name: 'Statistics', category: 'data', description: 'Reasoning about uncertainty in data.' },
    { name: 'Linear Algebra', category: 'data', description: 'Vectors, matrices and the mathematics behind models.' },
    { name: 'Machine Learning', category: 'data', description: 'Building models that learn from data.' },
    { name: 'Deep Learning', category: 'data', description: 'Neural network methods.' },
    { name: 'Natural Language Processing', category: 'data', description: 'Working with human language as data.' },
    { name: 'Data Engineering', category: 'data', description: 'Moving and shaping data so it can be used.' },
    { name: 'Technical Writing', category: 'communication', description: 'Explaining technical work in writing.' },
    { name: 'Presentation', category: 'communication', description: 'Explaining work to a room.' },
    { name: 'Teaching', category: 'communication', description: 'Helping somebody else become able to do it.' },
    { name: 'Project Coordination', category: 'delivery', description: 'Keeping work moving between people.' },
  ],
  relations: [
    ['Software Engineering', 'parent', 'Programming'],
    ['Software Engineering', 'parent', 'Testing'],
    ['Software Engineering', 'parent', 'Web Development'],
    ['Programming', 'parent', 'Python'],
    ['Programming', 'parent', 'JavaScript'],
    ['JavaScript', 'parent', 'TypeScript'],
    ['Databases', 'parent', 'SQL'],
    ['Databases', 'parent', 'Data Modelling'],
    ['SQL', 'parent', 'PostgreSQL'],
    ['Data Analysis', 'parent', 'Statistics'],
    ['Machine Learning', 'parent', 'Deep Learning'],
    ['Machine Learning', 'parent', 'Natural Language Processing'],
    ['Statistics', 'prerequisite', 'Machine Learning'],
    ['Linear Algebra', 'prerequisite', 'Deep Learning'],
    ['SQL', 'prerequisite', 'Data Analysis'],
    ['Programming', 'prerequisite', 'Web Development'],
    ['Data Analysis', 'related', 'Machine Learning'],
    ['Data Engineering', 'complementary', 'Machine Learning'],
    ['Accessibility', 'complementary', 'Web Development'],
    ['Testing', 'complementary', 'Software Engineering'],
    ['Technical Writing', 'complementary', 'Software Engineering'],
    ['Teaching', 'adjacent', 'Presentation'],
    ['Technical Writing', 'adjacent', 'Presentation'],
    ['Data Engineering', 'adjacent', 'Data Analysis'],
    ['Python', 'substitute', 'JavaScript'],
  ],
  aliases: [
    { skill: 'Machine Learning', alias: 'ML', kind: 'abbreviation' },
    { skill: 'Natural Language Processing', alias: 'NLP', kind: 'abbreviation' },
    { skill: 'JavaScript', alias: 'JS', kind: 'abbreviation' },
    { skill: 'TypeScript', alias: 'TS', kind: 'abbreviation' },
    { skill: 'PostgreSQL', alias: 'Postgres', kind: 'synonym' },
    { skill: 'PostgreSQL', alias: 'psql', kind: 'abbreviation' },
    { skill: 'Deep Learning', alias: 'Neural Networks', kind: 'synonym' },
    { skill: 'Accessibility', alias: 'a11y', kind: 'abbreviation' },
    { skill: 'Data Analysis', alias: 'Data Analytics', kind: 'synonym' },
    { skill: 'Project Coordination', alias: 'Project Management', kind: 'synonym' },
  ],
};

export interface SeedReport {
  ok: boolean;
  ran: boolean;
  skillsCreated: number;
  skillsAlreadyPresent: number;
  relationsCreated: number;
  relationsAlreadyPresent: number;
  aliasesCreated: number;
  aliasesRefused: number;
  /** Every refusal, verbatim, so nothing is lost silently. */
  refusals: string[];
  sentence: string;
  error?: string;
}

/**
 * Apply the starter set. AN EXPLICIT ADMIN ACTION, never a side effect of a page load.
 *
 * IT RUNS ONLY INTO AN EMPTY GRAPH. If skill_relations already holds anything, this returns
 * ran: false and changes nothing — an administrator who deleted an edge on purpose must not have it
 * resurrected by the next deploy, and a graph an organization has curated is not ours to top up.
 *
 * Skills go in through createSkill() in src/lib/skills.ts, which is the one front door to the
 * catalogue. Where a name is already there, its existing row is used and nothing is overwritten:
 * the seed adds edges to what an organization already has rather than a parallel set of its own.
 */
export async function seedStarterOntology(actorUserId?: string | null): Promise<SeedReport> {
  const actor = isUuid(actorUserId) ? String(actorUserId) : null;
  const report: SeedReport = {
    ok: false, ran: false, skillsCreated: 0, skillsAlreadyPresent: 0,
    relationsCreated: 0, relationsAlreadyPresent: 0, aliasesCreated: 0, aliasesRefused: 0,
    refusals: [], sentence: '',
  };
  try {
    await ensureSkillOntologySchema();
    const existing = rowsOf(await db.execute(sql`SELECT COUNT(*)::int AS n FROM skill_relations`))[0];
    if ((Number(existing?.n) || 0) > 0) {
      return {
        ...report,
        ok: true,
        ran: false,
        sentence: 'The skill graph already has relations in it, so the starter set was not applied. '
          + 'Add what is missing one relation at a time; nothing here overwrites a curated graph.',
      };
    }

    const idByName = new Map<string, string>();
    for (const s of STARTER_ONTOLOGY.skills) {
      const made = await createSkill({
        name: s.name, category: s.category, description: s.description, actorUserId: actor,
      });
      if (made.ok && made.id) {
        idByName.set(s.name, made.id);
        report.skillsCreated += 1;
        continue;
      }
      if (made.id) {
        idByName.set(s.name, made.id);
        report.skillsAlreadyPresent += 1;
        continue;
      }
      const found = rowsOf(await db.execute(sql`
        SELECT id::text AS id FROM hr_skills WHERE lower(name) = lower(${s.name}) LIMIT 1`));
      if (found.length) {
        idByName.set(s.name, String(found[0].id));
        report.skillsAlreadyPresent += 1;
      } else {
        report.refusals.push('Could not add the skill ' + s.name + ': ' + (made.error || 'unknown reason'));
      }
    }

    for (const [fromName, relation, toName] of STARTER_ONTOLOGY.relations) {
      const from = idByName.get(fromName);
      const to = idByName.get(toName);
      if (!from || !to) {
        report.refusals.push('Skipped ' + fromName + ' ' + relation + ' ' + toName + ': one of the skills is not in the catalogue.');
        continue;
      }
      const made = await assertRelation({
        fromSkillId: from, relation, toSkillId: to, actorUserId: actor, source: 'seed',
      });
      if (made.ok) report.relationsCreated += 1;
      else if (made.id) report.relationsAlreadyPresent += 1;
      else report.refusals.push('Skipped ' + fromName + ' ' + relation + ' ' + toName + ': ' + (made.error || 'unknown reason'));
    }

    for (const a of STARTER_ONTOLOGY.aliases) {
      const skillId = idByName.get(a.skill);
      if (!skillId) {
        report.aliasesRefused += 1;
        report.refusals.push('Skipped the name "' + a.alias + '": ' + a.skill + ' is not in the catalogue.');
        continue;
      }
      const made = await addAlias({
        skillId, alias: a.alias, kind: a.kind, actorUserId: actor, source: 'seed',
      });
      if (made.ok) report.aliasesCreated += 1;
      else {
        report.aliasesRefused += 1;
        report.refusals.push('Skipped the name "' + a.alias + '": ' + (made.error || 'unknown reason'));
      }
    }

    // Say what is ACTUALLY there now, from the database, rather than from the counters above.
    const after = await ontologyStats();
    return {
      ...report,
      ok: true,
      ran: true,
      sentence: 'Starter graph applied. ' + (after.ok ? after.sentence : 'The graph could not be re-read to confirm.')
        + (report.refusals.length ? ' ' + report.refusals.length + ' item(s) were skipped and are listed.' : ''),
    };
  } catch (e: any) {
    logFail(MOD, 'seedStarterOntology', e);
    return {
      ...report,
      ok: false,
      sentence: 'The starter graph was not applied.',
      error: e?.cause?.message || e?.message || 'unknown error',
    };
  }
}

// =================================================================================================
// SELF-CHECK — the invariants, checkable without a database or a test runner
// =================================================================================================

/**
 * Returns the list of things that are WRONG. An empty array is the pass.
 *
 * There is no vitest in this worktree, so the invariants that hold this module together are checked
 * by a function an admin screen or a health check can call, rather than by a test file nothing runs.
 */
export function ontologySelfCheck(): string[] {
  const problems: string[] = [];
  // The divergence report must never name a table this module owns: an entry like that would make
  // the graph report itself as its own rival and hide a real second store behind the noise.
  for (const f of FOREIGN_EDGE_STORES) {
    if (f.table === 'skill_relations' || f.table === 'skill_aliases' || f.table === 'hr_skills') {
      problems.push('FOREIGN_EDGE_STORES names ' + f.table + ', which this module owns.');
    }
    if (!f.ownedBy.length) problems.push('The foreign edge store ' + f.table + ' names nobody who owns it.');
    if (f.why.trim().length < 40) problems.push('The foreign edge store ' + f.table + ' has no readable reason.');
  }
  for (const r of SKILL_RELATIONS) {
    if (!RELATION_LABELS[r]) problems.push('Relation ' + r + ' has no label.');
    if (!RELATION_MEANING[r]) problems.push('Relation ' + r + ' has no explanation sentence.');
  }
  for (const k of ALIAS_KINDS) {
    if (!ALIAS_KIND_LABELS[k]) problems.push('Alias kind ' + k + ' has no label.');
  }
  if (IMPLYING_RELATIONS.length !== 1 || IMPLYING_RELATIONS[0] !== 'parent') {
    problems.push('IMPLYING_RELATIONS must be exactly ["parent"]: no other relation may support a '
      + 'statement about a person.');
  }
  for (const r of SYMMETRIC_RELATIONS) {
    if (r === 'parent' || r === 'child' || r === 'prerequisite') {
      problems.push('Relation ' + r + ' is directional and must not be stored symmetrically.');
    }
  }
  if (normalizeSkillText('Machine Learning') !== normalizeSkillText('machine-learning')) {
    problems.push('Normalisation no longer folds "machine-learning" onto "Machine Learning".');
  }
  if (normalizeSkillText('C++') === normalizeSkillText('C')) {
    problems.push('Normalisation collapses C++ onto C. Those are different skills.');
  }
  if (normalizeSkillText('ML') === normalizeSkillText('Machine Learning')) {
    problems.push('Normalisation is expanding an abbreviation. Abbreviations must be recorded as aliases.');
  }
  const names = new Set(STARTER_ONTOLOGY.skills.map((s) => normalizeSkillText(s.name)));
  if (names.size !== STARTER_ONTOLOGY.skills.length) {
    problems.push('The starter set contains two skills whose names normalise the same.');
  }
  for (const [from, relation, to] of STARTER_ONTOLOGY.relations) {
    if (!names.has(normalizeSkillText(from))) problems.push('Starter relation names an unknown skill: ' + from);
    if (!names.has(normalizeSkillText(to))) problems.push('Starter relation names an unknown skill: ' + to);
    if (!isSkillRelation(relation)) problems.push('Starter relation uses an unknown relation: ' + relation);
    if (normalizeSkillText(from) === normalizeSkillText(to)) problems.push('Starter relation joins a skill to itself: ' + from);
  }
  const aliasNorms = new Set<string>();
  for (const a of STARTER_ONTOLOGY.aliases) {
    const n = normalizeSkillText(a.alias);
    if (aliasNorms.has(n)) problems.push('The starter set records the name "' + a.alias + '" twice.');
    aliasNorms.add(n);
    if (names.has(n)) problems.push('The starter name "' + a.alias + '" is also a catalogue skill name.');
    if (!names.has(normalizeSkillText(a.skill))) problems.push('Starter alias names an unknown skill: ' + a.skill);
    if (!isAliasKind(a.kind)) problems.push('Starter alias uses an unknown kind: ' + a.kind);
  }
  return problems;
}
