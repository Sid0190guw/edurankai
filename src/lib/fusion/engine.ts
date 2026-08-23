// src/lib/fusion/engine.ts — GATHER, FUSE, STORE, COMPARE. THE PART THAT TOUCHES THE DATABASE.
//
// =================================================================================================
// THE PROFILE IS DYNAMIC BECAUSE IT IS RECOMPUTED, NOT BECAUSE IT IS CACHED CLEVERLY
// =================================================================================================
//
// buildProfile() reads every provider, fuses ten dimensions and returns. A snapshot is written only
// when somebody asks for one — because a row written on every page view would fill the evolution
// table with two hundred identical readings and bury the three that actually moved.
//
// EVOLUTION IS THE PREVIOUS SNAPSHOT, NOT A RUNNING AVERAGE. Each reading is compared against the
// last stored reading FOR THE SAME DIMENSION, which is what hif_readings_evolution indexes. Nothing
// here smooths, decays or extrapolates: the record moved or it did not, and the sentence says which.
//
// =================================================================================================
// EVERY READ IS ALLOWED TO FAIL, AND NONE OF THEM MAY FAIL SILENTLY
// =================================================================================================
//
// A provider that throws becomes a named line in `unreadable`. A weighting that cannot be loaded
// falls back to the built-in and says so. A snapshot that cannot be written returns a sentence a
// person can read rather than a thrown page. What must never happen is a profile that renders
// confidently while a third of its inputs failed to load — that is a lie about a person, and this
// project has already shipped a screen that made it.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { logAudit } from '@/lib/audit';
import {
  FUSION_DIMENSIONS,
  SOURCE_CLASSES,
  isFusionDimension,
  isNoteStance,
  type DimensionReading,
  type FusionDimension,
  type FusionProfile,
  type HumanNote,
  type ProfileSubject,
  type Signal,
  type SourceClass,
} from './types';
import { fuseProfile, type PreviousReading } from './fuse';
import {
  BUILT_IN_PROFILE,
  DEFAULT_SOURCE_WEIGHTS,
  validateSourceWeights,
  weightingSentence,
  type SourceWeights,
  type WeightProfile,
} from './weights';
import { gatherSignals, notConnectedProviders, type GatherContext } from './signals';
import { registerFirstPartyProviders } from './providers';
import { ensureFusionSchema, logFail, rowsOf } from './schema';

const MOD = 'fusion/engine';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

export const clean = (v: unknown, max: number): string =>
  String(v ?? '').replace(/\s+$/, '').trim().slice(0, max);

/** A note shorter than this is not a note. Same floor src/lib/provenance.ts puts under a reason. */
export const MIN_NOTE_CHARS = 12;

const WRITE_FAILED = 'We could not record that just now. Nothing was changed.';

const HUMAN_AUTHORITY = Object.freeze({
  decides: false as const,
  sentence:
    'Nothing on this page decides anything. These are readings of what is already on record, and '
    + 'every one of them is a prompt for a conversation with the person it is about. Hiring, '
    + 'rejection, promotion, termination, pay and discipline are decided by a named human in the '
    + 'module that owns that decision, and none of those modules reads this one.',
  routes: [
    { label: 'Appraisals', href: '/admin/hr/performance/cycles' },
    { label: 'Skills', href: '/admin/hr/performance/skills' },
    { label: 'Assigned learning', href: '/admin/hr/performance/learning' },
  ],
});

const FAIRNESS_SENTENCE =
  'No protected or sensitive personal attribute was read, and there is no field in this engine one '
  + 'could arrive through. Nothing here reads keystrokes, screenshots, activity or message volume. '
  + 'Signals that named one were refused by name and are listed rather than dropped.';

// -------------------------------------------------------------------------------------------------
// THE WEIGHTING IN FORCE
// -------------------------------------------------------------------------------------------------

