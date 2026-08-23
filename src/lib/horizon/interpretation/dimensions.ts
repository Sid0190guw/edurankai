// src/lib/horizon/interpretation/dimensions.ts — THE ONLY VOCABULARY THIS LAYER IS ALLOWED TO SPEAK.
//
// =================================================================================================
// TWELVE NEUTRAL PROFESSIONAL DIMENSIONS, AND NOTHING ELSE LEAVES THIS LAYER
// =================================================================================================
//
// PATCH 03 exists to translate. What arrives is a set of foundational factors whose vocabulary
// belongs to PATCH 02; what leaves is one of the twelve dimensions below, in ordinary workplace
// language that would be unremarkable in any competency framework.
//
// The list is CLOSED. There is no path in this module that emits a thirteenth dimension, and the
// contract validator refuses a mapping that names one. That is what makes the guarantee checkable
// rather than a promise: everything a screen can render is written down in this file, in advance,
// in language a person could be shown alongside their own record without explanation.
//
// =================================================================================================
// WHAT A DIMENSION IS NOT
// =================================================================================================
//
// It is not a trait, not a score of the person, and not a prediction. Every phrase in this file is
// written as an ORIENTATION or a TENDENCY that was INDICATED BY INPUTS — a statement about a signal,
// not about a human being. The implications are written as support suggestions in the conditional
// ("may benefit from", "can be supported by"), never as instructions about a person's employment.
//
// Three phrasings are structurally absent, and language-guard.ts enforces their absence at emit
// time rather than trusting this file to stay disciplined:
//
//   - deterministic prediction   nothing here says what somebody WILL do
//   - health language            nothing here names a condition, a diagnosis or a state of health
//   - employment decisions       nothing here says hire, reject, promote, retain or terminate
//
// STABILITY AND RECOVERY ARE THE TWO THAT NEEDED THE MOST CARE. "Stability pattern" must never read
// as attrition risk and "recovery/activation pattern" must never read as health. Both are written
// about WORK RHYTHM — how work is sequenced and handed over — and both carry an extra limitation
// line saying in words what they are not.

export const DIMENSION_IDS = [
  'analytical_orientation',
  'learning_orientation',
  'communication_orientation',
  'execution_drive',
  'sustained_effort',
  'achievement_orientation',
  'leadership_tendency',
  'collaboration_tendency',
  'stability_pattern',
  'adaptation_tendency',
  'knowledge_orientation',
  'recovery_activation_pattern',
] as const;

export type DimensionId = (typeof DIMENSION_IDS)[number];

export function isDimensionId(v: unknown): v is DimensionId {
  return typeof v === 'string' && (DIMENSION_IDS as readonly string[]).includes(v);
}

// =================================================================================================
// LEVELS
// =================================================================================================
//
// Five states, one of which is the honest refusal. `indeterminate` is not the bottom of the scale —
// it is OFF the scale, and it is what a dimension reports when too little reached it to say
// anything. A dimension with no usable input renders as "not indicated" and never as "low", because
// low is a finding and absence is not.

export const DIMENSION_LEVELS = ['indeterminate', 'limited', 'moderate', 'elevated', 'pronounced'] as const;
export type DimensionLevel = (typeof DIMENSION_LEVELS)[number];

export const LEVEL_LABELS: Record<DimensionLevel, string> = {
  indeterminate: 'Not indicated',
  limited: 'Limited indication',
  moderate: 'Moderate indication',
  elevated: 'Elevated indication',
  pronounced: 'Pronounced indication',
};

/** Order for sorting and for comparing two runs over time. `indeterminate` is deliberately -1: it
 *  is not a rank, so it must not sort as though it were the lowest one. */
export const LEVEL_RANK: Record<DimensionLevel, number> = {
  indeterminate: -1,
  limited: 0,
  moderate: 1,
  elevated: 2,
  pronounced: 3,
};

export const CONFIDENCE_BANDS = ['very_low', 'low', 'moderate', 'high'] as const;
export type ConfidenceBand = (typeof CONFIDENCE_BANDS)[number];

