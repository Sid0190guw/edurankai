// src/lib/foundational/engine.ts — THE FOUR ENTRY POINTS, AND EVERY GUARD IN FRONT OF THEM.
//
// =================================================================================================
// THE ORDER OF THE GUARDS IS THE DESIGN
// =================================================================================================
//
//   1. CAPABILITY   who is asking, and may they ask this at all
//   2. CONSENT      did the person agree, for THIS purpose, and have they since revoked
//   3. PROTECTION   can the input be encrypted before it is written — if not, it is not written
//   4. COMPUTE      pure arithmetic, no I/O, no clock
//   5. PERSIST      append-only; a recomputation is a new row, never an edit
//   6. AUDIT        who read or wrote what, recorded before the caller gets its answer
//   7. EMIT         intelligence.computation_completed, carrying identifiers and never values
//
// A refusal at any step returns a typed Refusal rather than throwing. That is deliberate: this
// engine sits behind HTTP handlers written by other patches, and a thrown exception in a handler
// that forgot a try/catch is a 500 where a 403 was meant.
//
// =================================================================================================
// WHAT NEVER LEAVES THIS FILE
// =================================================================================================
//
// The decrypted birth input. computeProfile() decrypts it, computes with it, and drops it; no return
// value from any exported function contains a birth date, a birth time or a birth place, and the
// stored `raw` block — which contains the normalised input and is therefore as sensitive as the
// input itself — is stripped by projectComputation() for every viewer without the technical
// capability. A caller that wants the input back has to go and ask the person.
//
// =================================================================================================
// ENCRYPTION IS A PRECONDITION, NOT A FEATURE FLAG
// =================================================================================================
//
// storeBirthInput() REFUSES when no key material is configured. It does not fall back to plaintext
// with a warning, because a warning in a log is not a control. The engine still computes without
// keys — computeFromInput() is pure and needs nothing — so an installation without keys can use the
// engine transiently and simply cannot persist a birth record, which is the correct trade.
import { createHash, createHmac } from 'node:crypto';
import { logAudit } from '@/lib/audit';
import { encryptField, decryptField } from '@/lib/crypto/envelope';
import { activeKeyId, getKeyMaterial } from '@/lib/crypto/keys';
import {
  ANGLE_DP, CALCULATION_METHOD_VERSION, CONSENT_PURPOSE, FOUNDATIONAL_CAPABILITIES,
  INTELLIGENCE_EVENTS, UNIT_DP, canonicalJson, decisionWordIn, hasCapabilities, maySeeTechnical,
  projectComputation, projectFactor, projectPeriod, reasonOf, rowsOf,
  type BirthInput, type ComputationReason, type ComputationRecord, type CyclePeriod,
  type FoundationalFactor, type MethodManifest, type NormalizedBirthInput, type RawComputation,
  type Refusal, type SubjectRef, type TimePeriodAnalysis, type ViewerContext,
} from './types';
import { InputError, VALID_FROM_YEAR, VALID_TO_YEAR, normalizeBirthInput } from './time';
import { AYANAMSA_J2000_DEG, AYANAMSA_MODEL, POINT_UNCERTAINTY_DEG, computeRaw } from './astronomy';
import { STRENGTH_WEIGHTS, deriveFactors } from './factors';
import { CYCLE_SEQUENCE, CYCLE_TOTAL_YEARS, CYCLE_YEAR_DAYS, analyzePeriods, computePeriods, cycleFactors } from './periods';
import { ensureFoundationalSchema } from './schema';
import { checkConsent, consentProviderName } from './consent';

const MOD = 'foundational-engine';

// -------------------------------------------------------------------------------------------------
// CONSTANTS. Declared before the functions that read them: `const` is not hoisted, and a handler
// reaching a later declaration has taken pages down on this project.
// -------------------------------------------------------------------------------------------------

/** How many computations a history listing returns before it starts asking for a narrower window. */
const MAX_HISTORY = 50;

const CAP = FOUNDATIONAL_CAPABILITIES;

/**
 * Where birth co-ordinates come from. Null means the default — HORIZON patch 01, falling back to
 * this engine's own encrypted store. Set once at start-up; setting it per request is a race.
 */
let birthInputSource: import('./horizon-bridge').BirthInputSource | null = null;

export function setBirthInputSource(source: import('./horizon-bridge').BirthInputSource | null): void {
  birthInputSource = source;
}

function refuse(code: Refusal['code'], reason: string): Refusal {
  return { ok: false, code, reason };
}

async function ctx() {
  const { db } = await import('@/lib/db');
  const { sql } = await import('drizzle-orm');
  return { db, sql };
}

// =================================================================================================
// THE METHOD MANIFEST — how a third party checks a result without reading this code
// =================================================================================================

