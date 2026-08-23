// src/lib/horizon/cycles.ts — LAYER D. THE FOUNDATIONAL TIME CYCLES, AND THE GATE IN FRONT OF THEM.
//
// =================================================================================================
// WHAT LAYER D IS FOR
// =================================================================================================
//
// The other three layers answer "what happened", "what is true now" and "what might develop". None
// of them answers the question a time engine is actually for: WHERE IN A REPEATING CYCLE IS THIS
// PERSON STANDING. A review lands every six months whether or not anybody is ready for it. Probation
// ends on a date fixed at hire. The organisation's year has a shape. Somebody eleven months into a
// role is in a different part of a cycle from somebody eleven days in, and that is a fact about
// TIMING, not about them.
//
// That is what this file computes. Cadence and phase. Never worth, never ability, never character.
//
// =================================================================================================
// PROVIDERS, AND WHY THIS IS AN INTERFACE RATHER THAN A FUNCTION
// =================================================================================================
//
// The master build prompt for this system contemplates more than one basis for a foundational cycle
// reading, including traditional birth-based computation, and requires (a) that any such method be
// SEPARATED from the professional interpretation layer, (b) that it never be presented as proven
// scientific fact, and (c) that demonstrated job-related evidence always outweigh it.
//
// A provider interface is how those three requirements become structural instead of promised. Every
// provider returns the same shape, carries its own basis, and is composed by the engine identically
// — so the separation cannot be lost by somebody wiring a shortcut, and the decision weight cannot
// be raised by anybody, because there is no field on a CycleReading that holds one. It is the
// literal string 'none' on the type.
//
// =================================================================================================
// WHAT SHIPS ENABLED, WHAT SHIPS DISABLED, AND WHY
// =================================================================================================
//
// ENABLED: `tenure_cycle`. Computes foundational cycles from dates this organisation itself
// recorded — joining, probation end, confirmation, review cadence, the position of today inside the
// person's own tenure year. Every input is an organisational record, none of it is a protected
// attribute, and the person can see every input on their own screen.
//
// DISABLED, AND NOT BECAUSE THE INTERFACE IS UNFINISHED: `birth_cycle`. It is registered, it is
// typed, and its gate is real code with tests. What it will not do is run by default against live
// employees, for a reason worth writing down rather than burying:
//
//   A cycle derived from a date of birth is derived from age. Age is a protected characteristic in
//   Indian employment law and in most jurisdictions this platform operates toward. Emitting
//   "leadership trajectory" and "potential challenges" for a named employee from their birth date
//   produces an age-correlated signal on a career surface, and the correlation survives every
//   disclaimer placed around it. Rule 22 of the build prompt already puts this below demonstrated
//   evidence; running it by default would put it on the screen anyway, next to the evidence, where
//   a reader's eye does the combining that the code refuses to do.
//
//   It is also refused one layer down and not by this file: src/lib/digital-twin.ts — the master
//   employee record, which this patch does not own and must not modify — puts 'dob', 'birth' and
//   'age' in PROTECTED_ATTRIBUTE_SEGMENTS and screens them out at the column level. A query naming
//   date_of_birth there produces a refusal and a log line, not a value. Patch 07 honours that
//   contract rather than reaching around it.
//
// SO THE DECISION IS LEFT WHERE IT BELONGS. Turning this on is a policy choice with legal exposure,
// not a mechanism change, and the three things it needs are named in BIRTH_CYCLE_PRECONDITIONS
// below. Nothing here silently decides it either way, and nothing here is a stub: the gate, the
// consent read, the refusal and the audit sentence are all implemented and all tested.

import { FOUNDATIONAL_DISCLAIMER } from './time';

export const MOD = 'horizon/cycles';

// =================================================================================================
// THE SHAPE EVERY PROVIDER RETURNS
// =================================================================================================

export type CycleBasis = 'organisational_record' | 'birth_data';

export const CYCLE_BASIS_LABELS: Record<CycleBasis, string> = {
  organisational_record: 'Organisational records',
  birth_data: 'Date-of-birth derived',
};