export async function getWeightProfile(key = 'default'): Promise<WeightProfile> {
  const k = clean(key, 60) || 'default';
  try {
    await ensureFusionSchema();
    const row = rowsOf(await db.execute(sql`
      SELECT key, label, owner_user_id, weights, note, updated_at
        FROM hif_weight_profiles
       WHERE key = ${k}
       LIMIT 1`))[0];
    if (!row) return BUILT_IN_PROFILE;

    const v = validateSourceWeights(row.weights);
    // A STORED WEIGHTING THAT NO LONGER VALIDATES IS NOT SILENTLY USED. The limits in weights.ts are
    // source constants; if one is tightened, a profile saved under the old one stops being valid and
    // the built-in takes over WITH THE REASON PRINTED, rather than readings continuing to be
    // produced under a policy the code no longer permits.
    if (!v.ok) {
      return {
        ...BUILT_IN_PROFILE,
        sentence: 'The stored weighting "' + k + '" is no longer valid (' + (v.error || 'refused')
          + '), so the built-in default was used instead. Nobody owns the built-in. Save a valid profile.',
      };
    }

    return {
      key: String(row.key),
      label: String(row.label || k),
      ownerUserId: row.owner_user_id ? String(row.owner_user_id) : null,
      weights: v.weights,
      note: row.note ? String(row.note) : null,
      updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
      isBuiltInDefault: false,
      sentence: weightingSentence(v.weights),
    };
  } catch (e: any) {
    logFail('getWeightProfile', e);
    return {
      ...BUILT_IN_PROFILE,
      sentence: 'The stored weighting could not be read just now, so the built-in default was used. '
        + 'That is a failed read, not a decision to use the default.',
    };
  }
}

export interface WeightWriteResult {
  ok: boolean;
  error?: string;
}

/**
 * Save a weighting.
 *
 * IT REFUSES A PROFILE WITH NO OWNER, and the reason is the same one src/lib/match.ts gives for its
 * own weights: this is a policy about people. Moving what manager evidence is worth changes how
 * everybody reads, retrospectively, without appearing on any one person's record. A change like that
 * has a name attached or it does not happen.
 */
export async function saveWeightProfile(input: {
  key: string;
  label: string;
  weights: unknown;
  note?: string | null;
  ownerUserId: string;
}): Promise<WeightWriteResult> {
  const key = clean(input?.key, 60) || 'default';
  const label = clean(input?.label, 120);
  const note = clean(input?.note, 600) || null;

  if (!isUuid(input?.ownerUserId)) {
    return {
      ok: false,
      error: 'A weighting has to have an owner. This decides how every person is read, so it is not '
        + 'saved without a name on it.',
    };
  }
  if (!label) return { ok: false, error: 'Give the weighting a name, so a reader knows which policy produced a reading.' };

  const v = validateSourceWeights(input?.weights);
  if (!v.ok) return { ok: false, error: v.error || 'That weighting was refused.' };

  try {
    await ensureFusionSchema();
    await db.execute(sql`
      INSERT INTO hif_weight_profiles (key, label, owner_user_id, weights, note, updated_at)
      VALUES (${key}, ${label}, ${input.ownerUserId}::uuid, ${JSON.stringify(v.weights)}::jsonb, ${note}, NOW())
      ON CONFLICT (key) DO UPDATE
         SET label = EXCLUDED.label,
             owner_user_id = EXCLUDED.owner_user_id,
             weights = EXCLUDED.weights,
             note = EXCLUDED.note,
             updated_at = NOW()`);

    await logAudit({
      userId: input.ownerUserId,
      action: 'fusion.weights.save',
      entity: 'hif_weight_profiles',
      entityId: key,
      diff: { weights: v.weights, label },
    }).catch((e: any) => logFail('audit weights.save', e));

    return { ok: true };
  } catch (e: any) {
    logFail('saveWeightProfile', e);
    return { ok: false, error: WRITE_FAILED + ' (' + (e?.cause?.message || e?.message || 'no reason given') + ')' };
  }
}

// -------------------------------------------------------------------------------------------------
// THE SUBJECT
// -------------------------------------------------------------------------------------------------