export function describeMethod(): MethodManifest {
  return {
    engine: 'foundational-personal-computation',
    version: CALCULATION_METHOD_VERSION,
    anglePrecisionDp: ANGLE_DP,
    unitPrecisionDp: UNIT_DP,
    ayanamsaModel: AYANAMSA_MODEL,
    ayanamsaAtJ2000Deg: AYANAMSA_J2000_DEG,
    houseModel: 'whole-sector, counted from the ascending sector',
    cycleYearDays: CYCLE_YEAR_DAYS,
    cycleTotalYears: CYCLE_TOTAL_YEARS,
    strengthWeights: { ...STRENGTH_WEIGHTS },
    accuracy: {
      ...Object.fromEntries(Object.entries(POINT_UNCERTAINTY_DEG).map(([k, v]) => [k, `${v} deg`])),
      ascendant: 'dominated by recorded birth-time precision, about 0.25 deg per minute of error',
      notApplied: 'nutation, annual aberration and light-time are not applied; each is below the planetary model error',
      reproducibility: `identical to ${ANGLE_DP} decimal places of a degree for the same input and version`,
    },
    validRange: { fromYear: VALID_FROM_YEAR, toYear: VALID_TO_YEAR },
  };
}

// =================================================================================================
// HASHING
// =================================================================================================

/**
 * Hash of the normalised input.
 *
 * KEYED WHEN A KEY EXISTS. A plain digest of a birth date, time and place is not an anonymous
 * identifier: the space of plausible inputs is small enough to enumerate, so an unkeyed hash column
 * is a lookup table waiting for somebody with read access to the database and an afternoon. The
 * active data key is used as an HMAC key, which makes the column useless to anybody who does not
 * already hold the key that decrypts the row next to it.
 *
 * Without key material — a transient computation on an installation that stores nothing — it falls
 * back to a plain digest, and nothing is written anywhere.
 */
export function inputHashOf(input: NormalizedBirthInput): string {
  const canonical = canonicalJson(input);
  try {
    const key = getKeyMaterial(activeKeyId());
    return 'h1:' + createHmac('sha256', key).update(canonical, 'utf8').digest('hex');
  } catch {
    return 'h0:' + createHash('sha256').update(canonical, 'utf8').digest('hex');
  }
}

/**
 * Hash of the output. EXCLUDES computed_at everywhere, so re-running the same input on a different
 * day produces the same hash — which is exactly the property that lets recomputeProfile() tell a
 * genuine change from a pointless rewrite.
 */
export function outputHashOf(factors: FoundationalFactor[], periods: CyclePeriod[]): string {
  const f = factors.map((x) => ({ ...x, computed_at: undefined }));
  const p = periods.map((x) => ({ ...x }));
  return createHash('sha256').update(canonicalJson({ f, p }), 'utf8').digest('hex');
}

// =================================================================================================
// THE PURE PATH — no database, no clock, no permissions
// =================================================================================================

export interface ComputedProfile {
  normalized: NormalizedBirthInput;
  raw: RawComputation;
  factors: FoundationalFactor[];
  periods: { level1: CyclePeriod[]; level2: CyclePeriod[] };
  inputHash: string;
  outputHash: string;
  method: MethodManifest;
}

/**
 * Positions, factors and periods for one birth input. Pure, deterministic, and callable with no
 * database at all — which is what makes every one of them testable.
 *
 * `computedAt` is a parameter rather than a call to the clock, so two runs an hour apart produce
 * identical objects. Every guard against fabricated determinism in this engine depends on that.
 */
export function computeFromInput(input: BirthInput, computedAt: string): ComputedProfile {
  const normalized = normalizeBirthInput(input);
  const raw = computeRaw(normalized);
  const factors = deriveFactors(raw, { computedAt });
  const { level1, level2 } = computePeriods(raw);
  const cycles = cycleFactors(raw, level1, { computedAt });
  const all = [...factors, ...cycles];

  // THE COMPUTATION LAYER CHECKS ITSELF. A factor that has learned to speak in decisions is a bug in
  // this file, not a policy problem for whoever renders it, and it is cheaper to fail here than to
  // discover it on a screen an applicant is looking at.
  for (const f of all) {
    for (const text of [f.code, f.label, f.value]) {
      const word = decisionWordIn(text);
      if (word) {
        throw new Error(`factor ${f.factor_id} contains the decision word '${word}' in '${text}'`);
      }
    }
  }

  return {
    normalized,
    raw,
    factors: all,
    periods: { level1, level2 },
    inputHash: inputHashOf(normalized),
    outputHash: outputHashOf(all, [...level1, ...level2]),
    method: describeMethod(),
  };
}

// =================================================================================================
// BIRTH INPUT STORAGE
// =================================================================================================

function aadFor(subject: SubjectRef): string {
  // Binding the ciphertext to the subject means a row copied onto another person's record fails to
  // decrypt rather than quietly describing the wrong human being.
  return `fpc:${subject.kind}:${subject.id}`;
}

export interface StoreInputResult { ok: true; inputHash: string; }

/**
 * Store or correct a subject's birth input. Requires the manageInput capability AND consent.
 *
 * The row is UPSERTed, because a birth time recorded wrongly must be correctable — but every
 * computation that used the old value stays exactly where it was, which is why computations are a
 * separate append-only table and not a column on this one.
 */