export interface CycleReading {
  providerId: string;
  /** The cycle being described, in words a person would recognise. */
  cycleName: string;
  /** Where in that cycle today falls. */
  phase: string;
  phaseIndex: number;
  phaseCount: number;
  /** How far through the current cycle, 0 to 100. */
  positionPct: number;
  /** What the phase means for TIMING. Never a statement about the person. */
  meaning: string;
  /** Rule 12: the inputs, named, so the output is reproducible by hand. */
  inputs: string[];
  basis: CycleBasis;
  /**
   * Not a variable. The literal string. There is no code path that sets this to anything else and
   * no caller that can, because the type admits one value.
   */
  decisionWeight: 'none';
  /** Rule 21. Carried on the row, not only on the panel, so it survives being read out of context. */
  notScientific: string;
}

export interface CycleRefusal {
  providerId: string;
  refused: true;
  /** What would have to be true. Written for the person who has to decide, not for a log. */
  because: string;
  missing: string[];
}

export type CycleResult = CycleReading[] | CycleRefusal;

export function isRefusal(r: CycleResult): r is CycleRefusal {
  return !Array.isArray(r) && (r as CycleRefusal).refused === true;
}

/** Everything a provider is allowed to see. Deliberately narrow. */
export interface CycleInput {
  /** ISO day the whole reading is anchored on. */
  today: string;
  joiningDay: string | null;
  probationEndDay: string | null;
  confirmationDay: string | null;
  /** Days between the last two review cycles this person sat in, when there were two. */
  reviewCadenceDays: number | null;
  /** ISO day of the most recent review period end. */
  lastReviewDay: string | null;
  /**
   * Present ONLY when a provider that needs it has passed its gate. The tenure provider never reads
   * it. It is optional on the type so that the default path cannot accidentally supply it.
   */
  birthDay?: string | null;
}

export interface CycleProvider {
  id: string;
  label: string;
  basis: CycleBasis;
  /** Ships on, or ships off. See the header. */
  enabledByDefault: boolean;
  /** Does a named human have to have recorded the person's agreement first. */
  requiresConsent: boolean;
  /** One line, shown wherever the provider is named in the console. */
  describe: string;
  compute(input: CycleInput): CycleResult;
}

const DAY_MS = 86400000;

function daysBetween(a: string, b: string): number {
  const x = new Date(a + 'T00:00:00Z').getTime();
  const y = new Date(b + 'T00:00:00Z').getTime();
  if (isNaN(x) || isNaN(y)) return 0;
  return Math.round((y - x) / DAY_MS);
}

function pct(part: number, whole: number): number {
  if (!whole || whole <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((part / whole) * 100)));
}

// =================================================================================================
// PROVIDER 1 — TENURE CYCLE. ENABLED. EVERY INPUT IS A DATE THIS ORGANISATION WROTE DOWN.
// =================================================================================================
//
// Four cycles, each computed from a date the people desk already holds and the person can already
// see on their own record:
//
//   engagement stage   where today sits between joining, probation end and confirmation
//   tenure year        how far through the current year-of-service today falls
//   review cadence     how far through the gap between review cycles today falls
//   organisational year which quarter of the calendar year the organisation is working in
//
// None of these is a judgement. "Eleven months into a tenure year" is the same sentence for the
// strongest and the weakest performer in the company, which is exactly the property that makes it
// safe to compute and useful to show.

export const ENGAGEMENT_PHASES = [
  'joining',
  'probation',
  'confirmation pending',
  'confirmed',
  'established',
] as const;

export type EngagementPhase = (typeof ENGAGEMENT_PHASES)[number];

/** Pure, exported and tested separately: this is the part most likely to be quietly off by a day. */
export function engagementPhase(input: CycleInput): {
  phase: EngagementPhase;
  index: number;
  positionPct: number;
  inputs: string[];
} | null {
  const { today, joiningDay, probationEndDay, confirmationDay } = input;
  if (!joiningDay) return null;

  const tenureDays = daysBetween(joiningDay, today);
  const inputs = ['hr_employees.joining_date = ' + joiningDay];
  if (probationEndDay) inputs.push('hr_employees.probation_end_date = ' + probationEndDay);
  if (confirmationDay) inputs.push('hr_employees.confirmation_date = ' + confirmationDay);

  if (tenureDays < 30) {
    return { phase: 'joining', index: 0, positionPct: pct(tenureDays, 30), inputs };
  }
  if (confirmationDay && today >= confirmationDay) {
    const sinceConfirm = daysBetween(confirmationDay, today);
    // Two years past confirmation is treated as established. The number is a convention, and it is
    // written here rather than hidden in a query so it can be argued with.
    if (sinceConfirm >= 730) {
      return { phase: 'established', index: 4, positionPct: 100, inputs };
    }
    return { phase: 'confirmed', index: 3, positionPct: pct(sinceConfirm, 730), inputs };
  }
  if (probationEndDay) {
    if (today < probationEndDay) {
      const total = Math.max(1, daysBetween(joiningDay, probationEndDay));
      return { phase: 'probation', index: 1, positionPct: pct(tenureDays, total), inputs };
    }
    return { phase: 'confirmation pending', index: 2, positionPct: 100, inputs };
  }
  return { phase: 'probation', index: 1, positionPct: pct(tenureDays, 180), inputs };
}

