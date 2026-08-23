// src/lib/manager-intelligence/recommend.ts — SIGNALS IN, SUGGESTIONS OUT. STILL NO DATABASE.
//
// =================================================================================================
// WHAT A RECOMMENDATION IS HERE
// =================================================================================================
//
// A sentence proposing something a manager might DO, next to the signals it was drawn from. It is
// not a finding about a person, not a score, and not an instruction. Every one of them is an
// invitation to go and have a conversation, and the wording is chosen so that reading it aloud to
// the person it concerns would be a reasonable thing to do.
//
// =================================================================================================
// THE RULE THAT MAKES THE OUTPUT HONEST: NO RECOMMENDATION RESTS ON ARITHMETIC ALONE
// =================================================================================================
//
// Every candidate below names its TRIGGERS — the signal keys that caused it. After the candidates
// are built, `admissible()` throws away any whose strongest trigger is merely 'derived'. So a
// comparison this module worked out ("carrying 1.7x the team average") can COLOUR a recommendation,
// but it cannot BE one: there must also be something the person actually did or something a human
// actually wrote. That is rule 22 of the house brief expressed as a filter rather than a paragraph.
//
// The corroboration is a real condition, not a formality. `reviewWorkload` does not attach a
// demonstrated signal to satisfy the check; it only fires when demonstrated pressure — overdue work,
// or a stack of high and urgent tasks — exists beside the derived comparison. A rule that reaches
// for any demonstrated signal to get past its own gate is a rule that has been switched off.
//
// =================================================================================================
// AND NOTHING HERE DECIDES ANYTHING
// =================================================================================================
//
// `humanDecides: true` is a literal in the type. There is no field for an outcome, no status this
// module can set, and no call from here into any module that changes somebody's employment record.
// NOTHING_DECIDED is the sentence every surface rendering these prints beside them.

import {
  decisionWeight,
  type ActionUrgency,
  type EvidenceStrength,
  type ManagerActionKind,
  type ManagerSignal,
  type RecommendedAction,
} from './types';

/** Printed beside every recommendation, on every surface, without exception. */
export const NOTHING_DECIDED =
  'These are suggestions drawn from work records. Nothing here has decided anything, nothing has been '
  + 'sent to anyone, and no automated step follows from leaving one alone.';

// -------------------------------------------------------------------------------------------------
// HELPERS — declared above every function that reads them.
// -------------------------------------------------------------------------------------------------

interface Candidate {
  key: string;
  headline: string;
  why: string;
  triggers: string[];
  urgency: ActionUrgency;
  suggests: ManagerActionKind;
}

const URGENCY_ORDER: ActionUrgency[] = ['now', 'this_week', 'watch'];

const indexOfKey = (signals: readonly ManagerSignal[], key: string): ManagerSignal | null =>
  signals.find((s) => s.key === key) || null;

const has = (signals: readonly ManagerSignal[], key: string): boolean => !!indexOfKey(signals, key);

/**
 * Read one of a signal's declared inputs by its label.
 *
 * The conditions below need NUMBERS, and the alternative was scanning the headline sentence for a
 * substring — which breaks silently the first time somebody improves the wording. `inputs` is the
 * structured half of the envelope and is exactly what it is for. An absent label returns 0, so a
 * condition can never fire on a value that was not published.
 */
function inputValue(signal: ManagerSignal | null, label: string): number {
  if (!signal) return 0;
  const found = signal.inputs.find((i) => i.label === label);
  if (!found) return 0;
  const n = Number(found.value);
  return Number.isFinite(n) ? n : 0;
}

/** The strongest evidence behind a set of triggers, and the mean of their confidences. */
function weigh(signals: readonly ManagerSignal[], triggers: readonly string[]): {
  restsOn: EvidenceStrength;
  confidence: number;
  present: string[];
} {
  const present: ManagerSignal[] = [];
  for (const t of triggers) {
    const s = indexOfKey(signals, t);
    if (s) present.push(s);
  }
  if (!present.length) return { restsOn: 'derived', confidence: 0, present: [] };
  let restsOn: EvidenceStrength = 'derived';
  let total = 0;
  for (const s of present) {
    if (decisionWeight(s.evidenceStrength) > decisionWeight(restsOn)) restsOn = s.evidenceStrength;
    total += s.confidence;
  }
  return {
    restsOn,
    // Rounded to two places: a recommendation carrying 0.7333333 claims a precision it does not have.
    confidence: Math.round((total / present.length) * 100) / 100,
    present: present.map((s) => s.key),
  };
}