export async function storeBirthInput(args: {
  subject: SubjectRef;
  input: BirthInput;
  viewer: ViewerContext;
}): Promise<StoreInputResult | Refusal> {
  const { subject, input, viewer } = args;
  if (!hasCapabilities(viewer, CAP.manageInput)) {
    return refuse('not_permitted', `capability ${CAP.manageInput} is required to store a birth input`);
  }

  const consent = await checkConsent(subject);
  if (!consent.granted) {
    return refuse('no_consent', `no active consent for purpose '${CONSENT_PURPOSE}' (register: ${consent.source})`);
  }

  let normalized: NormalizedBirthInput;
  try {
    normalized = normalizeBirthInput(input);
  } catch (e: any) {
    if (e instanceof InputError) return refuse('input_invalid', e.message);
    return refuse('input_invalid', reasonOf(e));
  }

  let ciphertext: unknown;
  let keyId: string;
  try {
    keyId = activeKeyId();
    ciphertext = encryptField(JSON.stringify(normalized), aadFor(subject));
  } catch (e: any) {
    return refuse(
      'input_unprotected',
      `birth input cannot be encrypted and will not be stored in the clear: ${reasonOf(e)}`,
    );
  }

  const inputHash = inputHashOf(normalized);
  try {
    await ensureFoundationalSchema();
    const { db, sql } = await ctx();
    await db.execute(sql`
      INSERT INTO fpc_subject_input
        (subject_kind, subject_id, ciphertext, key_id, input_hash, time_precision, created_by, updated_by)
      VALUES
        (${subject.kind}, ${subject.id}, ${JSON.stringify(ciphertext)}::jsonb, ${keyId}, ${inputHash},
         ${normalized.timePrecision}, ${viewer.userId}, ${viewer.userId})
      ON CONFLICT (subject_kind, subject_id) DO UPDATE
        SET ciphertext = EXCLUDED.ciphertext,
            key_id     = EXCLUDED.key_id,
            input_hash = EXCLUDED.input_hash,
            time_precision = EXCLUDED.time_precision,
            updated_at = NOW(),
            updated_by = EXCLUDED.updated_by,
            erased_at  = NULL,
            erased_by  = NULL
    `);
  } catch (e: any) {
    const reason = reasonOf(e);
    console.error('[' + MOD + '] storeBirthInput failed: ' + reason);
    return refuse('storage_failed', reason);
  }

  // The audit row records THAT a birth input was written and by whom. It does not record the input:
  // an audit log is read by more people than the table it describes.
  await logAudit({
    userId: viewer.userId,
    action: 'foundational.input.stored',
    entity: 'fpc_subject_input',
    entityId: subject.id,
    diff: { subjectKind: subject.kind, inputHash, timePrecision: normalized.timePrecision },
    ipAddress: viewer.ipAddress ?? undefined,
  });

  return { ok: true, inputHash };
}

/**
 * Resolve a subject's birth co-ordinates.
 *
 * HORIZON PATCH 01 FIRST, ALWAYS. That patch owns hzn_personal_foundation and its boundary is
 * explicit: nothing outside it reads the ciphertext. Reading through it means the person's access
 * log, consent check and purpose limitation all happen in the module that owns them, and this engine
 * keeps no second copy of a date of birth to erase and forget about.
 *
 * The local store is reached only when patch 01 is not installed or holds nothing for this subject.
 * An `incomplete` answer — a record with no time, or no coordinates — is NOT a reason to fall
 * through to a second store and hope it has more: it is the honest state of that person's record and
 * it is returned as a refusal naming the missing field.
 */
async function resolveBirthInput(
  subject: SubjectRef,
  actorUserId: string | null,
): Promise<{ ok: true; input: BirthInput; source: string } | Refusal> {
  try {
    const { horizonBirthInputSource } = await import('./horizon-bridge');
    const source = birthInputSource || horizonBirthInputSource;
    const res = await source.load(subject, actorUserId);
    if (res.ok) return { ok: true, input: res.input, source: res.source };
    if (res.code === 'incomplete') return refuse('input_invalid', res.reason);
    if (res.code === 'refused') return refuse('no_consent', res.reason);
    // 'not_available' — patch 01 is absent or holds nothing. Try this engine's own store.
  } catch (e: any) {
    console.error('[' + MOD + '] upstream birth input source failed: ' + reasonOf(e));
  }

  let normalized: NormalizedBirthInput | null = null;
  try {
    normalized = await loadBirthInput(subject);
  } catch (e: any) {
    return refuse('storage_failed', `stored birth input could not be read: ${reasonOf(e)}`);
  }
  if (!normalized) return refuse('input_missing', 'no birth input is available for this subject');
  return {
    ok: true,
    source: 'fpc_subject_input',
    input: {
      date: normalized.localDate,
      time: normalized.localTime,
      utcOffsetMinutes: normalized.utcOffsetMinutes,
      timeZone: normalized.timeZone,
      location: normalized.location,
      timePrecision: normalized.timePrecision,
    },
  };
}