const ENGAGEMENT_MEANING: Record<EngagementPhase, string> = {
  joining:
    'The first month. Records are thin by definition here, and thin records are not a finding about the person.',
  probation:
    'Inside the probation window recorded at hire. The date was fixed on joining, not by anything that has happened since.',
  'confirmation pending':
    'The recorded probation date has passed and no confirmation date is on the record. This is a gap in the paperwork, not a judgement.',
  confirmed:
    'Confirmed on the record, inside the first two years after it.',
  established:
    'More than two years past confirmation. The record is long enough that trends in it mean something.',
};

export const tenureCycleProvider: CycleProvider = {
  id: 'tenure_cycle',
  label: 'Tenure and cadence cycles',
  basis: 'organisational_record',
  enabledByDefault: true,
  requiresConsent: false,
  describe:
    'Cycles computed from dates this organisation recorded: joining, probation, confirmation and review cadence.',
  compute(input: CycleInput): CycleResult {
    const out: CycleReading[] = [];
    const base = {
      providerId: 'tenure_cycle',
      basis: 'organisational_record' as const,
      decisionWeight: 'none' as const,
      notScientific: FOUNDATIONAL_DISCLAIMER,
    };

    const eng = engagementPhase(input);
    if (eng) {
      out.push({
        ...base,
        cycleName: 'Engagement stage',
        phase: eng.phase,
        phaseIndex: eng.index,
        phaseCount: ENGAGEMENT_PHASES.length,
        positionPct: eng.positionPct,
        meaning: ENGAGEMENT_MEANING[eng.phase],
        inputs: eng.inputs,
      });
    }

    if (input.joiningDay) {
      const tenureDays = Math.max(0, daysBetween(input.joiningDay, input.today));
      const yearIndex = Math.floor(tenureDays / 365);
      const intoYear = tenureDays - yearIndex * 365;
      out.push({
        ...base,
        cycleName: 'Tenure year',
        phase: 'year ' + (yearIndex + 1) + ' of service, day ' + intoYear,
        phaseIndex: yearIndex,
        phaseCount: 0,
        positionPct: pct(intoYear, 365),
        meaning:
          'Where today falls inside this person\'s own year of service. Anniversary-linked events '
          + 'cluster near the end of it; that is a property of the calendar, not of their work.',
        inputs: ['hr_employees.joining_date = ' + input.joiningDay],
      });
    }

    if (input.reviewCadenceDays && input.lastReviewDay) {
      const since = Math.max(0, daysBetween(input.lastReviewDay, input.today));
      out.push({
        ...base,
        cycleName: 'Review cadence',
        phase:
          since + ' days since the last review period closed, on a '
          + input.reviewCadenceDays + '-day cadence',
        phaseIndex: Math.floor(since / Math.max(1, input.reviewCadenceDays)),
        phaseCount: 0,
        positionPct: pct(since % Math.max(1, input.reviewCadenceDays), input.reviewCadenceDays),
        meaning:
          'How far through the organisation\'s own review rhythm today falls. Evidence gathered '
          + 'late in a cycle has had less time to be verified, which affects confidence and nothing else.',
        inputs: [
          'hr_review_cycles.period_end (latest) = ' + input.lastReviewDay,
          'derived cadence = ' + input.reviewCadenceDays + ' days between the last two cycles',
        ],
      });
    }

    if (out.length === 0) {
      return {
        providerId: 'tenure_cycle',
        refused: true,
        because:
          'No joining date is recorded for this person, and every cycle here is measured from one. '
          + 'The people desk holds that field; until it is filled in there is nothing to compute and '
          + 'a guess would be worse than a blank.',
        missing: ['hr_employees.joining_date'],
      };
    }
    return out;
  },
};