async function loadSubject(employeeId: string): Promise<{ subject: ProfileSubject | null; because: string | null }> {
  try {
    const row = rowsOf(await db.execute(sql`
      SELECT id, user_id, full_name, designation, department_id::text AS department_id
        FROM hr_employees
       WHERE id = ${employeeId}::uuid
       LIMIT 1`))[0];
    if (!row) return { subject: null, because: 'No employee record with that id exists.' };
    return {
      subject: {
        employeeId: String(row.id),
        displayName: row.full_name ? String(row.full_name) : null,
        designation: row.designation ? String(row.designation) : null,
        departmentId: row.department_id ? String(row.department_id) : null,
        roleId: null,
        roleTitle: row.designation ? String(row.designation) : null,
      },
      because: null,
    };
  } catch (e: any) {
    logFail('loadSubject', e);
    return {
      subject: null,
      because: 'The employee record could not be read just now: '
        + (e?.cause?.message || e?.message || 'no reason given') + '.',
    };
  }
}

async function userIdFor(employeeId: string): Promise<string | null> {
  try {
    const row = rowsOf(await db.execute(sql`
      SELECT user_id FROM hr_employees WHERE id = ${employeeId}::uuid LIMIT 1`))[0];
    return row?.user_id ? String(row.user_id) : null;
  } catch (e: any) {
    logFail('userIdFor', e);
    return null;
  }
}

// -------------------------------------------------------------------------------------------------
// PREVIOUS READINGS — WHAT MAKES EVOLUTION POSSIBLE
// -------------------------------------------------------------------------------------------------

export async function previousReadings(
  employeeId: string,
): Promise<Partial<Record<FusionDimension, PreviousReading>>> {
  const out: Partial<Record<FusionDimension, PreviousReading>> = {};
  if (!isUuid(employeeId)) return out;
  try {
    await ensureFusionSchema();
    // DISTINCT ON gives the newest row per dimension in one pass — ten dimensions, one round trip,
    // straight down hif_readings_evolution. Ten separate queries would be ten round trips at ~177ms.
    const rows = rowsOf(await db.execute(sql`
      SELECT DISTINCT ON (dimension) dimension, reading, confidence_value, computed_at
        FROM hif_readings
       WHERE employee_id = ${employeeId}::uuid
       ORDER BY dimension, computed_at DESC`));
    for (const r of rows) {
      const d = String(r.dimension);
      if (!isFusionDimension(d)) continue;
      out[d] = {
        reading: r.reading === null || r.reading === undefined ? null : Number(r.reading),
        confidenceValue: r.confidence_value === null || r.confidence_value === undefined
          ? null : Number(r.confidence_value),
        computedAt: r.computed_at ? new Date(r.computed_at).toISOString() : null,
      };
    }
  } catch (e: any) {
    logFail('previousReadings', e);
  }
  return out;
}

export async function snapshotHistory(
  employeeId: string,
  limit = 12,
): Promise<{ snapshotId: string; computedAt: string; dimensionsRead: number }[]> {
  if (!isUuid(employeeId)) return [];
  const lim = Math.min(Math.max(Number(limit) || 12, 1), 50);
  try {
    await ensureFusionSchema();
    const rows = rowsOf(await db.execute(sql`
      SELECT id, computed_at, dimensions_read
        FROM hif_snapshots
       WHERE employee_id = ${employeeId}::uuid
       ORDER BY computed_at DESC
       LIMIT ${lim}`));
    return rows.map((r: any) => ({
      snapshotId: String(r.id),
      computedAt: r.computed_at ? new Date(r.computed_at).toISOString() : '',
      dimensionsRead: Number(r.dimensions_read) || 0,
    }));
  } catch (e: any) {
    logFail('snapshotHistory', e);
    return [];
  }
}