/** Read the stored input back. INTERNAL — nothing exported returns its plaintext to a caller. */
async function loadBirthInput(subject: SubjectRef): Promise<NormalizedBirthInput | null> {
  await ensureFoundationalSchema();
  const { db, sql } = await ctx();
  const rows = rowsOf(await db.execute(sql`
    SELECT ciphertext, erased_at
      FROM fpc_subject_input
     WHERE subject_kind = ${subject.kind} AND subject_id = ${subject.id}
     LIMIT 1
  `));
  const row = rows[0];
  if (!row || row.erased_at) return null;
  const env = typeof row.ciphertext === 'string' ? JSON.parse(row.ciphertext) : row.ciphertext;
  return JSON.parse(decryptField(env)) as NormalizedBirthInput;
}

/**
 * Erase a subject's birth input.
 *
 * The ciphertext is overwritten, not merely flagged — an erasure that leaves the data recoverable is
 * not an erasure. Past computations are left in place: they contain derived factors and the raw
 * block, so the caller is told, in the return value, that a full erasure also means erasing those.
 */
export async function eraseBirthInput(args: { subject: SubjectRef; viewer: ViewerContext; alsoComputations?: boolean }): Promise<{ ok: true; computationsRemoved: number } | Refusal> {
  const { subject, viewer } = args;
  if (!hasCapabilities(viewer, CAP.manageInput)) {
    return refuse('not_permitted', `capability ${CAP.manageInput} is required to erase a birth input`);
  }
  try {
    await ensureFoundationalSchema();
    const { db, sql } = await ctx();
    await db.execute(sql`
      UPDATE fpc_subject_input
         SET ciphertext = '{}'::jsonb, input_hash = '', erased_at = NOW(), erased_by = ${viewer.userId}
       WHERE subject_kind = ${subject.kind} AND subject_id = ${subject.id}
    `);
    let removed = 0;
    if (args.alsoComputations) {
      const ids = rowsOf(await db.execute(sql`
        SELECT id FROM fpc_computation WHERE subject_kind = ${subject.kind} AND subject_id = ${subject.id}
      `)).map((r: any) => r.id);
      removed = ids.length;
      await db.execute(sql`DELETE FROM fpc_factor  WHERE subject_kind = ${subject.kind} AND subject_id = ${subject.id}`);
      await db.execute(sql`DELETE FROM fpc_period  WHERE subject_kind = ${subject.kind} AND subject_id = ${subject.id}`);
      await db.execute(sql`DELETE FROM fpc_computation WHERE subject_kind = ${subject.kind} AND subject_id = ${subject.id}`);
    }
    await logAudit({
      userId: viewer.userId,
      action: 'foundational.input.erased',
      entity: 'fpc_subject_input',
      entityId: subject.id,
      diff: { subjectKind: subject.kind, computationsRemoved: removed },
      ipAddress: viewer.ipAddress ?? undefined,
    });
    return { ok: true, computationsRemoved: removed };
  } catch (e: any) {
    const reason = reasonOf(e);
    console.error('[' + MOD + '] eraseBirthInput failed: ' + reason);
    return refuse('storage_failed', reason);
  }
}

// =================================================================================================
// PERSISTENCE OF A COMPUTATION
// =================================================================================================

async function persist(args: {
  subject: SubjectRef;
  profile: ComputedProfile;
  reason: ComputationReason;
  computedAt: string;
  viewer: ViewerContext;
}): Promise<{ id: string } | Refusal> {
  const { subject, profile, reason, computedAt, viewer } = args;
  const periods = [...profile.periods.level1, ...profile.periods.level2];
  try {
    await ensureFoundationalSchema();
    const { db, sql } = await ctx();

    const inserted = rowsOf(await db.execute(sql`
      INSERT INTO fpc_computation
        (subject_kind, subject_id, method_version, input_hash, output_hash, reason,
         factor_count, period_count, method, raw, computed_at, computed_by)
      VALUES
        (${subject.kind}, ${subject.id}, ${CALCULATION_METHOD_VERSION}, ${profile.inputHash},
         ${profile.outputHash}, ${reason}, ${profile.factors.length}, ${periods.length},
         ${JSON.stringify(profile.method)}::jsonb, ${JSON.stringify(profile.raw)}::jsonb,
         ${computedAt}::timestamptz, ${viewer.userId})
      RETURNING id
    `));
    const id = inserted[0]?.id;
    if (!id) return refuse('storage_failed', 'computation insert returned no id');

    // Factors and periods go in as two multi-row statements rather than several hundred round trips.
    // At about 177ms each from the deployed function, a row-at-a-time loop here would cost a minute.
    if (profile.factors.length) {
      const values = profile.factors.map((f) => sql`(
        ${id}::uuid, ${subject.kind}, ${subject.id}, ${f.factor_id}, ${f.category}, ${f.code},
        ${f.label}, ${f.value}, ${f.numeric_value}, ${f.strength}, ${f.confidence},
        ${f.calculation_method_version}, ${JSON.stringify(f.source_inputs)}::jsonb,
        ${JSON.stringify(f.evidence)}::jsonb,
        ${f.components ? JSON.stringify(f.components) : null}::jsonb,
        ${f.technical ? JSON.stringify(f.technical) : null}::jsonb,
        ${f.computed_at}::timestamptz
      )`);
      await db.execute(sql`
        INSERT INTO fpc_factor
          (computation_id, subject_kind, subject_id, factor_id, category, code, label, value_text,
           numeric_value, strength, confidence, method_version, source_inputs, evidence, components,
           technical, computed_at)
        VALUES ${sql.join(values, sql`, `)}
        ON CONFLICT (computation_id, factor_id) DO NOTHING
      `);
    }

    if (periods.length) {
      const values = periods.map((p) => sql`(
        ${id}::uuid, ${subject.kind}, ${subject.id}, ${p.period_id}, ${p.level}, ${p.ruler_code},
        ${JSON.stringify(p.chain)}::jsonb, ${p.starts_at}::timestamptz, ${p.ends_at}::timestamptz,
        ${p.length_days}, ${p.calculation_method_version},
        ${p.technical ? JSON.stringify(p.technical) : null}::jsonb
      )`);
      await db.execute(sql`
        INSERT INTO fpc_period
          (computation_id, subject_kind, subject_id, period_id, level, ruler_code, chain,
           starts_at, ends_at, length_days, method_version, technical)
        VALUES ${sql.join(values, sql`, `)}
        ON CONFLICT (computation_id, period_id) DO NOTHING
      `);
    }

    return { id };
  } catch (e: any) {
    const reason2 = reasonOf(e);
    console.error('[' + MOD + '] persist failed: ' + reason2);
    return refuse('storage_failed', reason2);
  }
}