export const CONFIDENCE_LABELS: Record<ConfidenceBand, string> = {
  very_low: 'Very low confidence',
  low: 'Low confidence',
  moderate: 'Moderate confidence',
  high: 'High confidence',
};

export interface DimensionSpec {
  id: DimensionId;
  /** What a screen calls it. */
  label: string;
  /** One neutral sentence: what this dimension describes in ordinary workplace terms. */
  description: string;
  /** What the dimension does NOT describe. Printed next to it, because the most damaging reading of
   *  a professional dimension is usually the one it never claimed to support. */
  notAbout: string;
  /** Support-oriented implications, by level. Never about employment status. */
  implications: Record<Exclude<DimensionLevel, 'indeterminate'>, string[]>;
  /** A caveat specific to this dimension, on top of the universal limitation text. */
  limitation: string;
}

const NO_IMPLICATIONS: string[] = [];

export const DIMENSIONS: Record<DimensionId, DimensionSpec> = {
  analytical_orientation: {
    id: 'analytical_orientation',
    label: 'Analytical orientation',
    description:
      'The degree to which the inputs point towards working through problems by breaking them down, comparing options and reasoning from stated information.',
    notAbout: 'It is not a measure of intelligence, of technical skill, or of the quality of any decision this person has made.',
    implications: {
      limited: [
        'Written problem framing and worked examples may make expectations clearer at the start of a task.',
        'Where a task depends on structured comparison, a shared template can carry the structure instead of the individual.',
      ],
      moderate: [
        'Ordinary analytical work is unlikely to need special support arrangements.',
        'Pairing on the first pass of an unfamiliar analysis can be useful without being necessary.',
      ],
      elevated: [
        'Work involving investigation, root-cause analysis or option appraisal may be a good use of interest.',
        'Reviewing another person’s reasoning is a contribution this orientation often supports.',
      ],
      pronounced: [
        'Deep analytical work may be engaging, and a role with none of it may feel under-used.',
        'Explicit time limits on analysis help where a decision is needed before every question can be closed.',
      ],
    },
    limitation:
      'Analytical work performed on this platform — completed assessments, reviewed submissions, delivered projects — is a stronger indicator than this dimension and takes precedence over it.',
  },

  learning_orientation: {
    id: 'learning_orientation',
    label: 'Learning orientation',
    description:
      'The degree to which the inputs point towards seeking out new material, revisiting what did not work, and treating unfamiliarity as ordinary.',
    notAbout: 'It is not a measure of qualifications held, of learning ability, or of how quickly anybody learns anything.',
    implications: {
      limited: [
        'Structured, scheduled learning with a clear finish point tends to work better than open-ended self study.',
        'Naming exactly which skill a piece of training is for makes the ask concrete.',
      ],
      moderate: [
        'Standard onboarding and role training are likely to be sufficient.',
        'Optional depth material can be offered without being made a requirement.',
      ],
      elevated: [
        'Access to material beyond the immediate role may be worth offering.',
        'Learning that is shared back to a team can be a natural contribution.',
      ],
      pronounced: [
        'Breadth of interest may need a stated priority order so that current work is not displaced.',
        'A role with an explicit study or research component may suit this orientation.',
      ],
    },
    limitation:
      'Completed courses, passed assessments and verified credentials on record are stronger indicators than this dimension and take precedence over it.',
  },

  communication_orientation: {
    id: 'communication_orientation',
    label: 'Communication orientation',
    description:
      'The degree to which the inputs point towards expressing reasoning, updates and disagreement in a form other people can act on.',
    notAbout: 'It is not a measure of language proficiency, of confidence, or of how well anybody presents. It is not an assessment of personality.',
    implications: {
      limited: [
        'Written updates on an agreed cadence can carry information that would otherwise depend on speaking up.',
        'Direct questions in a review get more than open invitations to comment.',
      ],
      moderate: [
        'Ordinary team communication is unlikely to need special arrangements.',
        'Occasional written summaries help where work crosses teams.',
      ],
      elevated: [
        'Work involving explanation, documentation or coordination across teams may be a good fit for interest.',
        'This orientation often supports the role of relaying decisions accurately.',
      ],
      pronounced: [
        'Communication-heavy work may be engaging; agreeing what does not need to be circulated is equally useful.',
        'A stated escalation path prevents breadth of contact from becoming duplicated messages.',
      ],
    },
    limitation:
      'Recorded work — written documents, delivered sessions, reviewed correspondence — is a stronger indicator than this dimension and takes precedence over it.',
  },

  execution_drive: {
    id: 'execution_drive',
    label: 'Action and execution drive',
    description:
      'The degree to which the inputs point towards starting, moving work forward and closing items rather than holding them open.',
    notAbout: 'It is not a measure of productivity, output volume, or how much anybody has delivered.',
    implications: {
      limited: [
        'Smaller committed increments with named finish points may make progress easier to see.',
        'Removing approval bottlenecks helps more than adding follow-up.',
      ],
      moderate: [
        'Standard planning and review cadence is likely to be sufficient.',
      ],
      elevated: [
        'Work with clear deliverables and short cycles may suit this orientation.',
        'A defined point at which a decision is checked before acting prevents pace from outrunning agreement.',
      ],
      pronounced: [
        'Fast-moving work may be engaging; explicit review gates keep speed and correctness together.',
        'Agreeing what is deliberately NOT being started is as useful as agreeing what is.',
      ],
    },
    limitation:
      'Delivered work on record — closed tasks, shipped changes, completed assignments — is a stronger indicator than this dimension and takes precedence over it.',
  },

  sustained_effort: {
    id: 'sustained_effort',
    label: 'Discipline and sustained effort',
    description:
      'The degree to which the inputs point towards staying with long-running work through the part of it that is neither new nor visible.',
    notAbout: 'It is not a measure of commitment, of reliability, or of anybody’s work ethic, and it is not a basis for any statement about attendance.',
    implications: {
      limited: [
        'Breaking long work into milestones with visible progress can maintain momentum.',
        'Rotating routine work across a team is often better than assigning it permanently.',
      ],
      moderate: [
        'Ordinary long-running work is unlikely to need special arrangements.',
      ],
      elevated: [
        'Work requiring follow-through over months may suit this orientation.',
        'Periodic checks that the original goal still holds prevent persistence on something that has changed.',
      ],
      pronounced: [
        'Long-horizon work may be engaging; a stated stopping rule matters where a line of work stops being worthwhile.',
        'Explicit handover points keep durable ownership from becoming sole ownership.',
      ],
    },
    limitation:
      'Attendance and time records must never be read together with this dimension as though they confirmed each other. They are separate records with separate purposes, and this dimension is not evidence about either.',
  },

  achievement_orientation: {
    id: 'achievement_orientation',
    label: 'Ambition and achievement orientation',
    description:
      'The degree to which the inputs point towards setting a higher bar, seeking a larger remit and measuring work against a target.',
    notAbout: 'It is not a measure of performance, of readiness for a larger role, or of whether anybody deserves advancement.',
    implications: {
      limited: [
        'Development conversations may be more useful when framed around craft and interest than around progression.',
      ],
      moderate: [
        'Standard goal-setting is likely to be sufficient.',
      ],
      elevated: [
        'A visible development path and stretch work may be worth discussing.',
        'Naming what a larger remit would actually require keeps ambition and expectation aligned.',
      ],
      pronounced: [
        'Clear, written criteria for a larger remit matter more here than encouragement.',
        'Where progression is not currently available, saying so plainly is better than deferring the conversation.',
      ],
    },
    limitation:
      'This dimension must not be used to decide a promotion, a rating or a pay outcome. Those decisions rest on demonstrated work and a named human’s judgement, and this dimension is neither.',
  },

  leadership_tendency: {
    id: 'leadership_tendency',
    label: 'Leadership tendency',
    description:
      'The degree to which the inputs point towards taking responsibility for a shared outcome, setting direction and answering for a group’s work.',
    notAbout: 'It is not an assessment of leadership capability, of authority held, or of suitability to manage anybody.',
    implications: {
      limited: [
        'Contribution is not dependent on leading; senior individual work is a full path in its own right.',
      ],
      moderate: [
        'Leading a piece of work rather than a team can be a useful next step where the person wants it.',
      ],
      elevated: [
        'Ownership of a defined workstream, with the decisions it involves stated explicitly, may be a good fit.',
        'Support in giving difficult feedback is usually more useful than support in taking charge.',
      ],
      pronounced: [
        'A clear boundary of authority matters: what may be decided alone, and what must be agreed.',
        'Where a leadership role is not available, the reason is worth stating rather than leaving open.',
      ],
    },
    limitation:
      'No leadership appointment may rest on this dimension. Authority in this organisation is resolved from the organisation graph and granted by a named human, and this dimension has no part in that.',
  },

  collaboration_tendency: {
    id: 'collaboration_tendency',
    label: 'Collaboration tendency',
    description:
      'The degree to which the inputs point towards working through other people — asking, offering, and coordinating rather than proceeding alone.',
    notAbout: 'It is not a measure of how well anybody works with others, and it is not an assessment of teamwork or of any working relationship.',
    implications: {
      limited: [
        'Deep individual work with agreed check-in points may be more effective than continuous joint working.',
        'Written handovers carry what informal contact would otherwise carry.',
      ],
      moderate: [
        'Ordinary team working is unlikely to need special arrangements.',
      ],
      elevated: [
        'Work spanning several people or teams may suit this orientation.',
        'Protected time for individual work keeps availability from consuming the day.',
      ],
      pronounced: [
        'Coordination-heavy work may be engaging; agreeing which decisions do not need consensus keeps it moving.',
      ],
    },
    limitation:
      'Feedback from colleagues, where it exists, is a stronger indicator than this dimension. One person’s view of a working relationship is not organisational truth and must not be aggregated as though it were.',
  },

  stability_pattern: {
    id: 'stability_pattern',
    label: 'Stability pattern',
    description:
      'The degree to which the inputs point towards a steady working rhythm — consistent method, steady sequencing, and few changes of direction within a piece of work.',
    notAbout:
      'It is NOT a prediction about how long anybody will stay, not a retention or attrition signal, and not a basis for any decision about continued employment. It describes rhythm within work, not tenure.',
    implications: {
      limited: [
        'Explicit checkpoints and written state make work legible when the approach changes within it.',
        'Shorter planning horizons may fit better than long fixed plans.',
      ],
      moderate: [
        'Standard planning is likely to be sufficient.',
      ],
      elevated: [
        'Work benefiting from consistent method — operations, compliance, long-lived systems — may suit this rhythm.',
      ],
      pronounced: [
        'Advance notice of change in priorities is worth more here than after-the-fact explanation.',
        'Where a change of direction cannot be avoided, saying why keeps consistency from reading as resistance.',
      ],
    },
    limitation:
      'This dimension must never be used as, or alongside, an attrition or flight-risk indicator, and must never inform a decision about renewing, ending or not offering employment.',
  },

  adaptation_tendency: {
    id: 'adaptation_tendency',
    label: 'Adaptation tendency',
    description:
      'The degree to which the inputs point towards adjusting approach when circumstances change, and working usefully before the picture is complete.',
    notAbout: 'It is not a measure of flexibility as a virtue, and it is not an assessment of how anybody has responded to any actual change.',
    implications: {
      limited: [
        'Advance notice, a written rationale and a transition period make change easier to absorb.',
        'Keeping one part of the work stable while another changes reduces the surface of the change.',
      ],
      moderate: [
        'Ordinary change management is likely to be sufficient.',
      ],
      elevated: [
        'Early-stage or shifting work may suit this orientation.',
        'Recording what was decided keeps adaptability from erasing the reasoning behind it.',
      ],
      pronounced: [
        'A stated bar for what counts as enough new information prevents continuous re-planning.',
      ],
    },
    limitation:
      'How a person has actually responded to a real change at work is a stronger indicator than this dimension and takes precedence over it.',
  },

  knowledge_orientation: {
    id: 'knowledge_orientation',
    label: 'Reflective and knowledge orientation',
    description:
      'The degree to which the inputs point towards stepping back from immediate work to consolidate what is known, write it down and reconsider it.',
    notAbout: 'It is not a measure of expertise, seniority, or how much anybody knows.',
    implications: {
      limited: [
        'Documentation is more likely to happen when it is a named deliverable rather than an expectation.',
      ],
      moderate: [
        'Standard documentation practice is likely to be sufficient.',
      ],
      elevated: [
        'Work involving synthesis, standards or internal reference material may suit this orientation.',
      ],
      pronounced: [
        'Reflective work may be engaging; a stated audience and finish point keep it from expanding indefinitely.',
      ],
    },
    limitation:
      'Material this person has actually written, taught or reviewed on record is a stronger indicator than this dimension and takes precedence over it.',
  },

  recovery_activation_pattern: {
    id: 'recovery_activation_pattern',
    label: 'Recovery and activation pattern',
    description:
      'The degree to which the inputs point towards a working rhythm that alternates — concentrated activity followed by consolidation — rather than an even distribution of effort across a period.',
    notAbout:
      'It is NOT about health, energy, wellbeing, fatigue, burnout, or any physical or mental state. It describes how work is SEQUENCED, and it is not a health signal of any kind. It must never be read as one.',
    implications: {
      limited: [
        'An even distribution of work across a period is likely to fit; large single blocks may be less effective.',
      ],
      moderate: [
        'Ordinary scheduling is likely to be sufficient.',
      ],
      elevated: [
        'Where the work allows it, scheduling concentrated blocks with consolidation time between them may fit this rhythm.',
      ],
      pronounced: [
        'Agreeing the shape of a working period in advance is more useful than managing it afterwards.',
        'Deadlines set at the end of a consolidation period rather than inside a concentrated block reduce collisions.',
      ],
    },
    limitation:
      'This dimension makes no statement about health, capacity or wellbeing, must never be used to question a leave request, an accommodation or an absence, and must never be recorded as health information.',
  },
};