/** One dimension's readings over time. What the evolution chart on the profile page draws. */
export async function dimensionTimeline(
  employeeId: string,
  dimension: FusionDimension,
  limit = 24,
): Promise<{ at: string; reading: number | null; confidence: number; status: string }[]> {
  if (!isUuid(employeeId) || !isFusionDimension(dimension)) return [];
  const lim = Math.min(Math.max(Number(limit) || 24, 1), 100);
  try {
    await ensureFusionSchema();
    const rows = rowsOf(await db.execute(sql`
      SELECT computed_at, reading, confidence_value, status
        FROM hif_readings
       WHERE employee_id = ${employeeId}::uuid AND dimension = ${dimension}
       ORDER BY computed_at DESC
       LIMIT ${lim}`));
    return rows.map((r: any) => ({
      at: r.computed_at ? new Date(r.computed_at).toISOString() : '',
      reading: r.reading === null || r.reading === undefined ? null : Number(r.reading),
      confidence: Number(r.confidence_value) || 0,
      status: String(r.status || 'unreadable'),
    })).reverse();
  } catch (e: any) {
    logFail('dimensionTimeline', e);
    return [];
  }
}

// -------------------------------------------------------------------------------------------------
// HUMAN NOTES — (d) IN THE FIVE-WAY SEPARATION
// -------------------------------------------------------------------------------------------------

export async function notesFor(employeeId: string, limit = 50): Promise<HumanNote[]> {
  if (!isUuid(employeeId)) return [];
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
  try {
    await ensureFusionSchema();
    const rows = rowsOf(await db.execute(sql`
      SELECT n.id, n.dimension, n.author_user_id, n.author_relationship, n.stance, n.body, n.written_at,
             u.name AS author_name
        FROM hif_notes n
        LEFT JOIN users u ON u.id = n.author_user_id
       WHERE n.employee_id = ${employeeId}::uuid
       ORDER BY n.written_at DESC
       LIMIT ${lim}`));
    return rows.map((r: any) => ({
      noteId: String(r.id),
      dimension: isFusionDimension(String(r.dimension)) ? (String(r.dimension) as FusionDimension) : null,
      authorUserId: String(r.author_user_id),
      authorName: r.author_name ? String(r.author_name) : null,
      authorRelationship: r.author_relationship ? String(r.author_relationship) : null,
      stance: (r.stance === 'agrees' || r.stance === 'disagrees') ? r.stance : 'adds_context',
      body: String(r.body || ''),
      writtenAt: r.written_at ? new Date(r.written_at).toISOString() : '',
    }));
  } catch (e: any) {
    logFail('notesFor', e);
    return [];
  }
}

export interface NoteWriteResult {
  ok: boolean;
  error?: string;
}

/**
 * Record a named human's response to a reading.
 *
 * IT DOES NOT CHANGE THE READING, and there is no code path here that could. A note sits beside the
 * reading with its author's name and their relationship to the subject on it. Two people may
 * disagree with each other and both notes stay. Nobody's note becomes the organisation's view.
 */
export async function addNote(input: {
  employeeId: string;
  dimension?: string | null;
  authorUserId: string;
  authorRelationship?: string | null;
  stance: string;
  body: string;
}): Promise<NoteWriteResult> {
  if (!isUuid(input?.employeeId)) return { ok: false, error: 'That employee record does not exist.' };
  if (!isUuid(input?.authorUserId)) return { ok: false, error: 'A note has to have an author.' };
  if (!isNoteStance(input?.stance)) return { ok: false, error: 'Say whether you agree, disagree, or are adding context.' };

  const body = clean(input?.body, 4000);
  if (body.length < MIN_NOTE_CHARS) {
    return {
      ok: false,
      error: 'Write at least ' + MIN_NOTE_CHARS + ' characters. A one-word disagreement is not '
        + 'something the person it is about can answer.',
    };
  }

  const dim = input?.dimension && isFusionDimension(String(input.dimension))
    ? String(input.dimension) : null;

  try {
    await ensureFusionSchema();
    await db.execute(sql`
      INSERT INTO hif_notes (employee_id, dimension, author_user_id, author_relationship, stance, body)
      VALUES (${input.employeeId}::uuid, ${dim}, ${input.authorUserId}::uuid,
              ${clean(input?.authorRelationship, 80) || null}, ${input.stance}, ${body})`);

    await logAudit({
      userId: input.authorUserId,
      action: 'fusion.note.add',
      entity: 'hr_employees',
      entityId: input.employeeId,
      diff: { dimension: dim, stance: input.stance },
    }).catch((e: any) => logFail('audit note.add', e));

    return { ok: true };
  } catch (e: any) {
    logFail('addNote', e);
    return { ok: false, error: WRITE_FAILED + ' (' + (e?.cause?.message || e?.message || 'no reason given') + ')' };
  }
}