/**
 * Announce a completed computation, on HORIZON's durable outbox rather than the in-process bus.
 *
 * IDENTIFIERS AND COUNTS ONLY. No factor, no value, no position, and above all no birth data — an
 * event payload is the most widely-copied object in any system, and a subscriber that needs the
 * factors can ask for them through getComputationByVersion(), where the capability check is.
 *
 * The emit cannot break the computation that already committed: a failure is logged with the real
 * reason and the function returns. The computation row is itself the durable record, so a missed
 * event is recoverable by querying for computations a subscriber has not processed.
 */
async function announce(args: {
  subject: SubjectRef;
  computationId: string;
  outcome: 'succeeded' | 'failed' | 'refused';
  detail?: string | null;
  durationMs?: number | null;
  actorId: string | null;
}): Promise<void> {
  const { emitComputationCompleted } = await import('./horizon-bridge');
  const out = await emitComputationCompleted({
    subject: args.subject,
    computationId: args.computationId,
    engineId: 'foundational-personal-computation',
    engineVersion: CALCULATION_METHOD_VERSION,
    outcome: args.outcome,
    detail: args.detail ?? null,
    durationMs: args.durationMs ?? null,
    actorUserId: args.actorId,
  });
  if (!out.ok) {
    console.error('[' + MOD + '] ' + INTELLIGENCE_EVENTS.computationCompleted
      + ' not recorded: ' + out.errors.join('; '));
  }
}

// =================================================================================================
// ENTRY POINT 1 — computeProfile
// =================================================================================================

export interface ComputeResult {
  ok: true;
  computation: ComputationRecord;
  factors: FoundationalFactor[];
  periods: CyclePeriod[];
  /** True when a recomputation produced exactly what was already stored, so nothing was written. */
  unchanged: boolean;
}

/**
 * Compute (or re-compute) a subject's factors and store the result.
 *
 * `input` is optional: supplied, it is stored first and then used; omitted, the stored input is
 * decrypted and used. Supplying an input without the manageInput capability is refused, because
 * "compute this for me from data I brought" is a write to the person's record whatever it is called.
 */