/**
 * A recommendation may not rest on arithmetic alone.
 *
 * 'derived' means this module counted two other numbers and divided them. That is enough to draw a
 * manager's eye and not enough to propose an action about a colleague, so it is dropped here rather
 * than rendered with a caveat nobody reads.
 */
function admissible(restsOn: EvidenceStrength): boolean {
  return decisionWeight(restsOn) > decisionWeight('derived');
}

// -------------------------------------------------------------------------------------------------
// THE CANDIDATES
// -------------------------------------------------------------------------------------------------
//
// Each is a sentence a manager can act on directly, and each names the signal keys behind it. The
// conditions are written against the SIGNAL SET rather than against raw facts on purpose: a
// recommendation can only ever point at something the page is already showing, so there is no
// suggestion whose basis the manager cannot see.

function candidatesFor(signals: readonly ManagerSignal[]): Candidate[] {
  const out: Candidate[] = [];

  const overdue = indexOfKey(signals, 'current_work.overdue');
  const load = indexOfKey(signals, 'capacity.current_load');
  const aboveTeam = has(signals, 'capacity.above_team_load');
  const priorityStacked = inputValue(load, 'Urgent open') + inputValue(load, 'High open') > 0;

  // THE ONE FROM THE BRIEF. It fires on demonstrated pressure — a stack of high or urgent tasks, and
  // either overdue work or a load well above the team's — with the team comparison as colour only.
  if (priorityStacked && (aboveTeam || !!overdue)) {
    out.push({
      key: 'rec.review_workload',
      headline: 'Review workload before assigning additional high-priority tasks.',
      why: aboveTeam && overdue
        ? 'There is work already past its date, and the open assignment count is well above the team average.'
        : (overdue
          ? 'There is work already past its date alongside a stack of high or urgent tasks.'
          : 'The open assignment count is well above the team average and several of those tasks are high or urgent.'),
      triggers: ['capacity.current_load', 'capacity.above_team_load', 'current_work.overdue'],
      urgency: overdue ? 'now' : 'this_week',
      suggests: 'intervention_recorded',
    });
  }

  if (has(signals, 'capacity.leave_against_deadlines')) {
    out.push({
      key: 'rec.arrange_cover',
      headline: 'Arrange cover for the deadlines that fall during the booked leave.',
      why: 'Approved leave in the next fortnight overlaps work due inside the week. Sorting cover now is '
        + 'ordinary planning; discovering it on the day is not.',
      triggers: ['capacity.leave_against_deadlines'],
      urgency: 'this_week',
      suggests: 'intervention_recorded',
    });
  }

  const blocked = indexOfKey(signals, 'current_work.blocked');
  if (blocked && blocked.direction === 'attention') {
    out.push({
      key: 'rec.unblock',
      headline: 'Ask what the blocked work is waiting on, and get the cause written down.',
      why: 'Work is sitting at blocked with no stated cause, which is the one kind of blocker nobody else '
        + 'can pick up or help with.',
      triggers: ['current_work.blocked'],
      urgency: 'now',
      suggests: 'intervention_recorded',
    });
  }

  if (has(signals, 'current_work.stale_open')) {
    out.push({
      key: 'rec.resolve_stale',
      headline: 'Close, split or drop the oldest open task rather than carrying it another month.',
      why: 'A task open this long is usually one that changed shape, lost its owner, or stopped mattering. '
        + 'Any of those is a decision worth making explicitly.',
      triggers: ['current_work.stale_open'],
      urgency: 'this_week',
      suggests: 'intervention_recorded',
    });
  }

  if (has(signals, 'development.dated_delivery')) {
    out.push({
      key: 'rec.agree_dates',
      headline: 'Agree the next few due dates together rather than setting them.',
      why: 'Dated work is closing after the date more often than before it. Where the dates were set by '
        + 'somebody else, agreeing them is the change that moves the number.',
      triggers: ['development.dated_delivery', 'current_work.on_time_rate'],
      urgency: 'this_week',
      suggests: 'development_action',
    });
  }

  if (has(signals, 'development.reporting_consistency') || has(signals, 'submission.gap')) {
    out.push({
      key: 'rec.confirm_reporting_expectation',
      headline: 'Confirm the daily report is expected, and by when.',
      why: 'Reports are missing on days attendance records as worked. The usual cause is that nobody said '
        + 'the report was expected, which is a two-minute conversation.',
      triggers: ['development.reporting_consistency', 'submission.gap', 'submission.consistency'],
      urgency: 'this_week',
      suggests: 'development_action',
    });
  }

  if (has(signals, 'development.rework_rate')) {
    out.push({
      key: 'rec.review_handover',
      headline: 'Go through the sent-back work together before the next handover.',
      why: 'A share of reviewed work is coming back for changes. What the send-backs have in common is the '
        + 'useful question, and it is as often about the brief as about the work.',
      triggers: ['development.rework_rate', 'rework.send_back_rate'],
      urgency: 'this_week',
      suggests: 'development_action',
    });
  }

  const strengths = signals.filter((s) => s.section === 'strengths');
  if (strengths.length) {
    out.push({
      key: 'rec.record_strength',
      headline: 'Record what went well while the evidence is still fresh.',
      why: 'There is demonstrated work here worth naming. Feedback written now, against the record it '
        + 'refers to, is worth more at review time than a recollection six months later.',
      triggers: strengths.map((s) => s.key),
      urgency: 'watch',
      suggests: 'structured_feedback',
    });
  }

  if (has(signals, 'behaviour.conduct_notes')) {
    out.push({
      key: 'rec.check_with_hr',
      headline: 'Speak to HR before acting on anything else on this page.',
      why: 'HR holds informal conduct notes on this person. This screen shows only that they exist. Acting '
        + 'on the rest of the page without knowing what they concern risks addressing the same thing twice, '
        + 'or cutting across something already in hand.',
      triggers: ['behaviour.conduct_notes'],
      urgency: 'now',
      suggests: 'hr_support_requested',
    });
  }

  return out;
}