// =================================================================================================
// PROVIDER 2 — BIRTH CYCLE. REGISTERED, GATED, AND OFF.
// =================================================================================================
//
// The gate is the implementation. Read BIRTH_CYCLE_PRECONDITIONS as the specification of what
// turning this on actually costs; each entry is a thing somebody has to do, not a flag to flip.

export const BIRTH_CYCLE_PRECONDITIONS: readonly { requirement: string; why: string }[] = Object.freeze([
  {
    requirement:
      'A recorded, revocable, purpose-named consent from the person themselves, held in horizon_consent and re-asked when the purpose changes.',
    why:
      'Rule 17. A date of birth is collected for payroll and statutory filing. Using it for a career-development reading is a different purpose, and consent for one is not consent for the other.',
  },
  {
    requirement:
      'An explicit deployment decision recorded by a named accountable person, not an environment variable set in passing.',
    why:
      'The exposure is legal, not technical. It should have a name attached to it inside the system that carries it.',
  },
  {
    requirement:
      'A written position on age-adverse-impact for the jurisdictions this platform employs in, and a decision to accept it.',
    why:
      'A reading derived from a birth date is derived from age. That correlation does not go away because the output is labelled advisory, and it is the specific thing an employment tribunal would ask about.',
  },
  {
    requirement:
      'A surface rule that keeps this layer off every screen where a hiring, promotion, discipline or exit decision is being made.',
    why:
      'Rule 22 orders the layers. Only keeping them on separate screens actually enforces the order, because a reader standing in front of both does the combining the code refuses to do.',
  },
]);

/** What the caller must prove before the provider will compute anything. */
export interface BirthCycleGate {
  /** A named human recorded this person's agreement, for this purpose. */
  consentRecorded: boolean;
  /** The deployment has explicitly enabled the provider. */
  deploymentEnabled: boolean;
  /** The surface asking is not a decision surface. */
  surfaceIsNonDecision: boolean;
  /** A birth day was supplied by a caller that had the right to read it. */
  birthDayAvailable: boolean;
}

export const CLOSED_GATE: BirthCycleGate = Object.freeze({
  consentRecorded: false,
  deploymentEnabled: false,
  surfaceIsNonDecision: false,
  birthDayAvailable: false,
});

/**
 * The gate, as a function, so it is testable and so there is exactly one place it is decided.
 *
 * Returns the list of unmet preconditions. An empty list means the gate is open. Every caller in
 * this module treats a non-empty list as a refusal and none of them can choose otherwise.
 */
export function birthGateFailures(gate: BirthCycleGate): string[] {
  const missing: string[] = [];
  if (!gate.deploymentEnabled) missing.push('deployment has not enabled the date-of-birth cycle provider');
  if (!gate.consentRecorded) missing.push('no recorded consent from this person for this purpose');
  if (!gate.surfaceIsNonDecision) missing.push('the requesting surface is one where decisions are made');
  if (!gate.birthDayAvailable) missing.push('no date of birth was supplied by a caller entitled to read it');
  return missing;
}

let _birthGate: BirthCycleGate = CLOSED_GATE;

/**
 * Install a gate state. Exists so the deployment decision is made in ONE place by whoever owns it,
 * and so the tests can exercise both sides of the gate without an environment.
 *
 * There is no call to this anywhere in the shipped code. That is the point: the provider is off
 * until somebody with the authority to make the decision in BIRTH_CYCLE_PRECONDITIONS wires it.
 */
export function setBirthGate(gate: Partial<BirthCycleGate>): void {
  _birthGate = { ..._birthGate, ...gate };
}

export function currentBirthGate(): BirthCycleGate {
  return { ..._birthGate };
}