export async function computeProfile(args: {
  subject: SubjectRef;
  viewer: ViewerContext;
  input?: BirthInput;
  reason?: ComputationReason;
  /** Supplied by the caller so a computation is reproducible and testable. Defaults to now. */
  now?: Date;
  /** Skip the write and return the result only. Nothing is stored, nothing is emitted. */
  transient?: boolean;
}): Promise<ComputeResult | Refusal> {
  const { subject, viewer } = args;
  if (!hasCapabilities(viewer, CAP.compute)) {
    return refuse('not_permitted', `capability ${CAP.compute} is required to run a computation`);
  }

  const consent = await checkConsent(subject);
  if (!consent.granted) {
    return refuse('no_consent', `no active consent for purpose '${CONSENT_PURPOSE}' (register: ${consentProviderName()})`);
  }

  if (args.input && !hasCapabilities(viewer, CAP.manageInput)) {
    return refuse('not_permitted', `supplying a birth input requires ${CAP.manageInput}`);
  }

  const computedAt = (args.now || new Date()).toISOString();

  // Resolve the input: what was supplied, else what is stored.
  let birth: BirthInput;
  if (args.input) {
    if (!args.transient) {
      const stored = await storeBirthInput({ subject, input: args.input, viewer });
      if (!('ok' in stored) || stored.ok !== true) return stored as Refusal;
    }
    birth = args.input;
  } else {
    const resolved = await resolveBirthInput(subject, viewer.userId);
    if (!('input' in resolved)) return resolved as Refusal;
    birth = resolved.input;
  }

  let profile: ComputedProfile;
  try {
    profile = computeFromInput(birth, computedAt);
  } catch (e: any) {
    if (e instanceof InputError) return refuse('input_invalid', e.message);
    return refuse('input_invalid', reasonOf(e));
  }

  const allPeriods = [...profile.periods.level1, ...profile.periods.level2];
  const allowTechnical = maySeeTechnical(viewer);

  const record = (id: string, reason: ComputationReason): ComputationRecord => ({
    id,
    subject,
    calculation_method_version: CALCULATION_METHOD_VERSION,
    input_hash: profile.inputHash,
    output_hash: profile.outputHash,
    reason,
    computed_at: computedAt,
    computed_by: viewer.userId,
    factor_count: profile.factors.length,
    period_count: allPeriods.length,
    raw: profile.raw,
    method: profile.method,
  });

  if (args.transient) {
    return {
      ok: true,
      computation: projectComputation(record('transient', args.reason || 'initial'), allowTechnical),
      factors: profile.factors.map((f) => projectFactor(f, allowTechnical)),
      periods: allPeriods.map((p) => projectPeriod(p, allowTechnical)),
      unchanged: false,
    };
  }

  const reason: ComputationReason = args.reason || 'initial';
  const saved = await persist({ subject, profile, reason, computedAt, viewer });
  if (!('id' in saved)) return saved as Refusal;

  await logAudit({
    userId: viewer.userId,
    action: 'foundational.computation.created',
    entity: 'fpc_computation',
    entityId: saved.id,
    diff: {
      subjectKind: subject.kind, subjectId: subject.id, reason,
      methodVersion: CALCULATION_METHOD_VERSION, outputHash: profile.outputHash,
      factorCount: profile.factors.length, periodCount: allPeriods.length,
    },
    ipAddress: viewer.ipAddress ?? undefined,
  });

  await announce({
    subject,
    computationId: saved.id,
    outcome: 'succeeded',
    detail: `${profile.factors.length} factors, ${allPeriods.length} periods, reason ${reason}`,
    actorId: viewer.userId,
  });

  return {
    ok: true,
    computation: projectComputation(record(saved.id, reason), allowTechnical),
    factors: profile.factors.map((f) => projectFactor(f, allowTechnical)),
    periods: allPeriods.map((p) => projectPeriod(p, allowTechnical)),
    unchanged: false,
  };
}

// =================================================================================================
// ENTRY POINT 2 — recomputeProfile
// =================================================================================================

/**
 * Re-run a subject's computation from the stored input.
 *
 * WRITES ONLY WHEN THE ANSWER CHANGED. A nightly recomputation of ten thousand people whose inputs
 * have not moved would otherwise add ten thousand identical rows a night, and the history would stop
 * being readable — which is the only reason the history exists. When the output hash and the method
 * version both match the latest stored computation, this returns that computation with
 * `unchanged: true` and records an audit line saying the check ran.
 */
export async function recomputeProfile(args: {
  subject: SubjectRef;
  viewer: ViewerContext;
  reason?: ComputationReason;
  now?: Date;
  /** Write a new row even when nothing changed. For a deliberate re-attestation, not for a cron. */
  force?: boolean;
}): Promise<ComputeResult | Refusal> {
  const { subject, viewer } = args;
  if (!hasCapabilities(viewer, CAP.compute)) {
    return refuse('not_permitted', `capability ${CAP.compute} is required to run a computation`);
  }

  const latest = await latestComputationRow(subject);
  const result = await computeProfile({
    subject,
    viewer,
    reason: args.reason || 'recompute',
    now: args.now,
    transient: true,
  });
  if (!('ok' in result) || result.ok !== true) return result as Refusal;

  const same = !!latest
    && latest.output_hash === result.computation.output_hash
    && latest.method_version === CALCULATION_METHOD_VERSION;

  if (same && !args.force) {
    await logAudit({
      userId: viewer.userId,
      action: 'foundational.computation.unchanged',
      entity: 'fpc_computation',
      entityId: latest.id,
      diff: { subjectKind: subject.kind, subjectId: subject.id, outputHash: latest.output_hash },
      ipAddress: viewer.ipAddress ?? undefined,
    });
    const allowTechnical = maySeeTechnical(viewer);
    return {
      ok: true,
      computation: projectComputation({ ...result.computation, id: latest.id, computed_at: new Date(latest.computed_at).toISOString() }, allowTechnical),
      factors: result.factors,
      periods: result.periods,
      unchanged: true,
    };
  }

  return computeProfile({
    subject,
    viewer,
    reason: args.reason || (latest ? 'recompute' : 'initial'),
    now: args.now,
  });
}

async function latestComputationRow(subject: SubjectRef, methodVersion?: string): Promise<any | null> {
  try {
    await ensureFoundationalSchema();
    const { db, sql } = await ctx();
    const rows = rowsOf(await db.execute(sql`
      SELECT * FROM fpc_computation
       WHERE subject_kind = ${subject.kind} AND subject_id = ${subject.id}
         AND (${methodVersion ?? null}::text IS NULL OR method_version = ${methodVersion ?? null})
       ORDER BY computed_at DESC
       LIMIT 1
    `));
    return rows[0] || null;
  } catch (e: any) {
    console.error('[' + MOD + '] latestComputationRow failed: ' + reasonOf(e));
    return null;
  }
}