export const DIMENSION_LIST: DimensionSpec[] = DIMENSION_IDS.map((id) => DIMENSIONS[id]);

export function dimensionSpec(id: unknown): DimensionSpec | null {
  return isDimensionId(id) ? DIMENSIONS[id] : null;
}

/**
 * THE UNIVERSAL LIMITATION TEXT, ATTACHED TO EVERY DIMENSION EVER EMITTED.
 *
 * Not a footer on a page — a field on the object, so that a dimension copied into an export, an
 * email or another system carries its own caveat with it. A limitation that lives only in the
 * template is a limitation that disappears the first time somebody screenshots the value.
 */
export const UNIVERSAL_LIMITATIONS: readonly string[] = [
  'This is an indication derived from indirect inputs. It is not a measurement, not a test result, and not established scientific fact.',
  'It describes a tendency suggested by inputs, never a certainty, and it says nothing about what this person will do.',
  'Demonstrated work on record always takes precedence over this indication where the two differ.',
  'It must not be used to make or support a hiring, rejection, promotion, termination or disciplinary decision.',
  'It is not a health assessment and contains no clinical statement of any kind.',
  'A person may ask how this was produced, may disagree with it on the record, and may ask for it to be set aside.',
];

/** The implications for a level, or an empty list for `indeterminate`. Absence emits nothing:
 *  a dimension that could not be indicated has no professional implications to offer. */
export function implicationsFor(id: DimensionId, level: DimensionLevel): string[] {
  if (level === 'indeterminate') return NO_IMPLICATIONS;
  return DIMENSIONS[id].implications[level] || NO_IMPLICATIONS;
}

/** Every limitation line for a dimension: the universal set plus its own caveat. */
export function limitationsFor(id: DimensionId): string[] {
  const spec = DIMENSIONS[id];
  return [...UNIVERSAL_LIMITATIONS, spec.limitation];
}