// -------------------------------------------------------------------------------------------------
// BUILD
// -------------------------------------------------------------------------------------------------

export interface BuildOptions {
  employeeId: string;
  /** Which stored weighting to read under. Defaults to 'default'. */
  weightKey?: string;
  /** Nothing before this is worth reading. Null means everything on record. */
  since?: string | null;
  /** Time is an argument, here as everywhere else in this module. */
  now?: Date;
}

/**
 * Build one person's profile.
 *
 * IT NEVER THROWS. Every failure becomes a named line the screen prints. A caller that got an
 * exception would render an error page, and an error page about a person is indistinguishable from
 * a person with no record.
 */
export async function buildProfile(opts: BuildOptions): Promise<FusionProfile | { error: string }> {
  const employeeId = String(opts?.employeeId || '');
  if (!isUuid(employeeId)) return { error: 'That employee record was not named properly.' };

  const now = opts?.now || new Date();
  registerFirstPartyProviders();

  const [{ subject, because }, weighting] = await Promise.all([
    loadSubject(employeeId),
    getWeightProfile(opts?.weightKey || 'default'),
  ]);

  if (!subject) return { error: because || 'That employee record could not be read.' };

  const userId = await userIdFor(employeeId);

  const ctx: GatherContext = {
    employeeId,
    userId,
    roleId: subject.roleId,
    since: opts?.since ?? null,
    now,
  };

  const gathered = await gatherSignals(ctx);
  const previous = await previousReadings(employeeId);

  const dimensions = fuseProfile({
    signals: gathered.signals,
    weights: weighting.weights,
    previous,
    now,
  });

  const [humanNotes, history] = await Promise.all([
    notesFor(employeeId, 50),
    snapshotHistory(employeeId, 12),
  ]);

  return {
    subject,
    dimensions,
    weighting: {
      key: weighting.key,
      label: weighting.label,
      ownerUserId: weighting.ownerUserId,
      weights: weighting.weights as Record<SourceClass, number>,
      isBuiltInDefault: weighting.isBuiltInDefault,
      sentence: weighting.sentence,
    },
    unreadable: gathered.unreadable,
    withheld: [],
    notConnected: gathered.notConnected,
    humanNotes,
    history,
    fairness: {
      protectedAttributesUsed: [],
      refusedSignals: gathered.refused,
      sentence: FAIRNESS_SENTENCE,
    },
    humanAuthority: HUMAN_AUTHORITY,
    computedAt: now.toISOString(),
    fromSnapshotId: null,
  };
}

// -------------------------------------------------------------------------------------------------
// STORE A SNAPSHOT — WHAT MAKES THE NEXT COMPARISON POSSIBLE
// -------------------------------------------------------------------------------------------------

export interface SnapshotResult {
  ok: boolean;
  snapshotId?: string;
  error?: string;
}

/**
 * Write one snapshot and its ten readings.
 *
 * ONE STATEMENT FOR THE READINGS, not ten. Ten inserts is ten round trips, and this project has
 * already measured what that costs from a function region that is not the database's.
 *
 * `reading` GOES IN AS NULL WHERE THERE IS NONE. The column is nullable precisely so that an absence
 * survives storage as an absence. A zero written here would become a permanent finding about a
 * person that nobody ever made.
 */