// =================================================================================================
// ENTRY POINT 3 — getComputationByVersion
// =================================================================================================

export interface ComputationView {
  ok: true;
  computation: ComputationRecord;
  factors: FoundationalFactor[];
  periods: CyclePeriod[];
}

/**
 * Read one stored computation: the latest under a method version, or an exact one by id.
 *
 * Every successful read writes an audit row BEFORE returning. Reading somebody's personal
 * computation is an event in that person's record, and a read that is not logged did not happen as
 * far as anybody reviewing the system later is concerned.
 */
export async function getComputationByVersion(args: {
  subject: SubjectRef;
  viewer: ViewerContext;
  /** Omit for the latest of any version. */
  methodVersion?: string;
  /** Wins over methodVersion when supplied. */
  computationId?: string;
  /** Periods are many; omit them when only factors are wanted. */
  includePeriods?: boolean;
}): Promise<ComputationView | Refusal> {
  const { subject, viewer } = args;
  if (!hasCapabilities(viewer, CAP.read)) {
    return refuse('not_permitted', `capability ${CAP.read} is required to read a computation`);
  }

  // Consent is checked on READ as well as on write. Revocation has to reach the screens, not only
  // the engine — otherwise a person withdraws consent and every existing surface carries on.
  const consent = await checkConsent(subject);
  if (!consent.granted) {
    return refuse('no_consent', `no active consent for purpose '${CONSENT_PURPOSE}' (register: ${consentProviderName()})`);
  }

  const allowTechnical = maySeeTechnical(viewer);
  try {
    await ensureFoundationalSchema();
    const { db, sql } = await ctx();

    const rows = args.computationId
      ? rowsOf(await db.execute(sql`
          SELECT * FROM fpc_computation
           WHERE id = ${args.computationId}::uuid
             AND subject_kind = ${subject.kind} AND subject_id = ${subject.id}
           LIMIT 1
        `))
      : rowsOf(await db.execute(sql`
          SELECT * FROM fpc_computation
           WHERE subject_kind = ${subject.kind} AND subject_id = ${subject.id}
             AND (${args.methodVersion ?? null}::text IS NULL OR method_version = ${args.methodVersion ?? null})
           ORDER BY computed_at DESC
           LIMIT 1
        `));

    const row = rows[0];
    if (!row) return refuse('not_found', 'no stored computation matches');

    const factorRows = rowsOf(await db.execute(sql`
      SELECT * FROM fpc_factor WHERE computation_id = ${row.id}::uuid ORDER BY category, code, factor_id
    `));
    const periodRows = args.includePeriods === false ? [] : rowsOf(await db.execute(sql`
      SELECT * FROM fpc_period WHERE computation_id = ${row.id}::uuid ORDER BY level, starts_at
    `));

    const factors: FoundationalFactor[] = factorRows.map((r: any) => projectFactor({
      factor_id: r.factor_id,
      category: r.category,
      code: r.code,
      label: r.label,
      value: r.value_text,
      numeric_value: r.numeric_value === null ? null : Number(r.numeric_value),
      strength: Number(r.strength),
      confidence: Number(r.confidence),
      calculation_method_version: r.method_version,
      source_inputs: r.source_inputs || [],
      evidence: r.evidence || [],
      components: r.components || undefined,
      technical: r.technical || null,
      computed_at: new Date(r.computed_at).toISOString(),
    }, allowTechnical));

    const periods: CyclePeriod[] = periodRows.map((r: any) => projectPeriod({
      period_id: r.period_id,
      level: r.level,
      ruler_code: r.ruler_code,
      chain: r.chain || [],
      starts_at: new Date(r.starts_at).toISOString(),
      ends_at: new Date(r.ends_at).toISOString(),
      length_days: Number(r.length_days),
      calculation_method_version: r.method_version,
      technical: r.technical || null,
    }, allowTechnical));

    await logAudit({
      userId: viewer.userId,
      action: 'foundational.computation.read',
      entity: 'fpc_computation',
      entityId: row.id,
      diff: { subjectKind: subject.kind, subjectId: subject.id, technical: allowTechnical },
      ipAddress: viewer.ipAddress ?? undefined,
    });

    return {
      ok: true,
      computation: projectComputation({
        id: row.id,
        subject,
        calculation_method_version: row.method_version,
        input_hash: row.input_hash,
        output_hash: row.output_hash,
        reason: row.reason,
        computed_at: new Date(row.computed_at).toISOString(),
        computed_by: row.computed_by,
        factor_count: row.factor_count,
        period_count: row.period_count,
        raw: row.raw || null,
        method: row.method || describeMethod(),
      }, allowTechnical),
      factors,
      periods,
    };
  } catch (e: any) {
    const reason = reasonOf(e);
    console.error('[' + MOD + '] getComputationByVersion failed: ' + reason);
    return refuse('storage_failed', reason);
  }
}