// -------------------------------------------------------------------------------------------------
// THE PUBLIC CALL
// -------------------------------------------------------------------------------------------------

/**
 * Every recommendation this signal set supports, strongest first.
 *
 * Sorted by urgency, then by the confidence of what it rests on, then by key so the order is stable
 * across renders. A list that reshuffles between two loads of the same page teaches a manager that
 * the order means nothing.
 */
export function recommendationsFor(signals: readonly ManagerSignal[]): RecommendedAction[] {
  const built: RecommendedAction[] = [];

  for (const c of candidatesFor(signals)) {
    const w = weigh(signals, c.triggers);
    if (!w.present.length) continue;
    if (!admissible(w.restsOn)) continue;
    built.push({
      key: c.key,
      headline: c.headline,
      why: c.why,
      fromSignals: w.present,
      restsOn: w.restsOn,
      urgency: c.urgency,
      suggests: c.suggests,
      confidence: w.confidence,
      humanDecides: true,
    });
  }

  built.sort((a, b) => {
    const u = URGENCY_ORDER.indexOf(a.urgency) - URGENCY_ORDER.indexOf(b.urgency);
    if (u !== 0) return u;
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    return a.key < b.key ? -1 : (a.key > b.key ? 1 : 0);
  });

  return built;
}

/**
 * The sentence for a manager with nothing suggested.
 *
 * "No recommendations" reads as an absence of information. It is usually the opposite: everything
 * was read and nothing crossed a threshold, which is the ordinary state of a team that is fine.
 */
export function noRecommendationsSentence(signals: readonly ManagerSignal[]): string {
  if (!signals.length) {
    return 'There is nothing recorded in this window to draw a suggestion from. That is a statement '
      + 'about the records, not about this person.';
  }
  return 'Nothing in this window crosses a threshold worth suggesting an action for. Everything on this '
    + 'page was read; none of it needed anything from you.';
}