export const birthCycleProvider: CycleProvider = {
  id: 'birth_cycle',
  label: 'Foundational date cycles',
  basis: 'birth_data',
  enabledByDefault: false,
  requiresConsent: true,
  describe:
    'Cycles derived from a recorded date of birth. Off by default. Carries no decision weight and is '
    + 'not a scientific finding.',
  compute(input: CycleInput): CycleResult {
    const gate: BirthCycleGate = {
      ..._birthGate,
      birthDayAvailable: !!input.birthDay,
    };
    const missing = birthGateFailures(gate);
    if (missing.length) {
      return {
        providerId: 'birth_cycle',
        refused: true,
        because:
          'This layer is not computed. It is off by default because a cycle derived from a date of '
          + 'birth is a cycle derived from age, and age is a protected characteristic; the master '
          + 'employee record refuses that column at the query level for the same reason. Turning it '
          + 'on is a policy decision with the preconditions listed in BIRTH_CYCLE_PRECONDITIONS, not '
          + 'a setting.',
        missing,
      };
    }

    // The gate is open, which means a named person accepted the preconditions. Even then the output
    // is cadence only, carries decisionWeight 'none' like every other cycle, and names its input so
    // the reading can be checked and challenged.
    const birthDay = String(input.birthDay);
    const dayOfYear = (() => {
      const d = new Date(birthDay + 'T00:00:00Z');
      const start = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
      return Math.floor((d.getTime() - start.getTime()) / DAY_MS);
    })();
    const todayDate = new Date(input.today + 'T00:00:00Z');
    const todayStart = new Date(Date.UTC(todayDate.getUTCFullYear(), 0, 1));
    const todayDoy = Math.floor((todayDate.getTime() - todayStart.getTime()) / DAY_MS);
    const intoPersonalYear = (todayDoy - dayOfYear + 365) % 365;

    return [
      {
        providerId: 'birth_cycle',
        cycleName: 'Personal annual cycle',
        phase: 'day ' + intoPersonalYear + ' of the personal year',
        phaseIndex: Math.floor(intoPersonalYear / 91),
        phaseCount: 4,
        positionPct: pct(intoPersonalYear, 365),
        meaning:
          'Where today falls in the twelve months measured from the recorded date. This describes '
          + 'timing only. It says nothing about ability, character or suitability for any role, and '
          + 'it is outranked by every piece of demonstrated work on the record.',
        inputs: ['a recorded date of birth, read under recorded consent'],
        basis: 'birth_data',
        decisionWeight: 'none',
        notScientific: FOUNDATIONAL_DISCLAIMER,
      },
    ];
  },
};

// =================================================================================================
// THE REGISTRY
// =================================================================================================

export const CYCLE_PROVIDERS: readonly CycleProvider[] = Object.freeze([
  tenureCycleProvider,
  birthCycleProvider,
]);

export function cycleProvider(id: string): CycleProvider | null {
  return CYCLE_PROVIDERS.find((p) => p.id === id) || null;
}

export interface CycleLayer {
  readings: CycleReading[];
  refusals: CycleRefusal[];
  /** Named providers that are registered but off, so a console can say so without guessing. */
  disabled: { id: string; label: string; because: string }[];
  disclaimer: string;
}

/**
 * Run every enabled provider and collect both what they said and what they refused.
 *
 * A refusal is returned, never swallowed. "This layer is off and here is why" is a better answer
 * than an empty panel, which reads as "there is nothing here" and is a different claim.
 */
export function computeCycles(input: CycleInput): CycleLayer {
  const readings: CycleReading[] = [];
  const refusals: CycleRefusal[] = [];
  const disabled: { id: string; label: string; because: string }[] = [];

  for (const p of CYCLE_PROVIDERS) {
    const on = p.id === 'birth_cycle' ? _birthGate.deploymentEnabled : p.enabledByDefault;
    if (!on) {
      disabled.push({
        id: p.id,
        label: p.label,
        because:
          p.basis === 'birth_data'
            ? 'Off by default. Derived from age, which is a protected characteristic; enabling it is a recorded policy decision.'
            : 'Not enabled in this deployment.',
      });
      continue;
    }
    let r: CycleResult;
    try {
      r = p.compute(input);
    } catch (e: any) {
      refusals.push({
        providerId: p.id,
        refused: true,
        because:
          'This provider failed while computing, so no cycle is shown for it. A failure is reported '
          + 'rather than rendered as an empty cycle. (' + (e?.cause?.message || e?.message || 'unknown') + ')',
        missing: ['provider did not complete'],
      });
      continue;
    }
    if (isRefusal(r)) refusals.push(r);
    else readings.push(...r);
  }

  return { readings, refusals, disabled, disclaimer: FOUNDATIONAL_DISCLAIMER };
}