/** Every stored computation for a subject, newest first. Headers only — no factors, no raw block. */
export async function listComputations(args: {
  subject: SubjectRef;
  viewer: ViewerContext;
  limit?: number;
}): Promise<{ ok: true; computations: Array<Pick<ComputationRecord, 'id' | 'calculation_method_version' | 'output_hash' | 'reason' | 'computed_at' | 'computed_by' | 'factor_count' | 'period_count'>> } | Refusal> {
  const { subject, viewer } = args;
  if (!hasCapabilities(viewer, CAP.read)) {
    return refuse('not_permitted', `capability ${CAP.read} is required to list computations`);
  }
  try {
    await ensureFoundationalSchema();
    const { db, sql } = await ctx();
    const limit = Math.min(MAX_HISTORY, Math.max(1, args.limit || MAX_HISTORY));
    const rows = rowsOf(await db.execute(sql`
      SELECT id, method_version, output_hash, reason, computed_at, computed_by, factor_count, period_count
        FROM fpc_computation
       WHERE subject_kind = ${subject.kind} AND subject_id = ${subject.id}
       ORDER BY computed_at DESC
       LIMIT ${limit}
    `));
    return {
      ok: true,
      computations: rows.map((r: any) => ({
        id: r.id,
        calculation_method_version: r.method_version,
        output_hash: r.output_hash,
        reason: r.reason,
        computed_at: new Date(r.computed_at).toISOString(),
        computed_by: r.computed_by,
        factor_count: r.factor_count,
        period_count: r.period_count,
      })),
    };
  } catch (e: any) {
    const reason = reasonOf(e);
    console.error('[' + MOD + '] listComputations failed: ' + reason);
    return refuse('storage_failed', reason);
  }
}

// =================================================================================================
// ENTRY POINT 4 — getTimePeriodAnalysis
// =================================================================================================

/**
 * Current, upcoming and long-horizon periods for a subject.
 *
 * Recomputed from the stored computation's own raw block rather than read out of fpc_period, for one
 * reason: fpc_period stores levels 1 and 2, and level 3 is generated on demand. Deriving all three
 * from the same seed guarantees the three levels agree with each other, which a mixed read could
 * not. fpc_period remains the queryable index other patches join against.
 */
export async function getTimePeriodAnalysis(args: {
  subject: SubjectRef;
  viewer: ViewerContext;
  asOf?: Date;
  from?: Date;
  to?: Date;
  horizonYears?: number;
  includeLevel3?: boolean;
  computationId?: string;
}): Promise<{ ok: true; analysis: TimePeriodAnalysis } | Refusal> {
  const { subject, viewer } = args;
  if (!hasCapabilities(viewer, CAP.read)) {
    return refuse('not_permitted', `capability ${CAP.read} is required to read a time-period analysis`);
  }

  const consent = await checkConsent(subject);
  if (!consent.granted) {
    return refuse('no_consent', `no active consent for purpose '${CONSENT_PURPOSE}' (register: ${consentProviderName()})`);
  }

  try {
    await ensureFoundationalSchema();
    const { db, sql } = await ctx();
    const rows = args.computationId
      ? rowsOf(await db.execute(sql`
          SELECT id, raw, method_version FROM fpc_computation
           WHERE id = ${args.computationId}::uuid AND subject_kind = ${subject.kind} AND subject_id = ${subject.id}
           LIMIT 1
        `))
      : rowsOf(await db.execute(sql`
          SELECT id, raw, method_version FROM fpc_computation
           WHERE subject_kind = ${subject.kind} AND subject_id = ${subject.id}
           ORDER BY computed_at DESC LIMIT 1
        `));
    const row = rows[0];
    if (!row) return refuse('not_found', 'no stored computation for this subject');

    const raw = (typeof row.raw === 'string' ? JSON.parse(row.raw) : row.raw) as RawComputation;
    if (!raw?.points?.B02) return refuse('not_found', 'stored computation has no usable position set');

    const allowTechnical = maySeeTechnical(viewer);
    const analysis = analyzePeriods(raw, {
      subject,
      computationId: row.id,
      asOf: args.asOf || new Date(),
      from: args.from,
      to: args.to,
      horizonYears: args.horizonYears,
      includeLevel3: args.includeLevel3,
      version: row.method_version,
    });

    await logAudit({
      userId: viewer.userId,
      action: 'foundational.periods.read',
      entity: 'fpc_computation',
      entityId: row.id,
      diff: { subjectKind: subject.kind, subjectId: subject.id, technical: allowTechnical },
      ipAddress: viewer.ipAddress ?? undefined,
    });

    return {
      ok: true,
      analysis: {
        ...analysis,
        current: analysis.current.map((p) => ({ ...projectPeriod(p, allowTechnical), fraction_elapsed: p.fraction_elapsed })),
        upcoming: analysis.upcoming.map((p) => projectPeriod(p, allowTechnical)),
        horizon: analysis.horizon.map((p) => projectPeriod(p, allowTechnical)),
      },
    };
  } catch (e: any) {
    const reason = reasonOf(e);
    console.error('[' + MOD + '] getTimePeriodAnalysis failed: ' + reason);
    return refuse('storage_failed', reason);
  }
}

export { CYCLE_SEQUENCE };