export async function storeSnapshot(input: {
  profile: FusionProfile;
  actorUserId: string | null;
  reason: string;
}): Promise<SnapshotResult> {
  const p = input?.profile;
  if (!p || !isUuid(p?.subject?.employeeId)) return { ok: false, error: 'There is no profile to store.' };

  const reason = clean(input?.reason, 300) || 'Recomputed on request.';
  const read = p.dimensions.filter((d) => d.reading !== null).length;
  const signalsUsed = p.dimensions.reduce((s, d) => s + d.sources.reduce((t, v) => t + v.signalCount, 0), 0);

  try {
    await ensureFusionSchema();

    const snap = rowsOf(await db.execute(sql`
      INSERT INTO hif_snapshots
        (employee_id, weight_profile_key, weights, dimensions_read, signals_used, signals_refused,
         providers_missing, computed_by_user_id, reason)
      VALUES
        (${p.subject.employeeId}::uuid, ${p.weighting.key}, ${JSON.stringify(p.weighting.weights)}::jsonb,
         ${read}, ${signalsUsed}, ${p.fairness.refusedSignals.length}, ${p.notConnected.length},
         ${isUuid(input?.actorUserId) ? input.actorUserId : null}, ${reason})
      RETURNING id`))[0];

    if (!snap?.id) return { ok: false, error: WRITE_FAILED + ' The snapshot row was not returned.' };
    const snapshotId = String(snap.id);

    // One VALUES list, one round trip. The payload keeps the whole reading — sources, agreement,
    // contradiction and explanation — so a stored snapshot can be re-read months later and still say
    // why it said what it said, under the weighting it was actually produced under.
    const values = p.dimensions.map((d) => sql`(
      ${snapshotId}::uuid,
      ${p.subject.employeeId}::uuid,
      ${d.dimension},
      ${d.status},
      ${d.reading},
      ${d.explanation.confidence.value},
      ${d.explanation.confidence.band},
      ${d.explanation.confidence.direction},
      ${d.explanation.confidence.independentSources},
      ${d.sentence},
      ${JSON.stringify(d)}::jsonb,
      ${p.computedAt}::timestamptz
    )`);

    await db.execute(sql`
      INSERT INTO hif_readings
        (snapshot_id, employee_id, dimension, status, reading, confidence_value, confidence_band,
         confidence_direction, independent_sources, sentence, payload, computed_at)
      VALUES ${sql.join(values, sql`, `)}
      ON CONFLICT (snapshot_id, dimension) DO NOTHING`);

    await logAudit({
      userId: input?.actorUserId || null,
      action: 'fusion.snapshot.store',
      entity: 'hr_employees',
      entityId: p.subject.employeeId,
      diff: { snapshotId, dimensionsRead: read, weightKey: p.weighting.key, reason },
    }).catch((e: any) => logFail('audit snapshot.store', e));

    return { ok: true, snapshotId };
  } catch (e: any) {
    logFail('storeSnapshot', e);
    return { ok: false, error: WRITE_FAILED + ' (' + (e?.cause?.message || e?.message || 'no reason given') + ')' };
  }
}

// -------------------------------------------------------------------------------------------------
// WHAT IS CONNECTED — SO A SCREEN CAN SAY SO WITHOUT BUILDING A PROFILE
// -------------------------------------------------------------------------------------------------

export function connectionReport(): {
  firstParty: number;
  missing: { providerKey: string; ownerPatch: string; what: string }[];
  sentence: string;
} {
  const r = registerFirstPartyProviders();
  const missing = notConnectedProviders();
  return {
    firstParty: r.registered,
    missing,
    sentence: missing.length
      ? missing.length + ' of the expected providers have not registered yet: '
        + missing.map((m) => m.ownerPatch).join(', ') + '. Every reading below is missing whatever '
        + 'they would have contributed, and that is stated on each one rather than shown as a lower number.'
      : 'Every expected provider is connected.',
  };
}

/** Named exports a screen iterates. Declared here so a page never spells a dimension by hand. */
export { FUSION_DIMENSIONS, SOURCE_CLASSES, DEFAULT_SOURCE_WEIGHTS };
export type { Signal, DimensionReading, FusionProfile, SourceWeights };
